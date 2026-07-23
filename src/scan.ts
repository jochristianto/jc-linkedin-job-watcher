// Scan cycle — the pure decisions the background scan loop makes (PRD §9 "Scan
// cycle" / §5 / §7). `background.ts` is the side-effect wrapper: it opens the
// invisible tabs, fires the alarm and sets the badge, and calls these functions
// for every choice that isn't a raw `chrome.*` call (PRD §14 — "anything that is
// only an orchestration of chrome.* calls is not unit-tested"). Everything here
// is a pure function of its arguments, so `node --test` proves it without a
// browser, the same shape as filter.ts / schedule.ts / dedupe.ts.

import type { Job, Watch } from "./types.ts";
import type { JobsMap } from "./storage.ts";

/** Postings per results page on `/jobs/search/` — the `&start=` step (PRD §9:
 *  `url + &start=(page-1)*25`). */
const RESULTS_PER_PAGE = 25;

/** Above this the badge shows `99+` rather than a wide, unreadable number. */
const BADGE_CAP = 99;

/** The message `background.ts` sends the invisible scan tab; the content script
 *  scroll-settles the lazy list, parses it, and replies with {@link ScanResponse}.
 *  A single shared shape so the two wrappers agree without redefining it. */
export type ScanRequest = { type: "LJW_SCAN" };

export type ScanResponse = {
  /** The jobs parsed from the settled page (scan-context fields still neutral —
   *  `background.ts` stamps them with {@link stampJobs}). */
  jobs: Job[];
  /** Whether the list stabilised before the poll timeout (`pollUntilSettled`).
   *  A settled=false, zero-card page is the invisible-tab assumption failing
   *  (issue #5, Q1/Q4) — the ticket-#15 stop condition. */
  settled: boolean;
};

/** The enabled watches to scan, in their saved order (PRD §9: "for each enabled
 *  watch, sequentially"). Disabled watches are skipped entirely. */
export function enabledWatches(watches: Watch[]): Watch[] {
  return watches.filter((w) => w.enabled);
}

/**
 * The results URL for page `page` (1-based) of a watch (PRD §9). Sets — not
 * appends — the `start` offset to `(page-1)*25`, so page 1 is `start=0` and a
 * saved search that already carries a `start=` is corrected rather than doubled.
 * The rest of the query (keywords, `sortBy=DD`, filters) is preserved verbatim.
 */
export function scanPageUrl(watchUrl: string, page: number): string {
  const u = new URL(watchUrl);
  u.searchParams.set("start", String((page - 1) * RESULTS_PER_PAGE));
  return u.toString();
}

/**
 * Stamp the scan-context fields `parseJobCards` deliberately leaves neutral
 * (PRD §5/§12): which watch surfaced each job and when. Returns fresh records —
 * the parser's output is not mutated — so the same parsed array could be stamped
 * for more than one watch without cross-talk.
 */
export function stampJobs(jobs: Job[], watchId: string, foundAt: number): Job[] {
  return jobs.map((job) => ({ ...job, watchId, foundAt }));
}

/**
 * Merge freshly-found jobs into the persisted `jobs` map (PRD §6), keyed by id.
 * A job already in the store keeps its stored record — crucially its
 * `opened`/`openedAt` state — so a re-scan of a job the user already opened does
 * not silently reset it back to unopened and re-inflate the badge.
 */
export function mergeJobs(existing: JobsMap, newJobs: Job[]): JobsMap {
  const merged: JobsMap = { ...existing };
  for (const job of newJobs) {
    if (!(job.id in merged)) merged[job.id] = job;
  }
  return merged;
}

/** The unopened-job count the badge shows (PRD §7). */
export function unopenedCount(jobs: JobsMap): number {
  return Object.values(jobs).filter((j) => !j.opened).length;
}

/** The badge label for a count: empty (no badge) at zero, `99+` past the cap,
 *  otherwise the number. Chrome renders an empty string as no badge at all. */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  if (count > BADGE_CAP) return `${BADGE_CAP}+`;
  return String(count);
}
