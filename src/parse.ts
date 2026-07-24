// Read a LinkedIn job-search page into `Job[]` (issue #13 / ticket 02, PRD §12).
//
// This is the load-bearing piece: if the selectors below are wrong, everything
// downstream silently returns nothing. `parseJobCards` is PURE (§14) — it reads a
// `Document` and nothing else: no `chrome.*`, no live `document`, no network. The
// content script (content.ts) is the only thing that hands it the live page.
//
// The selectors are issue #2's evidence-backed hypotheses against the
// authenticated `/jobs/search/` DOM. Public "LinkedIn scraping" guides document
// the *guest* DOM and return nothing here. `src/parse.test.ts` proves these
// against small hand-written cards always, and against a captured fixture when
// one is present.

import { extractJobIds, jobIdOf, type CardLike } from "./scan-probe.ts";
import { isSavableJob } from "./health.ts";
import type { Job } from "./types.ts";

/** The authenticated search page wraps each posting in a job-card container.
 *  Exported so the content script counts and settles the same cards this parses,
 *  single-sourcing the selector instead of keeping a hand-synced copy.
 *
 *  A *union*, not one class, because LinkedIn A/B-tests card markup: a single
 *  variant we don't match reads as "that posting doesn't exist" rather than as a
 *  breakage, which is the silent-miss failure this whole module exists to avoid.
 *  The occludable `<li>` is in the union deliberately — it is the one node that
 *  survives whether or not the row has been materialised — and overlapping
 *  matches are safe because {@link parseJobCards} dedupes on the job id. */
export const CARD_SELECTOR =
  "li[data-occludable-job-id], div.job-card-container, div.job-card-job-posting-card-wrapper, div[data-job-id]";

/** The card containers that only exist once a row has actually **rendered** —
 *  {@link CARD_SELECTOR} minus the occludable `<li>`, which is present from first
 *  paint whether or not its contents ever materialise.
 *
 *  The distinction is the whole diagnostic. Counting `<li>`s tells you what the
 *  page promised; counting these tells you what it delivered. Conflating them is
 *  how a scan that rendered 4 of 25 postings reported itself healthy. */
export const MATERIALISED_CARD_SELECTOR =
  "div.job-card-container, div.job-card-job-posting-card-wrapper, div[data-job-id]";

/** The posting *slots* the page declares, materialised or not. LinkedIn renders a
 *  fixed-height `<li>` per result and only fills in its contents near the
 *  viewport, so this is the page's own claim about how many results it holds —
 *  the denominator the scan compares its parsed count against to notice a
 *  truncated read (§16.3). Zero means the page doesn't use occludable slots and
 *  the scan has no independent expectation to check itself against. */
export const SLOT_SELECTOR = "li[data-occludable-job-id]";

/** The results-list *container* that holds the cards (PRD §16.3). Its presence —
 *  independent of whether it has any cards inside — is what tells an empty-but-
 *  valid search apart from a dead layout: absent means LinkedIn moved the DOM
 *  (`structure-changed`), present-but-empty means a genuine no-results (`empty`).
 *  A union of the containers issue #2 saw on the authenticated `/jobs/search/`
 *  DOM, so a single moved class name doesn't read as the whole list vanishing. */
export const RESULTS_LIST_SELECTOR =
  ".scaffold-layout__list, .scaffold-layout__list-container, ul.jobs-search__results-list, .jobs-search-results-list, .jobs-search-results__list, div[data-results-list-top-scroll-sentinel]";

/** Last-resort candidate scroll containers for the results column, most specific
 *  first — used only if the structural search below finds nothing.
 *
 *  The results list is its own overflow region: the *window* barely scrolls on
 *  `/jobs/search/`, so scrolling the window materialises nothing. But the column
 *  can no longer be found by name either — measured against the live page on
 *  2026-07-24, the scrolling element's class is a build-hashed string
 *  (`CooICPkKTliGzVJcDSWmuBCrvdJUuwNJpibRI`) that changes with LinkedIn's build,
 *  and of the names below only `.scaffold-layout__list` was still present, on a
 *  non-scrolling ancestor. Hence {@link findResultsScroller}: identify the column
 *  by what it *does* (it scrolls, and it contains the cards), not what it is
 *  called. These names remain as a fallback for older//variant layouts. */
export const SCROLLER_SELECTORS = [
  ".scaffold-layout__list-container",
  ".jobs-search-results-list",
  ".jobs-search-results__list",
  ".scaffold-layout__list",
];

