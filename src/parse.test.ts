import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { parseJobCards } from "./parse.ts";

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
