// Background service worker (MV3) — the scan loop's side-effect wrapper (PRD §9 /
// §15 / §17). This ticket (04, issue #15) turns the prefactor entry into the
// first real scan: an alarm fires, a short-lived window opens on one watch's URL, the
// content script scroll-settles and parses the page, the tab closes, the new jobs
// land in storage and the badge shows the unread count.
//
// Per PRD §14 this file holds NO decision logic — every choice lives in a pure,
// tested module and this only orchestrates `chrome.*`:
//   • schedule.ts  → nextScanDelayMs (when to fire next; jitter + quiet hours)
//   • lifecycle.ts → the scan lock, keepalive interval, orphaned-tab cleanup
//   • scan.ts      → enabled watches, page URLs, job stamping/merging, badge text
//   • dedupe.ts    → new-vs-seen, composing filter.ts
// so this wrapper is not unit-tested; the modules it calls are.

import { get, set } from "./storage.ts";
import { dedupe } from "./dedupe.ts";
import type { FilterRules } from "./filter.ts";
import { nextScanDelayMs, randomPauseMs, SCAN_ALARM_NAME } from "./schedule.ts";
import {
  KEEPALIVE_PING_MS,
  beginScan,
  endScan,
  holdLock,
  recoverStaleLock,
  requestCatchUp,
  trackTab,
  untrackTab,
  type ScanLifecycleState,
} from "./lifecycle.ts";
import {
  badgeFor,
  enabledWatches,
  mergeJobs,
  repeatsPreviousPage,
  sameSearchPage,
  scanPageUrl,
  stampJobs,
  unreadCount,
  withScanToken,
  type ScanNowRequest,
  type ScanNowResponse,
  type ScanRequest,
  type ScanResponse,
  type SetEnabledRequest,
} from "./scan.ts";
import {
  OK_HEALTH,
  NO_FIELD_READS,
  aggregateFieldCounts,
  aggregateOutcome,
  classifyPage,
  reduceFieldHealth,
  reducePushHealth,
  reduceScanHealth,
  shouldRunScan,
  type FieldReadCounts,
  type PageOutcome,
  type PageSignals,
  type Severity,
} from "./health.ts";
import {
  sendAppliedPush,
  sendPush,
  type AppliedPushFailure,
  type AppliedPushRequest,
  type AppliedPushResponse,
} from "./push.ts";
import {
  clearHistory,
  collectGarbage,
  historyCounts,
  historyPhrase,
  removedCounts,
  GC_ALARM_NAME,
  GC_FIRST_RUN_DELAY_MINUTES,
  GC_PERIOD_MINUTES,
  type ClearHistoryRequest,
  type ClearHistoryResponse,
} from "./gc.ts";
import {
  backupCounts,
  backupPhrase,
  reconcileUi,
  restoredSettings,
  type ImportBackupRequest,
  type ImportBackupResponse,
} from "./backup.ts";
import { buildScanNotification, SCAN_NOTIFICATION_ID } from "./notify.ts";
import { focusOrOpenJobsTab } from "./jobs-tab.ts";
import type { HealthState, Job, Settings } from "./types.ts";

/** The single re-armed one-shot alarm (PRD §15 decision 3): one name, re-created
 *  with a fresh `{ when }` at the end of every cycle. The name is `schedule.ts`'s
 *  because the list view reads the same alarm to count down to the next scan. */
const ALARM_NAME = SCAN_ALARM_NAME;

/** The fixed id for the hard-failure health notification (PRD §16.8). Fixed so a
 *  new transition replaces the prior alert rather than stacking one per cycle. */
const HEALTH_NOTIFICATION_ID = "ljw-health";

/** How long to wait for a scan tab to finish loading before messaging it. Loose
 *  because the content script settles the lazy list itself (pollUntilSettled). */
const TAB_LOAD_TIMEOUT_MS = 30_000;

/** Size of the scan window (see {@link scanPageIn}). Deliberately a real,
 *  on-screen size rather than 1×1: LinkedIn renders the results column lazily by
 *  viewport, so a tiny window would paint a handful of rows and stop — the very
 *  failure this window exists to avoid.
 *
 *  The height is the dial to turn for a less obtrusive window; the walk simply
 *  takes a step or two more. The **width is deliberately left at the value the
 *  25-of-25 read was measured at**: LinkedIn switches `/jobs/search/` to a
 *  single-column layout below roughly 1024px, and the selectors this file depends
 *  on have only ever been verified against the two-pane one. Worth shrinking, but
 *  only behind a measurement, not a guess. */
const SCAN_WINDOW = { width: 1000, height: 720 } as const;

/** Gap between the scan window and the edge of the user's browser window, so it
 *  reads as tucked into the corner rather than flush against it. */
const SCAN_WINDOW_MARGIN = 24;

/** Bottom-right corner of wherever the user's browser currently is — which
 *  approximates "the corner of the screen they are working on" without needing
 *  the `system.display` permission just to place a window. Falls back to a fixed
 *  offset if the host window has no bounds (it may be minimised). */
async function scanWindowBounds(): Promise<chrome.windows.CreateData> {
  const { width, height } = SCAN_WINDOW;
  const host = await chrome.windows.getLastFocused().catch(() => undefined);
  if (host?.left === undefined || host.top === undefined || host.width === undefined || host.height === undefined) {
    return { width, height, left: 60, top: 60 };
  }
  return {
    width,
    height,
    left: Math.max(0, host.left + host.width - width - SCAN_WINDOW_MARGIN),
    top: Math.max(0, host.top + host.height - height - SCAN_WINDOW_MARGIN),
  };
}

/** The one window a cycle borrows for all of its pages (see {@link openScanSession}). */
type ScanSession = { windowId: number; tabId: number };

