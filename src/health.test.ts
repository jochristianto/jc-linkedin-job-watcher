import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPage,
  aggregateOutcome,
  reduceScanHealth,
  isSavableJob,
  fieldMissingAcrossAll,
  reducePushHealth,
  isLockStale,
  OK_HEALTH,
  type PageSignals,
  type HealthState,
} from "./health.ts";
import type { BackoffConfig } from "./schedule.ts";

// Pure-logic reference for issue #9 (08 — failure diagnosis & surfacing). No
// chrome.*, no DOM, no network: every signal comes in as a value (prd.md §14).

const backoff = (o: Partial<BackoffConfig> = {}): BackoffConfig => ({
  emptyScansBeforeBackoff: 3,
  maxIntervalMinutes: 60,
  ...o,
});
const signals = (o: Partial<PageSignals> = {}): PageSignals => ({
  navError: false,
  finalUrl: "https://www.linkedin.com/jobs/search/?keywords=x",
  hasResultsList: true,
  cardCount: 5,
  ...o,
});

// ── classifyPage: the five load failures told apart (§16.1–3, §16.5) ──────────

test("classifyPage: a healthy page with cards is ok", () => {
  assert.equal(classifyPage(signals()), "ok");
});

test("classifyPage: results list present but zero cards is a genuine empty (§16.3)", () => {
  assert.equal(classifyPage(signals({ cardCount: 0 })), "empty");
});

test("classifyPage: a missing results list is structure-changed, not empty (§16.3)", () => {
  assert.equal(classifyPage(signals({ hasResultsList: false, cardCount: 0 })), "structure-changed");
});

test("classifyPage: a login wall is logged-out (§16.1)", () => {
  assert.equal(
    classifyPage(signals({ finalUrl: "https://www.linkedin.com/authwall?trk=..." })),
    "logged-out",
  );
  assert.equal(
    classifyPage(signals({ finalUrl: "https://www.linkedin.com/login" })),
    "logged-out",
  );
});

test("classifyPage: a checkpoint/challenge outranks everything (§16.2)", () => {
  assert.equal(
    classifyPage(signals({ finalUrl: "https://www.linkedin.com/checkpoint/challenge/verify" })),
    "challenge",
  );
  // Even with a nav error present, a landed challenge URL is not what we key on —
  // navError wins only when the tab truly never loaded.
  assert.equal(
    classifyPage(signals({ navError: true, finalUrl: "https://www.linkedin.com/checkpoint/x" })),
    "load-failed",
  );
});

test("classifyPage: a nav error is load-failed regardless of the rest (§16.5)", () => {
  assert.equal(classifyPage(signals({ navError: true, hasResultsList: false })), "load-failed");
});

// ── aggregateOutcome: worst-first across the whole cycle (§16) ────────────────

test("aggregateOutcome: no pages scanned is ok", () => {
  assert.equal(aggregateOutcome([]), "ok");
});

test("aggregateOutcome: one challenged tab halts a cycle of otherwise-ok tabs", () => {
  assert.equal(aggregateOutcome(["ok", "empty", "challenge", "ok"]), "challenge");
});

test("aggregateOutcome: picks the most severe of a mixed cycle", () => {
  assert.equal(aggregateOutcome(["ok", "empty", "load-failed", "structure-changed"]), "structure-changed");
});

// ── reduceScanHealth: the surfacing decisions (§16.8) ─────────────────────────

test("reduceScanHealth: ok clears back to healthy", () => {
  const prior: HealthState = { ...OK_HEALTH, severity: "warn", consecutiveEmptyScans: 4, message: "x" };
  assert.deepEqual(reduceScanHealth(prior, "ok", backoff()), OK_HEALTH);
});

test("reduceScanHealth: a challenge halts, errors, and notifies once (§16.2)", () => {
  const first = reduceScanHealth(OK_HEALTH, "challenge", backoff());
  assert.equal(first.mode, "halted");
  assert.equal(first.severity, "error");
  assert.equal(first.notify, true);
  // Second consecutive challenge: still halted, but no repeat notification.
  const second = reduceScanHealth(first, "challenge", backoff());
  assert.equal(second.mode, "halted");
  assert.equal(second.notify, false);
});

test("reduceScanHealth: logged-out pauses and notifies once (§16.1)", () => {
  const r = reduceScanHealth(OK_HEALTH, "logged-out", backoff());
  assert.equal(r.mode, "paused");
  assert.equal(r.severity, "error");
  assert.equal(r.notify, true);
  assert.equal(reduceScanHealth(r, "logged-out", backoff()).notify, false);
});

