import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPage,
  aggregateOutcome,
  reduceScanHealth,
  shouldRunScan,
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
  // A complete read by default — every pre-existing case here is about *which*
  // failure a page is, not about how much of it was read.
  savedCount: 5,
  slotCount: 5,
  settled: true,
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

// ── partial reads: the failure that used to be indistinguishable from `ok` ────

test("classifyPage: reading 11 of 25 declared slots is partial, not ok", () => {
  // The live-page measurement that started this: LinkedIn declared 25 postings,
  // only 11 were ever materialised, and the old classifier called it `ok`.
  assert.equal(classifyPage(signals({ cardCount: 11, savedCount: 11, slotCount: 25 })), "partial");
});

test("classifyPage: 4 jobs off a page promising 25 rows is partial (live regression)", () => {
  // Straight from the worker log: `4 saved / 25 seen / 25 slots` came back `ok`,
  // because the first version of isPartialRead compared the declared slots
  // against a count derived from those same slots — a number against itself.
  assert.equal(classifyPage(signals({ cardCount: 4, savedCount: 4, slotCount: 25 })), "partial");
});

test("classifyPage: cards that render but don't parse are partial (field drift)", () => {
  // Everything the page promised rendered, but the fields no longer match the
  // selectors, so almost nothing was savable. A different fault from the above,
  // and one the slot count alone can never see.
  assert.equal(classifyPage(signals({ cardCount: 25, savedCount: 4, slotCount: 25 })), "partial");
});

test("classifyPage: a walk that never finished is partial even at full count", () => {
  assert.equal(
    classifyPage(signals({ cardCount: 25, savedCount: 25, slotCount: 25, settled: false })),
    "partial",
  );
});

test("classifyPage: 21 of 25 is partial — the read that used to slip through", () => {
  // Measured after the window fix: everything rendered, but 4 cards used a second
  // layout and were dropped for having no title. At the old 0.8 ratio this scored
  // 0.84 and reported `ok`, which is how the two originally-missing postings
  // stayed missing even once the page was rendering fully.
  assert.equal(classifyPage(signals({ cardCount: 25, savedCount: 21, slotCount: 25 })), "partial");
});

test("classifyPage: a couple of ghost slots do not warn (COMPLETE_READ_RATIO)", () => {
  // Promoted/ghost rows occupy a slot without yielding a job id. Demanding every
  // slot would warn on every healthy scan, which trains the user to ignore it.
  assert.equal(classifyPage(signals({ cardCount: 23, savedCount: 23, slotCount: 25 })), "ok");
});

test("classifyPage: a page that declares no slots has no yardstick, so it is ok", () => {
  assert.equal(classifyPage(signals({ cardCount: 5, savedCount: 5, slotCount: 0 })), "ok");
});

test("classifyPage: an empty page is empty, never partial", () => {
  assert.equal(classifyPage(signals({ cardCount: 0, savedCount: 0, slotCount: 25 })), "empty");
});

test("classifyPage: account-safety signals still outrank a partial read", () => {
  const short = { cardCount: 1, savedCount: 1, slotCount: 25 };
  assert.equal(
    classifyPage(signals({ ...short, finalUrl: "https://www.linkedin.com/checkpoint/x" })),
    "challenge",
  );
  assert.equal(
    classifyPage(signals({ ...short, finalUrl: "https://www.linkedin.com/authwall" })),
    "logged-out",
  );
});

test("aggregateOutcome: one partial page marks the whole cycle partial", () => {
  assert.equal(aggregateOutcome(["ok", "partial", "ok"]), "partial");
  // ...but a real breakage still outranks it.
  assert.equal(aggregateOutcome(["partial", "logged-out"]), "logged-out");
});

test("reduceScanHealth: partial warns at once and leaves the back-off counter alone", () => {
  // Backing the cadence off on a partial read would mean scanning *less* often
  // while already reading less of each page — exactly the wrong direction.
  const prior = { ...OK_HEALTH, consecutiveEmptyScans: 2 };
  const h = reduceScanHealth(prior, "partial", backoff());
  assert.equal(h.severity, "warn");
  assert.equal(h.mode, "active");
  assert.equal(h.consecutiveEmptyScans, 2);
  assert.equal(h.notify, false);
  assert.match(h.message ?? "", /part of the results list/i);
});

test("reduceScanHealth: a clean scan clears a partial warning", () => {
  const warned = reduceScanHealth(OK_HEALTH, "partial", backoff());
  assert.deepEqual(reduceScanHealth(warned, "ok", backoff()), OK_HEALTH);
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

// ── shouldRunScan: pause auto-recovers, halt needs a manual resume (§16.1/§16.2) ─

test("shouldRunScan: active and paused keep scanning; halted does not", () => {
  // paused keeps scanning so a later `ok` scan is what auto-resumes it (§16.1).
  assert.equal(shouldRunScan("active"), true);
  assert.equal(shouldRunScan("paused"), true);
  // halted stops entirely until the user clears the challenge and resumes (§16.2).
  assert.equal(shouldRunScan("halted"), false);
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
