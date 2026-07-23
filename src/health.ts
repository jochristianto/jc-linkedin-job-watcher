// Failure diagnosis & surfacing — PRD §16 "What happens when it breaks, and how
// do you find out?" (resolves issue #9 / ticket 08).
//
// The scan runs unattended every few minutes, so silence is indistinguishable
// from "no new jobs" — the failure mode §16 exists to prevent is the extension
// quietly stopping for weeks. This module is the pure-logic reference for that:
// it turns the raw signals of a scan (where each tab landed, whether the results
// list was there, how many cards parsed, whether push went through) into a
// health state with a severity and a user-facing signal.
//
// Like `filter.ts` and `schedule.ts` it touches no chrome.*, no DOM and no
// network — every signal comes in as an argument — so `node --test` proves it
// without a browser (PRD §14). The content script classifies the live page and
// hands a `PageSignals` in; `background.ts` persists the returned `HealthState`,
// sets the badge colour, and fires notifications. Those wrappers are not
// unit-tested; the decisions here are.

import type { BackoffConfig } from "./schedule.ts";

/**
 * The classified result of loading one page (PRD §16, failures 1–5). The order
 * matters: `challenge` is the account-safety signal and outranks everything.
 *
 * - `ok`                — results list present, ≥1 card parsed.
 * - `empty`             — results list present, 0 cards. A genuine "no results
 *                         for this search" (failure 3): the page rendered fine.
 * - `structure-changed` — the results list itself was absent. Selectors are dead
 *                         — LinkedIn moved the DOM (PRD §12), not an empty search.
 * - `logged-out`        — the tab landed on a login wall / authwall (failure 1).
 * - `challenge`         — landed on a checkpoint / captcha / verification page
 *                         (failure 2). The most dangerous for the account.
 * - `load-failed`       — the tab never loaded: timeout, network down, 5xx
 *                         (failure 5). An infra failure, not a parser signal.
 */
export type PageOutcome =
  | "ok"
  | "empty"
  | "structure-changed"
  | "logged-out"
  | "challenge"
  | "load-failed";

/** The structured signals the content script reads off one page load. Pure: the
 *  live-DOM reading happens in the wrapper, the *decision* happens here. */
export type PageSignals = {
  /** The tab failed to load at all — navigation error, timeout, or HTTP 5xx. */
  navError: boolean;
  /** Where the tab actually ended up (LinkedIn redirects logged-out / challenged
   *  sessions), lower- or mixed-case; compared case-insensitively. */
  finalUrl: string;
  /** Whether the job-results list *container* is present in the DOM at all. Its
   *  absence (not merely zero cards inside it) is the structure-changed signal. */
  hasResultsList: boolean;
  /** Distinct job cards parsed (see `extractJobIds`, scan-probe.ts). */
  cardCount: number;
};

/**
 * Classify one page load into a {@link PageOutcome} (PRD §16, failures 1–5).
 * Precedence is by account-safety, not by the order signals happen to arrive:
 * a navigation failure is reported as such; otherwise a challenge outranks a
 * login wall, which outranks a dead selector, which outranks an empty-but-valid
 * results page. This is what tells "no results for this search" apart from
 * "LinkedIn changed the page" (failure 3) — the difference is `hasResultsList`.
 */
export function classifyPage(s: PageSignals): PageOutcome {
  if (s.navError) return "load-failed";
  const url = s.finalUrl.toLowerCase();
  // Challenge / verification first — this is the signal that matters most (§16.2).
  if (url.includes("/checkpoint/") || url.includes("/challenge")) return "challenge";
  if (
    url.includes("/authwall") ||
    url.includes("/login") ||
    url.includes("/uas/login") ||
    url.includes("/signup")
  ) {
    return "logged-out";
  }
  if (!s.hasResultsList) return "structure-changed";
  if (s.cardCount === 0) return "empty";
  return "ok";
}

/** Worst-first ranking (PRD §16): the aggregated outcome of a cycle is the most
 *  severe page outcome across every watch, so one challenged tab halts the whole
 *  cycle even if the others read fine. */