/** Sleep for a drawn pause length — the in-cycle pacing (PRD §9/§15 decision 5).
 *  A plain timer; the *length* is decided by the tested `randomPauseMs`. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Badge ────────────────────────────────────────────────────────────────────

/** Reflect the unread count AND health severity onto the toolbar badge (PRD §7/
 *  §16.8): the number in slate when healthy, amber on a soft warning, a red `!` on
 *  a hard failure. `badgeFor` decides text+colour; this only calls the browser API.
 *  Settings come along for the blocklist — a blocked company's jobs stay on screen
 *  greyed out, but they no longer count towards the badge.
 *
 *  A field break (issue #52) is a separate axis, so it is folded in here rather
 *  than through the passed `severity`: it bumps an otherwise-`ok` badge to amber,
 *  and every caller — a scan cycle, a resume, a GC prune — reflects it without
 *  having to know about it. It never overrides a hard red (a challenge outranks a
 *  dead selector), so it only ever raises `ok` to `warn`. */
async function updateBadge(severity: Severity): Promise<void> {
  const [jobs, settings, fieldHealth] = await Promise.all([
    get("jobs"),
    get("settings"),
    get("fieldHealth"),
  ]);
  const effective: Severity = severity === "ok" && fieldHealth.message !== null ? "warn" : severity;
  const blocked = settings.blockedCompanies.map((b) => b.normalized);
  const { text, color } = badgeFor(
    unreadCount(jobs, blocked, settings.hideReposted),
    effective,
  );
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ── Notification ───────────────────────────────────────────────────────────────

/** Fire the ONE merged desktop notification for a cycle's new jobs (PRD §3/§9).
 *  `buildScanNotification` returns null for an empty batch, so a cycle that found
 *  nothing fires nothing; a non-empty batch is already deduped across every watch,
 *  so this is one notification per cycle, never one per watch. The fixed
 *  `SCAN_NOTIFICATION_ID` means a fresh cycle's notification replaces the prior
 *  one rather than stacking, and lets the click handler recognise ours.
 *
 *  The Options switch is honoured here and only here: turning it off stops the
 *  pop-up, while the badge (fired before this) and the Telegram push (after it)
 *  carry on — the point of the switch is to stop being interrupted, not to stop
 *  being told. Absent in settings written before it existed, which reads as on. */
async function fireNewJobsNotification(settings: Settings, newJobs: Job[]): Promise<void> {
  if (settings.notifyDesktop === false) return;
  const spec = buildScanNotification(newJobs);
  if (!spec) return;
  await chrome.notifications.create(SCAN_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: spec.title,
    message: spec.message,
  });
}

/** Fire ONE desktop notification on the transition INTO a hard failure (PRD
 *  §16.8): logged-out or challenge. `reduceScanHealth` sets `notify` true only on
 *  the tick that enters the state, so this never repeats every cycle, and never
 *  fires for a soft warning (structure-changed / stalled) — those stay badge +
 *  banner only. A fixed id means a fresh transition replaces the prior alert. */
async function fireHealthNotification(health: HealthState): Promise<void> {
  if (!health.notify || !health.message) return;
  await chrome.notifications.create(HEALTH_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: "LinkedIn Job Watcher",
    message: health.message,
  });
}

// ── Telegram push ────────────────────────────────────────────────────────────

/** Deliver the cycle's new jobs to the phone (PRD §8), additive to the desktop
 *  notification, never a replacement. `sendPush` already no-ops when push is
 *  disabled/unconfigured or the batch is empty and never throws — an offline phone
 *  or a wrong chat id can never break the scan or the badge (§8). Only an actually
 *  attempted send moves the §16.7 failure counter, so a cycle that pushes nothing
 *  (disabled, unconfigured, or zero new jobs) leaves `pushHealth` untouched; three
 *  real failures in a row raise the soft warning, and one good send resets it. A
 *  batch over ten jobs goes out as several messages (§8) but still counts once —
 *  the counter tracks cycles that failed to reach the phone, not requests. */
async function firePush(settings: Settings, newJobs: Job[]): Promise<void> {
  const cfg = settings.push;
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId || newJobs.length === 0) return;
  const ok = await sendPush(newJobs, cfg);
  const prior = await get("pushHealth");
  await set(
    "pushHealth",
    reducePushHealth(ok, prior.consecutivePushFailures, settings.pushFailWarnThreshold),
  );
}

/** Send the `[Applied]` message for one job — PRD §8's push, reused for the answer
 *  to "Did you apply for this job?".
 *
 *  The list view has already written the record (`applied`, `appliedAt` and the
 *  note) before it asks for this, so the job is read back from storage rather than
 *  carried in the message, and a failure here costs the message only, never the
 *  application.
 *
 *  The three "didn't even try" cases are told apart and reported, because they need
 *  three different things from the user (see {@link AppliedPushFailure}) — and only
 *  a send that was actually *attempted* moves the §16.7 failure counter, the same
 *  rule `firePush` follows: a push skipped because the toggle is off is not a
 *  failing credential. */
async function fireAppliedPush(jobId: string): Promise<AppliedPushResponse> {
  const [settings, jobs] = await Promise.all([get("settings"), get("jobs")]);
  const job = jobs[jobId];
  if (!job) return { sent: false, reason: "unknown-job" };

  const cfg = settings.push;
  // Credentials first: empty ones in *saved* settings usually mean the Options form
  // was filled in and tested but never saved, which is the more actionable of the
  // two — Send test message reads the live fields and forces the toggle on, so it
  // succeeds in exactly that state.
  if (!cfg.botToken || !cfg.chatId) return { sent: false, reason: "unconfigured" };
  if (!cfg.enabled) return { sent: false, reason: "push-off" };

  const ok = await sendAppliedPush(job, job.applyNotes ?? "", cfg);
  const prior = await get("pushHealth");
  await set(
    "pushHealth",
    reducePushHealth(ok, prior.consecutivePushFailures, settings.pushFailWarnThreshold),
  );
  return ok ? { sent: true } : { sent: false, reason: "refused" };
}

// ── Talking to the scan window ─────────────────────────────────────────────────

/** Resolve `true` once the tab reports `status: "complete"`, or `false` if the
 *  timeout elapses first so a wedged load can't hang the cycle. The content script
 *  runs at document_idle, so "complete" means it is ready to receive the scan
 *  message; a timeout is a genuine load failure (PRD §16.5 — `navError`). */
