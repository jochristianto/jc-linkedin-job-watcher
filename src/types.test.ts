// Tests for the shared data shapes (PRD §5) and shipped defaults (PRD §15).
//
// types.ts is the prefactor's single home for every shape the other tickets
// share. There is no behaviour to test here — only that DEFAULT_SETTINGS carries
// the exact numbers §15 shipped, so no later ticket re-invents a default, and
// that the module type-checks against the tested pure modules it re-exports.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS } from "./types.ts";
import type { Settings } from "./types.ts";

test("DEFAULT_SETTINGS carries §15's shipped scan defaults", () => {
  assert.equal(DEFAULT_SETTINGS.intervalMinutes, 5);
  assert.equal(DEFAULT_SETTINGS.jitterMinutes, 1);
  assert.equal(DEFAULT_SETTINGS.pagesPerScan, 1);
  assert.equal(DEFAULT_SETTINGS.catchUpPages, 4);
});

test("DEFAULT_SETTINGS quiet hours default to 23:00–07:00, on", () => {
  assert.deepEqual(DEFAULT_SETTINGS.quietHours, {
    enabled: true,
    startMinute: 1380,
    endMinute: 420,
  });
});

test("DEFAULT_SETTINGS carries §15 pacing and back-off defaults", () => {
  assert.deepEqual(DEFAULT_SETTINGS.pacing, {
    pagePauseMs: [3000, 5000],
    watchPauseMs: [8000, 12000],
  });
  assert.deepEqual(DEFAULT_SETTINGS.backoff, {
    emptyScansBeforeBackoff: 3,
    maxIntervalMinutes: 60,
  });
});

test("DEFAULT_SETTINGS carries §7 retention defaults", () => {
  assert.deepEqual(DEFAULT_SETTINGS.retention, {
    seenDays: 15,
    openedJobDays: 7,
    unopenedJobDays: 30,
    seenHardCap: 50_000,
  });
});

test("DEFAULT_SETTINGS carries §16 lock and push-failure thresholds", () => {
  assert.equal(DEFAULT_SETTINGS.staleLockMs, 300_000);
  assert.equal(DEFAULT_SETTINGS.pushFailWarnThreshold, 3);
});

test("DEFAULT_SETTINGS starts with empty lists and push disabled", () => {
  assert.deepEqual(DEFAULT_SETTINGS.watches, []);
  assert.deepEqual(DEFAULT_SETTINGS.blockedCompanies, []);
  assert.deepEqual(DEFAULT_SETTINGS.blockedTitleKeywords, []);
  assert.equal(DEFAULT_SETTINGS.hideReposted, false);
  assert.equal(DEFAULT_SETTINGS.push.enabled, false);
});

test("DEFAULT_SETTINGS satisfies the Settings type it is declared as", () => {
  // A compile-time guarantee made a runtime assertion: if the shape drifted from
  // Settings, tsc would already have failed. This keeps the intent visible.
  const s: Settings = DEFAULT_SETTINGS;
  assert.ok(s);
});
