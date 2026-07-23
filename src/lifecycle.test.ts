import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEEPALIVE_PING_MS,
  IDLE_LIFECYCLE,
  requestCatchUp,
  beginScan,
  endScan,
  trackTab,
  untrackTab,
  recoverStaleLock,
  type ScanLifecycleState,
} from "./lifecycle.ts";

// Pure-logic reference for issue #11 (10 — worker lifecycle). No chrome.*, no
// DOM, no network; `now`, tab ids and settings are all arguments (prd.md §14).

const STALE_MS = 300_000; // §16.6 default staleLockMs (5 min)

const state = (o: Partial<ScanLifecycleState> = {}): ScanLifecycleState => ({
  ...IDLE_LIFECYCLE,
  ...o,
});

// ── decision 1: keepalive keeps a cycle alive ───────────────────────────────

test("keepalive ping fires under the ~30s idle-teardown", () => {
  // The whole point of decision 1: a ping below 30s survives the dead air.
  assert.ok(KEEPALIVE_PING_MS < 30_000);
  assert.equal(KEEPALIVE_PING_MS, 25_000);
});

// ── decision 5: catch-up depth, requested and consumed exactly once ──────────

test("beginScan uses pagesPerScan by default", () => {
  const { pages, state: next } = beginScan(state(), 1_000, 4, 1);
  assert.equal(pages, 1);
  assert.equal(next.isScanning, true);
  assert.equal(next.startedAt, 1_000);
  assert.equal(next.pendingCatchUp, false);
});

test("requestCatchUp makes the next scan run deep", () => {
  const asked = requestCatchUp(state());
  assert.equal(asked.pendingCatchUp, true);
  const { pages } = beginScan(asked, 1_000, 4, 1);
  assert.equal(pages, 4);
});

test("requestCatchUp only sets the flag — it never scans or takes the lock", () => {
  const asked = requestCatchUp(state());
  assert.equal(asked.isScanning, false);
  assert.equal(asked.startedAt, null);
});

test("catch-up fires exactly once: a second scan reverts to shallow depth", () => {
  const asked = requestCatchUp(state());
  const first = beginScan(asked, 1_000, 4, 1);
  assert.equal(first.pages, 4);
  // The consumed flag means the next cycle (after this one ends) is shallow.
  const second = beginScan(endScan(first.state), 2_000, 4, 1);
  assert.equal(second.pages, 1);
});

// ── decision 4: nothing persisted for resume ────────────────────────────────

test("beginScan starts every cycle with a fresh, empty tab list", () => {
  // No cursor is carried forward — an abandoned cycle is re-scanned, not resumed.
  const dirty = state({ openTabIds: [7, 8], pendingCatchUp: true });
  const { state: next } = beginScan(dirty, 1_000, 4, 1);
  assert.deepEqual(next.openTabIds, []);
});

test("endScan releases the lock and clears the tab list", () => {
  const running = state({ isScanning: true, startedAt: 1_000, openTabIds: [3] });
  const done = endScan(running);
  assert.equal(done.isScanning, false);
  assert.equal(done.startedAt, null);
  assert.deepEqual(done.openTabIds, []);
});

// ── decision 2: orphaned-tab tracking and cleanup ───────────────────────────

test("trackTab records an opened tab; untrackTab forgets a closed one", () => {
  let s = trackTab(state(), 11);
  s = trackTab(s, 12);
  assert.deepEqual(s.openTabIds, [11, 12]);
  s = untrackTab(s, 11);
  assert.deepEqual(s.openTabIds, [12]);
});

test("trackTab is idempotent (persist-then-open race can't duplicate)", () => {
  const s = trackTab(trackTab(state(), 11), 11);
  assert.deepEqual(s.openTabIds, [11]);
});

test("recoverStaleLock sweeps the orphaned tabs of a stuck cycle", () => {
  const stuck = state({ isScanning: true, startedAt: 0, openTabIds: [4, 5] });
  const { tabIdsToClose, state: next } = recoverStaleLock(stuck, STALE_MS + 1, STALE_MS);
  assert.deepEqual(tabIdsToClose, [4, 5]);
  assert.equal(next.isScanning, false);
  assert.equal(next.startedAt, null);
  assert.deepEqual(next.openTabIds, []);
});

// ── decision 3: staleness is §16.6's isLockStale, reused ─────────────────────

test("recoverStaleLock leaves a fresh, running cycle untouched", () => {
  const running = state({ isScanning: true, startedAt: 1_000, openTabIds: [4] });
  const { tabIdsToClose, state: next } = recoverStaleLock(running, 1_000 + 60_000, STALE_MS);
  assert.deepEqual(tabIdsToClose, []);
  assert.equal(next, running); // returned unchanged
});

test("recoverStaleLock treats isScanning with a null startedAt as stale (corrupt)", () => {
  const corrupt = state({ isScanning: true, startedAt: null, openTabIds: [9] });
  const { tabIdsToClose, state: next } = recoverStaleLock(corrupt, 500, STALE_MS);
  assert.deepEqual(tabIdsToClose, [9]);
  assert.equal(next.isScanning, false);
});

test("recoverStaleLock is a no-op when nothing is scanning", () => {
  const { tabIdsToClose, state: next } = recoverStaleLock(state(), 999_999, STALE_MS);
  assert.deepEqual(tabIdsToClose, []);
  assert.equal(next.isScanning, false);
});

// ── decisions 2 + 5: a stale-lock sweep preserves a pending catch-up ─────────

test("a startup that finds a stuck lock still keeps its catch-up owed", () => {
  const startup = requestCatchUp(state({ isScanning: true, startedAt: 0, openTabIds: [2] }));
  const { state: next } = recoverStaleLock(startup, STALE_MS + 1, STALE_MS);
  assert.equal(next.pendingCatchUp, true);
  assert.equal(next.isScanning, false);
  const { pages } = beginScan(next, STALE_MS + 2, 4, 1);
  assert.equal(pages, 4);
});