function waitForTabComplete(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(completed);
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** The result of loading one page: the parsed jobs plus its classified outcome
 *  (PRD §16). The classification is `classifyPage`'s — this wrapper only gathers
 *  the raw signals it needs. */
type PageResult = { jobs: Job[]; outcome: PageOutcome; fieldCounts: FieldReadCounts };

/**
 * Open the one window a cycle reads all of its pages in, tucked into the corner
 * of the user's screen and never focused.
 *
 * **A window, not a background tab.** The original design (PRD §9/§17 decision 2)
 * used `tabs.create({ active: false })` and was never verified — issue #5's
 * question 4, left open. Measured on 2026-07-24 it does not work: Chrome gives a
 * tab you cannot see no animation frames and heavily throttled timers, and
 * LinkedIn's results column needs both to fill in rows. The same page rendered
 * 25 of 25 postings in a visible tab and 7 of 25 in a hidden one, and no amount
 * of scrolling closes that gap — the rows are never painted to be read. So the
 * scan window must genuinely be on screen for as long as it lives.
 *
 * Given that it must be seen, it is made as small a thing to see as possible:
 * one window per *cycle* rather than per page, so a nine-page cycle interrupts
 * the user once instead of nine times.
 *
 * Returns null if the window could not be created; the caller reports that as
 * `load-failed` rather than as an empty search.
 */
async function openScanSession(): Promise<ScanSession | null> {
  const win = await chrome.windows
    .create({ url: "about:blank", type: "popup", focused: false, ...(await scanWindowBounds()) })
    .catch(() => undefined);
  const windowId = win?.id;
  const tabId = win?.tabs?.[0]?.id;
  if (windowId === undefined || tabId === undefined) return null;
  // Record the tab before any async work so a mid-cycle teardown can sweep it
  // (lifecycle.recoverStaleLock); untracked when the session closes.
  await set("scanState", trackTab(await get("scanState"), tabId));
  return { windowId, tabId };
}

/** Close the cycle's window. Removes the *window*, not the tab: closing the tab
 *  would leave an empty popup frame on screen, which is precisely what must never
 *  outlive a scan. */
async function closeScanSession(session: ScanSession): Promise<void> {
  await chrome.windows.remove(session.windowId).catch(() => {});
  await set("scanState", untrackTab(await get("scanState"), session.tabId));
}

/** Navigate the cycle's window to `url`, let the content script walk and parse it,
 *  and return the jobs with the page's classified {@link PageOutcome} (PRD §16). A
 *  fresh one-time token is minted per load and stamped onto the URL fragment; the
 *  same token rides the LJW_SCAN message, and the content script reads nothing
 *  unless the two match (PRD §9) — so a LinkedIn tab the user opened by hand,
 *  which carries no token, is never scraped.
 *
 *  `focused` is normally false, so the window is simply there without taking
 *  keyboard focus. It escalates to true only on a retry (see {@link runCycle}),
 *  because Chrome also throttles a window it considers *fully occluded* — one
 *  sitting silently behind everything else is, to the compositor, no better than a
 *  hidden tab. Borrowed focus is always handed back in the `finally`.
 *
 *  The classification is `classifyPage`'s (§16 structural consequence — no
 *  decision logic here): a page that never finishes loading is a `navError`
 *  (`load-failed`); one that lands on `/authwall` or `/checkpoint` is read from its
 *  final URL even when the content script's token gate refuses the redirected page. */
async function scanPageIn(session: ScanSession, url: string, focused: boolean): Promise<PageResult> {
  const token = crypto.randomUUID();
  const target = withScanToken(url, token);
  // Captured before focus moves, so it can be returned to whatever the user was
  // actually working in rather than to whichever window Chrome picks.
  const previous = focused ? await chrome.windows.getLastFocused().catch(() => undefined) : undefined;
  if (focused) await chrome.windows.update(session.windowId, { focused: true }).catch(() => {});

  try {
    const before = (await chrome.tabs.get(session.tabId).catch(() => undefined))?.url ?? "";
    // Listen before navigating: `tabs.update` starts the load immediately, and a
    // listener attached afterwards can miss the `complete` it is waiting for.
    const loading = waitForTabComplete(session.tabId);
    await chrome.tabs.update(session.tabId, { url: target });
    // Retrying the same page mints a fresh token, so the new URL differs from the
    // current one *only in its fragment* — which the browser treats as a
    // same-document navigation. The document is never rebuilt, the content script
    // is never re-injected, and it answers with the token from the previous load,
    // so the read is refused. Force a real load in exactly that case, and only
    // there: reloading a genuinely different URL would fetch the page twice.
    if (sameSearchPage(before, target)) await chrome.tabs.reload(session.tabId).catch(() => {});
    const completed = await loading;
    const landed = await chrome.tabs.get(session.tabId).catch(() => undefined);
    const finalUrl = landed?.url ?? url;
    const tabId = session.tabId;

    // Try to read the page's own signals; a token-gated redirect (e.g. to
    // /authwall) may refuse to answer, in which case we classify from the URL.
    let jobs: Job[] = [];
    let hasResultsList = false;
    let cardCount = 0;
    let savedCount = 0;
    let slotCount = 0;
    let settled = false;
    let fieldCounts: FieldReadCounts = NO_FIELD_READS;
    // Whether the page answered at all. Without this, "the content script never
    // replied" and "the page replied that it holds no job list" both arrive as a
    // row of zeros and get diagnosed as the same fault, which they are not.
    let reachable = false;
    try {
      const req: ScanRequest = { type: "LJW_SCAN", token };
      const res = (await chrome.tabs.sendMessage(tabId, req)) as ScanResponse | undefined;
      if (res) {
        reachable = true;
        jobs = res.jobs;
        hasResultsList = res.hasResultsList;
        cardCount = res.cardCount;
        savedCount = res.savedCount;
        slotCount = res.slotCount;
        settled = res.settled;
        fieldCounts = res.fieldCounts;
      }
    } catch {
      // content script unreachable — the URL-based signals below still classify it
    }

    const signals: PageSignals = {
      // Only a tab that never finished loading is a true infra failure. A completed
      // tab we couldn't message (a token-gated authwall/checkpoint redirect) is
      // classified from its landing URL, not counted as `load-failed`.
      navError: !completed,
      finalUrl,
      hasResultsList,
      cardCount,
      savedCount,
      slotCount,
      settled,
      fieldCounts,
    };
    const outcome = classifyPage(signals);
    // Logged for EVERY page, not just failures, and attributed to its URL while
    // that is still known — the cycle folds every watch into one health state, so
    // by the time anything is surfaced to the user it can only say "a page".
    //
    // `first` is the first posting id the page yielded, and it is here to answer a
    // question the health state cannot: whether `&start=` still paginates. If two
    // pages of the same watch report the same `first`, LinkedIn served the same
    // results twice and everything past the first page is unreachable — which
    // looks identical to a healthy scan from every other signal.
    const line =
      `[ljw] ${outcome} — ${url}\n` +
      `      ${savedCount} saved / ${cardCount} rendered / ${slotCount} slots, ` +
      `settled=${settled}, first=${jobs[0]?.id ?? "none"}\n` +
      `      page answered=${reachable}, results list present=${hasResultsList}, ` +
      `landed on ${sameSearchPage(finalUrl, url) ? "the requested URL" : finalUrl}`;
    if (outcome === "ok") console.log(line);
    else console.warn(line);
    return { jobs, outcome, fieldCounts };
  } finally {
    // The window outlives the page — it is the cycle's, not this call's — so only
    // the borrowed focus is given back here. `closeScanSession` owns the window.
    if (previous?.id !== undefined) {
      await chrome.windows.update(previous.id, { focused: true }).catch(() => {});
    }
  }
}

// ── The cycle ──────────────────────────────────────────────────────────────────

function filterRulesOf(settings: Settings): FilterRules {
  return {
    blockedCompanies: settings.blockedCompanies.map((b) => b.normalized),
    blockedTitleKeywords: settings.blockedTitleKeywords,
    hideReposted: settings.hideReposted,
  };
}

/** Run one full scan cycle: every enabled watch, in saved order, `pages` deep,
 *  into storage. Watches run strictly one after another — never in parallel
 *  (PRD §3) — with a randomised pause between pages and a longer one between
 *  watches (PRD §9/§15 decision 5) so the traffic doesn't beat a fixed heartbeat.
 *  Every watch's results are collected and merged into ONE batch before a single
 *  dedupe (PRD §5), so a role surfacing under two searches notifies only once. The
 *  keepalive interval (PRD §17 decision 1) runs for the whole cycle and is cleared
 *  in the `finally`. */
async function runCycle(settings: Settings, pages: number): Promise<void> {
  const keepalive = setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, KEEPALIVE_PING_MS);

  try {
    const watches = enabledWatches(settings.watches);
    const found: Job[] = [];
    const outcomes: PageOutcome[] = [];
    // Per-page field-read counts, summed at the end for the separate field-break
    // axis (issue #52). Collected alongside `outcomes` — one entry per page read.
    const fieldCountsList: FieldReadCounts[] = [];
    // Logged up front so the per-page lines below can be read as a complete set:
    // without it, a console attached partway through a cycle looks identical to a
    // cycle that only ever scanned one page.
    console.log(
      `[ljw] cycle start — ${watches.length} of ${settings.watches.length} watches, ` +
        `${pages} page(s) each`,
    );
    // ONE window for the whole cycle, navigated from page to page, rather than a
    // fresh one per page: a single window tucked in the corner for a minute is far
    // less disruptive than nine that each appear and vanish. Opened only if there
    // is actually something to scan, and always closed in the `finally` below.
    const session = watches.length > 0 ? await openScanSession() : null;
    try {
      for (const [w, watch] of watches.entries()) {
        // The first posting id of the page just read, for the pagination guard
        // below. Reset per watch — a repeat only means anything within one search.
        let previousFirstId: string | null = null;
        for (let page = 1; page <= pages; page++) {
          const pageUrl = scanPageUrl(watch.url, page);
          // No window means no read at all; report it as the infra failure it is
          // rather than as an empty search, which would trip the back-off.
          let { jobs, outcome, fieldCounts } = session
            ? await scanPageIn(session, pageUrl, false)
            : { jobs: [] as Job[], outcome: "load-failed" as PageOutcome, fieldCounts: NO_FIELD_READS };
          // A load failure retries the page once, then skips it and continues the
          // cycle (PRD §16.5). The retry is infra, not a parser signal, so a
          // persistent `load-failed` is recorded as such — `reduceScanHealth` leaves
          // the empty-scan back-off counter untouched for it.
          if (session && outcome === "load-failed") {
            await sleep(randomPauseMs(settings.pacing.pagePauseMs));
            ({ jobs, outcome, fieldCounts } = await scanPageIn(session, pageUrl, false));
          }
          // A partial read means the window was on screen but Chrome never painted
          // it — the occluded-window case, which it throttles exactly like a hidden
          // tab. Retrying *with* focus makes it unambiguously visible. This is the
          // only point at which the scan takes focus, it only happens when the quiet
          // attempt already failed, and the focus is handed straight back after.
          if (session && outcome === "partial") {
            await sleep(randomPauseMs(settings.pacing.pagePauseMs));
            ({ jobs, outcome, fieldCounts } = await scanPageIn(session, pageUrl, true));
          }
          // In-cycle pagination guard (issue #30 item 2). A page whose first id
          // repeats the previous page's is `&start=` no longer paginating — the
          // list has gone append-only and this page re-served page 1. Dedupe would
          // collapse the repeat silently and the miss would read as a healthy scan,
          // so it is logged here, where the two pages are still distinguishable.
          const firstId = jobs[0]?.id ?? null;
          if (repeatsPreviousPage(firstId, previousFirstId)) {
            console.warn(
              `[ljw] pagination stall — ${watch.url}\n` +
                `      page ${page} first id (${firstId}) repeats page ${page - 1}'s; ` +
                `&start= may no longer paginate, so results past page 1 are unreachable (issue #30)`,
            );
          }
          previousFirstId = firstId;
          found.push(...stampJobs(jobs, watch.id, Date.now()));
          outcomes.push(outcome);
          fieldCountsList.push(fieldCounts);
          if (page < pages) await sleep(randomPauseMs(settings.pacing.pagePauseMs));
        }
        if (w < watches.length - 1) await sleep(randomPauseMs(settings.pacing.watchPauseMs));
      }
    } finally {
      if (session) await closeScanSession(session);
    }

    // Merge-before-dedupe (PRD §5): one dedupe over every watch's results so a
    // cross-watch duplicate id collapses to a single new job.
    const { newJobs, seen } = dedupe(found, await get("seen"), filterRulesOf(settings), Date.now());
    // The cycle's own arithmetic, so a miss can be located: how many postings were
    // read across every page, how many of those were distinct, and how many
    // survived. `distinct` well below `read` means the pages overlapped — the same
    // results served more than once — rather than the search being quiet.
    const distinct = new Set(found.map((j) => j.id)).size;
    console.log(
      `[ljw] cycle done — ${found.length} read, ${distinct} distinct, ` +
        `${newJobs.length} new after dedupe+filters`,
    );
    await set("seen", seen);
    if (newJobs.length > 0) {
      await set("jobs", mergeJobs(await get("jobs"), newJobs));
    }

    // Fold the cycle's per-page outcomes into the one HealthState (PRD §16). The
    // worst page decides the cycle (aggregateOutcome); the reducer owns pause/halt,
    // the empty-scan counter, the banner text, and whether this transition fires a
    // desktop notification. No classification logic lives here (§16 structural AC).
    const health = reduceScanHealth(
      await get("health"),
      aggregateOutcome(outcomes),
      settings.backoff,
    );
    await set("health", health);

    // Field-break guard (PRD §16.4, issue #52): the SEPARATE axis from PageOutcome.
    // Sum the cycle's per-page counts and fold them into their own `fieldHealth`
    // state — a page can be `ok` on every count above and still have a dead
    // selector, so this is decided apart from `health` and never ranked against it.
    // The reducer skips a below-floor sample and fires only at total absence.
    const fieldHealth = reduceFieldHealth(
      await get("fieldHealth"),
      aggregateFieldCounts(fieldCountsList),
    );
    await set("fieldHealth", fieldHealth);
    if (fieldHealth.message) console.warn(`[ljw] ${fieldHealth.message}`);

    // Badge reflects the worse of scan health and a field break (issue #52):
    // `updateBadge` reads `fieldHealth` itself, so a break shows amber even when
    // the page otherwise read `ok`, and every other badge caller stays in step.
    await updateBadge(health.severity);
    // One merged notification for the whole cycle's new jobs (PRD §3/§9), then the
    // hard-failure health alert if this cycle transitioned into one (§16.8). Both
    // fired after the badge so the surfaces agree.
    await fireNewJobsNotification(settings, newJobs);
    await fireHealthNotification(health);
    // Additive Telegram push (PRD §8), after the badge and desktop notification so
    // its failure — swallowed by sendPush — can never affect either.
    await firePush(settings, newJobs);
  } finally {
    clearInterval(keepalive);
  }
}

