// Scheduling — PRD §3 "Scanning" / §9 "Scan cycle" & "Browser startup" / §12
// "Request volume", and the new §15 "Cadence, depth, and going quiet".
//
// This is the pure-logic reference for issue #8 (07 — "How often, how deep, and
// when to go quiet?"). It answers, in code, the seven decisions that ticket
// settled: interval, page depth, jitter, quiet hours, in-cycle pauses, the
// stopping rule, and the shipped defaults. Like `filter.ts` it touches no
// chrome.*, no DOM and no network — every value comes in as an argument — so
// `node --test` proves it without a browser (prd.md §14). `chrome.alarms` and
// the scan loop are the thin wrappers that call these functions; the randomness
// source is injected (`rand`) exactly so a test can make it deterministic.

/** Randomness source in [0, 1). Injected so tests are deterministic; production
 *  passes `Math.random`. Same idea as `sendPush`'s injectable `fetch` (PRD §14). */
export type Rand = () => number;

/**
 * The name of the single re-armed one-shot alarm (PRD §15, decision 3).
 *
 * It lives here rather than in background.ts because the *list view* reads that
 * alarm too: `chrome.alarms.get(SCAN_ALARM_NAME).scheduledTime` is the one true
 * answer to "when is the next scan?", and the alternative — mirroring the fire
 * time into a storage key — would be a second copy that can disagree with the
 * alarm actually armed. Importing the name from background.ts is not an option:
 * that module registers service-worker listeners at import time, so pulling it
 * into the popup bundle would run the scan loop's wiring inside the popup.
 */
export const SCAN_ALARM_NAME = "ljw-scan";

/**
 * Quiet hours (PRD §15, decision 4). A clock-based window in the user's *local*
 * time, expressed as minutes since local midnight so the pure logic never has to
 * parse "23:00". `enabled` off means scan around the clock. The window may wrap
 * midnight (`startMinute > endMinute`), which is the common case (e.g. 23:00→07:00).
 */
export type QuietHours = {
  enabled: boolean;
  startMinute: number; // 0..1439, local minutes-of-day the quiet window opens
  endMinute: number; // 0..1439, local minutes-of-day it reopens for scanning
};

/**
 * Back-off config (PRD §15, decision 6 — "the stopping rule"). When consecutive
 * scans come back completely empty across every watch — the signature of a
 * broken parser or a soft block (PRD §12) — the extension lengthens its own
 * interval instead of hammering LinkedIn at the same cadence, and warns the user.
 */
export type BackoffConfig = {
  emptyScansBeforeBackoff: number; // consecutive empty scans that trip back-off
  maxIntervalMinutes: number; // ceiling the doubling interval is clamped to
};

/** Inputs to {@link nextScanDelayMs}. `now` is the only clock read; everything
 *  else is settings/state so the decision stays a pure function of its inputs. */
export type NextScanParams = {
  now: Date;
  baseIntervalMinutes: number;
  jitterMinutes: number;
  consecutiveEmptyScans: number;
  quietHours: QuietHours;
  backoff: BackoffConfig;
};

export type NextScan = {
  delayMs: number;
  /** True when the next fire was pushed to the end of a quiet window. The caller
   *  scans at `catchUpPages` depth on that wake, the same as browser startup
   *  (PRD §9) — a quiet gap and a closed-Chrome gap are the same problem. */
  willResumeFromQuiet: boolean;
};

const MIN = 60_000;
const DAY_MINUTES = 1440;

/** Local minutes-of-day for a Date (0..1439), dropping seconds. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * The next one-shot alarm delay, in ms, for the routine cadence (PRD §15,
 * decision 3). LinkedIn's fixed-heartbeat concern is answered by re-arming a
 * one-shot alarm each cycle rather than a periodic one, jittering ±`jitterMinutes`
 * onto the interval. Clamped to a 1-minute floor because `chrome.alarms` will not
 * honour anything shorter (issue #3 / PRD §2), so a large jitter can't produce a
 * sub-minute — or negative — delay.
 */
export function jitteredDelayMs(
  intervalMinutes: number,
  jitterMinutes: number,
  rand: Rand = Math.random,
): number {
  const offset = (rand() * 2 - 1) * jitterMinutes; // [-jitter, +jitter)
  const minutes = Math.max(1, intervalMinutes + offset);
  return Math.round(minutes * MIN);
}

