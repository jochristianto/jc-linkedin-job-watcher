import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearJobApplied,
  toJobViews,
  unreadCount,
  markJobApplied,
  markJobOpened,
  markAllRead,
  setJobRead,
  toggleBlockedCompany,
  selectView,
  scanButtonState,
  scanStatus,
} from "./view.ts";
import { PUSH_FAILING_MESSAGE } from "./health.ts";
import { visibleJobs } from "./view-model.ts";
import { minutesOfDay } from "./schedule.ts";
import type { ViewContext } from "./view.ts";
import type { Job, Watch, BlockedCompany, QuietHours } from "./types.ts";
import type { JobsMap } from "./storage.ts";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "3901",
    title: "Senior Software Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia",
    isReposted: false,
    postedAt: null,
    postedPrecision: null,
    postedText: "2 hours ago",
    linkedInStatus: null,
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

test("toJobViews carries the applied flag, absent on older records reading as no", () => {
  assert.equal(toJobViews([job()], watches)[0]!.applied, false);
  assert.equal(toJobViews([job({ applied: true })], watches)[0]!.applied, true);
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

test("toJobViews drops reposted rows when the setting is on, and only then", () => {
  const jobs = [job({ id: "1", isReposted: true }), job({ id: "2" })];
  assert.deepEqual(
    toJobViews(jobs, watches, [], true).map((v) => v.id),
    ["2"],
  );
  // Off — the default — leaves the list exactly as it was.
  assert.equal(toJobViews(jobs, watches, [], false).length, 2);
  assert.equal(toJobViews(jobs, watches).length, 2);
});

test("toJobViews re-asks the reposted rule per render, so it reaches jobs already found", () => {
  // The job was discovered while the setting was off, so it is in storage; turning
  // the setting on has to take it off the list without a re-scan. This is the bug:
  // the rule used to be applied once, at discovery, and never again.
  const stored = [job({ id: "old-repost", isReposted: true, foundAt: 100 })];
  assert.equal(toJobViews(stored, watches, [], false).length, 1);
  assert.equal(toJobViews(stored, watches, [], true).length, 0);
});

test("toJobViews hides nothing for records written before isReposted existed", () => {
  const legacy = { ...job(), isReposted: undefined } as unknown as Job;
  assert.equal(toJobViews([legacy], watches, [], true).length, 1);
});

test("unreadCount counts the jobs you have not looked at — either way of looking clears one", () => {
  const jobs = [job({ id: "1" }), job({ id: "2", read: true }), job({ id: "3" })];
  assert.equal(unreadCount(jobs), 2);
  // Clicking through counts as looking, even though the row stays on the New
  // list — the badge answers "anything I haven't seen?", not "anything left?".
  assert.equal(unreadCount([job({ id: "1", opened: true, read: false })]), 0);
});

test("unreadCount ignores blocked companies, so blocking quiets the badge", () => {
  const jobs = [job({ id: "1", company: "Acme Corp" }), job({ id: "2", company: "Globex" })];
  assert.equal(unreadCount(jobs, []), 2);
  assert.equal(unreadCount(jobs, ["acme"]), 1);
});

test("unreadCount ignores hidden reposts, so the badge can't promise unreachable rows", () => {
  const jobs = [job({ id: "1", isReposted: true }), job({ id: "2" })];
  assert.equal(unreadCount(jobs, [], false), 2);
  assert.equal(unreadCount(jobs, [], true), 1);
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

test("markJobApplied records the answer and its note without mutating the input", () => {
  const jobs: JobsMap = { "3901": job() };
  const next = markJobApplied(jobs, "3901", "  Referred by Dita  ", 1234);
  assert.equal(next["3901"]!.applied, true);
  assert.equal(next["3901"]!.appliedAt, 1234);
  // Trimmed: the box is free text, and " " is not a note.
  assert.equal(next["3901"]!.applyNotes, "Referred by Dita");
  assert.equal(jobs["3901"]!.applied, undefined);
});

test("markJobApplied accepts an empty note — the answer is what matters", () => {
  const next = markJobApplied({ a: job({ id: "a" }) }, "a", "", 7);
  assert.equal(next["a"]!.applied, true);
  assert.equal(next["a"]!.applyNotes, "");
});

test("markJobApplied does not read or dismiss the row — applying is its own state", () => {
  const next = markJobApplied({ a: job({ id: "a" }) }, "a", "", 7);
  assert.equal(next["a"]!.read, false);
  assert.equal(next["a"]!.opened, false);
});

test("markJobApplied keeps the first appliedAt but takes the newer note", () => {
  const jobs: JobsMap = { a: job({ id: "a", applied: true, appliedAt: 5, applyNotes: "old" }) };
  const next = markJobApplied(jobs, "a", "corrected", 999);
  assert.equal(next["a"]!.appliedAt, 5);
  assert.equal(next["a"]!.applyNotes, "corrected");
});

test("markJobApplied leaves other jobs alone and no-ops on an unknown id", () => {
  const jobs: JobsMap = { a: job({ id: "a" }), b: job({ id: "b" }) };
  assert.equal(markJobApplied(jobs, "a", "", 5)["b"]!.applied, undefined);
  assert.equal(markJobApplied(jobs, "missing", "", 5), jobs);
});

test("clearJobApplied puts the job back to never-applied, note and all", () => {
  const jobs: JobsMap = {
    a: job({ id: "a", applied: true, appliedAt: 5, applyNotes: "Referred by Dita" }),
  };
  const next = clearJobApplied(jobs, "a");
  // Deleted, not falsified: nothing left to tell "undone" from "never answered",
  // which is what makes the question askable again.
  assert.equal("applied" in next["a"]!, false);
  assert.equal("appliedAt" in next["a"]!, false);
  assert.equal("applyNotes" in next["a"]!, false);
  // input untouched
  assert.equal(jobs["a"]!.applied, true);
  assert.equal(jobs["a"]!.applyNotes, "Referred by Dita");
});

test("clearJobApplied leaves the rest of the job exactly as it was", () => {
  const jobs: JobsMap = {
    a: job({ id: "a", applied: true, appliedAt: 5, opened: true, openedAt: 3, read: true, readAt: 4 }),
  };
  const cleared = clearJobApplied(jobs, "a")["a"]!;
  assert.equal(cleared.opened, true);
  assert.equal(cleared.openedAt, 3);
  assert.equal(cleared.read, true);
  assert.equal(cleared.readAt, 4);
  assert.equal(cleared.title, jobs["a"]!.title);
});

test("clearJobApplied no-ops (same reference) with nothing to undo", () => {
  const jobs: JobsMap = { a: job({ id: "a" }), b: job({ id: "b", applied: true, appliedAt: 1 }) };
  assert.equal(clearJobApplied(jobs, "a"), jobs); // never applied
  assert.equal(clearJobApplied(jobs, "missing"), jobs); // unknown id
  // ...and undoing one leaves the other's record alone.
  assert.equal(clearJobApplied(jobs, "b")["a"]!.applied, undefined);
});

test("markJobApplied and clearJobApplied round-trip through toJobViews", () => {
  // What the row actually reads: the tag appears, the undo removes it.
  const applied = markJobApplied({ a: job({ id: "a" }) }, "a", "note", 5);
  assert.equal(toJobViews(Object.values(applied), watches)[0]!.applied, true);
  const undone = clearJobApplied(applied, "a");
  assert.equal(toJobViews(Object.values(undone), watches)[0]!.applied, false);
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

test("markAllRead under a watch chip leaves the other watches unread", () => {
  // "All" is all of the list in front of you. Tidying one watch must not clear
  // four others you have not looked at — nothing un-reads in bulk.
  const jobs: JobsMap = {
    a: job({ id: "a", watchId: "w-id" }),
    b: job({ id: "b", watchId: "w-other" }),
  };
  const next = markAllRead(jobs, 999, { watchId: "w-id" });
  assert.equal(next["a"]!.read, true);
  assert.equal(next["b"]!.read, false);
  // The out-of-scope job is not even copied, so a caller comparing references can
  // tell which jobs a bulk read touched.
  assert.equal(next["b"], jobs["b"]);
});

test("markAllRead treats a blank or absent watch scope as every watch", () => {
  const jobs: JobsMap = {
    a: job({ id: "a", watchId: "w-id" }),
    b: job({ id: "b", watchId: "w-other" }),
  };
  for (const scope of [{}, { watchId: null }, { watchId: "" }]) {
    const next = markAllRead(jobs, 999, scope);
    assert.equal(next["a"]!.read, true);
    assert.equal(next["b"]!.read, true);
  }
});

test("markAllRead skips jobs hideReposted has taken off the list", () => {
  // Not on the list, so not yours to dismiss: turning the setting back off has to
  // bring the job back as the new job it never got shown as.
  const jobs: JobsMap = {
    a: job({ id: "a" }),
    b: job({ id: "b", isReposted: true }),
  };
  const next = markAllRead(jobs, 999, { hideReposted: true });
  assert.equal(next["a"]!.read, true);
  assert.equal(next["b"]!.read, false);
  // With the setting off the repost is a row like any other, and gets read.
  assert.equal(markAllRead(jobs, 999, { hideReposted: false })["b"]!.read, true);
});

test("markAllRead no-ops (same reference) when the scope holds nothing unread", () => {
  // The only unread job belongs to another watch, so there is nothing to write —
  // `<ListView>` skips the storage write on this reference alone.
  const jobs: JobsMap = { a: job({ id: "a", watchId: "w-other" }) };
  assert.equal(markAllRead(jobs, 1, { watchId: "w-id" }), jobs);
});

test("markAllRead still reaches blocked companies — those rows are on screen", () => {
  // Unlike a hidden repost, a blocked company's row stays visible and greyed, so
  // it is part of the list you just cleared.
  const jobs: JobsMap = { a: job({ id: "a", company: "Acme Corp" }) };
  assert.equal(markAllRead(jobs, 999, { watchId: "w-id" })["a"]!.read, true);
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
  // A leftover fragment would keep the company blocked and make the button look broken.
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

// ── selectView: every decision the page makes, as data ──────────────────────
//
// These were `renderPage` tests when this layer emitted a markup string. The
// page is a React component now, so the assembly decisions it makes are asserted
// on the props `selectView` hands it — which is stricter than a regex over HTML
// ever was: a badge of 2 is the number 2, not `/class="badge">2</`.

/** A ViewContext with the boilerplate filled in. */
function ctx(over: Partial<ViewContext> = {}): ViewContext {
  return { jobs: [job()], watches, mode: "new", title: "New jobs", ...over };
}

test("selectView renders the watch filter chips and carries the mode", () => {
  const v = selectView(ctx());
  assert.deepEqual(v.chips, [{ id: "w-id", name: "Indonesia" }]);
  assert.equal(v.activeWatchId, null);
  assert.equal(v.mode, "new");
});

test("selectView filters the list to the active watch chip", () => {
  const jobs = [job({ id: "1", watchId: "w-id" }), job({ id: "2", watchId: "other" })];
  const filtered = selectView(ctx({ jobs, mode: "all", activeWatchId: "w-id" }));
  assert.deepEqual(filtered.jobs.map((j) => j.id), ["1"]);

  const allWatches = selectView(ctx({ jobs, mode: "all" }));
  assert.deepEqual(allWatches.jobs.map((j) => j.id).sort(), ["1", "2"]);
});

test("selectView badge counts unread across all watches, ignoring the chip filter", () => {
  const jobs = [job({ id: "1", watchId: "w-id" }), job({ id: "2", watchId: "other" })];
  assert.equal(selectView(ctx({ jobs, mode: "all", activeWatchId: "w-id" })).badge, 2);
});

test("selectView keeps the badge and the list in step when reposts are hidden", () => {
  const jobs = [job({ id: "1", isReposted: true }), job({ id: "2" })];
  const hidden = selectView(ctx({ jobs, mode: "all", hideReposted: true }));
  assert.deepEqual(hidden.jobs.map((j) => j.id), ["2"]);
  // The badge must drop with the row: a "2" over a one-row list points at a job
  // no chip or mode can reach.
  assert.equal(hidden.badge, 1);

  const shown = selectView(ctx({ jobs, mode: "all", hideReposted: false }));
  assert.equal(shown.jobs.length, 2);
  assert.equal(shown.badge, 2);
});

test("selectView shows the scanning empty state while a first scan is in flight", () => {
  assert.equal(selectView(ctx({ jobs: [], scanning: true })).emptyKind, "scanning");
});

test("selectView badges the unread count and drops it to zero when all are read", () => {
  assert.equal(selectView(ctx({ jobs: [job({ id: "1" }), job({ id: "2" })] })).badge, 2);
  assert.equal(selectView(ctx({ jobs: [job({ id: "1", read: true })], mode: "all" })).badge, 0);
});

test("selectView badge counts unread regardless of the view mode", () => {
  // 'all' mode shows read jobs, but the badge still reflects unread only.
  const jobs = [job({ id: "1" }), job({ id: "2", read: true })];
  assert.equal(selectView(ctx({ jobs, mode: "all" })).badge, 1);
});

test("selectView badge drops a job you opened, though the row stays on the list", () => {
  const jobs = [job({ id: "1", opened: true, read: false })];
  const v = selectView(ctx({ jobs }));
  // Off the count — you have looked at it, which is what the count is about…
  assert.equal(v.badge, 0);
  // …but still on the New list, because you have not said you are done with it.
  assert.equal(visibleJobs(v.jobs, v.mode).length, 1);
});

test("selectView flags a blocked company's rows and drops them off the badge", () => {
  const v = selectView(
    ctx({
      jobs: [job({ id: "1", company: "Acme Corp" }), job({ id: "2", company: "Globex" })],
      blockedCompanies: ["acme"],
    }),
  );
  // Still in the list — blocking governs future scans, it doesn't delete rows.
  assert.equal(v.jobs.find((j) => j.id === "1")!.blocked, true);
  assert.equal(v.jobs.find((j) => j.id === "2")!.blocked, false);
  assert.equal(v.badge, 1);
});

test("selectView carries the title through untouched", () => {
  // Escaping used to be this layer's job; React escapes its children now, so the
  // title travels as the plain string it is. `components.test.tsx` proves the
  // escaping still happens where it now belongs.
  assert.equal(selectView(ctx({ jobs: [], title: "A & B" })).title, "A & B");
});

test("selectView keeps a job you opened out of the empty state — the reported bug", () => {
  const v = selectView(ctx({ jobs: [job({ id: "1", opened: true, read: false })] }));
  assert.equal(v.emptyKind, null);
  assert.equal(v.jobs.find((j) => j.id === "1")!.opened, true);
});

test("selectView surfaces the health message as a banner (§16.8)", () => {
  const v = selectView(
    ctx({
      jobs: [job({ id: "1" })],
      mode: "all",
      severity: "error",
      message: "Signed out of LinkedIn — scanning paused.",
    }),
  );
  assert.deepEqual(v.banners, [
    { message: "Signed out of LinkedIn — scanning paused.", severity: "error" },
  ]);
});

test("selectView shows no banner when health is clear", () => {
  assert.deepEqual(selectView(ctx({ jobs: [job({ id: "1" })], mode: "all" })).banners, []);
});

test("selectView shows the soft push-failing warning when pushWarn is set (§16.7)", () => {
  const v = selectView(ctx({ jobs: [job({ id: "1" })], mode: "all", pushWarn: true }));
  assert.deepEqual(v.banners, [{ message: PUSH_FAILING_MESSAGE, severity: "warn" }]);
});

test("selectView shows no push warning when pushWarn is false", () => {
  assert.deepEqual(selectView(ctx({ jobs: [job({ id: "1" })], mode: "all" })).banners, []);
});

test("selectView shows an amber field-break banner when a field stops reading (§16.4, #52)", () => {
  const msg = "LinkedIn showed no company name on any of 25 postings — its layout may have changed.";
  const v = selectView(ctx({ jobs: [job({ id: "1" })], mode: "all", fieldBreakMessage: msg }));
  assert.deepEqual(v.banners, [{ message: msg, severity: "warn" }]);
});

test("selectView stacks a field break under the health banner — a separate axis (#52)", () => {
  // The page read `ok` on scan health yet a selector is dead: both surface, health
  // first, the field break as its own amber banner rather than being masked.
  const fieldMsg = "LinkedIn showed no company name on any of 25 postings.";
  const v = selectView(
    ctx({
      jobs: [job({ id: "1" })],
      mode: "all",
      severity: "error",
      message: "Signed out of LinkedIn — scanning paused.",
      fieldBreakMessage: fieldMsg,
    }),
  );
  assert.equal(v.banners.length, 2);
  assert.equal(v.banners[0]!.severity, "error");
  assert.deepEqual(v.banners[1], { message: fieldMsg, severity: "warn" });
});

test("selectView stacks the health banner and the push warning, health first", () => {
  const v = selectView(
    ctx({
      jobs: [job({ id: "1" })],
      mode: "all",
      severity: "error",
      message: "Signed out of LinkedIn — scanning paused.",
      pushWarn: true,
    }),
  );
  assert.equal(v.banners.length, 2);
  assert.equal(v.banners[0]!.severity, "error");
  assert.deepEqual(v.banners[1], { message: PUSH_FAILING_MESSAGE, severity: "warn" });
});

test("selectView picks the right empty state for each situation", () => {
  // no watches configured
  assert.equal(selectView(ctx({ jobs: [], watches: [] })).emptyKind, "no-watches");
  // watches exist but nothing scanned yet
  assert.equal(selectView(ctx({ jobs: [] })).emptyKind, "no-jobs-yet");
  // jobs exist but all read, in New mode → all caught up
  assert.equal(selectView(ctx({ jobs: [job({ read: true })] })).emptyKind, "no-new");
  // scan is broken → scan-error, whatever else is true
  assert.equal(selectView(ctx({ jobs: [], severity: "error" })).emptyKind, "scan-error");
  // a list with something in it gets no empty state at all
  assert.equal(selectView(ctx()).emptyKind, null);
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

test("scanButtonState reports scanning from the click, before the lock exists", () => {
  // The reported bug: waking the service worker takes long enough that a button
  // still reading "Scan now" looks like a click that missed.
  assert.equal(
    scanButtonState({ jobs: [], watches, mode: "new", title: "New", pendingScan: true }),
    "scanning",
  );
});

test("scanButtonState: a pending click outranks a halted mode too", () => {
  // "Scan now" is also the manual resume (§16.2), so the halted label must give
  // way the moment it is pressed — otherwise the one control that clears a halt
  // is the one that looks like it did nothing.
  assert.equal(
    scanButtonState({
      jobs: [],
      watches,
      mode: "new",
      title: "New",
      pendingScan: true,
      scanMode: "halted",
    }),
    "scanning",
  );
});

// ── scanStatus: what the footer says the loop is doing ───────────────────────

/** A fixed instant so the countdowns are exact. Quiet-hours windows below are
 *  built *relative to its local minutes-of-day*, because the window is a local
 *  clock rule (§15) and the suite must pass in any timezone. */
const NOW = 1_700_000_000_000;
const NOW_MINUTE = minutesOfDay(new Date(NOW));

/** A window one hour wide, starting `offsetMinutes` from now — so offset 0 is a
 *  window we are inside, and offset 60 one we are not. Wraps midnight safely. */
function window(offsetMinutes: number): QuietHours {
  const startMinute = (NOW_MINUTE + offsetMinutes + 1440) % 1440;
  return { enabled: true, startMinute, endMinute: (startMinute + 60) % 1440 };
}

const base = { jobs: [], watches, mode: "new" as const, title: "New" };

test("scanStatus counts down to the armed alarm", () => {
  assert.deepEqual(scanStatus({ ...base, nextScanAt: NOW + 252_000, now: NOW }), {
    kind: "waiting",
    remainingMs: 252_000,
    quiet: false,
  });
});

test("scanStatus marks a countdown that is running through quiet hours", () => {
  const status = scanStatus({
    ...base,
    quietHours: window(0),
    nextScanAt: NOW + 3_600_000,
    now: NOW,
  });
  assert.deepEqual(status, { kind: "waiting", remainingMs: 3_600_000, quiet: true });
});

test("scanStatus does not blame quiet hours outside the window", () => {
  const status = scanStatus({
    ...base,
    quietHours: window(60),
    nextScanAt: NOW + 300_000,
    now: NOW,
  });
  assert.equal(status.kind === "waiting" && status.quiet, false);
});

test("scanStatus reports the scan in flight, whatever the schedule says", () => {
  assert.deepEqual(
    scanStatus({ ...base, scanning: true, nextScanAt: NOW + 300_000, now: NOW }),
    { kind: "scanning" },
  );
});

test("scanStatus stops the countdown the moment Scan now is pressed", () => {
  // Without this the footer keeps ticking "Next scan in 3m 14s" under a button
  // the user has already pressed — the two surfaces contradicting each other.
  assert.deepEqual(
    scanStatus({ ...base, pendingScan: true, nextScanAt: NOW + 194_000, now: NOW }),
    { kind: "scanning" },
  );
});

test("scanStatus has nothing to count down to while halted (§16.2)", () => {
  // The alarm stays armed through a halt, but it will not scan when it fires —
  // counting down to it would be a lie the user acts on.
  assert.deepEqual(
    scanStatus({ ...base, scanMode: "halted", nextScanAt: NOW + 300_000, now: NOW }),
    { kind: "halted" },
  );
});

test("scanStatus still counts down while paused — that one resumes itself (§16.1)", () => {
  const status = scanStatus({
    ...base,
    scanMode: "paused",
    nextScanAt: NOW + 300_000,
    now: NOW,
  });
  assert.equal(status.kind, "waiting");
});

test("scanStatus goes silent when no search is enabled", () => {
  const off: Watch[] = [{ id: "w-id", name: "Indonesia", url: "https://x", enabled: false }];
  assert.deepEqual(
    scanStatus({ ...base, watches: off, nextScanAt: NOW + 300_000, now: NOW }),
    { kind: "off" },
  );
  assert.deepEqual(scanStatus({ ...base, watches: [], now: NOW }), { kind: "off" });
});

test("scanStatus says Paused when the master switch is off (§ master)", () => {
  // Off means off: even with a watch enabled and an alarm armed, the loop is
  // paused on purpose, so the footer must not count down to a scan that won't run.
  assert.deepEqual(
    scanStatus({ ...base, enabled: false, nextScanAt: NOW + 300_000, now: NOW }),
    { kind: "disabled" },
  );
});

test("scanStatus: the master switch outranks a stale halt", () => {
  // A loop turned off should read as paused, not as a challenge waiting on Resume.
  assert.deepEqual(
    scanStatus({ ...base, enabled: false, scanMode: "halted", now: NOW }),
    { kind: "disabled" },
  );
});

test("scanStatus: a cycle in flight still wins over the master switch", () => {
  // Toggling off mid-scan lets that cycle finish; only the next status is paused.
  assert.deepEqual(
    scanStatus({ ...base, enabled: false, scanning: true, now: NOW }),
    { kind: "scanning" },
  );
});

test("scanStatus treats an absent master switch as on (upgrade back-compat)", () => {
  // Settings written before the switch existed have no `enabled`; they keep
  // counting down rather than reading as paused.
  assert.deepEqual(scanStatus({ ...base, nextScanAt: NOW + 300_000, now: NOW }), {
    kind: "waiting",
    remainingMs: 300_000,
    quiet: false,
  });
});

test("scanStatus reports an armed time already past as due, never as a negative", () => {
  assert.deepEqual(scanStatus({ ...base, nextScanAt: NOW - 5_000, now: NOW }), { kind: "due" });
});

test("scanStatus says so when no alarm is armed at all", () => {
  assert.deepEqual(scanStatus({ ...base, nextScanAt: null, now: NOW }), { kind: "unscheduled" });
});

test("scanStatus reports manual-only as a state, not as a missing schedule", () => {
  // With nothing armed it would otherwise fall through to `unscheduled`, which
  // reads as a fault. Here the absence of a schedule is the setting working.
  assert.deepEqual(scanStatus({ ...base, manualOnly: true, nextScanAt: null, now: NOW }), {
    kind: "manual",
  });
});

test("scanStatus: manual-only outranks an alarm left armed from before the switch", () => {
  // The worker clears that alarm, but not necessarily before the popup next
  // paints — and a countdown to a wake that will only cancel itself is a lie.
  assert.deepEqual(
    scanStatus({ ...base, manualOnly: true, nextScanAt: NOW + 300_000, now: NOW }),
    { kind: "manual" },
  );
});

test("scanStatus: the master switch and a live cycle both outrank manual-only", () => {
  // Paused is a stronger statement than manual — under it the button is gone too —
  // and a cycle in flight is simply what is happening, however it was started.
  assert.deepEqual(scanStatus({ ...base, manualOnly: true, enabled: false, now: NOW }), {
    kind: "disabled",
  });
  assert.deepEqual(scanStatus({ ...base, manualOnly: true, scanning: true, now: NOW }), {
    kind: "scanning",
  });
});

test("scanStatus treats an absent manual-only as off (upgrade back-compat)", () => {
  assert.deepEqual(scanStatus({ ...base, nextScanAt: NOW + 60_000, now: NOW }), {
    kind: "waiting",
    remainingMs: 60_000,
    quiet: false,
  });
});

test("selectView hands the footer a countdown to the next scan", () => {
  const v = selectView({ ...base, jobs: [job()], nextScanAt: NOW + 252_000, now: NOW });
  assert.deepEqual(v.status, { kind: "waiting", remainingMs: 252_000, quiet: false });
});

test("selectView says it is scanning while a cycle holds the lock", () => {
  const v = selectView({ ...base, jobs: [job()], scanning: true, now: NOW });
  assert.deepEqual(v.status, { kind: "scanning" });
});

test("selectView turns the status bar off entirely when there is nothing to scan", () => {
  // `off` is what makes the bar render nothing at all, so the popup doesn't end
  // in a strip promising a scan that no enabled search will ever produce.
  const v = selectView({ ...base, watches: [], now: NOW });
  assert.deepEqual(v.status, { kind: "off" });
});

test("selectView puts the scan control in the right state", () => {
  assert.equal(selectView({ ...base, jobs: [job()] }).scanButton, "idle");
  assert.equal(selectView({ ...base, jobs: [job()], scanning: true }).scanButton, "scanning");
  assert.equal(
    selectView({ ...base, jobs: [job()], scanMode: "halted", severity: "error" }).scanButton,
    "halted",
  );
});

test("selectView says Scanning… everywhere from the click, not from the reply", () => {
  // One flag, three surfaces: the header button, the footer bar and — with an
  // empty list — the empty state. A click that only moved one of them would read
  // as the other two disagreeing with it.
  const v = selectView({ ...base, pendingScan: true, nextScanAt: NOW + 194_000, now: NOW });
  assert.equal(v.scanButton, "scanning");
  assert.deepEqual(v.status, { kind: "scanning" });
  assert.equal(v.emptyKind, "scanning");
});
