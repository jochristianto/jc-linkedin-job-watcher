// Background service worker (MV3) — the scan loop's side-effect wrapper (PRD §9 /
// §15 / §17). This ticket (04, issue #15) turns the prefactor entry into the
// first real scan: an alarm fires, an invisible tab opens on one watch's URL, the
// content script scroll-settles and parses the page, the tab closes, the new jobs
// land in storage and the badge shows the unopened count.
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
} from "./lifecycle.ts";
import {
  badgeText,
  enabledWatches,
  mergeJobs,
  scanPageUrl,
  stampJobs,
  unopenedCount,
  withScanToken,
  type ScanRequest,
  type ScanResponse,
} from "./scan.ts";
import type { Job, Settings } from "./types.ts";

/** The single re-armed one-shot alarm (PRD §15 decision 3). One name, re-created
 *  with a fresh `{ when }` at the end of every cycle. */
const ALARM_NAME = "ljw-scan";

/** How long to wait for a scan tab to finish loading before messaging it. Loose
 *  because the content script settles the lazy list itself (pollUntilSettled). */
const TAB_LOAD_TIMEOUT_MS = 30_000;

/** Sleep for a drawn pause length — the in-cycle pacing (PRD §9/§15 decision 5).
 *  A plain timer; the *length* is decided by the tested `randomPauseMs`. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Badge ────────────────────────────────────────────────────────────────────

/** Reflect the unopened count onto the toolbar badge (PRD §7). Pure count from
 *  scan.ts; this only calls the browser API. */
async function updateBadge(): Promise<void> {
  const jobs = await get("jobs");
  await chrome.action.setBadgeText({ text: badgeText(unopenedCount(jobs)) });
}

// ── Talking to the invisible tab ───────────────────────────────────────────────

/** Resolve once the tab reports `status: "complete"` (or the timeout elapses so a
 *  wedged load can't hang the cycle). The content script runs at document_idle,
 *  so "complete" means it is ready to receive the scan message. */
function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Open one invisible tab on `url`, let the content script settle+parse it, and
 *  return the parsed jobs. A fresh one-time token is minted per injection and
 *  stamped onto the tab's URL fragment; the same token rides the LJW_SCAN message,
 *  and the content script reads nothing unless the two match (PRD §9) — so a
 *  LinkedIn tab the user opened by hand, which carries no token, is never scraped.
 *  The tab is created `active: false` (never steals focus, PRD §17 decision 2) and
 *  ALWAYS closed in the `finally` — even if the page or the messaging throws — so a
 *  parse failure can't orphan a tab. */
async function scanPage(url: string): Promise<Job[]> {
  const token = crypto.randomUUID();
  const tab = await chrome.tabs.create({ url: withScanToken(url, token), active: false });
  const tabId = tab.id;
  if (tabId === undefined) return [];

  // Record the tab before the async work so a mid-cycle teardown can sweep it
  // (lifecycle.recoverStaleLock); untrack once it is cleanly closed below.
  await set("scanState", trackTab(await get("scanState"), tabId));
  try {
    await waitForTabComplete(tabId);
    const req: ScanRequest = { type: "LJW_SCAN", token };
    const res = (await chrome.tabs.sendMessage(tabId, req)) as ScanResponse | undefined;
    return res?.jobs ?? [];
  } catch {
    return []; // a dead tab / no content script is an empty page, not a crash
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
    for (const [w, watch] of watches.entries()) {
      for (let page = 1; page <= pages; page++) {
        const parsed = await scanPage(scanPageUrl(watch.url, page));
        found.push(...stampJobs(parsed, watch.id, Date.now()));
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
    await updateBadge();
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

  const { pages, state } = beginScan(
    recovered.state,
    Date.now(),
    settings.catchUpPages,
    settings.pagesPerScan,
  );
  await set("scanState", state);
  try {
    await runCycle(settings, pages);
  } finally {
    await set("scanState", endScan(await get("scanState")));
    await armNextAlarm(settings);
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void onAlarm();
});

/** Fresh install: arm the first alarm so the loop starts. */
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await armNextAlarm(await get("settings"));
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
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) await armNextAlarm(settings);
  })();
});
