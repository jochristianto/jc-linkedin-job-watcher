import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toJobViews,
  unreadCount,
  markJobOpened,
  markAllRead,
  setJobRead,
  toggleBlockedCompany,
  renderPage,
  scanButtonState,
} from "./view.ts";
import { PUSH_FAILING_MESSAGE } from "./health.ts";
import type { Job, Watch, BlockedCompany } from "./types.ts";
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
    read: false,
    readAt: null,
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

test("toJobViews derives blocked from the blocklist, so unblocking un-greys rows", () => {
  const jobs = [job({ id: "1", company: "Acme Corp" }), job({ id: "2", company: "Globex" })];
  const views = toJobViews(jobs, watches, ["acme"]);
  assert.equal(views.find((v) => v.id === "1")!.blocked, true);
  assert.equal(views.find((v) => v.id === "2")!.blocked, false);
  // Same jobs, empty blocklist: nothing blocked, no per-job fixup needed.
  assert.equal(toJobViews(jobs, watches, [])[0]!.blocked, false);
});

test("unreadCount counts unread jobs — opening one does not decrement it", () => {
  const jobs = [job({ id: "1" }), job({ id: "2", read: true }), job({ id: "3" })];
  assert.equal(unreadCount(jobs), 2);
  // Opened but not read still counts: it's still sitting in your list.
  assert.equal(unreadCount([job({ id: "1", opened: true, read: false })]), 1);
});

