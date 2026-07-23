import { test } from "node:test";
import assert from "node:assert/strict";
import { toJobViews, unopenedCount, markJobOpened, renderPage } from "./view.ts";
import { PUSH_FAILING_MESSAGE } from "./health.ts";
import type { Job, Watch } from "./types.ts";
import type { JobsMap } from "./storage.ts";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "3901",
    title: "Senior Software Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia",
    isReposted: false,
    postedText: "2 hours ago",
    url: "https://www.linkedin.com/jobs/view/3901/",
    foundAt: 1000,
    watchId: "w-id",
    opened: false,
    openedAt: null,
    ...overrides,
  };
}

const watches: Watch[] = [
  { id: "w-id", name: "Indonesia", url: "https://x", enabled: true },
];

test("toJobViews maps a Job to a JobView and resolves the watch name", () => {
  const [v] = toJobViews([job()], watches);
  assert.equal(v!.id, "3901");
  assert.equal(v!.title, "Senior Software Engineer");
  assert.equal(v!.company, "Acme Corp");
  assert.equal(v!.watchName, "Indonesia");
  assert.equal(v!.url, "https://www.linkedin.com/jobs/view/3901/");
  assert.equal(v!.opened, false);
});

test("toJobViews orders jobs newest-first by foundAt", () => {
  const views = toJobViews(
    [
      job({ id: "old", foundAt: 100 }),
      job({ id: "new", foundAt: 900 }),
      job({ id: "mid", foundAt: 500 }),
    ],
    watches,
  );
  assert.deepEqual(
    views.map((v) => v.id),
    ["new", "mid", "old"],
  );
});

test("toJobViews fails independently: an unknown watchId leaves watchName blank", () => {
  const [v] = toJobViews([job({ watchId: "gone" })], watches);
  assert.equal(v!.watchName, "");
});

test("unopenedCount counts only jobs that have not been opened", () => {
  const jobs = [job({ id: "1" }), job({ id: "2", opened: true }), job({ id: "3" })];
  assert.equal(unopenedCount(jobs), 2);
});

test("markJobOpened sets opened + openedAt without mutating the input", () => {
  const jobs: JobsMap = { "3901": job() };
  const next = markJobOpened(jobs, "3901", 1234);
  assert.equal(next["3901"]!.opened, true);
  assert.equal(next["3901"]!.openedAt, 1234);
  // input untouched
  assert.equal(jobs["3901"]!.opened, false);
  assert.equal(jobs["3901"]!.openedAt, null);
});

test("markJobOpened leaves other jobs alone and no-ops on an unknown id", () => {
  const jobs: JobsMap = { a: job({ id: "a" }), b: job({ id: "b" }) };
  const next = markJobOpened(jobs, "a", 5);
  assert.equal(next["b"]!.opened, false);
  assert.equal(markJobOpened(jobs, "missing", 5), jobs);
});

test("renderPage shows a badge with the unopened count and drops it at zero", () => {
  const two = renderPage({
    jobs: [job({ id: "1" }), job({ id: "2" })],
    watches,
    mode: "new",
    title: "New jobs",
  });
  assert.match(two, /<span class="badge">2<\/span>/);

  const none = renderPage({
    jobs: [job({ id: "1", opened: true })],
    watches,
    mode: "all",
    title: "All",
  });
  assert.doesNotMatch(none, /class="badge"/);
});

test("renderPage badge counts unopened regardless of the view mode", () => {
  // 'all' mode shows opened jobs, but the badge still reflects unopened only.
  const html = renderPage({
    jobs: [job({ id: "1" }), job({ id: "2", opened: true })],
    watches,
    mode: "all",
    title: "All",
  });
  assert.match(html, /<span class="badge">1<\/span>/);
});

test("renderPage escapes the title", () => {
  const html = renderPage({ jobs: [], watches, mode: "new", title: "A & B" });
  assert.match(html, /A &amp; B/);
});

test("renderPage new mode hides opened jobs; all mode keeps them on screen", () => {
  const jobs = [job({ id: "1" }), job({ id: "2", opened: true })];
  const newHtml = renderPage({ jobs, watches, mode: "new", title: "New" });
  assert.match(newHtml, /data-job-id="1"/);
  assert.doesNotMatch(newHtml, /data-job-id="2"/);

  const allHtml = renderPage({ jobs, watches, mode: "all", title: "All" });
  assert.match(allHtml, /data-job-id="1"/);
  assert.match(allHtml, /data-job-id="2"/);
});

test("renderPage shows the health message as a one-line banner (§16.8)", () => {
  const html = renderPage({
    jobs: [job({ id: "1" })],
    watches,
    mode: "all",
    title: "All",
    severity: "error",
    message: "Signed out of LinkedIn — scanning paused.",
  });
  assert.match(html, /class="banner banner-error"/);
  assert.match(html, /Signed out of LinkedIn — scanning paused\./);
});

test("renderPage shows no banner when health is clear", () => {
  const html = renderPage({ jobs: [job({ id: "1" })], watches, mode: "all", title: "All" });
  assert.doesNotMatch(html, /class="banner/);
});

test("renderPage escapes the banner message", () => {
  const html = renderPage({
    jobs: [],
    watches,
    mode: "new",
    title: "New",
    severity: "warn",
    message: "a < b & c",
  });
  assert.match(html, /a &lt; b &amp; c/);
});

test("renderPage shows the soft push-failing warning when pushWarn is set (§16.7)", () => {
  const html = renderPage({
    jobs: [job({ id: "1" })],
    watches,
    mode: "all",
    title: "All",
    pushWarn: true,
  });
  assert.match(html, /class="banner banner-warn"/);
  assert.match(html, new RegExp(PUSH_FAILING_MESSAGE.replace(/[.*+?^${}()|[\]\\—]/g, "\\$&")));
});

test("renderPage shows no push warning when pushWarn is false", () => {
  const html = renderPage({ jobs: [job({ id: "1" })], watches, mode: "all", title: "All" });
  assert.doesNotMatch(html, new RegExp(PUSH_FAILING_MESSAGE.slice(0, 20)));
});

test("renderPage shows both the health banner and the push warning at once", () => {
  const html = renderPage({
    jobs: [job({ id: "1" })],
    watches,
    mode: "all",
    title: "All",
    severity: "error",
    message: "Signed out of LinkedIn — scanning paused.",
    pushWarn: true,
  });
  assert.match(html, /class="banner banner-error"/);
  assert.match(html, /class="banner banner-warn"/);
});

test("renderPage picks the right empty state for each situation", () => {
  // no watches configured
  assert.match(
    renderPage({ jobs: [], watches: [], mode: "new", title: "New" }),
    /data-kind="no-watches"/,
  );
  // watches exist but nothing scanned yet
  assert.match(
    renderPage({ jobs: [], watches, mode: "new", title: "New" }),
    /data-kind="no-jobs-yet"/,
  );
  // jobs exist but all opened, in New mode → all caught up
  assert.match(
    renderPage({ jobs: [job({ opened: true })], watches, mode: "new", title: "New" }),
    /data-kind="no-new"/,
  );
  // scan is broken → scan-error, whatever else is true
  assert.match(
    renderPage({ jobs: [], watches, mode: "new", title: "New", severity: "error" }),
    /data-kind="scan-error"/,
  );
});
