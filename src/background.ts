// Background service worker (MV3) — the scan loop's side-effect wrapper (PRD §9 /
// §15 / §17). This ticket (04, issue #15) turns the prefactor entry into the
// first real scan: an alarm fires, an invisible tab opens on one watch's URL, the
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
import { nextScanDelayMs, randomPauseMs } from "./schedule.ts";
import {
  KEEPALIVE_PING_MS,
  beginScan,
  endScan,
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
  scanPageUrl,
  stampJobs,
  unreadCount,
  withScanToken,
  type ScanNowRequest,
  type ScanNowResponse,
  type ScanRequest,
  type ScanResponse,
} from "./scan.ts";
import {
  OK_HEALTH,
  aggregateOutcome,
  classifyPage,
  fieldMissingAcrossAll,
  reducePushHealth,
  reduceScanHealth,
  shouldRunScan,
  type PageOutcome,
  type PageSignals,
  type Severity,
} from "./health.ts";
import { sendPush } from "./push.ts";
import { buildScanNotification, jobsTabToFocus, SCAN_NOTIFICATION_ID } from "./notify.ts";
import type { HealthState, Job, Settings } from "./types.ts";

/** The single re-armed one-shot alarm (PRD §15 decision 3). One name, re-created
 *  with a fresh `{ when }` at the end of every cycle. */
const ALARM_NAME = "ljw-scan";

/** The fixed id for the hard-failure health notification (PRD §16.8). Fixed so a
 *  new transition replaces the prior alert rather than stacking one per cycle. */
const HEALTH_NOTIFICATION_ID = "ljw-health";

/** How long to wait for a scan tab to finish loading before messaging it. Loose
 *  because the content script settles the lazy list itself (pollUntilSettled). */
const TAB_LOAD_TIMEOUT_MS = 30_000;

/** Sleep for a drawn pause length — the in-cycle pacing (PRD §9/§15 decision 5).
 *  A plain timer; the *length* is decided by the tested `randomPauseMs`. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Badge ────────────────────────────────────────────────────────────────────

/** Reflect the unread count AND health severity onto the toolbar badge (PRD §7/
 *  §16.8): the number in slate when healthy, amber on a soft warning, a red `!` on
 *  a hard failure. `badgeFor` decides text+colour; this only calls the browser API.
 *  Settings come along for the blocklist — a blocked company's jobs stay on screen
 *  greyed out, but they no longer count towards the badge. */