/** Can this element actually scroll vertically? Both halves matter: an element
 *  can be taller than its box but clip with `overflow: hidden` (scrolling it is a
 *  no-op), and one can be scrollable in principle but currently hold no overflow. */
function isScrollable(el: Element, view: { getComputedStyle(e: Element): { overflowY: string } }): boolean {
  return (
    /auto|scroll|overlay/.test(view.getComputedStyle(el).overflowY) &&
    el.scrollHeight > el.clientHeight + 1
  );
}

/**
 * Find the element that scrolls the results column, structurally: start at the
 * first job card and walk up to the nearest scrollable ancestor.
 *
 * Deliberately not selector-based. LinkedIn ships build-hashed class names on
 * this element, so any name we hard-code is wrong by the next deploy — but
 * "the nearest scrollable ancestor of a job card" stays true across renames, and
 * cannot accidentally pick the job-*details* pane on the right, which holds no
 * cards. Falls back to {@link SCROLLER_SELECTORS} and then to the document, so a
 * layout with no scrollable column still scrolls *something* rather than nothing.
 */
export function findResultsScroller(doc: Document, win: Window): Element | null {
  const anchor = doc.querySelector(CARD_SELECTOR) ?? doc.querySelector(RESULTS_LIST_SELECTOR);
  for (let node = anchor?.parentElement; node; node = node.parentElement) {
    if (isScrollable(node, win)) return node;
  }
  for (const selector of SCROLLER_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el && isScrollable(el, win)) return el;
  }
  return doc.scrollingElement ?? null;
}

/** The nested anchor that carries the canonical `/jobs/view/<id>/` posting link —
 *  the source both the id fallback and the url read from, so it lives once here. */
const VIEW_LINK_SELECTOR = 'a[href*="/jobs/view/"]';

/** A card's identity attributes are spread across three elements: `data-job-id`
 *  on the container, `data-occludable-job-id` on the enclosing `<li>`, and the
 *  `/jobs/view/<id>/` href on a nested anchor. This view resolves each where it
 *  actually lives, so `jobIdOf`'s existing three-tier fallback (scan-probe.ts)
 *  works unchanged instead of being reimplemented here. */
function identityOf(card: Element): CardLike {
  return {
    getAttribute(name: string): string | null {
      const own = card.getAttribute(name);
      if (own != null) return own;
      if (name === "data-occludable-job-id") {
        return card.closest("[data-occludable-job-id]")?.getAttribute(name) ?? null;
      }
      if (name === "href") {
        return card.querySelector(VIEW_LINK_SELECTOR)?.getAttribute("href") ?? null;
      }
      return null;
    },
  };
}

/** Where each display field lives, in preference order. Tried one selector at a
 *  time — not as one comma-union — because `querySelector` on a union returns the
 *  first match in *document* order, not the first *selector* that matches, which
 *  on a mixed-markup card silently reads the wrong node. First non-empty wins. */
const TITLE_SELECTORS = [
  ".artdeco-entity-lockup__title",
  ".job-card-list__title",
  ".job-card-list__title--link",
  "a.job-card-container__link",
  "a.job-card-job-posting-card-wrapper__card-link",
  // Last resorts, keyed off the posting link rather than a class name. Measured
  // on the live page, 5 of 25 cards used a layout none of the names above match,
  // and every one of them was silently dropped for having no title — including
  // both postings originally reported missing. The link to the posting is the one
  // thing a job card cannot lack, so its own text is the safest floor.
  // Narrowest first: `strong` and the aria-hidden span hold just the title, while
  // the bare anchor may wrap the whole card on some layouts.
  'a[href*="/jobs/view/"] strong',
  'a[href*="/jobs/view/"] span[aria-hidden="true"]',
  'a[href*="/jobs/view/"]',
];
const COMPANY_SELECTORS = [
  ".artdeco-entity-lockup__subtitle",
  ".job-card-container__primary-description",
  ".job-card-container__company-name",
];
const LOCATION_SELECTORS = [
  ".artdeco-entity-lockup__caption",
  ".job-card-container__metadata-item",
  ".job-card-container__metadata-wrapper li",
];

/** LinkedIn duplicates visible text into a `visually-hidden` sibling for screen
 *  readers, so a naive `textContent` reads "TitleTitle". Prefer the
 *  `aria-hidden="true"` copy when present; fall back to the element's own text.
 *  Collapse whitespace so multi-line markup reads as one clean string. */
function fieldText(card: Element, selectors: string[]): string {
  for (const selector of selectors) {
    const el = card.querySelector(selector);
    if (!el) continue;
    const strong = el.querySelector('[aria-hidden="true"]');
    const text = norm((strong ?? el).textContent);
    if (text !== "") return text;
  }
  return "";
}

