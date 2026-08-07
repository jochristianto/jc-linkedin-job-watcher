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
 * - `ok`                — results list present, ≥1 card parsed, whole list read.
 * - `empty`             — results list present, 0 cards. A genuine "no results
 *                         for this search" (failure 3): the page rendered fine.
 * - `partial`           — the page rendered and parsed, but only part of it was
 *                         read: the walk didn't finish, or well under the slots
 *                         the page declared came back. Postings were silently
 *                         missed, which is the failure this whole extension is
 *                         supposed to prevent, so it is never reported as `ok`.
 * - `structure-changed` — the results list itself was absent. Selectors are dead
 *                         — LinkedIn moved the DOM (PRD §12), not an empty search.
 * - `search-moved`      — the results list was absent *and* the tab did not land
 *                         on the classic `/jobs/search/` surface: LinkedIn moved
 *                         this account onto its newer `/jobs/search-results/` page
 *                         (PRD §16, issue #50 / #47), which the reader can't parse
 *                         yet. A specific, nameable cause of `structure-changed`.
 * - `logged-out`        — the tab landed on a login wall / authwall (failure 1).
 * - `challenge`         — landed on a checkpoint / captcha / verification page
 *                         (failure 2). The most dangerous for the account.
 * - `load-failed`       — the tab never loaded: timeout, network down, 5xx
 *                         (failure 5). An infra failure, not a parser signal.
 */
export type PageOutcome =
  | "ok"
  | "empty"
  | "partial"
  | "structure-changed"
  | "search-moved"
  | "logged-out"
  | "challenge"
  | "load-failed";

/** Read at least this share of the postings a page declared before calling the
 *  read complete. Not 1.0 on purpose: a promoted or ghost slot can occupy a row
 *  without ever yielding a job id, so demanding every slot would warn forever.
 *
 *  Tightened from 0.8 after a measured 21-of-25 read (0.84) passed as healthy
 *  while dropping 4 real postings — including the two the user reported missing.
 *  A page that declares 25 rows and yields 22 is now worth a look. The false-
 *  positive risk is low: every one of the 25 slots on the measured page was a
 *  genuine posting, no ghosts. An amber badge you can dismiss is far cheaper than
 *  a job you never hear about, which is the whole point of the extension. */
export const COMPLETE_READ_RATIO = 0.9;

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
  /** Distinct postings that actually **rendered** (see `postingIdsOn`, parse.ts) —
   *  not the slots reserved for them. */
  cardCount: number;
  /** Postings that rendered *and* parsed into a usable job. */
  savedCount: number;
  /** Posting slots the page declared, or 0 when it declares none (no yardstick). */
  slotCount: number;
  /** Whether the walk down the list ran to completion. */
  settled: boolean;
};

/**
 * Did the scan read the whole list, or only part of it? True when the walk gave
 * up early, or when the page declared slots and well under
 * {@link COMPLETE_READ_RATIO} of them came back.
 *
 * Split out and exported because "we read 11 of the 25 postings on this page"
 * was, for the entire life of this extension, indistinguishable from a perfect
 * scan: the only card signal was `cardCount >= 1`. A silent partial read is
 * strictly worse than a loud failure — the user reads an empty list as "no new
 * jobs" and stops checking — so it gets its own signal.
 */
export function isPartialRead(
  s: Pick<PageSignals, "cardCount" | "savedCount" | "slotCount" | "settled">,
): boolean {
  if (s.cardCount === 0) return false; // an empty page is `empty`, not partial
  if (!s.settled) return true;
  // Rendered but unparseable — the fields drifted out from under the selectors.
  if (s.savedCount < s.cardCount * COMPLETE_READ_RATIO) return true;
  if (s.slotCount === 0) return false; // no yardstick — nothing to be short of
  // Promised but never rendered. Checked against `savedCount`, not `cardCount`:
  // the first version of this compared the slots the page declared against a
  // count that was itself derived from those same slots, so it was comparing a
  // number with itself and could never fire. A page that reserves 25 rows and
  // yields 4 jobs is the exact failure being watched for.
  return s.savedCount < s.slotCount * COMPLETE_READ_RATIO;
}

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
  if (!s.hasResultsList) {
    // Same broken outcome, but a nameable cause when we can point to it: a tab
    // that ended anywhere other than the classic `/jobs/search/` surface was
    // moved onto LinkedIn's newer results page, which the reader can't parse yet
    // (issue #50 / #47). Ranked below logged-out/challenge above, so this URL
    // check can never outrank an account-safety signal.
    if (!url.includes("/jobs/search/")) return "search-moved";
    return "structure-changed";
  }
  if (s.cardCount === 0) return "empty";
  if (isPartialRead(s)) return "partial";
  return "ok";
}

/** Worst-first ranking (PRD §16): the aggregated outcome of a cycle is the most
 *  severe page outcome across every watch, so one challenged tab halts the whole
 *  cycle even if the others read fine. */
const RANK: Record<PageOutcome, number> = {
  ok: 0,
  empty: 1,
  "load-failed": 2,
  // Above load-failed: a page that didn't load is transient and retried, a page
  // that loaded and was only half-read drops postings on every single cycle.
  partial: 3,
  "structure-changed": 4,
  // Above structure-changed: same amber severity, but when a cycle has both, the
  // specific "moved to the new surface" message is the one worth showing (#50).
  "search-moved": 5,
  "logged-out": 6,
  challenge: 7,
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
 * - `search-moved`     → same as structure-changed, but with the specific message
 *                        that LinkedIn moved the account to its new results page
 *                        (§16, issue #50) — actionable, not a shrug.
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
    case "search-moved": {
      // A named structure-changed: warn at once and feed the same back-off
      // counter, but say *why* the page can't be read — LinkedIn moved this
      // account onto its newer results surface, unsupported for now (#50 / #47).
      const n = prior.consecutiveEmptyScans + 1;
      return {
        mode: "active",
        severity: "warn",
        consecutiveEmptyScans: n,
        message:
          "LinkedIn moved your search to its new results page, which this extension cannot read yet.",
        notify: false,
      };
    }
    case "partial":
      // Warn at once, like structure-changed: reading half a page is unambiguous,
      // there is nothing to wait and see about. The empty-scan counter is left
      // alone deliberately — this scan found jobs, and backing the cadence off
      // would mean reading even less of the list, not more.
      return {
        mode: "active",
        severity: "warn",
        consecutiveEmptyScans: prior.consecutiveEmptyScans,
        message: "Only part of the results list could be read — some new postings were probably missed.",
        notify: false,
      };
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

/** The persisted push-failure record (`'pushHealth'` storage key, PRD §16.7). Kept
 *  apart from the scan {@link HealthState} because push failures are independent of
 *  scan health — a scan can read fine while a wrong chat id silently drops every
 *  message — and reset on their own schedule (one good send). */
export type PushHealthState = { consecutivePushFailures: number; warn: boolean };

/** The healthy starting point for push (no failures, no warning). */
export const OK_PUSH_HEALTH: PushHealthState = { consecutivePushFailures: 0, warn: false };

/** The soft warning surfaced in the popup and options once push has failed
 *  `pushFailWarnThreshold` times in a row (PRD §16.7). Never a desktop
 *  notification — a wrong chat id is a config mistake, not an account-safety event. */
export const PUSH_FAILING_MESSAGE = "Telegram push has been failing — run Send test message";

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
): PushHealthState {
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
