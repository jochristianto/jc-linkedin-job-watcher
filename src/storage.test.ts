import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateJobs, type JobsMap } from "./storage.ts";
import type { Job } from "./types.ts";

// storage.ts itself is a §14 side-effect wrapper (it is the only module that
// touches chrome.storage), but the shape migration inside it is pure decision
// logic — and the kind that fails silently, on a store nobody can reproduce from
// a fresh install. So it is exported and tested here with plain values.

function job(overrides: Partial<Job> & { id: string }): Job {
  return {
    title: "Staff Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia",
    isReposted: false,
    postedText: "2 hours ago",
    url: `https://www.linkedin.com/jobs/view/${overrides.id}/`,
    foundAt: 1000,
    watchId: "w-id",
    opened: false,
    openedAt: null,
    read: false,
    readAt: null,
    ...overrides,
  };
}

/** A record as an older build wrote it: no `read`/`readAt` fields at all. */
function legacyJob(overrides: Partial<Job> & { id: string }): Job {
  const { read: _read, readAt: _readAt, ...rest } = job(overrides);
  return rest as Job;
}

test("migrateJobs carries a legacy opened job across as read", () => {
  // Back then, opening a job WAS dismissing it — so it stays dismissed rather
  // than reappearing in New on the first launch after the update.
  const jobs: JobsMap = { "1": legacyJob({ id: "1", opened: true, openedAt: 500 }) };
  const next = migrateJobs(jobs);
  assert.equal(next["1"]!.read, true);
  assert.equal(next["1"]!.readAt, 500);
  // and the opened state it was derived from survives
  assert.equal(next["1"]!.opened, true);
});

test("migrateJobs leaves a legacy unopened job unread", () => {
  const jobs: JobsMap = { "1": legacyJob({ id: "1", opened: false }) };
  const next = migrateJobs(jobs);
  assert.equal(next["1"]!.read, false);
  assert.equal(next["1"]!.readAt, null);
});

test("migrateJobs never overwrites a record that already has the new fields", () => {
  // The distinction the migration must not flatten: opened but deliberately
  // left unread is exactly the state the new row behaviour creates.
  const jobs: JobsMap = { "1": job({ id: "1", opened: true, openedAt: 5, read: false }) };
  const next = migrateJobs(jobs);
  assert.equal(next["1"]!.read, false);
  assert.equal(next["1"]!.readAt, null);
});

test("migrateJobs no-ops (same reference) when nothing needs migrating", () => {
  const jobs: JobsMap = { "1": job({ id: "1" }), "2": job({ id: "2", read: true, readAt: 9 }) };
  assert.equal(migrateJobs(jobs), jobs);
  const empty: JobsMap = {};
  assert.equal(migrateJobs(empty), empty);
});

test("migrateJobs migrates a mixed store, touching only the legacy records", () => {
  const fresh = job({ id: "new", read: true, readAt: 42 });
  const jobs: JobsMap = { new: fresh, old: legacyJob({ id: "old", opened: true, openedAt: 7 }) };
  const next = migrateJobs(jobs);
  assert.equal(next["new"], fresh); // untouched, same object
  assert.equal(next["old"]!.read, true);
  assert.equal(next["old"]!.readAt, 7);
});
