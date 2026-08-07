import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearHistory,
  collectGarbage,
  historyCounts,
  historyPhrase,
  removedCounts,
  type GcState,
} from "./gc.ts";
import type { Job } from "./types.ts";
import type { SeenMap } from "./dedupe.ts";
import type { JobsMap, UiState } from "./storage.ts";

// The reaper for PRD §7 — pure (§14): no chrome.*, no clock read (the caller
// passes `now`), so `node --test` proves each retention boundary with plain
// numbers. §7's algorithm is lifted verbatim into collectGarbage; these tests
// pin its two lifetimes and the hard-cap backstop.

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed "now" so ages are exact

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "1",
    title: "Staff Engineer",
    company: "Acme Corp",
    location: "Remote",
    isReposted: false,
    postedAt: null,
    postedPrecision: null,
    postedText: "2 hours ago",
    linkedInStatus: null,
    url: "https://www.linkedin.com/jobs/view/1/",
    foundAt: NOW,
    watchId: "w1",
    opened: false,
    openedAt: null,
    read: false,
    readAt: null,
    ...overrides,
  };
}

function state(overrides: Partial<GcState> = {}): GcState {
  return {
    seen: {},
    jobs: {},
    retention: {
      seenDays: 15,
      openedJobDays: 7,
      unopenedJobDays: 30,
      seenHardCap: 50_000,
    },
    ...overrides,
  };
}

// ── Unopened jobs: the 30-day lifetime ───────────────────────────────────────

test("an unopened job just inside unopenedJobDays is kept", () => {
  const jobs: JobsMap = {
    "1": job({ opened: false, foundAt: NOW - 30 * DAY + 1 }),
  };
  const { jobs: kept } = collectGarbage(state({ jobs }), NOW);
  assert.ok("1" in kept);
});

test("an unopened job just outside unopenedJobDays is dropped", () => {
  const jobs: JobsMap = {
    "1": job({ opened: false, foundAt: NOW - 30 * DAY }),
  };
  const { jobs: kept } = collectGarbage(state({ jobs }), NOW);
  assert.ok(!("1" in kept));
});

// ── Opened jobs: the shorter 7-day lifetime ──────────────────────────────────

test("an opened job just inside openedJobDays is kept", () => {
  const jobs: JobsMap = {
    "1": job({ opened: true, foundAt: NOW - 7 * DAY + 1 }),
  };
  const { jobs: kept } = collectGarbage(state({ jobs }), NOW);
  assert.ok("1" in kept);
});

test("an opened job just outside openedJobDays is dropped", () => {
  const jobs: JobsMap = {
    "1": job({ opened: true, foundAt: NOW - 7 * DAY }),
  };
  const { jobs: kept } = collectGarbage(state({ jobs }), NOW);
  assert.ok(!("1" in kept));
});

test("opening a job shortens its life — kept if unopened, dropped once opened", () => {
  const foundAt = NOW - 10 * DAY; // 10 days: past 7 (opened), inside 30 (unopened)
  assert.ok(
    "1" in collectGarbage(state({ jobs: { "1": job({ opened: false, foundAt }) } }), NOW).jobs,
  );
  assert.ok(
    !("1" in collectGarbage(state({ jobs: { "1": job({ opened: true, foundAt }) } }), NOW).jobs),
  );
});

// ── seen ids: the long-lived memory ──────────────────────────────────────────

test("a seen id just inside seenDays is kept", () => {
  const seen: SeenMap = { "1": NOW - 15 * DAY + 1 };
  const { seen: kept } = collectGarbage(state({ seen }), NOW);
  assert.ok("1" in kept);
});

test("a seen id just outside seenDays is dropped", () => {
  const seen: SeenMap = { "1": NOW - 15 * DAY };
  const { seen: kept } = collectGarbage(state({ seen }), NOW);
  assert.ok(!("1" in kept));
});

// ── The two lifetimes diverge (§6): the record dies, the memory survives ──────

