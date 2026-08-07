import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { findResultsScroller, parseJobCards, parsePostedAge, postingIdsOn } from "./parse.ts";

/** Parse an HTML string into a Document the way the content script sees one. */
function doc(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

/** One card in the shape issue #2 found on the authenticated /jobs/search DOM. */
function cardHtml(opts: {
  jobId?: string;
  occludableId?: string;
  title?: string;
  company?: string;
  location?: string;
  posted?: string;
  datetime?: string;
  href?: string;
  footer?: string;
  footerState?: string;
}): string {
  const {
    jobId,
    occludableId,
    title = "Staff Engineer",
    company = "Acme Corp",
    location = "Jakarta, Indonesia",
    posted = "2 hours ago",
    datetime,
    href = `/jobs/view/${jobId ?? occludableId ?? "0"}/?trk=foo`,
    footer = "",
    footerState = "",
  } = opts;
  // A dateless card (Viewed/Promoted) renders no <time> at all — that absence is
  // exactly what the parser reads as "no posting date".
  const time = posted || datetime
    ? `<li><time${datetime ? ` datetime="${datetime}"` : ""}>${posted}</time></li>`
    : "";
  return `
    <li ${occludableId ? `data-occludable-job-id="${occludableId}"` : ""}>
      <div class="job-card-container" ${jobId ? `data-job-id="${jobId}"` : ""}>
        <a class="job-card-container__link" href="${href}">
          <div class="artdeco-entity-lockup__title">
            <span aria-hidden="true">${title}</span><span class="visually-hidden">${title}</span>
          </div>
        </a>
        <div class="artdeco-entity-lockup__subtitle">${company}</div>
        <div class="artdeco-entity-lockup__caption">${location}</div>
        <ul class="job-card-container__metadata-wrapper">
          ${time}
          ${footerState ? `<li class="job-card-container__footer-job-state">${footerState}</li>` : ""}
          ${footer ? `<li class="job-card-container__footer-item">${footer}</li>` : ""}
        </ul>
      </div>
    </li>`;
}

function page(cards: string[]): Document {
  return doc(`<ul class="scaffold-layout__list-container">${cards.join("")}</ul>`);
}

test("parseJobCards reads a whole card off the authenticated DOM (issue #2 selectors)", () => {
  const jobs = parseJobCards(page([cardHtml({ jobId: "4012345678" })]));
  assert.equal(jobs.length, 1);
  const j = jobs[0]!;
  assert.equal(j.id, "4012345678");
  assert.equal(j.title, "Staff Engineer");
  assert.equal(j.company, "Acme Corp");
  assert.equal(j.location, "Jakarta, Indonesia");
  assert.equal(j.postedText, "2 hours ago");
  assert.equal(j.url, "https://www.linkedin.com/jobs/view/4012345678/");
  assert.equal(j.isReposted, false);
  // Scan-context fields are stamped in later; parse leaves neutral defaults.
  assert.equal(j.watchId, "");
  assert.equal(j.foundAt, 0);
  assert.equal(j.opened, false);
  assert.equal(j.openedAt, null);
});

test("id falls back to the enclosing <li> data-occludable-job-id when data-job-id is absent", () => {
  const jobs = parseJobCards(page([cardHtml({ occludableId: "4099999999" })]));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, "4099999999");
});

test("each field fails independently — a blank company leaves the rest intact (§12)", () => {
  const jobs = parseJobCards(page([cardHtml({ jobId: "1", company: "" })]));
  assert.equal(jobs.length, 1);
  const j = jobs[0]!;
  assert.equal(j.company, ""); // gone
  assert.equal(j.title, "Staff Engineer"); // still here
  assert.equal(j.location, "Jakarta, Indonesia");
  assert.equal(j.postedText, "2 hours ago");
});

test("cards missing id, url or title are dropped via isSavableJob (§16.4)", () => {
  const jobs = parseJobCards(
    page([
      cardHtml({ jobId: "1" }), // savable
      cardHtml({ jobId: "2", title: "" }), // no title → dropped
      cardHtml({ jobId: "3", href: "" }), // no url → dropped
      cardHtml({ title: "Ghost", href: "/jobs/collections/recommended/" }), // no numeric id → dropped
    ]),
  );
  assert.deepEqual(
    jobs.map((j) => j.id),
    ["1"],
  );
});