/** Compute and arm the next one-shot alarm (PRD §15 decision 3). `nextScanDelayMs`
 *  owns jitter, back-off and the quiet-hours jump; this only creates the alarm.
 *
 *  Every route that arms goes through here — the alarm tick's re-arm, the manual
 *  "Scan now", and `ensureAlarmExists` on install and startup — which is why the
 *  manual-only switch is enforced in this one place rather than at each caller. */
async function armNextAlarm(settings: Settings): Promise<void> {
  // "Only scan when I press Scan now" (§ manual-only): there is no cadence to arm.
  // It *clears* rather than simply returning so an alarm armed before the switch
  // was turned on can't survive to fire; the alarm is also what every countdown
  // in the UI reads, so leaving one would promise a scan that will never run.
  if (settings.manualOnly === true) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const health = await get("health");
  const { delayMs, willResumeFromQuiet } = nextScanDelayMs({
    now: new Date(),
    baseIntervalMinutes: settings.intervalMinutes,
    jitterMinutes: settings.jitterMinutes,
    consecutiveEmptyScans: health.consecutiveEmptyScans,
    quietHours: settings.quietHours,
    backoff: settings.backoff,
  });
  if (willResumeFromQuiet) {
    // Waking after a quiet window is the same as waking after a restart (PRD §9):
    // the next scan runs deep. requestCatchUp only sets the flag; beginScan reads it.
    await set("scanState", requestCatchUp(await get("scanState")));
  }
  await chrome.alarms.create(ALARM_NAME, { when: Date.now() + delayMs });
}