const RANK: Record<PageOutcome, number> = {
  ok: 0,
  empty: 1,
  "load-failed": 2,
  "structure-changed": 3,
  "logged-out": 4,
  challenge: 5,
};

/**
 * Collapse a whole cycle's per-page outcomes into the single worst one (PRD §16).
 * An empty list of pages (no enabled watches) is `ok` — nothing was scanned, so
 * nothing is wrong. Used to drive {@link reduceScanHealth}.
 */
export function aggregateOutcome(pages: PageOutcome[]): PageOutcome {
  return pages.reduce<PageOutcome>((worst, p) => (RANK[p] > RANK[worst] ? p : worst), "ok");
}

/** How scanning should proceed after a cycle (PRD §16.2/§16.8):
 *  - `active`  — normal cadence.
 *  - `paused`  — logged out; scanning waits for the user to sign back in.
 *  - `halted`  — a challenge/captcha; scanning stops until the user clears it.
 *    Halting on a challenge is the single most important account-safety move. */
export type ScanMode = "active" | "paused" | "halted";

/**
 * Whether the routine scan should run this tick, given the current mode (§16.1/
 * §16.2). `active` and `paused` both scan — a paused (logged-out) cycle keeps
 * probing precisely so a later `ok` scan can auto-resume it. Only `halted` (a
 * challenge) stops entirely, and stays stopped until the user manually resumes.
 */
export function shouldRunScan(mode: ScanMode): boolean {
  return mode !== "halted";
}

/** Badge/severity level surfaced to the user (PRD §16.8). Maps to a badge colour:
 *  `ok`→default, `warn`→amber, `error`→red. */
export type Severity = "ok" | "warn" | "error";

/**
 * The persisted health record (`'health'` storage key, PRD §16.8). The reducer
 * below is a pure function of the previous record and the latest scan, so the
 * whole "how do you find out it broke" surface is one testable transition.
 */
export type HealthState = {
  mode: ScanMode;
  severity: Severity;
  /** Consecutive scans that loaded but yielded no cards anywhere — the §15
   *  back-off counter. Drives both the interval (schedule.ts) and the warning. */
  consecutiveEmptyScans: number;
  /** Banner text for the popup (PRD §16.8), or null when healthy. */
  message: string | null;
  /** True on the transition *into* a hard state — the caller fires one desktop
   *  notification (not one per scan). Soft warnings never notify (§16.8). */
  notify: boolean;
};

/** The healthy starting point. */
export const OK_HEALTH: HealthState = {
  mode: "active",
  severity: "ok",
  consecutiveEmptyScans: 0,
  message: null,
  notify: false,
};

/**
 * Fold the latest cycle's aggregated outcome into the health record (PRD §16).
 * The decisions, in the precedence the outcome ranking enforces:
 *
 * - `challenge`        → **halt** scanning entirely and raise a hard, red signal
 *                        (§16.2). Notify only on the transition in, so the user
 *                        gets one alert, not one every tick.
 * - `logged-out`       → **pause** and raise a hard signal (§16.1); resumes when
 *                        the user signs in and a later scan comes back `ok`.
 * - `structure-changed`→ a dead selector is unambiguous, so warn **immediately**
 *                        (amber), no threshold wait (§16.3). Still counts toward
 *                        the empty-scan back-off.
 * - `empty`            → could just be a quiet search, so it only warns once it
 *                        has repeated `emptyScansBeforeBackoff` times (§16.3 /
 *                        §15.6). Increments the counter.
 * - `load-failed`      → infra, not a parser signal (§16.5): stays `active`,
 *                        leaves the empty-scan counter untouched, no warning in
 *                        v1 (the retry/skip is handled upstream).
 * - `ok`               → clears everything back to {@link OK_HEALTH}.
 */
