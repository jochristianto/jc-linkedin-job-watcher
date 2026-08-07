// Save a copy of the live LinkedIn job-search page (issue #49, PRD §16 / #46).
//
// When LinkedIn changes its card markup the parser goes quiet, and the only way
// to diagnose it used to be pasting JavaScript into DevTools — which failed twice
// in practice before it produced a usable file. The early-warning message (#54)
// tells the user "the Options page has a button for it"; this is the pure half of
// that button (§14).
//
// It holds the DECISIONS — which open tab to capture, what the file is called, and
// the sentence each outcome shows — and nothing else: no chrome.*, no DOM, no
// clock read (the caller passes `capturedAt`), so `node --test` proves it without
// a browser, the same shape as backup.ts / scan.ts. The two thin wrappers are the
// Diagnostics card in `options-page.tsx` (which finds the tab and downloads the
// file) and the `LJW_CAPTURE` handler in `content.ts` (which scrolls and
// serialises the page).

/**
 * The message the Options page sends the LinkedIn tab's content script to ask it
 * to scroll the results list until the cards materialise and hand back the
 * serialised page.
 *
 * Unlike {@link import("./scan.ts").ScanRequest} it carries no one-time token: the
 * token gate exists to stop the *background* scraping a tab the user opened by
 * hand, and a capture is precisely the user asking to save that hand-opened tab,
 * from a click on the extension's own Options page. Only extension contexts can
 * message the content script (there is no `externally_connectable`), so a web page
 * can never trigger it.
 */
export type CaptureRequest = { type: "LJW_CAPTURE" };

/** What the content script reports back after walking and serialising the page. */
export type CaptureResponse = {
  /** The whole page as HTML — `document.documentElement.outerHTML`, ready to write
   *  to a file the fixture test in `parse.test.ts` can read back. */
  html: string;
  /** Where the tab actually is — `window.location.href`. A signed-out session that
   *  expired while sitting on `/jobs/search/` lands on an authwall, which
   *  {@link isLoggedOutUrl} reads off this. */
  finalUrl: string;
  /** Whether the results-list container is in the DOM. A capture is worth saving
   *  even when this is false — a page with no list is exactly the breakage the
   *  capture exists to diagnose — so it is informational, never a refusal. */
  hasResultsList: boolean;
  /** Distinct postings that rendered during the walk, for the "saved N postings"
   *  status. Zero is not an error: it means an empty or broken page, still worth a
   *  file. */
  cardCount: number;
};

/** The three states the capture cannot proceed from, each with a distinct next
 *  step to report (an AC: none of them may fail silently). */
export type CaptureFailure = "no-linkedin-tab" | "not-search-page" | "logged-out";

/** The subset of `chrome.tabs.Tab` {@link pickCaptureTab} reads. */
export type TabLike = { id?: number; url?: string };

export type PickResult =
  | { ok: true; tabId: number }
  | { ok: false; reason: CaptureFailure };

/** The LinkedIn URL of a tab, or null if it is not on linkedin.com (or has no
 *  readable URL — a tab whose host the extension has no permission for reports an
 *  empty `url`). */
function linkedInUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname === "linkedin.com" || u.hostname.endsWith(".linkedin.com") ? u : null;
  } catch {
    return null;
  }
}

/** The classic `/jobs/search/` page, with or without its trailing slash. The new
 *  `/jobs/search-results/` surface is deliberately *not* matched — it is out of
 *  scope (#47), and the selectors this extension reads have only ever been
 *  verified against the classic page. */
function isJobSearchUrl(url: string | undefined): boolean {
  const u = linkedInUrl(url);
  return u !== null && /^\/jobs\/search\/?$/.test(u.pathname);
}

/**
 * Is this URL one of the pages LinkedIn bounces a signed-out or challenged
 * session to? The same set `classifyPage` (health.ts) keys the `logged-out` /
 * `challenge` outcomes on — an authwall, a login or signup form, or a checkpoint.
 *
 * Exported because it is needed in two places: when picking the tab (a tab already
 * sitting on an authwall), and after the capture (a session that expired while the
 * tab was open and only redirected once it was messaged).
 */
