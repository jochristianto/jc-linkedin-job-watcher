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

import { jobIdOf, type CardLike } from "./scan-probe.ts";
import { isSavableJob } from "./health.ts";
import type { Job } from "./types.ts";

/** The authenticated search page wraps each posting in a job-card container. */
const CARD_SELECTOR = "div.job-card-container";

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
        return card.querySelector('a[href*="/jobs/view/"]')?.getAttribute("href") ?? null;
      }
      return null;
    },
  };
}

/** LinkedIn duplicates visible text into a `visually-hidden` sibling for screen
 *  readers, so a naive `textContent` reads "TitleTitle". Prefer the
 *  `aria-hidden="true"` copy when present; fall back to the element's own text.
 *  Collapse whitespace so multi-line markup reads as one clean string. */
function fieldText(card: Element, selector: string): string {
  const el = card.querySelector(selector);
  if (!el) return "";
  const strong = el.querySelector('[aria-hidden="true"]');
  return norm((strong ?? el).textContent);
}

function norm(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** The canonical posting URL, tracking query stripped. Read from the card's
 *  `/jobs/view/<id>/` anchor so it fails independently of the id (§12): a card
 *  with an id but no link comes back with a blank url and is dropped downstream. */
function jobUrlOf(card: Element): string {
  const href = card.querySelector('a[href*="/jobs/view/"]')?.getAttribute("href")?.trim();
  if (!href) return "";
  try {
    const u = new URL(href, "https://www.linkedin.com");
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/** True only for LinkedIn's "Reposted" marker. "Promoted" and "Easy Apply" are
 *  distinct badges that never contain the word, so a word-boundary match on the
 *  card's metadata text distinguishes them (§16, issue #2 finding 3). */
function isRepostedCard(card: Element): boolean {
  return /\breposted\b/i.test(norm(card.textContent));
}

/**
 * Turn a LinkedIn job-search Document into `Job[]`. Each field is read
 * independently (§12): a blank company or location leaves the rest of the job
 * intact. Cards whose `id`, `url` or `title` are missing are dropped via
 * `isSavableJob` (§16.4) — the three load-bearing fields.
 *
 * The scan-context fields (`foundAt`, `watchId`, `opened`, `openedAt`) are not on
 * the page; they are stamped in by the scan loop (a later ticket) and left at
 * neutral defaults here so this stays pure.
 */
export function parseJobCards(doc: Document): Job[] {
  const cards = Array.from(doc.querySelectorAll(CARD_SELECTOR));
  const jobs: Job[] = [];
  for (const card of cards) {
    const id = jobIdOf(identityOf(card)) ?? "";
    const job: Job = {
      id,
      title: fieldText(card, ".artdeco-entity-lockup__title"),
      company: fieldText(card, ".artdeco-entity-lockup__subtitle"),
      location: fieldText(card, ".artdeco-entity-lockup__caption"),
      isReposted: isRepostedCard(card),
      postedText: fieldText(card, "time"),
      url: jobUrlOf(card),
      foundAt: 0,
      watchId: "",
      opened: false,
      openedAt: null,
    };
    if (isSavableJob(job)) jobs.push(job);
  }
  return jobs;
}
