import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesOfDay,
  jitteredDelayMs,
  isWithinQuietHours,
  backoffIntervalMinutes,
  shouldWarnStalled,
  nextScanDelayMs,
  randomPauseMs,
  type QuietHours,
  type BackoffConfig,
  type Rand,
} from "./schedule.ts";

// Pure-logic reference for issue #8 (07 — scheduling). No chrome.*, no DOM, no
// network; randomness is injected so every case is deterministic (prd.md §14).

/** A Rand that plays back a fixed script of values, one per call. */
function scriptedRand(values: number[]): Rand {
  let i = 0;
  return () => values[i++ % values.length]!;
}

const MIN = 60_000;
const quiet = (o: Partial<QuietHours> = {}): QuietHours => ({
  enabled: true,
  startMinute: 23 * 60, // 23:00
  endMinute: 7 * 60, // 07:00
  ...o,
});
const backoff = (o: Partial<BackoffConfig> = {}): BackoffConfig => ({
  emptyScansBeforeBackoff: 3,
  maxIntervalMinutes: 60,
  ...o,
});

test("minutesOfDay reads local hours and minutes, dropping seconds", () => {
  assert.equal(minutesOfDay(new Date(2026, 6, 23, 0, 0, 30)), 0);
  assert.equal(minutesOfDay(new Date(2026, 6, 23, 7, 0, 0)), 420);
  assert.equal(minutesOfDay(new Date(2026, 6, 23, 23, 59, 59)), 1439);
});

test("jitteredDelayMs scatters ±jitter around the interval", () => {
  // rand 0.0 → offset -jitter; rand 1.0 (via 0.999…) → +jitter; 0.5 → centre.
  assert.equal(jitteredDelayMs(5, 1, () => 0), 4 * MIN);
  assert.equal(jitteredDelayMs(5, 1, () => 0.5), 5 * MIN);
  assert.equal(jitteredDelayMs(5, 1, () => 1), 6 * MIN);
});

test("jitteredDelayMs never returns below the 1-minute chrome.alarms floor", () => {
  // interval 1, jitter 2, rand 0 → 1 + (-2) = -1 → clamped to 1 minute.
  assert.equal(jitteredDelayMs(1, 2, () => 0), 1 * MIN);
});

test("isWithinQuietHours handles a midnight-wrapping window", () => {
  const q = quiet(); // 23:00 → 07:00
  assert.equal(isWithinQuietHours(23 * 60, q), true); // 23:00, boundary open
  assert.equal(isWithinQuietHours(2 * 60, q), true); // 02:00, after midnight
  assert.equal(isWithinQuietHours(7 * 60, q), false); // 07:00, boundary reopen
  assert.equal(isWithinQuietHours(12 * 60, q), false); // midday
});

test("isWithinQuietHours handles a same-day (non-wrapping) window", () => {
  const q = quiet({ startMinute: 1 * 60, endMinute: 6 * 60 }); // 01:00 → 06:00
  assert.equal(isWithinQuietHours(3 * 60, q), true);
  assert.equal(isWithinQuietHours(8 * 60, q), false);
});

test("isWithinQuietHours is never quiet when disabled or zero-width", () => {
  assert.equal(isWithinQuietHours(2 * 60, quiet({ enabled: false })), false);
  assert.equal(isWithinQuietHours(2 * 60, quiet({ startMinute: 120, endMinute: 120 })), false);
});

test("backoffIntervalMinutes stays at base below the threshold", () => {
  const cfg = backoff(); // trips at 3
  assert.equal(backoffIntervalMinutes(5, 0, cfg), 5);
  assert.equal(backoffIntervalMinutes(5, 2, cfg), 5);
});

test("backoffIntervalMinutes doubles per empty scan once tripped, clamped to the cap", () => {
  const cfg = backoff(); // trips at 3, cap 60
  assert.equal(backoffIntervalMinutes(5, 3, cfg), 10); // first step: ×2
  assert.equal(backoffIntervalMinutes(5, 4, cfg), 20); // ×4
  assert.equal(backoffIntervalMinutes(5, 5, cfg), 40); // ×8
  assert.equal(backoffIntervalMinutes(5, 6, cfg), 60); // ×16 → clamped to 60
  assert.equal(backoffIntervalMinutes(5, 20, cfg), 60); // stays clamped
});

test("shouldWarnStalled fires exactly when back-off trips", () => {
  const cfg = backoff();
  assert.equal(shouldWarnStalled(2, cfg), false);
  assert.equal(shouldWarnStalled(3, cfg), true);
});

test("nextScanDelayMs returns the jittered routine delay outside quiet hours", () => {
  const params = {
    now: new Date(2026, 6, 23, 12, 0, 0), // midday, well clear of quiet hours
    baseIntervalMinutes: 5,
    jitterMinutes: 1,
    consecutiveEmptyScans: 0,
    quietHours: quiet(),
    backoff: backoff(),
  };
  const r = nextScanDelayMs(params, () => 0.5);
  assert.equal(r.willResumeFromQuiet, false);
  assert.equal(r.delayMs, 5 * MIN);
});

test("nextScanDelayMs applies back-off to the interval before jittering", () => {
  const params = {
    now: new Date(2026, 6, 23, 12, 0, 0),
    baseIntervalMinutes: 5,
    jitterMinutes: 0,
    consecutiveEmptyScans: 4, // tripped: 5 × 4 = 20 minutes
    quietHours: quiet(),
    backoff: backoff(),
  };
  const r = nextScanDelayMs(params, () => 0.5);
  assert.equal(r.delayMs, 20 * MIN);
});

test("nextScanDelayMs defers to the end of quiet hours when the fire would land inside", () => {
  // 22:58 + a 5-minute-ish delay → ~23:03, inside the 23:00→07:00 window.
  const params = {
    now: new Date(2026, 6, 23, 22, 58, 0),
    baseIntervalMinutes: 5,
    jitterMinutes: 1,
    consecutiveEmptyScans: 0,
    quietHours: quiet(),
    backoff: backoff(),
  };
  // scriptedRand: first value drives jitteredDelayMs (fire lands in quiet),
  // second drives the resume jitter (0 → wake exactly at 07:00).
  const r = nextScanDelayMs(params, scriptedRand([0.5, 0]));
  assert.equal(r.willResumeFromQuiet, true);
  // From 22:58 to 07:00 next day = 8h02m = 482 minutes.
  assert.equal(r.delayMs, 482 * MIN);
});

test("nextScanDelayMs ignores quiet hours when disabled", () => {
  const params = {
    now: new Date(2026, 6, 23, 23, 30, 0), // inside 23:00→07:00 clock-wise…
    baseIntervalMinutes: 5,
    jitterMinutes: 0,
    consecutiveEmptyScans: 0,
    quietHours: quiet({ enabled: false }), // …but quiet hours are off
    backoff: backoff(),
  };
  const r = nextScanDelayMs(params, () => 0.5);
  assert.equal(r.willResumeFromQuiet, false);
  assert.equal(r.delayMs, 5 * MIN);
});

test("randomPauseMs is uniform across the given range", () => {
  assert.equal(randomPauseMs([3000, 5000], () => 0), 3000);
  assert.equal(randomPauseMs([3000, 5000], () => 0.5), 4000);
  assert.equal(randomPauseMs([8000, 12000], () => 1), 12000);
});
