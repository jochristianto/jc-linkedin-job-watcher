import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScanNotification,
  jobsTabToFocus,
  SCAN_NOTIFICATION_ID,
  type NotificationJob,
  type JobsTabRef,
} from "./notify.ts";

function job(overrides: Partial<NotificationJob> = {}): NotificationJob {
  return { title: "Senior Engineer", company: "Acme Corp", ...overrides };
}

test("buildScanNotification returns null for zero new jobs — a quiet cycle fires nothing", () => {
  assert.equal(buildScanNotification([]), null);
});

test("buildScanNotification titles a single job with the singular noun", () => {
  const spec = buildScanNotification([job()]);
  assert.ok(spec);
  assert.equal(spec.title, "1 new job");
  assert.match(spec.message, /Senior Engineer — Acme Corp/);
});

test("buildScanNotification pluralises the title and merges every job into one", () => {
  const spec = buildScanNotification([job(), job({ title: "Lead" })]);
  assert.ok(spec);
  assert.equal(spec.title, "2 new jobs");
  assert.match(spec.message, /Senior Engineer — Acme Corp/);
  assert.match(spec.message, /Lead — Acme Corp/);
});

test("buildScanNotification caps the listed jobs and summarises the rest", () => {
  const jobs = Array.from({ length: 8 }, (_, i) => job({ title: `Job ${i}` }));
  const spec = buildScanNotification(jobs);
  assert.ok(spec);
  assert.equal(spec.title, "8 new jobs");
  assert.match(spec.message, /\+3 more/);
});

test("jobsTabToFocus picks the first existing jobs.html tab so clicks reuse one tab", () => {
  const tabs: JobsTabRef[] = [
    { id: 7, windowId: 2 },
    { id: 9, windowId: 3 },
  ];
  assert.deepEqual(jobsTabToFocus(tabs), { id: 7, windowId: 2 });
});

test("jobsTabToFocus returns null when no jobs.html tab is open yet", () => {
  assert.equal(jobsTabToFocus([]), null);
});

test("jobsTabToFocus skips a tab with no id and takes the next usable one", () => {
  const tabs: JobsTabRef[] = [{ windowId: 2 }, { id: 9, windowId: 3 }];
  assert.deepEqual(jobsTabToFocus(tabs), { id: 9, windowId: 3 });
});

test("SCAN_NOTIFICATION_ID is a stable id so a new cycle replaces the old notification", () => {
  assert.equal(typeof SCAN_NOTIFICATION_ID, "string");
  assert.ok(SCAN_NOTIFICATION_ID.length > 0);
});