/** Re-arm the one-shot alarm only if none survived (PRD §17 decision 5, §15
 *  decision 3). Idempotent: a `chrome.alarms` entry that outlived the worker —
 *  including a *missed* alarm Chrome will replay on relaunch — is left untouched,
 *  so a Chrome restart runs the catch-up scan exactly once, never twice. Both the
 *  fresh install and the startup handler go through here. */
async function ensureAlarmExists(settings: Settings): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) await armNextAlarm(settings);
}

/**
 * Make the alarm agree with the settings as they now stand — the reconciliation
 * every surface that *writes* settings relies on, since only the worker can touch
 * `chrome.alarms`.
 *
 * The Options page saves and says nothing to the worker, so without this the two
 * manual-only transitions both end badly. Turning it ON would leave the armed
 * alarm ticking down in the footer until it fired and tidied itself away; turning
 * it OFF would leave *no* alarm at all and nothing to re-arm one — the cadence
 * would be silently gone until the next Chrome restart or manual scan.
 */
async function syncAlarmToSettings(settings: Settings): Promise<void> {
  if (settings.enabled === false || settings.manualOnly === true) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  await ensureAlarmExists(settings);
}

/** Take the scan lock and persist it, returning this cycle's page depth (PRD §17
 *  decisions 4+5 — `beginScan` consumes the catch-up flag). Split from
 *  {@link runLockedCycle} so the manual "Scan now" can reply to the popup the
 *  moment the lock is *visible in storage*, while the cycle itself runs on. The
 *  caller must already have recovered a stale lock and confirmed nothing holds it. */
async function takeScanLock(settings: Settings, state: ScanLifecycleState): Promise<number> {
  const { pages, state: locked } = beginScan(
    state,
    Date.now(),
    settings.catchUpPages,
    settings.pagesPerScan,
  );
  await set("scanState", locked);
  return pages;
}