function norm(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** The canonical posting URL, tracking query stripped. Read from the card's
 *  `/jobs/view/<id>/` anchor so it fails independently of the id (§12): a card
 *  with an id but no link comes back with a blank url and is dropped downstream. */
function jobUrlOf(card: Element): string {
  const href = card.querySelector(VIEW_LINK_SELECTOR)?.getAttribute("href")?.trim();
  if (!href) return "";
  try {
    const u = new URL(href, "https://www.linkedin.com");
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/** Where LinkedIn's "Reposted" marker actually lives: the card's footer /
 *  metadata strip — the same row that carries the posted-date and the Promoted /
 *  Easy Apply badges — never the title and never the description snippet.
 *
 *  Narrowed here rather than matched against the whole card's `textContent`
 *  (issue #30 item 1). The over-block a whole-card match risks is *permanent*: a
 *  posting whose description merely mentions the word "reposted" is filtered out
 *  under `hideReposted: true` AND written to `seen` (dedupe.ts), so it is never
 *  re-surfaced even after the rule is corrected. Confining the match to the
 *  footer trades a theoretical missed marker (harmless — the job still shows) for
 *  no false over-block, which is the asymmetry that matters. */
const REPOSTED_MARKER_SELECTORS = [
  ".job-card-container__metadata-wrapper",
  ".job-card-container__footer-wrapper",
  ".job-card-container__footer-item",
  ".job-card-list__footer-wrapper",
  ".job-card-job-posting-card-wrapper__footer-items",
];

/** True only for LinkedIn's "Reposted" marker in the card's footer/metadata strip.
 *  "Promoted" and "Easy Apply" are distinct badges that never contain the word,
 *  and a word-boundary match keeps a title or description mentioning "reposted"
 *  from tripping it (§16, issue #2 finding 3 / issue #30 item 1). */
function isRepostedCard(card: Element): boolean {
  return REPOSTED_MARKER_SELECTORS.some((selector) =>
    Array.from(card.querySelectorAll(selector)).some((el) => /\breposted\b/i.test(norm(el.textContent))),
  );
}

/**
 * The distinct postings **rendered** in the DOM right now — the ones that have
 * real content, not the empty slots reserving space for them. Counted through the
 * same identity fallbacks {@link parseJobCards} uses, so a posting that yields an
 * id here and no job there is genuinely a field-parsing failure rather than an
 * artefact of two different counting rules.
 */
export function postingIdsOn(doc: Document): string[] {
  return extractJobIds(
    Array.from(doc.querySelectorAll(MATERIALISED_CARD_SELECTOR)).map(identityOf),
  );
}

/**
 * Turn a LinkedIn job-search Document into `Job[]`. Each field is read
 * independently (§12): a blank company or location leaves the rest of the job
 * intact. Cards whose `id`, `url` or `title` are missing are dropped via
 * `isSavableJob` (§16.4) — the three load-bearing fields.
 *
 * The scan-context fields (`foundAt`, `watchId`, `opened`/`openedAt`,
 * `read`/`readAt`) are not on the page; they are stamped in by the scan loop (a
 * later ticket) and left at neutral defaults here so this stays pure.
 */
export function parseJobCards(doc: Document): Job[] {
  const cards = Array.from(doc.querySelectorAll(CARD_SELECTOR));
  const jobs: Job[] = [];
  // Dedupe on the job id alone (PRD §5). Load-bearing here, not just tidiness:
  // CARD_SELECTOR is a union that deliberately overlaps — a materialised posting
  // matches both its occludable `<li>` and the card `<div>` nested inside it — so
  // without this every such posting would be emitted twice.
  const seen = new Set<string>();
  for (const card of cards) {
    const id = jobIdOf(identityOf(card)) ?? "";
    if (seen.has(id)) continue;
    const job: Job = {
      id,
      title: fieldText(card, TITLE_SELECTORS),
      company: fieldText(card, COMPANY_SELECTORS),
      location: fieldText(card, LOCATION_SELECTORS),
      isReposted: isRepostedCard(card),
      postedText: fieldText(card, ["time"]),
      url: jobUrlOf(card),
      foundAt: 0,
      watchId: "",
      opened: false,
      openedAt: null,
      read: false,
      readAt: null,
    };
    // An unmaterialised slot yields an id but no title/url, so it is dropped here
    // and NOT marked seen — the same posting is read properly once the walk
    // scrolls it into view and it materialises.
    if (!isSavableJob(job)) continue;
    seen.add(id);
    jobs.push(job);
  }
  return jobs;
}
