// Worker lifecycle — PRD §17 "How does a scan cycle stay alive, and pick up
// where it left off?" (resolves issue #11 / ticket 10).
//
// Issue #3 established the facts: an MV3 worker dies after ~30s of not touching
// an extension API, nothing in memory survives a teardown, and the dead air in a
// cycle is the wait for LinkedIn to render (`tabs.create` resolves before the
// page loads). This module is the pure-logic reference for what to *do* about
// them — the five decisions §17 settles:
//
//   1. Keepalive, not restartability. A 25s API ping (`KEEPALIVE_PING_MS`) keeps
//      a full cycle alive; a lost cycle costs one skipped scan and dedupe is by
//      job id, so no cursor is persisted to "resume" from.
//   4. Nothing per-watch/per-page is persisted for resume (follows from 1): the
//      only cross-teardown state is the scan lock and the list of tabs to clean.
//   2. Orphaned background tabs are cleaned by recording the ids the live cycle
//      opened and sweeping them closed when a stale lock is recovered.
//   3. Staleness is §16.6's `isLockStale` — settled once, imported here.
//   5. The startup / quiet-resume catch-up is a *consumable flag*, not an inline
//      scan, so it fires exactly once whether or not Chrome replays the missed
//      alarm on relaunch (issue #3's open question, verified in #5).
//
// Like `filter.ts`, `schedule.ts` and `health.ts` it touches no chrome.*, no DOM
// and no network — `now`, tab ids and settings all come in as arguments — so
// `node --test` proves it without a browser (PRD §14). `background.ts` is the
// thin wrapper: it runs the keepalive interval, opens/closes tabs, and persists
// the returned `ScanLifecycleState`. That wrapper is not unit-tested; the
// decisions here are.

import { isLockStale, type LockState } from "./health.ts";

/**
 * How often the keepalive pings an extension API while a cycle runs (PRD §17,
 * decision 1). Comfortably below the ~30s idle-teardown so a 60–90s cycle (§9)
 * survives the dead air waiting for LinkedIn to render. The wrapper does
 * `setInterval(chrome.runtime.getPlatformInfo, KEEPALIVE_PING_MS)` for the
 * duration of the cycle — the exact pattern Chrome sanctions for this case
 * (issue #3) — and clears it in a `finally`. Kept here as the single source of
 * the number even though the `setInterval` itself lives in the wrapper.
 */
export const KEEPALIVE_PING_MS = 25_000;

/**
 * The persisted scan-lifecycle record (PRD §5 `ScanState`, extended in §17). A
 * superset of {@link LockState}: the two lock fields plus the two things worth
 * persisting across a teardown — the tabs to clean up and whether the next scan
 * owes a catch-up. Deliberately *not* a resume cursor (decision 4): a torn-down
 * cycle is abandoned, not resumed; the next alarm re-scans and dedupe (§5) makes
 * that lossless.
 */
export type ScanLifecycleState = {
  /** True while a cycle holds the lock (PRD §9). */
  isScanning: boolean;
  /** When the current cycle took the lock, for staleness (`isLockStale`, §16.6). */
  startedAt: number | null;
  /** Tab ids the *live* cycle has open right now. Emptied as each closes; what
   *  remains after a teardown is the orphan set to sweep (decision 2). */
  openTabIds: number[];
  /** The next scan runs at catch-up depth (decision 5). Set on startup and on a
   *  quiet-hours resume (§9/§15); consumed by the one scan that begins next. */
  pendingCatchUp: boolean;
};

/** The idle starting point — no lock held, no tabs open, no catch-up owed. */
export const IDLE_LIFECYCLE: ScanLifecycleState = {
  isScanning: false,
  startedAt: null,
  openTabIds: [],
  pendingCatchUp: false,
};

/**
 * Request that the next scan run deep (PRD §17, decision 5). Called on browser
 * startup and on a quiet-hours resume (`willResumeFromQuiet`, schedule.ts) — a
 * closed-Chrome gap and a quiet gap are the same problem (§9). It only sets the
 * flag; it never scans, so it's safe to call before the alarm is even armed. The
 * flag survives a stale-lock sweep ({@link recoverStaleLock} spreads it through),
 * so a startup that also finds a stuck lock still gets its catch-up.
 */
export function requestCatchUp(state: ScanLifecycleState): ScanLifecycleState {
  return { ...state, pendingCatchUp: true };
}