test("dropping a job's full record keeps its seen entry — the memory not to re-alert survives", () => {
  const foundAt = NOW - 40 * DAY; // past even unopenedJobDays: the record is gone
  const jobs: JobsMap = { "1": job({ id: "1", opened: false, foundAt }) };
  const seen: SeenMap = { "1": NOW - 2 * DAY }; // but seen recently: memory alive
  const { jobs: keptJobs, seen: keptSeen } = collectGarbage(state({ jobs, seen }), NOW);
  assert.ok(!("1" in keptJobs), "the full record is dropped");
  assert.ok("1" in keptSeen, "the seen id is kept so it is never re-alerted");
});

test("a seen id past seenDays is kept while its own job record is still stored", () => {
  // The §7 lifetimes can cross: seenDays (15) is shorter than unopenedJobDays
  // (30), so between the two an unopened record outlives the memory of it. Left
  // alone, a posting still live on LinkedIn would come back as "new", fire a
  // notification and a push — and then show nothing, because mergeJobs keeps the
  // record already held. The memory always outlives the record it belongs to.
  const jobs: JobsMap = { "1": job({ id: "1", opened: false, foundAt: NOW - 20 * DAY }) };
  const seen: SeenMap = { "1": NOW - 20 * DAY }; // past seenDays
  const { seen: keptSeen, jobs: keptJobs } = collectGarbage(state({ jobs, seen }), NOW);
  assert.ok("1" in keptJobs, "the record is inside unopenedJobDays");
  assert.ok("1" in keptSeen, "so its seen id is held back too");
});

test("a seen id past seenDays goes once its job record has gone with it", () => {
  const jobs: JobsMap = { "1": job({ id: "1", opened: false, foundAt: NOW - 40 * DAY }) };
  const seen: SeenMap = { "1": NOW - 20 * DAY };
  const { seen: keptSeen, jobs: keptJobs } = collectGarbage(state({ jobs, seen }), NOW);
  assert.ok(!("1" in keptJobs));
  assert.ok(!("1" in keptSeen), "nothing is holding it back now");
});

// ── The hard cap: a backstop against a date bug defeating the age check ───────

test("the hard cap trims to 80% of seenHardCap when breached, keeping the newest", () => {
  const seenHardCap = 100;
  const seen: SeenMap = {};
  // 150 entries, all within seenDays so the age filter keeps them all; ages
  // increase with index so higher index == older == first to be trimmed.
  for (let i = 0; i < 150; i++) seen[`id${i}`] = NOW - i * 1000;
  const { seen: kept } = collectGarbage(
    state({ seen, retention: { seenDays: 15, openedJobDays: 7, unopenedJobDays: 30, seenHardCap } }),
    NOW,
  );
  assert.equal(Object.keys(kept).length, 80); // floor(100 * 0.8)
  assert.ok("id0" in kept, "the newest is kept");
  assert.ok("id79" in kept, "the 80th-newest is kept");
  assert.ok(!("id80" in kept), "the 81st-newest is trimmed");
  assert.ok(!("id149" in kept), "the oldest is trimmed");
});

test("the hard cap does not trim when seen count only equals the cap", () => {
  const seenHardCap = 100;
  const seen: SeenMap = {};
  for (let i = 0; i < 100; i++) seen[`id${i}`] = NOW - i * 1000;
  const { seen: kept } = collectGarbage(
    state({ seen, retention: { seenDays: 15, openedJobDays: 7, unopenedJobDays: 30, seenHardCap } }),
    NOW,
  );
  assert.equal(Object.keys(kept).length, 100); // > cap, not >=, so no trim at the cap
});

test("empty state collects to empty", () => {
  const { seen, jobs } = collectGarbage(state(), NOW);
  assert.deepEqual(seen, {});
  assert.deepEqual(jobs, {});
});

test("collectGarbage does not mutate the input seen or jobs", () => {
  const seen: SeenMap = { old: NOW - 100 * DAY, fresh: NOW };
  const jobs: JobsMap = { old: job({ id: "old", foundAt: NOW - 100 * DAY }) };
  collectGarbage(state({ seen, jobs }), NOW);
  assert.ok("old" in seen, "input seen is untouched");
  assert.ok("old" in jobs, "input jobs is untouched");
});

