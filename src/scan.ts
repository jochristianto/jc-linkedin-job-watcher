// Scan cycle — the pure decisions the background scan loop makes (PRD §9 "Scan
// cycle" / §5 / §7). `background.ts` is the side-effect wrapper: it opens the
// invisible tabs, fires the alarm and sets the badge, and calls these functions
// for every choice that isn't a raw `chrome.*` call (PRD §14 — "anything that is
// only an orchestration of chrome.* calls is not unit-tested"). Everything here
// is a pure function of its arguments, so `node --test` proves it without a
// browser, the same shape as filter.ts / schedule.ts / dedupe.ts.

import type { Job, Watch } from "./types.ts";
import type { JobsMap } from "./storage.ts";
import type { Severity } from "./health.ts";

/** Postings per results page on `/jobs/search/` — the `&start=` step (PRD §9:
 *  `url + &start=(page-1)*25`). */
const RESULTS_PER_PAGE = 25;

/** Above this the badge shows `99+` rather than a wide, unreadable number. */
const BADGE_CAP = 99;

/** The message `background.ts` sends the invisible scan tab; the content script
 *  scroll-settles the lazy list, parses it, and replies with {@link ScanResponse}.
 *  A single shared shape so the two wrappers agree without redefining it. The
 *  `token` is the one-time injection token (PRD §9): the content script only reads
 *  a page whose own URL carries the same token, so a LinkedIn tab the user opened
 *  by hand — which has no token — is never scraped. */
export type ScanRequest = { type: "LJW_SCAN"; token: string };

/** Fragment key under which `background.ts` stamps a page's one-time scan token.
 *  A URL *fragment* (never sent to LinkedIn) so the server sees the plain search
 *  URL; only the content script, reading `location.hash`, sees the token. */
export const SCAN_TOKEN_KEY = "ljw_token";

/**
 * Stamp a one-time injection token onto a scan URL's fragment (PRD §9). The token
 * proves the background opened this tab: only it ever writes the fragment, so a
 * tab the user opened themselves never carries one. Returns a fresh URL string;
 * the query (keywords, `sortBy=DD`, `start=`) is left untouched.
 */
export function withScanToken(url: string, token: string): string {
  const u = new URL(url);
  const params = new URLSearchParams(u.hash.replace(/^#/, ""));
  params.set(SCAN_TOKEN_KEY, token);
  u.hash = params.toString();
  return u.toString();
}

/** The one-time token a page's fragment carries, or null if it carries none
 *  (a hand-opened LinkedIn tab). `hash` is `window.location.hash` (with or
 *  without the leading `#`). */
export function readScanToken(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return params.get(SCAN_TOKEN_KEY) || null;
}

/**
 * Does the LJW_SCAN message's token match the token embedded in the page (PRD §9)?
 * An exact, non-empty match — an absent page token (`null`), an empty token, or a
 * missing message token never matches, so the content script refuses to read any
 * tab the background did not itself prepare.
 */
export function scanTokenMatches(pageToken: string | null, messageToken: string | undefined): boolean {
  return pageToken != null && pageToken !== "" && pageToken === messageToken;
}

export type ScanResponse = {
  /** The jobs parsed from the settled page (scan-context fields still neutral —
   *  `background.ts` stamps them with {@link stampJobs}). */
  jobs: Job[];
  /** Whether the list stabilised before the poll timeout (`pollUntilSettled`).
   *  A settled=false, zero-card page is the invisible-tab assumption failing
   *  (issue #5, Q1/Q4) — the ticket-#15 stop condition. */
  settled: boolean;
  /** Where the tab actually ended up — `window.location.href`. LinkedIn redirects
   *  a logged-out / challenged session, so this is what `classifyPage` keys on to
   *  tell those apart from a real search page (PRD §16.1/§16.2). */
  finalUrl: string;
  /** Whether the results-list *container* is in the DOM at all (§16.3): absent is
   *  `structure-changed`, present-but-empty is a genuine `empty`. NEVER a bare
   *  "0 cards" — the container flag is what makes the two distinguishable. */
  hasResultsList: boolean;
  /** Distinct job cards on the settled page — the classification signal, not the
   *  count of *savable* jobs (a card missing a load-bearing field still rendered). */
  cardCount: number;
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

/** The badge background colour for a health severity (PRD §16.8): the default
 *  slate for a healthy count, amber for a soft warning, red for a hard failure. */
export function badgeColor(severity: Severity): string {
  switch (severity) {
    case "error":
      return "#d11124"; // red — a hard failure (logged-out / challenge)
    case "warn":
      return "#b45309"; // amber — a soft warning (structure-changed / stalled)
    case "ok":
      return "#5b7083"; // slate — the ordinary unopened-count badge
  }
}

/**
 * The toolbar badge's `{ text, color }` for a given unopened count and health
 * severity (PRD §16.8). A healthy badge is just the count in slate. A hard
 * failure always shows a red `!` — even at zero unopened jobs — so the break is
 * visible when there is no count to colour; a warning keeps the count but turns
 * amber (or shows the `!` marker when nothing is unopened).
 */
export function badgeFor(count: number, severity: Severity): { text: string; color: string } {
  const color = badgeColor(severity);
  if (severity === "error") return { text: "!", color };
  const text = badgeText(count);
  if (severity === "warn" && text === "") return { text: "!", color };
  return { text, color };
}