test("unreadCount ignores blocked companies, so blocking quiets the badge", () => {
  const jobs = [job({ id: "1", company: "Acme Corp" }), job({ id: "2", company: "Globex" })];
  assert.equal(unreadCount(jobs, []), 2);
  assert.equal(unreadCount(jobs, ["acme"]), 1);
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

test("markJobOpened does NOT mark the job read — that is the tick button's job", () => {
  const next = markJobOpened({ "3901": job() }, "3901", 1234);
  assert.equal(next["3901"]!.read, false);
  assert.equal(next["3901"]!.readAt, null);
});

test("markJobOpened keeps the first openedAt when you re-open a job", () => {
  const jobs: JobsMap = { a: job({ id: "a", opened: true, openedAt: 5 }) };
  assert.equal(markJobOpened(jobs, "a", 999), jobs);
});

test("markJobOpened leaves other jobs alone and no-ops on an unknown id", () => {
  const jobs: JobsMap = { a: job({ id: "a" }), b: job({ id: "b" }) };
  const next = markJobOpened(jobs, "a", 5);
  assert.equal(next["b"]!.opened, false);
  assert.equal(markJobOpened(jobs, "missing", 5), jobs);
});

test("setJobRead marks one job read without mutating the input", () => {
  const jobs: JobsMap = { "3901": job() };
  const next = setJobRead(jobs, "3901", true, 1234);
  assert.equal(next["3901"]!.read, true);
  assert.equal(next["3901"]!.readAt, 1234);
  assert.equal(jobs["3901"]!.read, false);
});

test("setJobRead toggles back, clearing readAt so an undone tick leaves no trace", () => {
  const jobs: JobsMap = { a: job({ id: "a", read: true, readAt: 500 }) };
  const next = setJobRead(jobs, "a", false, 999);
  assert.equal(next["a"]!.read, false);
  assert.equal(next["a"]!.readAt, null);
});

test("setJobRead no-ops (same reference) on an unknown id or an unchanged flag", () => {
  const jobs: JobsMap = { a: job({ id: "a", read: true, readAt: 5 }) };
  assert.equal(setJobRead(jobs, "missing", true, 1), jobs);
  assert.equal(setJobRead(jobs, "a", true, 999), jobs);
});

test("markAllRead reads every unread job without mutating the input", () => {
  const jobs: JobsMap = {
    a: job({ id: "a", read: false }),
    b: job({ id: "b", read: true, readAt: 5 }),
  };
  const next = markAllRead(jobs, 999);
  assert.equal(next["a"]!.read, true);
  assert.equal(next["a"]!.readAt, 999);
  // already-read jobs keep their original readAt
  assert.equal(next["b"]!.readAt, 5);
  // input untouched
  assert.equal(jobs["a"]!.read, false);
});

test("markAllRead no-ops (same reference) when nothing is unread", () => {
  const jobs: JobsMap = { a: job({ id: "a", read: true }) };
  assert.equal(markAllRead(jobs, 1), jobs);
});

// ── Blocking a company from a row ────────────────────────────────────────────

const blocklist = (...names: string[]): BlockedCompany[] =>
  names.map((n) => ({ display: n, normalized: n.toLowerCase() }));

test("toggleBlockedCompany adds the company in the same shape Options writes", () => {
  const next = toggleBlockedCompany([], "  Acme Corp  ", true);
  assert.deepEqual(next, [{ display: "Acme Corp", normalized: "acme corp" }]);
});

test("toggleBlockedCompany no-ops when the company is already covered", () => {
  // "acme" already matches "Acme Corp" by substring, so blocking again would
  // only add a redundant entry to the Options list.
  const blocked = blocklist("acme");
  assert.equal(toggleBlockedCompany(blocked, "Acme Corp", true), blocked);
});

test("toggleBlockedCompany unblocks by removing every entry that matched", () => {
  // A leftover fragment would keep the company blocked and make ⊘ look broken.
  const blocked = blocklist("acme", "globex");
  assert.deepEqual(toggleBlockedCompany(blocked, "Acme Corp", false), blocklist("globex"));
});

test("toggleBlockedCompany no-ops on a blank company or an unblock of nothing", () => {
  const blocked = blocklist("acme");
  assert.equal(toggleBlockedCompany(blocked, "   ", true), blocked);
  assert.equal(toggleBlockedCompany(blocked, "Globex", false), blocked);
});

test("toggleBlockedCompany round-trips: block then unblock is a no-op overall", () => {
  const start = blocklist("globex");
  const blocked = toggleBlockedCompany(start, "Acme Corp", true);
  assert.deepEqual(toggleBlockedCompany(blocked, "Acme Corp", false), start);
});

test("renderPage renders the watch filter chips and the New/All toggle", () => {
  const html = renderPage({
    jobs: [job()],
    watches,
    mode: "new",
    title: "New jobs",
  });
  assert.match(html, /class="toolbar"/);
  assert.match(html, /data-watch-id=""[^>]*>All watches/);
  assert.match(html, /data-watch-id="w-id"[^>]*>Indonesia/);
  assert.match(html, /data-mode="new"\s+aria-pressed="true"/);
});

test("renderPage renders a Mark all as read control", () => {
  const html = renderPage({ jobs: [job()], watches, mode: "new", title: "New" });
  assert.match(html, /id="mark-all-read"/);
});

test("renderPage filters the list to the active watch chip", () => {
  const jobs = [
    job({ id: "1", watchId: "w-id" }),
    job({ id: "2", watchId: "other" }),
  ];
  const filtered = renderPage({
    jobs,
    watches,
    mode: "all",
    title: "All",
    activeWatchId: "w-id",
  });
  assert.match(filtered, /data-job-id="1"/);
  assert.doesNotMatch(filtered, /data-job-id="2"/);

  const allWatches = renderPage({ jobs, watches, mode: "all", title: "All" });
  assert.match(allWatches, /data-job-id="1"/);
  assert.match(allWatches, /data-job-id="2"/);
});

test("renderPage badge counts unread across all watches, ignoring the chip filter", () => {
  const jobs = [
    job({ id: "1", watchId: "w-id" }),
    job({ id: "2", watchId: "other" }),
  ];
  const html = renderPage({
    jobs,
    watches,
    mode: "all",
    title: "All",
    activeWatchId: "w-id",
  });
  assert.match(html, /<span class="badge">2<\/span>/);
});

test("renderPage shows the scanning empty state while a first scan is in flight", () => {
  const html = renderPage({
    jobs: [],
    watches,
    mode: "new",
    title: "New",
    scanning: true,
  });
  assert.match(html, /data-kind="scanning"/);
});

test("renderPage shows a badge with the unread count and drops it at zero", () => {
  const two = renderPage({
    jobs: [job({ id: "1" }), job({ id: "2" })],
    watches,
    mode: "new",
    title: "New jobs",
  });
  assert.match(two, /<span class="badge">2<\/span>/);

  const none = renderPage({
    jobs: [job({ id: "1", read: true })],
    watches,
    mode: "all",
    title: "All",
  });
  assert.doesNotMatch(none, /class="badge"/);
});

test("renderPage badge counts unread regardless of the view mode", () => {
  // 'all' mode shows read jobs, but the badge still reflects unread only.
  const html = renderPage({
    jobs: [job({ id: "1" }), job({ id: "2", read: true })],
    watches,
    mode: "all",
    title: "All",
  });
  assert.match(html, /<span class="badge">1<\/span>/);
});

test("renderPage badge ignores a job you merely opened — it is still waiting", () => {
  const html = renderPage({
    jobs: [job({ id: "1", opened: true, read: false })],
    watches,
    mode: "new",
    title: "New",
  });
  assert.match(html, /<span class="badge">1<\/span>/);
});

test("renderPage greys a blocked company's rows and drops them off the badge", () => {
  const html = renderPage({
    jobs: [job({ id: "1", company: "Acme Corp" }), job({ id: "2", company: "Globex" })],
    watches,
    mode: "new",
    title: "New",
    blockedCompanies: ["acme"],
  });
  // Still on screen — blocking governs future scans, it doesn't delete rows.
  assert.match(html, /data-job-id="1"[^>]*data-blocked="true"/);
  assert.match(html, /data-job-id="2"[^>]*data-blocked="false"/);
  assert.match(html, /<span class="badge">1<\/span>/);
});

test("renderPage escapes the title", () => {
  const html = renderPage({ jobs: [], watches, mode: "new", title: "A & B" });
  assert.match(html, /A &amp; B/);
});

test("renderPage new mode hides read jobs; all mode keeps them on screen", () => {
  const jobs = [job({ id: "1" }), job({ id: "2", read: true })];
  const newHtml = renderPage({ jobs, watches, mode: "new", title: "New" });
  assert.match(newHtml, /data-job-id="1"/);
  assert.doesNotMatch(newHtml, /data-job-id="2"/);

  const allHtml = renderPage({ jobs, watches, mode: "all", title: "All" });
  assert.match(allHtml, /data-job-id="1"/);
  assert.match(allHtml, /data-job-id="2"/);
});

test("renderPage new mode keeps a job you opened, highlighted — the reported bug", () => {
  const jobs = [job({ id: "1", opened: true, read: false })];
  const html = renderPage({ jobs, watches, mode: "new", title: "New" });
  assert.match(html, /data-job-id="1"/);
  assert.match(html, /data-opened="true"/);
  assert.doesNotMatch(html, /data-kind="no-new"/);
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
  // jobs exist but all read, in New mode → all caught up
  assert.match(
    renderPage({ jobs: [job({ read: true })], watches, mode: "new", title: "New" }),
    /data-kind="no-new"/,
  );
  // scan is broken → scan-error, whatever else is true
  assert.match(
    renderPage({ jobs: [], watches, mode: "new", title: "New", severity: "error" }),
    /data-kind="scan-error"/,
  );
});

// ── The manual scan control ─────────────────────────────────────────────────

test("scanButtonState is idle on a healthy, not-currently-scanning view", () => {
  assert.equal(
    scanButtonState({ jobs: [], watches, mode: "new", title: "New" }),
    "idle",
  );
});

test("scanButtonState reports scanning while a cycle holds the lock", () => {
  assert.equal(
    scanButtonState({ jobs: [], watches, mode: "new", title: "New", scanning: true }),
    "scanning",
  );
});

test("scanButtonState turns the control into the manual resume when halted (§16.2)", () => {
  assert.equal(
    scanButtonState({ jobs: [], watches, mode: "new", title: "New", scanMode: "halted" }),
    "halted",
  );
});

test("scanButtonState: an in-flight cycle outranks a halted mode", () => {
  // The halt was just cleared and the cycle started; there is nothing to resume.
  assert.equal(
    scanButtonState({
      jobs: [],
      watches,
      mode: "new",
      title: "New",
      scanning: true,
      scanMode: "halted",
    }),
    "scanning",
  );
});

test("scanButtonState stays idle for paused — that one resumes on its own (§16.1)", () => {
  assert.equal(
    scanButtonState({ jobs: [], watches, mode: "new", title: "New", scanMode: "paused" }),
    "idle",
  );
});

test("renderPage puts the scan control in the header, in the right state", () => {
  const idle = renderPage({ jobs: [job()], watches, mode: "new", title: "New" });
  assert.match(idle, /id="scan-now"[^>]*data-scan-state="idle"/);

  const scanning = renderPage({
    jobs: [job()],
    watches,
    mode: "new",
    title: "New",
    scanning: true,
  });
  assert.match(scanning, /id="scan-now"[^>]*data-scan-state="scanning"[^>]*disabled/);

  const halted = renderPage({
    jobs: [job()],
    watches,
    mode: "new",
    title: "New",
    scanMode: "halted",
    severity: "error",
  });
  assert.match(halted, /id="scan-now"[^>]*data-scan-state="halted"/);
  assert.match(halted, />Resume</);
});
