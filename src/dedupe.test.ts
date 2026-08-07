import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe } from "./dedupe.ts";
import type { SeenMap } from "./dedupe.ts";
import type { FilterRules } from "./filter.ts";
import type { Job } from "./types.ts";

/** A full Job with sensible defaults; override only what a case cares about. */
function job(overrides: Partial<Job> & { id: string }): Job {
  return {
    title: "Staff Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia",
    isReposted: false,
    postedAt: null,
    postedPrecision: null,
    postedText: "2 hours ago",
    linkedInStatus: null,
    url: `/jobs/view/${overrides.id}/`,
    foundAt: 0,
    watchId: "w1",
    opened: false,
    openedAt: null,
    read: false,
    readAt: null,
    ...overrides,
  };
}

/** The permissive ruleset — nothing blocked — unless a case tightens it. */
const OPEN_RULES: FilterRules = {
  blockedCompanies: [],
  blockedTitleKeywords: [],
  hideReposted: false,
};

const NOW = 1_000;

test("empty seen set: every parsed job is new", () => {
  const jobs = [job({ id: "1" }), job({ id: "2" })];
  const { newJobs, seen } = dedupe(jobs, {}, OPEN_RULES, NOW);
  assert.deepEqual(
    newJobs.map((j) => j.id),
    ["1", "2"],
  );
  assert.deepEqual(seen, { "1": NOW, "2": NOW });
});

test("repeat id: a job already in seen is not new and its timestamp is untouched", () => {
  const seenBefore: SeenMap = { "1": 500 };
  const { newJobs, seen } = dedupe([job({ id: "1" })], seenBefore, OPEN_RULES, NOW);
  assert.deepEqual(newJobs, []);
  assert.equal(seen["1"], 500); // first-seen time is preserved, not overwritten
});

test("cross-watch duplicate: the same id under two watches is one new job", () => {
  const jobs = [
    job({ id: "42", watchId: "indonesia" }),
    job({ id: "42", watchId: "japan" }),
  ];
  const { newJobs, seen } = dedupe(jobs, {}, OPEN_RULES, NOW);
  assert.deepEqual(
    newJobs.map((j) => j.id),
    ["42"],
  );
  assert.deepEqual(seen, { "42": NOW });
});

test("dedupe keys on id alone: same title+company, different ids are both new", () => {
  const jobs = [
    job({ id: "1", title: "Staff Engineer", company: "Acme Corp" }),
    job({ id: "2", title: "Staff Engineer", company: "Acme Corp" }),
  ];
  const { newJobs } = dedupe(jobs, {}, OPEN_RULES, NOW);
  assert.deepEqual(
    newJobs.map((j) => j.id),
    ["1", "2"],
  );
});

test("blocked company: filtered out of new list but still written to seen", () => {
  const rules: FilterRules = { ...OPEN_RULES, blockedCompanies: ["acme"] };
  const { newJobs, seen } = dedupe([job({ id: "1", company: "Acme Corp" })], {}, rules, NOW);
  assert.deepEqual(newJobs, []);
  assert.equal(seen["1"], NOW); // seen means evaluated, not shown (§6)
});

test("blocked title keyword: filtered out of new list but still written to seen", () => {
  const rules: FilterRules = { ...OPEN_RULES, blockedTitleKeywords: ["intern"] };
  const { newJobs, seen } = dedupe([job({ id: "1", title: "Data Intern" })], {}, rules, NOW);
  assert.deepEqual(newJobs, []);
  assert.equal(seen["1"], NOW);
});

test("hidden reposted: filtered out of new list but still written to seen", () => {
  const rules: FilterRules = { ...OPEN_RULES, hideReposted: true };
  const { newJobs, seen } = dedupe([job({ id: "1", isReposted: true })], {}, rules, NOW);
  assert.deepEqual(newJobs, []);
  assert.equal(seen["1"], NOW);
});

test("mixed batch: only the unseen, passing, id-unique jobs surface as new", () => {
  const rules: FilterRules = { ...OPEN_RULES, blockedCompanies: ["blockedco"] };
  const seenBefore: SeenMap = { old: 100 };
  const jobs = [
    job({ id: "old" }), // already seen
    job({ id: "new1" }), // fresh, passes
    job({ id: "new1", watchId: "w2" }), // cross-watch dup of new1
    job({ id: "blocked", company: "BlockedCo" }), // fresh but filtered
  ];
  const { newJobs, seen } = dedupe(jobs, seenBefore, rules, NOW);
  assert.deepEqual(
    newJobs.map((j) => j.id),
    ["new1"],
  );
  assert.deepEqual(seen, { old: 100, new1: NOW, blocked: NOW });
});