/** Run the cycle the lock was taken for, then always release the lock and — for
 *  the alarm path — re-arm the cadence, so a routine tick resets the next one to
 *  a full interval from now rather than leaving two scans stacked minutes apart.
 *  The manual "Scan now" passes `rearm: false`: it arms the alarm up front, from
 *  the click, so the countdown resets the instant the button is pressed instead
 *  of a minute later when the cycle ends (and a crash mid-cycle can't strand the
 *  cadence on the old, already-passed alarm). */
async function runLockedCycle(settings: Settings, pages: number, rearm = true): Promise<void> {
  try {
    await runCycle(settings, pages);
  } finally {
    await set("scanState", endScan(await get("scanState")));
    if (rearm) await armNextAlarm(settings);
  }
}

/**
 * The header's "Scan now" button (PRD §9): run a cycle immediately instead of
 * waiting out the interval, jitter and quiet hours the alarm honours.
 *
 * It also doubles as the manual resume §16.2 waits for. A `halted` health state
 * only clears on an `ok` scan, but `shouldRunScan` stops every scan while halted
 * — so nothing else can break that deadlock. The halt is cleared *before* the
 * cycle, not after, so `reduceScanHealth` simply halts it again if the challenge
 * is still there.
 */
async function runScanNow(): Promise<ScanNowResponse> {
  const settings = await get("settings");

  // The master switch is off (§ master): the header hides "Scan now" while off,
  // so this only guards a race — a click that raced the toggle. Nothing starts.
  if (settings.enabled === false) return { started: false, reason: "disabled" };

  // Same first step as an alarm tick: a lock a torn-down cycle left stuck must
  // not make the button silently do nothing (§16.6/§17.2).
  const recovered = recoverStaleLock(await get("scanState"), Date.now(), settings.staleLockMs);
  await Promise.all(recovered.tabIdsToClose.map((id) => chrome.tabs.remove(id).catch(() => {})));
  if (recovered.state.isScanning) return { started: false, reason: "already-scanning" };

  if ((await get("health")).mode === "halted") await set("health", { ...OK_HEALTH });

  const pages = await takeScanLock(settings, recovered.state);
  // Re-arm the cadence from *now* — the click — so the next automatic scan is a
  // full interval after this manual one, and the footer's countdown resets the
  // moment the button is pressed rather than when the ~minute-long cycle ends.
  // runLockedCycle therefore runs with `rearm: false`; arming here, before the
  // cycle, is why it must not arm again after. Under the manual-only switch this
  // arms nothing (armNextAlarm returns early) — the whole point of that switch is
  // that a press buys one round, not a round plus a new schedule.
  await armNextAlarm(settings);
  // Deliberately not awaited: the reply goes back now so the popup repaints as
  // "Scanning…" instead of hanging for the 60–90s the cycle takes. The keepalive
  // inside runCycle (§17 decision 1) is what keeps the worker alive meanwhile.
  void runLockedCycle(settings, pages, false);
  return { started: true };
}

/** The alarm handler — the whole cadence in one place (PRD §9). */
async function onAlarm(): Promise<void> {
  const settings = await get("settings");

  // The master switch is off (§ master): stop the loop and clear the alarm so a
  // sleeping worker isn't woken every interval for nothing. Self-healing — if a
  // toggle-off missed the worker, the next tick tidies up the stray alarm here.
  // Turning it back on re-arms via the LJW_SET_ENABLED handler below.
  // The manual-only switch lands here the same way and for the same reason: an
  // alarm armed before it was turned on must not run a round the user has said
  // they want to trigger themselves (§ manual-only).
  if (settings.enabled === false || settings.manualOnly === true) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  // Every tick, before anything else: clear a lock the previous (torn-down) cycle
  // left stuck and sweep the tabs it orphaned (PRD §16.6/§17.2).
  const recovered = recoverStaleLock(await get("scanState"), Date.now(), settings.staleLockMs);
  await Promise.all(recovered.tabIdsToClose.map((id) => chrome.tabs.remove(id).catch(() => {})));

  // A cycle already holds the lock — skip this tick and return (PRD §9). Still
  // re-arm so the cadence survives even if that cycle later dies.
  if (recovered.state.isScanning) {
    await armNextAlarm(settings);
    return;
  }

  // A challenge halted scanning (PRD §16.2): don't scan until the user manually
  // resumes. A logged-out `pause` keeps scanning (shouldRunScan true) precisely so
  // a later `ok` scan auto-resumes it (§16.1). Keep the alarm armed either way so
  // the cadence structure survives a resume.
  if (!shouldRunScan((await get("health")).mode)) {
    await armNextAlarm(settings);
    return;
  }

  await runLockedCycle(settings, await takeScanLock(settings, recovered.state));
}

// ── Garbage collection ─────────────────────────────────────────────────────────

/**
 * The daily prune (PRD §7): job records past their lifetime and seen ids past
 * theirs, dropped on the collector's own alarm.
 *
 * No decision here either — `collectGarbage` owns both lifetimes and the
 * hard-cap backstop, `removedCounts` says what that came to. This only reads the
 * three keys, writes back the ones that actually changed, and says so.
 *
 * It runs whatever the master switch says. Switching scanning off stops the
 * extension *doing* things; it does not freeze the clock, and a job found six
 * weeks ago is equally stale whether or not anything has scanned since.
 */