test("reduceScanHealth: structure-changed warns immediately, no threshold wait (§16.3)", () => {
  const r = reduceScanHealth(OK_HEALTH, "structure-changed", backoff());
  assert.equal(r.severity, "warn");
  assert.equal(r.mode, "active");
  assert.equal(r.consecutiveEmptyScans, 1);
  assert.equal(r.notify, false); // soft: badge + banner, never a desktop notification
});

test("reduceScanHealth: empty only warns after emptyScansBeforeBackoff repeats (§16.3/§15.6)", () => {
  const cfg = backoff(); // trips at 3
  let s = reduceScanHealth(OK_HEALTH, "empty", cfg);
  assert.equal(s.severity, "ok");
  assert.equal(s.consecutiveEmptyScans, 1);
  s = reduceScanHealth(s, "empty", cfg);
  assert.equal(s.severity, "ok");
  s = reduceScanHealth(s, "empty", cfg);
  assert.equal(s.severity, "warn"); // third in a row trips
  assert.equal(s.consecutiveEmptyScans, 3);
  assert.equal(s.notify, false);
});

test("reduceScanHealth: load-failed is transient — no warning, counter untouched (§16.5)", () => {
  const prior: HealthState = { ...OK_HEALTH, consecutiveEmptyScans: 2 };
  const r = reduceScanHealth(prior, "load-failed", backoff());
  assert.equal(r.mode, "active");
  assert.equal(r.severity, "ok");
  assert.equal(r.consecutiveEmptyScans, 2); // not incremented — infra, not a parser signal
  assert.equal(r.notify, false);
});

// ── isSavableJob / fieldMissingAcrossAll: partial parse (§16.4) ────────────────

test("isSavableJob: a job with id, title and url is saved even with blank company/location", () => {
  assert.equal(isSavableJob({ id: "123", title: "Engineer", url: "https://x/y" }), true);
});

test("isSavableJob: a job missing any load-bearing field is dropped", () => {
  assert.equal(isSavableJob({ id: "", title: "Engineer", url: "https://x/y" }), false);
  assert.equal(isSavableJob({ id: "123", title: "  ", url: "https://x/y" }), false);
  assert.equal(isSavableJob({ id: "123", title: "Engineer", url: "" }), false);
});

test("fieldMissingAcrossAll: flags a field blank on every card as selector drift", () => {
  const jobs = [
    { company: "", location: "Jakarta" },
    { company: "  ", location: "Tokyo" },
  ];
  assert.equal(fieldMissingAcrossAll(jobs, "company"), true);
  assert.equal(fieldMissingAcrossAll(jobs, "location"), false); // present on some
});

test("fieldMissingAcrossAll: an empty scan is not a drift signal", () => {
  assert.equal(fieldMissingAcrossAll([], "company"), false);
});

// ── reducePushHealth: silent-per-call, not silent-forever (§16.7) ─────────────

test("reducePushHealth: a good send resets the failure count", () => {
  assert.deepEqual(reducePushHealth(true, 5, 3), { consecutivePushFailures: 0, warn: false });
});

test("reducePushHealth: warns only after warnThreshold consecutive failures", () => {
  assert.deepEqual(reducePushHealth(false, 0, 3), { consecutivePushFailures: 1, warn: false });
  assert.deepEqual(reducePushHealth(false, 1, 3), { consecutivePushFailures: 2, warn: false });
  assert.deepEqual(reducePushHealth(false, 2, 3), { consecutivePushFailures: 3, warn: true });
});

// ── isLockStale: runs every tick, 5-minute threshold (§16.6) ──────────────────

test("isLockStale: an unlocked state is never stale", () => {
  assert.equal(isLockStale({ isScanning: false, startedAt: null }, 1_000_000, 300_000), false);
});

test("isLockStale: a fresh lock is not stale, an old one is", () => {
  const now = 1_000_000;
  assert.equal(isLockStale({ isScanning: true, startedAt: now - 60_000 }, now, 300_000), false);
  assert.equal(isLockStale({ isScanning: true, startedAt: now - 400_000 }, now, 300_000), true);
});

test("isLockStale: scanning with no startedAt is corrupt and treated as stale", () => {
  assert.equal(isLockStale({ isScanning: true, startedAt: null }, 1_000_000, 300_000), true);
});