export function reduceScanHealth(
  prior: HealthState,
  outcome: PageOutcome,
  cfg: BackoffConfig,
): HealthState {
  switch (outcome) {
    case "challenge":
      return {
        mode: "halted",
        severity: "error",
        consecutiveEmptyScans: 0,
        message: "LinkedIn asked for verification — scanning stopped. Open LinkedIn, clear it, then resume.",
        notify: prior.mode !== "halted",
      };
    case "logged-out":
      return {
        mode: "paused",
        severity: "error",
        consecutiveEmptyScans: 0,
        message: "Signed out of LinkedIn — scanning paused. Sign in and it resumes automatically.",
        notify: prior.mode !== "paused",
      };
    case "structure-changed": {
      const n = prior.consecutiveEmptyScans + 1;
      return {
        mode: "active",
        severity: "warn",
        consecutiveEmptyScans: n,
        message: "No job list on the page — LinkedIn may have changed its layout. Reading may be broken.",
        notify: false,
      };
    }
    case "empty": {
      const n = prior.consecutiveEmptyScans + 1;
      const tripped = n >= cfg.emptyScansBeforeBackoff;
      return {
        mode: "active",
        severity: tripped ? "warn" : "ok",
        consecutiveEmptyScans: n,
        message: tripped
          ? "Several scans in a row found nothing — reading may be broken, or every search is genuinely quiet."
          : null,
        notify: false,
      };
    }
    case "load-failed":
      // Transient infra: keep the current picture, don't touch the empty counter.
      return { ...prior, notify: false };
    case "ok":
      return { ...OK_HEALTH };
  }
}

/**
 * Whether a parsed job is complete enough to save and show (PRD §16.4 — partial
 * parse). Each field fails independently (PRD §12): `company`/`location` may come
 * back blank and the job is still saved (the list view drops blank meta parts).
 * But `id`, `title` and `url` are load-bearing — id for dedupe, url to open,
 * title to have something to show — so a job missing any of the three is dropped.
 */
export function isSavableJob(job: { id: string; title: string; url: string }): boolean {
  return job.id.trim() !== "" && job.title.trim() !== "" && job.url.trim() !== "";
}

/**
 * Soft selector-drift signal (PRD §16.4): given the jobs from a scan, is `field`
 * empty on *every* one? A single blank company is a per-job quirk; blank across
 * all cards means that field's selector likely drifted. Returns false for an
 * empty set (nothing parsed is a §16.3 concern, handled by the outcome, not here).
 */
export function fieldMissingAcrossAll(
  jobs: ReadonlyArray<Record<string, string>>,
  field: string,
): boolean {
  return jobs.length > 0 && jobs.every((j) => (j[field] ?? "").trim() === "");
}

/**
 * Push-failure tracking (PRD §16.7). §8 swallows every push failure so it can
 * never break the scan — that stays. But a wrong chat id fails silently for days
 * (§8), so this counts *consecutive* failures and asks the caller to surface a
 * soft warning once they reach `warnThreshold`. One good send resets it. Never a
 * desktop notification, never breaks the scan.
 */
export function reducePushHealth(
  ok: boolean,
  priorFailures: number,
  warnThreshold: number,
): { consecutivePushFailures: number; warn: boolean } {
  if (ok) return { consecutivePushFailures: 0, warn: false };
  const n = priorFailures + 1;
  return { consecutivePushFailures: n, warn: n >= warnThreshold };
}

/** Minimal view of the persisted scan lock (PRD §5 `ScanState`). */
export type LockState = {
  isScanning: boolean;
  startedAt: number | null;
};

/**
 * Is the scan lock stale (PRD §16.6)? PRD §9 only clears a stale lock on startup,
 * but the MV3 worker can be torn down mid-cycle on *any* tick (PRD §12), leaving
 * `isScanning` stuck true — so this runs on **every alarm tick**, not just
 * startup. A lock held longer than `staleAfterMs` (default 5 min, comfortably
 * above the 60–90s a real cycle takes, §9) is stale and cleared before scanning.
 * `isScanning` with no `startedAt` is corrupt and treated as stale.
 */
export function isLockStale(lock: LockState, now: number, staleAfterMs: number): boolean {
  if (!lock.isScanning) return false;
  if (lock.startedAt === null) return true;
  return now - lock.startedAt >= staleAfterMs;
}