async function runGarbageCollection(): Promise<void> {
  const settings = await get("settings");

  // Never against a live cycle (§7 "never on the scan path"). A cycle reads
  // `seen` and writes it back at its end; a prune landing between those two is
  // either overwritten by the cycle — harmless, tomorrow collects again — or
  // overwrites the ids the cycle just recorded, which would re-announce every job
  // it had just found. The window is short, but a daily run will find it.
  //
  // Read through `recoverStaleLock` rather than off the raw flag, exactly as the
  // two scan paths do: a worker torn down mid-cycle leaves `isScanning` true
  // forever, and a collector that trusted it would then skip every single day —
  // silently, and worst of all under the master switch, where no scan tick ever
  // comes to clear the lock. Recovery here is read-only: releasing the lock and
  // sweeping the tabs it orphaned belongs to the scan paths, not to this one.
  const recovered = recoverStaleLock(await get("scanState"), Date.now(), settings.staleLockMs);
  if (recovered.state.isScanning) {
    console.log("[ljw] gc skipped — a scan holds the lock; the next daily tick collects");
    return;
  }

  const before = {
    seen: await get("seen"),
    jobs: await get("jobs"),
    retention: settings.retention,
  };
  const after = collectGarbage(before, Date.now());
  const removed = removedCounts(before, after);
  const kept = historyPhrase(historyCounts(after.seen, after.jobs));

  // §6 has no partial updates: writing a key re-serialises the whole map. So a
  // key nothing aged out of is not written at all, and a run with nothing to do
  // costs three reads.
  if (removed.jobs === 0 && removed.seen === 0) {
    console.log(`[ljw] gc — nothing to prune; ${kept} kept`);
    return;
  }
  if (removed.seen > 0) await set("seen", after.seen);
  if (removed.jobs > 0) await set("jobs", after.jobs);
  console.log(`[ljw] gc — pruned ${historyPhrase(removed)}; ${kept} kept`);

  // Dropped records can take unread jobs with them, and nothing else would
  // notice until the next cycle — so the toolbar count is brought back in line
  // here, at the severity the current health already stands at.
  if (removed.jobs > 0) await updateBadge((await get("health")).severity);
}

/**
 * "Delete all job history" (PRD §7): empty `jobs` and `seen` outright, on the
 * options page's asking.
 *
 * It runs here rather than in the page because of the lock. A cycle reads `seen`,
 * dedupes against it and writes it back at its end; a delete landing inside that
 * makes every job the cycle just found new again, so it would write the records
 * straight back and announce them — the exact opposite of what the button was
 * pressed for. Holding the lock for the length of the delete is what makes that
 * impossible, and only the worker can hold it.
 *
 * The lock is read through `recoverStaleLock` for the same reason the collector
 * does, and `holdLock` keeps it — not `beginScan`, which would consume a pending
 * catch-up this is not.
 *
 * What actually goes is `clearHistory`'s decision, not this wrapper's.
 */
async function clearAllHistory(): Promise<ClearHistoryResponse> {
  const settings = await get("settings");
  const recovered = recoverStaleLock(await get("scanState"), Date.now(), settings.staleLockMs);
  if (recovered.state.isScanning) return { cleared: false, reason: "scanning" };
  await set("scanState", holdLock(recovered.state, Date.now()));

  try {
    const [seen, jobs, ui] = await Promise.all([get("seen"), get("jobs"), get("ui")]);
    const removed = historyCounts(seen, jobs);
    const cleared = clearHistory(ui);
    await set("seen", cleared.seen);
    await set("jobs", cleared.jobs);
    await set("ui", cleared.ui);
    console.log(`[ljw] history deleted — ${historyPhrase(removed)} removed`);
    // Nothing is unread when nothing is stored; the colour still belongs to the
    // health this has not changed.
    await updateBadge((await get("health")).severity);
    return { cleared: true, removed };
  } finally {
    await set("scanState", endScan(await get("scanState")));
  }
}

/**
 * Restore a backup file (the Backup section of the options page): the file's
 * settings, seen ids and job records become the stored ones.
 *
 * It runs here rather than in the page for the reason `clearAllHistory` does — an
 * import writes `seen` and `jobs`, the scan lock is what serialises those two
 * keys, and only the worker holds it. Without the lock an import can land inside
 * a cycle's read-dedupe-write tail, which would overwrite the imported ids with
 * the cycle's and quietly re-announce every restored posting. Same stale-lock
 * recovery as the collector, and `holdLock` rather than `beginScan` so a pending
 * catch-up this is not survives.
 *
 * The file has already been validated on the page (`parseBackup`), so by the time
 * it arrives here it is known to be well-formed; what is left is the two things
 * only this side knows. `restoredSettings` carries this browser's Telegram
 * credentials through — they are never in a file — and `reconcileUi` un-points
 * the view state from a watch or job the import removed.
 *
 * Writing `settings` is what re-arms the cadence: the `storage.onChanged`
 * listener below reconciles the alarm to whatever was just written, so a backup
 * carrying `manualOnly` or a different interval takes effect without this having
 * to know about alarms at all.
 */
async function importBackup(backup: ImportBackupRequest["backup"]): Promise<ImportBackupResponse> {
  const current = await get("settings");
  const recovered = recoverStaleLock(await get("scanState"), Date.now(), current.staleLockMs);
  if (recovered.state.isScanning) return { imported: false, reason: "scanning" };
  await set("scanState", holdLock(recovered.state, Date.now()));

  try {
    const settings = restoredSettings(backup.settings, current);
    const ui = reconcileUi(await get("ui"), backup.jobs, settings.watches);
    // `seen` and `jobs` before `settings`: the settings write is what wakes the
    // alarm reconciler, and it should find the restored history already in place.
    await set("seen", backup.seen);
    await set("jobs", backup.jobs);
    await set("ui", ui);
    await set("settings", settings);

    const counts = backupCounts(backup);
    console.log(`[ljw] backup imported — ${backupPhrase(counts)}`);
    // The restored records carry their own read/unread state, so the count on the
    // toolbar is almost certainly not the one that was there a moment ago. The
    // colour still belongs to the health this has not changed.
    await updateBadge((await get("health")).severity);
    return { imported: true, counts };
  } finally {
    await set("scanState", endScan(await get("scanState")));
  }
}

/** Make sure the daily collector alarm exists (PRD §7). Idempotent, and called
 *  from both install and startup: a periodic alarm survives the worker being
 *  torn down, so re-creating one that is already ticking would only push its
 *  next run a fresh day out — on a browser restarted daily, that is a collector
 *  that never runs. */
async function ensureGcAlarm(): Promise<void> {
  if (await chrome.alarms.get(GC_ALARM_NAME)) return;
  await chrome.alarms.create(GC_ALARM_NAME, {
    delayInMinutes: GC_FIRST_RUN_DELAY_MINUTES,
    periodInMinutes: GC_PERIOD_MINUTES,
  });
}

// ── Wiring ─────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void onAlarm();
  else if (alarm.name === GC_ALARM_NAME) void runGarbageCollection();
});