test("isReposted is true only for the Reposted marker", () => {
  const [reposted] = parseJobCards(page([cardHtml({ jobId: "1", footer: "Reposted" })]));
  assert.equal(reposted!.isReposted, true);
});

test("isReposted is never triggered by Promoted or Easy Apply", () => {
  const jobs = parseJobCards(
    page([
      cardHtml({ jobId: "1", footer: "Promoted" }),
      cardHtml({ jobId: "2", footer: "Easy Apply" }),
    ]),
  );
  assert.deepEqual(
    jobs.map((j) => j.isReposted),
    [false, false],
  );
});

test("isReposted matches the marker even when it carries a date — 'Reposted 3 days ago'", () => {
  const [j] = parseJobCards(page([cardHtml({ jobId: "1", footer: "Reposted 3 days ago" })]));
  assert.equal(j!.isReposted, true);
});

test("isReposted ignores the word 'reposted' in a description snippet — only the footer marker counts (issue #30 item 1)", () => {
  // The permanent-over-block case: `hideReposted` filters this out AND writes it
  // to `seen`, so a whole-card textContent match on a description mentioning the
  // word strands the job forever. The marker lives in the footer, not the body.
  const jobs = parseJobCards(
    page([
      `<li data-occludable-job-id="1">
         <div class="job-card-container" data-job-id="1">
           <a class="job-card-container__link" href="/jobs/view/1/">
             <div class="artdeco-entity-lockup__title"><span aria-hidden="true">Editor</span></div>
           </a>
           <div class="job-card-list__description">We hire fast — this role was reposted after our last editor left.</div>
           <ul class="job-card-container__metadata-wrapper">
             <li class="job-card-container__footer-item"><time>2 hours ago</time></li>
           </ul>
         </div>
       </li>`,
    ]),
  );
  assert.equal(jobs[0]!.isReposted, false);
});

test("isReposted ignores the word 'reposted' in the title", () => {
  const [j] = parseJobCards(page([cardHtml({ jobId: "1", title: "Reposted Content Manager" })]));
  assert.equal(j!.isReposted, false);
});

// ── posting date and the footer's exclusive state (issue #48) ───────────

test("the parser resolves the <time datetime> attribute to midnight UTC, day precision", () => {
  const [j] = parseJobCards(
    page([cardHtml({ jobId: "1", posted: "3 weeks ago", datetime: "2026-07-17" })]),
  );
  assert.equal(j!.postedAt, Date.UTC(2026, 6, 17));
  assert.equal(j!.postedPrecision, "day");
  assert.equal(j!.postedText, "3 weeks ago"); // the words are kept unchanged
  assert.equal(j!.linkedInStatus, "posted");
});

test("a card with a phrase but no datetime attribute leaves postedAt for stampJobs (null, no precision)", () => {
  // The parser holds no clock, so it cannot turn "3 weeks ago" into a date on its
  // own — it leaves postedAt null and stampJobs fills it from foundAt.
  const [j] = parseJobCards(page([cardHtml({ jobId: "1", posted: "3 weeks ago" })]));
  assert.equal(j!.postedAt, null);
  assert.equal(j!.postedPrecision, null);
  assert.equal(j!.linkedInStatus, "posted");
});

test("a Viewed card carries no date and reads its status from the named footer slot", () => {
  const [j] = parseJobCards(
    page([cardHtml({ jobId: "1", posted: "", footerState: "Viewed" })]),
  );
  assert.equal(j!.postedAt, null);
  assert.equal(j!.postedPrecision, null);
  assert.equal(j!.postedText, "");
  assert.equal(j!.linkedInStatus, "viewed");
});