export function isLoggedOutUrl(url: string | undefined): boolean {
  const u = linkedInUrl(url);
  if (!u) return false;
  const p = u.pathname.toLowerCase();
  return (
    p.includes("/authwall") ||
    p.includes("/login") ||
    p.includes("/uas/login") ||
    p.includes("/checkpoint") ||
    p.includes("/challenge") ||
    p.includes("/signup")
  );
}

/**
 * Choose the tab to capture from the browser's open tabs, or say why none will do.
 *
 * The three refusals are the failure modes the ticket names, told apart because
 * each needs a different thing from the user: no LinkedIn tab open at all, a
 * LinkedIn tab that is not on the job search, and a LinkedIn tab that has been
 * bounced to a login wall. The best case is checked first — a real `/jobs/search/`
 * tab wins even when a login tab is also open — so the message only reports a
 * problem when there is genuinely no page to capture.
 */
export function pickCaptureTab(tabs: TabLike[]): PickResult {
  const linkedIn = tabs.filter((t) => linkedInUrl(t.url) !== null);
  if (linkedIn.length === 0) return { ok: false, reason: "no-linkedin-tab" };

  const search = linkedIn.find((t) => t.id !== undefined && isJobSearchUrl(t.url));
  if (search?.id !== undefined) return { ok: true, tabId: search.id };

  if (linkedIn.some((t) => isLoggedOutUrl(t.url))) return { ok: false, reason: "logged-out" };
  return { ok: false, reason: "not-search-page" };
}

/** What the download is called: `linkedin-jobs-search-2026-08-07.html`. Dated like
 *  the backup file, so a folder of captures sorts newest-last and reads in order;
 *  `.html` so the gated fixture test in `parse.test.ts` picks it up by extension. */
export function captureFilename(capturedAt: number): string {
  const date = new Date(capturedAt).toISOString().slice(0, 10);
  return `linkedin-jobs-search-${date}.html`;
}

// ── What the outcome says ────────────────────────────────────────────────────

/** The outcome of one capture attempt: the file saved (with the count it holds),
 *  a tab-selection refusal, an unreachable tab, or a write failure. */
export type CaptureOutcome =
  | { kind: "saved"; cardCount: number }
  | { kind: CaptureFailure }
  | { kind: "unreachable" }
  | { kind: "failed" };

export type CaptureStatus = { message: string; kind: "ok" | "err" | "" };

/**
 * The status line each outcome shows. Every one either confirms the save or says
 * what to do next — an AC is that no failure is silent, so there is no empty
 * message and no bare "it didn't work".
 */
export function captureMessage(outcome: CaptureOutcome): CaptureStatus {
  switch (outcome.kind) {
    case "saved":
      return {
        kind: "ok",
        message:
          outcome.cardCount > 0
            ? `Saved the page — ${outcome.cardCount} ${outcome.cardCount === 1 ? "posting" : "postings"} on it. Check your downloads.`
            : "Saved the page — no postings rendered on it, which is itself worth capturing. Check your downloads.",
      };
    case "no-linkedin-tab":
      return {
        kind: "err",
        message: "No LinkedIn tab is open — open your job search on LinkedIn, then try again.",
      };
    case "not-search-page":
      return {
        kind: "err",
        message: "Your LinkedIn tab isn’t on a job search — open a /jobs/search/ page and try again.",
      };
    case "logged-out":
      return {
        kind: "err",
        message: "You’re signed out of LinkedIn — sign in, open your job search, then try again.",
      };
    case "unreachable":
      return {
        kind: "err",
        message: "Couldn’t reach the LinkedIn tab — reload it and try again.",
      };
    case "failed":
      return { kind: "err", message: "The page could not be saved." };
  }
}