/** Settings were saved somewhere — the Options page, most of the time — so bring
 *  the alarm back in line with them (see {@link syncAlarmToSettings}). Listening
 *  to storage rather than adding a message the Options page must remember to send
 *  means every present and future writer is covered by the one listener, and a
 *  save that changed nothing about the cadence costs an idempotent check. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("settings" in changes)) return;
  void (async () => {
    try {
      await syncAlarmToSettings(await get("settings"));
    } catch (err) {
      console.error("[ljw] Alarm sync failed:", err);
    }
  })();
});

/** The popup / jobs tab asking for a scan right now. Returning `true` keeps the
 *  message channel open for the async reply; the reply lands as soon as the lock
 *  is resolved, not when the cycle ends. Other message types are ignored (the
 *  content script is messaged the other way round, via `chrome.tabs.sendMessage`). */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as ScanNowRequest | undefined)?.type !== "LJW_SCAN_NOW") return;
  // Always answer, even on failure: a rejected runScanNow that never called
  // sendResponse would leave the channel to close empty, which the popup can only
  // read as a dead worker. Reply `{ started: false }` and log the real cause so
  // the service-worker console names it instead of the popup guessing.
  runScanNow().then(sendResponse, (err) => {
    console.error("[ljw] Scan now failed:", err);
    sendResponse({ started: false });
  });
  return true;
});

/** The header's master on/off toggle (§ master). The UI has already written
 *  `settings.enabled`; this only reconciles the *alarm*, which only the worker
 *  can touch: arm the cadence when turned on, clear it when turned off. Reads the
 *  desired state from the message rather than storage so a storage write still in
 *  flight can't make it arm the wrong way. Keeping the channel open (`return true`)
 *  lets the popup await the ack before it trusts the switch settled. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const req = message as SetEnabledRequest | undefined;
  if (req?.type !== "LJW_SET_ENABLED") return;
  void (async () => {
    try {
      if (req.enabled) await ensureAlarmExists(await get("settings"));
      else await chrome.alarms.clear(ALARM_NAME);
      sendResponse({ ok: true });
    } catch (err) {
      console.error("[ljw] Toggle failed:", err);
      sendResponse({ ok: false });
    }
  })();
  return true;
});

/** The list view answering "Yes" to "Did you apply for this job?". The send lives
 *  here rather than in the page because the popup is destroyed the moment it loses
 *  focus, which would cut off a request in flight — and because the §16.7 push
 *  counter is the worker's. The reply is honest either way, so a `sent: false` (push
 *  off, unconfigured, or refused) shows up as a line in the view instead of a
 *  message that quietly never arrives. Channel kept open for the async reply, as above. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const req = message as AppliedPushRequest | undefined;
  if (req?.type !== "LJW_APPLIED") return;
  fireAppliedPush(req.jobId).then(sendResponse, (err) => {
    console.error("[ljw] Applied push failed:", err);
    sendResponse({ sent: false } satisfies AppliedPushResponse);
  });
  return true;
});

/** The options page's "Delete all job history" (PRD §7). Handled here because the
 *  delete has to hold the scan lock — see {@link clearAllHistory} — and only the
 *  worker holds it. Channel kept open for the async reply, as above; a failure is
 *  answered rather than left silent, so the page can say nothing was deleted
 *  instead of appearing to hang. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as ClearHistoryRequest | undefined)?.type !== "LJW_CLEAR_HISTORY") return;
  clearAllHistory().then(sendResponse, (err) => {
    console.error("[ljw] Delete history failed:", err);
    sendResponse({ cleared: false, reason: "failed" } satisfies ClearHistoryResponse);
  });
  return true;
});

/** The options page's "Import a backup" (see {@link importBackup}). Handled here
 *  for the same reason the delete is: the import writes `seen` and `jobs`, and
 *  only the worker can hold the scan lock that serialises them. The file arrives
 *  already validated. Channel kept open for the async reply, as above; a failure
 *  is answered rather than left silent, so the page can say nothing was imported
 *  instead of appearing to hang. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const req = message as ImportBackupRequest | undefined;
  if (req?.type !== "LJW_IMPORT") return;
  importBackup(req.backup).then(sendResponse, (err) => {
    console.error("[ljw] Import failed:", err);
    sendResponse({ imported: false, reason: "failed" } satisfies ImportBackupResponse);
  });
  return true;
});

/** Notification click (PRD §3/§9): open our own list, never LinkedIn, and clear
 *  the notification. Marks nothing as opened. `openPopup()` can't be triggered
 *  from a click, so this opens the full jobs.html tab (the list component is
 *  shared with the popup, so it costs nothing). */
chrome.notifications.onClicked.addListener((id) => {
  if (id !== SCAN_NOTIFICATION_ID) return;
  void (async () => {
    await focusOrOpenJobsTab();
    await chrome.notifications.clear(id);
  })();
});

/** Fresh install: arm the first alarm so the loop starts (idempotent — an
 *  already-armed alarm from a prior version is left as-is). */
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const settings = await get("settings");
    // Never against the master switch (§ master): an upgrade of an install the
    // user had turned off must stay off rather than silently arm a fresh alarm.
    if (settings.enabled !== false) await ensureAlarmExists(settings);
    // The collector's alarm is armed either way — an install carrying records
    // from a prior version needs pruning whether or not scanning is on.
    await ensureGcAlarm();
  })();
});

/** Browser relaunch (PRD §9 "Browser startup"): recover any stuck lock, request a
 *  catch-up-depth scan, and make sure the one-shot alarm exists. No inline scan —
 *  the replayed-or-armed alarm runs it exactly once (PRD §17 decision 5). */
chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const settings = await get("settings");
    const recovered = recoverStaleLock(await get("scanState"), Date.now(), settings.staleLockMs);
    await Promise.all(recovered.tabIdsToClose.map((id) => chrome.tabs.remove(id).catch(() => {})));
    await set("scanState", requestCatchUp(recovered.state));
    // Honour the master switch across a relaunch (§ master): a browser the user
    // left with scanning off comes back up off, no alarm armed.
    if (settings.enabled !== false) await ensureAlarmExists(settings);
    await ensureGcAlarm();
  })();
});