test("linkedInStatus reads Promoted and Applied from the footer, and falls back to the footer strip", () => {
  const [promoted] = parseJobCards(
    page([cardHtml({ jobId: "1", posted: "", footerState: "Promoted" })]),
  );
  assert.equal(promoted!.linkedInStatus, "promoted");
  // Fallback: no named slot, the word only in the footer strip.
  const [applied] = parseJobCards(page([cardHtml({ jobId: "2", posted: "", footer: "Applied" })]));
  assert.equal(applied!.linkedInStatus, "applied");
});

test("a card with neither a date nor a readable state has linkedInStatus null", () => {
  const [j] = parseJobCards(page([cardHtml({ jobId: "1", posted: "" })]));
  assert.equal(j!.linkedInStatus, null);
  assert.equal(j!.postedAt, null);
});

test("parsePostedAge takes the first number+unit, ignoring the visually-hidden suffix (issue #43)", () => {
  const age = parsePostedAge("53 minutes ago Within the past 24 hours");
  assert.deepEqual(age, { offsetMs: 53 * 60_000, precise: true });
});

test("parsePostedAge marks sub-day units precise and coarse units estimated by their midpoint", () => {
  assert.deepEqual(parsePostedAge("6 hours ago"), { offsetMs: 6 * 3_600_000, precise: true });
  // "3 weeks ago" spans 21–27 days → the 24-day midpoint, not precise.
  assert.deepEqual(parsePostedAge("3 weeks ago"), { offsetMs: 24 * 86_400_000, precise: false });
});

test("parsePostedAge returns null for a non-English phrase rather than throwing", () => {
  assert.equal(parsePostedAge("il y a 3 semaines"), null);
  assert.equal(parsePostedAge("yesterday"), null);
});

test("url strips LinkedIn's tracking query (?trk=...) down to the canonical path", () => {
  const [j] = parseJobCards(
    page([cardHtml({ jobId: "1", href: "/jobs/view/1/?trk=flagship&refId=xyz" })]),
  );
  assert.equal(j!.url, "https://www.linkedin.com/jobs/view/1/");
});

test("an empty results page yields no jobs (no throw)", () => {
  assert.deepEqual(parseJobCards(doc("<ul></ul>")), []);
});

// ── markup variants and the occludable list ──────────────────────────────────
// CARD_SELECTOR is a union because LinkedIn A/B-tests card markup and hashes its
// class names; measured live on 2026-07-24 a single page held 25 occludable
// slots, 11 `div.job-card-container` and 13 `[data-job-id]` — three different
// numbers for the same list. These prove the union reads all of them and still
// emits each posting exactly once.

test("a posting matched by both its <li> and its inner card yields one job, not two", () => {
  const jobs = parseJobCards(page([cardHtml({ jobId: "1", occludableId: "1" })]));
  assert.deepEqual(
    jobs.map((j) => j.id),
    ["1"],
  );
});

test("an unmaterialised slot yields no phantom job", () => {
  // What an occluded row actually looks like: the slot holds its id and its
  // height, and nothing else. It has an id but no title or url, so it is dropped
  // — and, crucially, not marked seen, so it is read properly once it paints.
  const jobs = parseJobCards(page([`<li data-occludable-job-id="4444258335"></li>`]));
  assert.deepEqual(jobs, []);
});

test("a half-materialised list reads the painted rows and skips the empty slots", () => {
  const jobs = parseJobCards(
    page([
      cardHtml({ jobId: "1", occludableId: "1" }),
      `<li data-occludable-job-id="2"></li>`,
      `<li data-occludable-job-id="3"></li>`,
      cardHtml({ jobId: "4", occludableId: "4" }),
    ]),
  );
  assert.deepEqual(
    jobs.map((j) => j.id),
    ["1", "4"],
  );
});

test("a card carrying only data-job-id parses, without the job-card-container class", () => {
  // The 13 `[data-job-id]` vs 11 `.job-card-container` gap on the live page: two
  // postings were rendered in a variant the old single-class selector never saw.
  const jobs = parseJobCards(
    page([
      `<li data-occludable-job-id="7">
         <div data-job-id="7" class="job-card-job-posting-card-wrapper">
           <a class="job-card-job-posting-card-wrapper__card-link" href="/jobs/view/7/">
             <span aria-hidden="true">Backend Engineer</span>
           </a>
           <div class="artdeco-entity-lockup__subtitle">Tiket</div>
         </div>
       </li>`,
    ]),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, "7");
  assert.equal(jobs[0]!.title, "Backend Engineer");
  assert.equal(jobs[0]!.company, "Tiket");
});