/**
 * Take the scan lock and resolve this cycle's page depth (PRD §17, decisions 4
 * and 5), in one step so the depth can't be read after the flag is cleared. The
 * catch-up flag is *consumed* here — this is what makes the catch-up fire exactly
 * once: because the lock serialises cycles, only the first fire after startup
 * gets `pendingCatchUp === true`; a second concurrent fire sees `isScanning` and
 * skips before reaching here (PRD §9). Resets `openTabIds` for a fresh cycle.
 */
export function beginScan(
  state: ScanLifecycleState,
  now: number,
  catchUpPages: number,
  pagesPerScan: number,
): { pages: number; state: ScanLifecycleState } {
  const pages = state.pendingCatchUp ? catchUpPages : pagesPerScan;
  return {
    pages,
    state: { ...holdLock(state, now), openTabIds: [], pendingCatchUp: false },
  };
}

/**
 * Take the lock, and *only* take the lock.
 *
 * The lock is what serialises access to `seen` and `jobs` — a cycle is simply
 * its longest-running holder. "Delete all job history" (§7) writes both keys and
 * so has to hold it too, or it can interleave with a cycle's read-dedupe-write
 * tail and have the records it just deleted written straight back.
 *
 * What it deliberately does *not* do is the rest of what starting a cycle means:
 * the catch-up flag is left pending, because a delete is not the deep scan that
 * flag was set for and swallowing it would quietly downgrade the next round; and
 * `openTabIds` is left alone, because this holder opens no tabs and the ids in
 * there are someone else's to sweep. {@link endScan} releases it either way.
 */
export function holdLock(state: ScanLifecycleState, now: number): ScanLifecycleState {
  return { ...state, isScanning: true, startedAt: now };
}

/**
 * Release the lock at the clean end of a cycle (PRD §17). Drops `isScanning`,
 * clears `startedAt` and empties `openTabIds` (every tab was closed as its page
 * finished). Leaves `pendingCatchUp` alone — `beginScan` already consumed it, and
 * a quiet-resume request that arrived mid-cycle should carry to the next scan.
 */
export function endScan(state: ScanLifecycleState): ScanLifecycleState {
  return { ...state, isScanning: false, startedAt: null, openTabIds: [] };
}

/**
 * Record a background tab the cycle just opened (PRD §17, decision 2). Idempotent
 * — re-adding a known id is a no-op — so a persist-then-open race can't duplicate
 * it. The wrapper calls this right after `tabs.create` resolves.
 */
export function trackTab(state: ScanLifecycleState, tabId: number): ScanLifecycleState {
  if (state.openTabIds.includes(tabId)) return state;
  return { ...state, openTabIds: [...state.openTabIds, tabId] };
}

/**
 * Forget a tab the cycle just closed normally (PRD §17, decision 2). After a
 * page is scraped and its tab removed, it's no longer an orphan candidate, so it
 * leaves `openTabIds`; only tabs still tracked when the worker dies get swept.
 */
export function untrackTab(state: ScanLifecycleState, tabId: number): ScanLifecycleState {
  return { ...state, openTabIds: state.openTabIds.filter((id) => id !== tabId) };
}

/**
 * Recover a stale lock (PRD §17, decisions 2 + 3). Runs on **every** alarm tick
 * and on startup (§16.6): the worker can be torn down mid-cycle on any tick, so
 * the check can't be startup-only. Staleness is {@link isLockStale} — the same
 * 5-minute rule settled once in §16.6 and imported here, not re-decided. When the
 * lock is stale it returns the orphaned `openTabIds` for the wrapper to close and
 * a reset state (lock released, tab list emptied) so the pending scan proceeds;
 * `pendingCatchUp` is preserved. When the lock is fresh (a real cycle is running)
 * nothing is closed and the state is returned unchanged.
 */
export function recoverStaleLock(
  state: ScanLifecycleState,
  now: number,
  staleAfterMs: number,
): { tabIdsToClose: number[]; state: ScanLifecycleState } {
  const lock: LockState = { isScanning: state.isScanning, startedAt: state.startedAt };
  if (!isLockStale(lock, now, staleAfterMs)) return { tabIdsToClose: [], state };
  return {
    tabIdsToClose: state.openTabIds,
    state: { ...state, isScanning: false, startedAt: null, openTabIds: [] },
  };
}