// ── Counting what is stored ──────────────────────────────────────────────────

test("historyCounts counts each key separately", () => {
  const counts = historyCounts(
    { a: NOW, b: NOW },
    { a: job({ id: "a" }), b: job({ id: "b" }), c: job({ id: "c" }) },
  );
  assert.deepEqual(counts, { jobs: 3, seen: 2 });
});

test("historyCounts of empty storage is zero on both keys", () => {
  assert.deepEqual(historyCounts({}, {}), { jobs: 0, seen: 0 });
});

// ── What a run actually removed: the daily alarm's write-or-skip decision ─────

test("removedCounts is zero on both keys when nothing aged out", () => {
  const before = state({
    seen: { "1": NOW },
    jobs: { "1": job({ foundAt: NOW }) },
  });
  assert.deepEqual(removedCounts(before, collectGarbage(before, NOW)), {
    jobs: 0,
    seen: 0,
  });
});

test("removedCounts counts the dropped entries of each key separately", () => {
  const before = state({
    // Two ids past seenDays, one inside it.
    seen: { a: NOW - 20 * DAY, b: NOW - 16 * DAY, c: NOW },
    // One record past unopenedJobDays, one inside it.
    jobs: {
      a: job({ id: "a", foundAt: NOW - 40 * DAY }),
      c: job({ id: "c", foundAt: NOW }),
    },
  });
  assert.deepEqual(removedCounts(before, collectGarbage(before, NOW)), {
    jobs: 1,
    seen: 2,
  });
});

test("removedCounts reports the hard-cap trim, which the age filter alone would have missed", () => {
  const seen: SeenMap = {};
  for (let i = 0; i < 150; i++) seen[`id${i}`] = NOW - i * 1000; // all within seenDays
  const before = state({
    seen,
    retention: { seenDays: 15, openedJobDays: 7, unopenedJobDays: 30, seenHardCap: 100 },
  });
  assert.deepEqual(removedCounts(before, collectGarbage(before, NOW)), {
    jobs: 0,
    seen: 70, // 150 kept by age, trimmed to floor(100 * 0.8) = 80
  });
});

// ── Delete all job history: retention taken to its limit, by hand ─────────────

const ui: UiState = { activeWatchId: "w1", mode: "all", pendingApplyId: "1" };

test("clearHistory empties both jobs and seen", () => {
  const cleared = clearHistory(ui);
  assert.deepEqual(cleared.jobs, {});
  assert.deepEqual(cleared.seen, {});
});

test("clearHistory drops the pending apply question — the job it asks about is gone", () => {
  assert.equal(clearHistory(ui).ui.pendingApplyId, null);
});

test("clearHistory keeps the rest of the view state — which chip and mode you left it on", () => {
  const cleared = clearHistory(ui);
  assert.equal(cleared.ui.activeWatchId, "w1");
  assert.equal(cleared.ui.mode, "all");
});

test("clearHistory does not mutate the ui it is given", () => {
  clearHistory(ui);
  assert.equal(ui.pendingApplyId, "1");
});

// ── Saying how much there is to lose ─────────────────────────────────────────

test("historyPhrase names both keys, pluralised, with thousands separated", () => {
  assert.equal(historyPhrase({ jobs: 42, seen: 1203 }), "42 jobs and 1,203 seen ids");
});

test("historyPhrase reads as singular for one of each", () => {
  assert.equal(historyPhrase({ jobs: 1, seen: 1 }), "1 job and 1 seen id");
});

test("historyPhrase leaves out a key that holds nothing rather than saying 0", () => {
  assert.equal(historyPhrase({ jobs: 0, seen: 5 }), "5 seen ids");
  assert.equal(historyPhrase({ jobs: 3, seen: 0 }), "3 jobs");
});

test("historyPhrase says nothing when there is nothing", () => {
  assert.equal(historyPhrase({ jobs: 0, seen: 0 }), "nothing");
});