// ── finding the results column ───────────────────────────────────────────────
// Measured on the live page, the element that scrolls the results list has a
// build-hashed class ("CooICPkKTliGzVJcDSWmuBCrvdJUuwNJpibRI") and none of the
// documented names matched it, so it is found by what it does instead: the
// nearest scrollable ancestor of a job card.

/** Mark an element as scrollable the way the browser would report it. */
function makeScrollable(el: Element): Element {
  Object.defineProperty(el, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 700, configurable: true });
  return el;
}

/** A Window stand-in: `overflow-y: auto` for anything tagged, else `visible`. */
const fakeWin = {
  getComputedStyle: (el: Element) => ({
    overflowY: el.hasAttribute("data-scrolls") ? "auto" : "visible",
  }),
} as unknown as Window;

/** The live layout's shape: a named-but-static outer list, a hash-named scroller
 *  holding the cards, and a *separate* scrollable details pane on the right. */
function layout(): Document {
  const d = doc(`
    <div class="scaffold-layout__list">
      <div class="CooICPkKTliGzVJcDSWmuBCrvdJUuwNJpibRI" data-scrolls>
        <ul>${cardHtml({ jobId: "1", occludableId: "1" })}</ul>
      </div>
    </div>
    <div class="jobs-search__job-details--wrapper" data-scrolls></div>`);
  d.querySelectorAll("[data-scrolls]").forEach(makeScrollable);
  return d;
}

test("findResultsScroller finds the hash-named column by structure, not by name", () => {
  const found = findResultsScroller(layout(), fakeWin);
  assert.equal(found?.className, "CooICPkKTliGzVJcDSWmuBCrvdJUuwNJpibRI");
});

test("findResultsScroller never picks the job-details pane, which holds no cards", () => {
  const found = findResultsScroller(layout(), fakeWin);
  assert.ok(!found?.className.includes("job-details"));
});

test("findResultsScroller skips ancestors that clip instead of scrolling", () => {
  // `.scaffold-layout__list` is an ancestor of the cards and is taller than its
  // box, but it clips — scrolling it is a no-op, and stopping there is the bug.
  const d = layout();
  makeScrollable(d.querySelector(".scaffold-layout__list")!); // tall, but no overflow-y
  assert.equal(
    findResultsScroller(d, fakeWin)?.className,
    "CooICPkKTliGzVJcDSWmuBCrvdJUuwNJpibRI",
  );
});

test("findResultsScroller falls back to a documented name when no ancestor scrolls", () => {
  const d = doc(`
    <div class="jobs-search-results-list" data-scrolls>
      <ul>${cardHtml({ jobId: "1" })}</ul>
    </div>`);
  // Only the named container scrolls, and the walk up from the card reaches it.
  makeScrollable(d.querySelector(".jobs-search-results-list")!);
  assert.ok(findResultsScroller(d, fakeWin)?.className.includes("jobs-search-results-list"));
});

test("a card whose title lives only in the posting link still parses", () => {
  // The second card layout LinkedIn serves: none of the named title classes are
  // present, and the title is simply the text of the link to the posting. All 5
  // such cards on the measured page were dropped for "no title" — among them both
  // postings originally reported missing (4444332379, 4444258335).
  const jobs = parseJobCards(
    page([
      `<li data-occludable-job-id="4444332379">
         <div class="display-flex job-card-container" data-job-id="4444332379">
           <a href="/jobs/view/4444332379/?trk=x">
             <strong>Web Programmer Executive</strong>
             <span class="visually-hidden">Web Programmer Executive with verification</span>
           </a>
           <div class="artdeco-entity-lockup__subtitle">GF Culinary</div>
         </div>
       </li>`,
    ]),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, "4444332379");
  assert.equal(jobs[0]!.title, "Web Programmer Executive");
  assert.equal(jobs[0]!.url, "https://www.linkedin.com/jobs/view/4444332379/");
});