async function updateBadge(severity: Severity): Promise<void> {
  const [jobs, settings] = await Promise.all([get("jobs"), get("settings")]);
  const blocked = settings.blockedCompanies.map((b) => b.normalized);
  const { text, color } = badgeFor(unreadCount(jobs, blocked), severity);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ── Notification ───────────────────────────────────────────────────────────────

/** Fire the ONE merged desktop notification for a cycle's new jobs (PRD §3/§9).
 *  `buildScanNotification` returns null for an empty batch, so a cycle that found
 *  nothing fires nothing; a non-empty batch is already deduped across every watch,
 *  so this is one notification per cycle, never one per watch. The fixed
 *  `SCAN_NOTIFICATION_ID` means a fresh cycle's notification replaces the prior
 *  one rather than stacking, and lets the click handler recognise ours. */
async function fireNewJobsNotification(newJobs: Job[]): Promise<void> {
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
 *  real failures in a row raise the soft warning, and one good send resets it. */
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

/** Land the user in our own list (PRD §3/§9): focus an already-open jobs.html tab
 *  (raising its window) rather than duplicating it, else open a new one. Marks
 *  NOTHING as opened — it only gets you to the list. */
async function openJobsList(): Promise<void> {
  const url = chrome.runtime.getURL("jobs.html");
  const existing = jobsTabToFocus(await chrome.tabs.query({ url }));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
}

// ── Talking to the invisible tab ───────────────────────────────────────────────

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
type PageResult = { jobs: Job[]; outcome: PageOutcome };

/** Open one invisible tab on `url`, let the content script settle+parse it, and
 *  return the parsed jobs together with the page's classified {@link PageOutcome}
 *  (PRD §16). A fresh one-time token is minted per injection and stamped onto the
 *  tab's URL fragment; the same token rides the LJW_SCAN message, and the content
 *  script reads nothing unless the two match (PRD §9) — so a LinkedIn tab the user
 *  opened by hand, which carries no token, is never scraped.
 *
 *  The classification is `classifyPage`'s (§16 structural consequence — no
 *  decision logic here): a tab that never finishes loading is a `navError`
 *  (`load-failed`); one that lands on `/authwall` or `/checkpoint` is read from its
 *  final URL even when the content script's token gate refuses the redirected page.
 *  The tab is created `active: false` (never steals focus, PRD §17 decision 2) and
 *  ALWAYS closed in the `finally` so a parse failure can't orphan a tab. */
async function scanPage(url: string): Promise<PageResult> {
  const token = crypto.randomUUID();
  const tab = await chrome.tabs.create({ url: withScanToken(url, token), active: false });
  const tabId = tab.id;
  if (tabId === undefined) return { jobs: [], outcome: "load-failed" };

  // Record the tab before the async work so a mid-cycle teardown can sweep it
  // (lifecycle.recoverStaleLock); untrack once it is cleanly closed below.
  await set("scanState", trackTab(await get("scanState"), tabId));
  try {
    const completed = await waitForTabComplete(tabId);
    const landed = await chrome.tabs.get(tabId).catch(() => undefined);
    const finalUrl = landed?.url ?? url;

    // Try to read the page's own signals; a token-gated redirect (e.g. to
    // /authwall) may refuse to answer, in which case we classify from the URL.
    let jobs: Job[] = [];
    let hasResultsList = false;
    let cardCount = 0;
    try {
      const req: ScanRequest = { type: "LJW_SCAN", token };
      const res = (await chrome.tabs.sendMessage(tabId, req)) as ScanResponse | undefined;
      if (res) {
        jobs = res.jobs;
        hasResultsList = res.hasResultsList;
        cardCount = res.cardCount;
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
    };
    return { jobs, outcome: classifyPage(signals) };
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
    await set("scanState", untrackTab(await get("scanState"), tabId));
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
    for (const [w, watch] of watches.entries()) {
      for (let page = 1; page <= pages; page++) {
        let { jobs, outcome } = await scanPage(scanPageUrl(watch.url, page));
        // A load failure retries the page once, then skips it and continues the
        // cycle (PRD §16.5). The retry is infra, not a parser signal, so a
        // persistent `load-failed` is recorded as such — `reduceScanHealth` leaves
        // the empty-scan back-off counter untouched for it.
        if (outcome === "load-failed") {
          await sleep(randomPauseMs(settings.pacing.pagePauseMs));
          ({ jobs, outcome } = await scanPage(scanPageUrl(watch.url, page)));
        }
        found.push(...stampJobs(jobs, watch.id, Date.now()));
        outcomes.push(outcome);
        if (page < pages) await sleep(randomPauseMs(settings.pacing.pagePauseMs));
      }
      if (w < watches.length - 1) await sleep(randomPauseMs(settings.pacing.watchPauseMs));
    }

    // Merge-before-dedupe (PRD §5): one dedupe over every watch's results so a
    // cross-watch duplicate id collapses to a single new job.
    const { newJobs, seen } = dedupe(found, await get("seen"), filterRulesOf(settings), Date.now());
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

    // Selector-drift telemetry (PRD §16.4): a field blank on EVERY parsed card is
    // recorded as likely drift; a single blank company on one card is not.
    const cards = found.map((j) => ({ company: j.company, location: j.location }));
    for (const field of ["company", "location"] as const) {
      if (fieldMissingAcrossAll(cards, field)) {
        console.warn(`[ljw] "${field}" was blank on every card this scan — its selector may have drifted.`);
      }
    }

    await updateBadge(health.severity);
    // One merged notification for the whole cycle's new jobs (PRD §3/§9), then the
    // hard-failure health alert if this cycle transitioned into one (§16.8). Both
    // fired after the badge so the surfaces agree.
    await fireNewJobsNotification(newJobs);
    await fireHealthNotification(health);
    // Additive Telegram push (PRD §8), after the badge and desktop notification so
    // its failure — swallowed by sendPush — can never affect either.
    await firePush(settings, newJobs);
  } finally {
    clearInterval(keepalive);
  }
}

/** Compute and arm the next one-shot alarm (PRD §15 decision 3). `nextScanDelayMs`
 *  owns jitter, back-off and the quiet-hours jump; this only creates the alarm. */
async function armNextAlarm(settings: Settings): Promise<void> {
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

/** Run the cycle the lock was taken for, then always release the lock and re-arm
 *  the cadence — so a manual scan resets the next automatic one to a full
 *  interval from now, rather than leaving two scans stacked minutes apart. */
async function runLockedCycle(settings: Settings, pages: number): Promise<void> {
  try {
    await runCycle(settings, pages);
  } finally {
    await set("scanState", endScan(await get("scanState")));
    await armNextAlarm(settings);
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

  // Same first step as an alarm tick: a lock a torn-down cycle left stuck must
  // not make the button silently do nothing (§16.6/§17.2).
  const recovered = recoverStaleLock(await get("scanState"), Date.now(), settings.staleLockMs);
  await Promise.all(recovered.tabIdsToClose.map((id) => chrome.tabs.remove(id).catch(() => {})));
  if (recovered.state.isScanning) return { started: false, reason: "already-scanning" };

  if ((await get("health")).mode === "halted") await set("health", { ...OK_HEALTH });

  const pages = await takeScanLock(settings, recovered.state);
  // Deliberately not awaited: the reply goes back now so the popup repaints as
  // "Scanning…" instead of hanging for the 60–90s the cycle takes. The keepalive
  // inside runCycle (§17 decision 1) is what keeps the worker alive meanwhile.
  void runLockedCycle(settings, pages);
  return { started: true };
}

/** The alarm handler — the whole cadence in one place (PRD §9). */
async function onAlarm(): Promise<void> {
  const settings = await get("settings");

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

// ── Wiring ─────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void onAlarm();
});

/** The popup / jobs tab asking for a scan right now. Returning `true` keeps the
 *  message channel open for the async reply; the reply lands as soon as the lock
 *  is resolved, not when the cycle ends. Other message types are ignored (the
 *  content script is messaged the other way round, via `chrome.tabs.sendMessage`). */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as ScanNowRequest | undefined)?.type !== "LJW_SCAN_NOW") return;
  void runScanNow().then(sendResponse);
  return true;
});

/** Notification click (PRD §3/§9): open our own list, never LinkedIn, and clear
 *  the notification. Marks nothing as opened. `openPopup()` can't be triggered
 *  from a click, so this opens the full jobs.html tab (the list component is
 *  shared with the popup, so it costs nothing). */
chrome.notifications.onClicked.addListener((id) => {
  if (id !== SCAN_NOTIFICATION_ID) return;
  void (async () => {
    await openJobsList();
    await chrome.notifications.clear(id);
  })();
});

/** Fresh install: arm the first alarm so the loop starts (idempotent — an
 *  already-armed alarm from a prior version is left as-is). */
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureAlarmExists(await get("settings"));
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
    await ensureAlarmExists(settings);
  })();
});
