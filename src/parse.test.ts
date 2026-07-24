import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { findResultsScroller, parseJobCards } from "./parse.ts";

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
  href?: string;
  footer?: string;
}): string {
  const {
    jobId,
    occludableId,
    title = "Staff Engineer",
    company = "Acme Corp",
    location = "Jakarta, Indonesia",
    posted = "2 hours ago",
    href = `/jobs/view/${jobId ?? occludableId ?? "0"}/?trk=foo`,
    footer = "",
  } = opts;
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
          <li><time>${posted}</time></li>
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

test("parses a captured page-1 fixture into jobs with ids and titles (§14)", (t) => {
  const html = fixtureHtml();
  if (html === null) {
    t.skip("no page-1 fixture captured — see issue #2 checklist");
    return;
  }
  const jobs = parseJobCards(doc(html));
  assert.ok(jobs.length > 0, "expected the fixture to contain at least one job card");
  for (const j of jobs) {
    assert.match(j.id, /^\d+$/, "every parsed job carries a numeric LinkedIn id");
    assert.notEqual(j.title.trim(), "", "every parsed job carries a title");
    assert.match(j.url, /\/jobs\/view\/\d+/, "every parsed job carries a view url");
  }
});