test("the link fallback prefers the visible title over the screen-reader copy", () => {
  const jobs = parseJobCards(
    page([
      `<li data-occludable-job-id="9">
         <div class="job-card-container" data-job-id="9">
           <a href="/jobs/view/9/">
             <span aria-hidden="true">DevOps Engineer I</span>
             <span class="visually-hidden">DevOps Engineer I with verification</span>
           </a>
         </div>
       </li>`,
    ]),
  );
  assert.equal(jobs[0]!.title, "DevOps Engineer I");
});

test("named title selectors still win over the posting-link fallback", () => {
  // The fallback must not shadow the precise selectors on the 20-of-25 layout.
  const jobs = parseJobCards(
    page([
      `<li data-occludable-job-id="10">
         <div class="job-card-container" data-job-id="10">
           <div class="artdeco-entity-lockup__title"><span aria-hidden="true">Staff Engineer</span></div>
           <a href="/jobs/view/10/">Staff Engineer at Acme in Jakarta, Indonesia (On-site)</a>
         </div>
       </li>`,
    ]),
  );
  assert.equal(jobs[0]!.title, "Staff Engineer");
});

test("field selectors fall back in order, first non-empty wins", () => {
  const jobs = parseJobCards(
    page([
      `<li>
         <div class="job-card-container" data-job-id="8">
           <a href="/jobs/view/8/"><div class="job-card-list__title">Data Engineer</div></a>
           <div class="artdeco-entity-lockup__subtitle"></div>
           <div class="job-card-container__primary-description">CariKerja.IT</div>
         </div>
       </li>`,
    ]),
  );
  assert.equal(jobs[0]!.title, "Data Engineer");
  // An empty preferred selector must not shadow a populated later one.
  assert.equal(jobs[0]!.company, "CariKerja.IT");
});

// The captured-fixture proof (PRD §14). Fixtures are gitignored and captured by
// hand (issue #2), so this skips cleanly when the file is absent — the ticket
// does not wait on that capture, and the test starts running by itself once the
// page is saved.
const FIXTURE = path.resolve(
  import.meta.dirname,
  "../.scratch/linkedin-job-watcher/fixtures/page-1/",
);

function fixtureHtml(): string | null {
  let dir: string;
  try {
    dir = fs.statSync(FIXTURE).isDirectory() ? FIXTURE : "";
  } catch {
    return null;
  }
  if (!dir) return null;
  const html = fs.readdirSync(dir).find((f) => f.endsWith(".html") || f.endsWith(".htm"));
  return html ? fs.readFileSync(path.join(dir, html), "utf8") : null;
}

test("parses a captured page-1 fixture — every rendered posting becomes a job, full count (§14, issue #30 item 3)", (t) => {
  const html = fixtureHtml();
  if (html === null) {
    t.skip("no page-1 fixture captured — see issue #2 / #30 checklist");
    return;
  }
  const d = doc(html);
  const jobs = parseJobCards(d);
  // The count assertion, not just "at least one". `postingIdsOn` is what the page
  // *rendered*; every one of those must parse into a job. The drift this exists to
  // catch — two card layouts, 5 of 25 postings dropped for having no title — shows
  // up here as jobs < rendered rather than shipping as a silent partial read, and
  // deliberately breaking one title selector turns this red.
  const rendered = postingIdsOn(d);
  assert.ok(rendered.length > 0, "expected the fixture to contain rendered job cards");
  assert.equal(
    jobs.length,
    rendered.length,
    `every rendered posting must parse into a job: ${rendered.length} rendered, ${jobs.length} parsed`,
  );
  for (const j of jobs) {
    assert.match(j.id, /^\d+$/, "every parsed job carries a numeric LinkedIn id");
    assert.notEqual(j.title.trim(), "", "every parsed job carries a title");
    assert.match(j.url, /\/jobs\/view\/\d+/, "every parsed job carries a view url");
  }
});