/**
 * Is `nowMinute` (local minutes-of-day) inside the quiet window? Handles the
 * midnight-wrapping case (`start > end`) that a naive `start <= now < end` misses.
 * A zero-width window (`start === end`, or disabled) is never quiet.
 */
export function isWithinQuietHours(nowMinute: number, quiet: QuietHours): boolean {
  if (!quiet.enabled || quiet.startMinute === quiet.endMinute) return false;
  if (quiet.startMinute < quiet.endMinute) {
    return nowMinute >= quiet.startMinute && nowMinute < quiet.endMinute;
  }
  // Wraps midnight: quiet from start..24:00 and 00:00..end.
  return nowMinute >= quiet.startMinute || nowMinute < quiet.endMinute;
}

/**
 * The effective interval after the stopping rule (PRD §15, decision 6). Below the
 * threshold it's the plain base interval; once `emptyScansBeforeBackoff` scans in
 * a row return nothing, each further empty scan doubles the interval, clamped to
 * `maxIntervalMinutes`. Recovers instantly: one non-empty scan resets the caller's
 * counter to 0 and the interval snaps back to base.
 */
export function backoffIntervalMinutes(
  baseMinutes: number,
  consecutiveEmptyScans: number,
  cfg: BackoffConfig,
): number {
  if (consecutiveEmptyScans < cfg.emptyScansBeforeBackoff) return baseMinutes;
  const steps = consecutiveEmptyScans - cfg.emptyScansBeforeBackoff + 1;
  const scaled = baseMinutes * 2 ** steps;
  return Math.min(cfg.maxIntervalMinutes, scaled);
}

/** True once back-off has tripped — the caller both lengthens the interval (via
 *  {@link backoffIntervalMinutes}) and surfaces a "reading may be broken" warning
 *  to the user (PRD §15, decision 6: the extension does both, not one). */
export function shouldWarnStalled(
  consecutiveEmptyScans: number,
  cfg: BackoffConfig,
): boolean {
  return consecutiveEmptyScans >= cfg.emptyScansBeforeBackoff;
}

/** ms from `now` until the quiet window's `endMinute`, plus a small positive
 *  jitter so the resume scan doesn't land on the exact same wall-clock second
 *  each morning. Positive-only jitter keeps the wake at or after the window ends. */
function msUntilQuietEnds(now: Date, quiet: QuietHours, jitterMinutes: number, rand: Rand): number {
  let mins = quiet.endMinute - minutesOfDay(now);
  if (mins <= 0) mins += DAY_MINUTES; // end is later today, or tomorrow
  return Math.round((mins + rand() * jitterMinutes) * MIN);
}

/**
 * The one call the scan loop makes to arm its next alarm. Composes the pieces:
 * back-off decides the effective interval, jitter scatters it, and if the
 * resulting fire time would land inside quiet hours the wake is pushed to the end
 * of the window instead (with `willResumeFromQuiet` so the caller uses catch-up
 * depth). Pure: the only clock read is `params.now`, and randomness is injected.
 */
export function nextScanDelayMs(params: NextScanParams, rand: Rand = Math.random): NextScan {
  const { now, baseIntervalMinutes, jitterMinutes, consecutiveEmptyScans, quietHours, backoff } =
    params;
  const effective = backoffIntervalMinutes(baseIntervalMinutes, consecutiveEmptyScans, backoff);
  const delayMs = jitteredDelayMs(effective, jitterMinutes, rand);
  const fireAt = new Date(now.getTime() + delayMs);
  // `isWithinQuietHours` already returns false when the window is disabled.
  if (isWithinQuietHours(minutesOfDay(fireAt), quietHours)) {
    return { delayMs: msUntilQuietEnds(now, quietHours, jitterMinutes, rand), willResumeFromQuiet: true };
  }
  return { delayMs, willResumeFromQuiet: false };
}

/**
 * A single in-cycle pause length (PRD §15, decision 5 / §9). Uniform in
 * `[minMs, maxMs]`, so the 3–5s between pages and ~8–12s between watches are
 * randomised rather than a fixed metronome, for the same reason the interval is
 * jittered.
 */
export function randomPauseMs([minMs, maxMs]: readonly [number, number], rand: Rand = Math.random): number {
  return Math.round(minMs + rand() * (maxMs - minMs));
}
