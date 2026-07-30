import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  backupCounts,
  backupFilename,
  backupPhrase,
  buildBackup,
  parseBackup,
  reconcileUi,
  restoredSettings,
  serializeBackup,
  type BackupFile,
} from "./backup.ts";
import { DEFAULT_SETTINGS, type Job, type Settings } from "./types.ts";
import { DEFAULT_UI, type JobsMap } from "./storage.ts";
import type { SeenMap } from "./dedupe.ts";

// Export/import for PRD §5/§6 — pure (§14): no chrome.*, no DOM, no clock read
// (the caller passes `exportedAt`), so `node --test` proves every rule with plain
// values. What these pin is the three rules the module is built on: the two
// Telegram secrets never reach a file, a file is all-or-nothing, and an import
// replaces rather than merges.

const NOW = 1_753_833_600_000; // 2025-07-30T00:00:00Z — fixed, so dates are exact

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    watches: [{ id: "w1", name: "Tokyo remote", url: "https://www.linkedin.com/jobs/search/?keywords=go", enabled: true }],
    blockedCompanies: [{ display: "Acme Corp", normalized: "acme corp" }],
    blockedTitleKeywords: ["intern"],
    push: { enabled: true, botToken: "123456:SECRET-TOKEN", chatId: "987654321" },
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "1",
    title: "Staff Engineer",
    company: "Acme Corp",
    location: "Remote",
    isReposted: false,
    postedText: "2 hours ago",
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

function backup(overrides: Partial<Parameters<typeof buildBackup>[0]> = {}): BackupFile {
  return buildBackup({
    settings: settings(),
    seen: { "1": NOW },
    jobs: { "1": job() },
    exportedAt: NOW,
    extensionVersion: "0.1.0",
    ...overrides,
  });
}

/** A file's text, as the download would contain it — the only honest input to
 *  `parseBackup`, since that is what a user actually hands back. */
const asText = (file: BackupFile): string => serializeBackup(file);

// ── Rule 1: the two secrets never leave the browser ──────────────────────────

test("the bot token and chat id are structurally absent from the file", () => {
  const file = backup();
  assert.deepEqual(file.settings.push, { enabled: true });
  assert.equal("botToken" in file.settings.push, false);
  assert.equal("chatId" in file.settings.push, false);
});

test("neither secret survives anywhere in the serialised text", () => {
  // The belt-and-braces check: not "the field is gone" but "the string is gone",
  // which also catches a secret smuggled through some other field later.
  const text = asText(backup());
  assert.equal(text.includes("SECRET-TOKEN"), false);
  assert.equal(text.includes("987654321"), false);
});

test("push.enabled does survive — it is a preference, not a credential", () => {
  assert.equal(backup({ settings: settings({ push: { enabled: false, botToken: "t", chatId: "c" } }) }).settings.push.enabled, false);
  assert.equal(backup().settings.push.enabled, true);
});

test("importing keeps this browser's credentials and takes the file's toggle", () => {
  const local = settings({ push: { enabled: false, botToken: "LOCAL-TOKEN", chatId: "LOCAL-CHAT" } });
  const restored = restoredSettings(backup().settings, local);
  assert.equal(restored.push.botToken, "LOCAL-TOKEN");
  assert.equal(restored.push.chatId, "LOCAL-CHAT");
  assert.equal(restored.push.enabled, true); // the file said on
});

test("importing onto a browser with no credentials leaves the toggle on and empty", () => {
  // Documented rather than "fixed": overriding it would silently discard a
  // preference the file recorded, and an unconfigured push already reports itself.
  const fresh = settings({ push: { enabled: false, botToken: "", chatId: "" } });
  const restored = restoredSettings(backup().settings, fresh);
  assert.equal(restored.push.enabled, true);
  assert.equal(restored.push.botToken, "");
});

// ── Everything else does round-trip ──────────────────────────────────────────

test("a file written now parses back to exactly what went in", () => {
  const original = backup();
  const result = parseBackup(asText(original));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.backup, original);
});

test("the fields the options page never shows round-trip too", () => {
  // pacing/backoff/staleLockMs/pushFailWarnThreshold and the master switch are
  // only reachable by editing storage by hand, which is exactly why a restore
  // has to carry them.
  const tuned = settings({
    enabled: false,
    pacing: { pagePauseMs: [1000, 2000], watchPauseMs: [4000, 6000] },
    backoff: { emptyScansBeforeBackoff: 7, maxIntervalMinutes: 999 },
    staleLockMs: 60_000,
    pushFailWarnThreshold: 9,
  });
  const result = parseBackup(asText(backup({ settings: tuned })));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const restored = restoredSettings(result.backup.settings, settings());
  assert.equal(restored.enabled, false);
  assert.deepEqual(restored.pacing.pagePauseMs, [1000, 2000]);
  assert.equal(restored.backoff.maxIntervalMinutes, 999);
  assert.equal(restored.staleLockMs, 60_000);
  assert.equal(restored.pushFailWarnThreshold, 9);
});

test("a job's read/opened/applied state and its notes survive the trip", () => {
  const applied = job({ id: "42", opened: true, openedAt: NOW, read: true, readAt: NOW, applied: true, appliedAt: NOW, applyNotes: "referred by Sam" });
  const result = parseBackup(asText(backup({ jobs: { "42": applied } })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.backup.jobs["42"], applied);
});

test("a job record with none of the three apply fields is still valid", () => {
  // Records written before "Did you apply?" shipped carry none of them, and an
  // absent `applied` reads as "never applied" — the same rule storage follows.
  const result = parseBackup(asText(backup({ jobs: { "1": job() } })));
  assert.equal(result.ok, true);
  assert.equal(result.ok && "applied" in (result.backup.jobs["1"] ?? {}), false);
});

test("the seen map survives, which is what stops a restore re-announcing", () => {
  const seen: SeenMap = { a: 1, b: 2, c: 3 };
  const result = parseBackup(asText(backup({ seen })));
  assert.deepEqual(result.ok && result.backup.seen, seen);
});

// ── Rule 2: all or nothing ───────────────────────────────────────────────────

test("text that isn't JSON is refused, and says so", () => {
  const result = parseBackup("<!doctype html><html>not json</html>");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /valid JSON/);
});

test("valid JSON that isn't a backup is refused by kind, not by field", () => {
  const result = parseBackup(JSON.stringify({ some: "other file" }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /isn’t a LinkedIn Job Watcher backup/);
});

test("a JSON array is refused rather than crashing the kind check", () => {
  assert.equal(parseBackup("[1,2,3]").ok, false);
  assert.equal(parseBackup("null").ok, false);
});

test("a newer version is refused by number, so the message can name it", () => {
  const future = { ...backup(), version: BACKUP_VERSION + 1 };
  const result = parseBackup(JSON.stringify(future));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /v2.*reads v1/);
});

test("an older version is refused too — reading it is a decision, not a default", () => {
  const old = { ...backup(), version: 0 };
  assert.equal(parseBackup(JSON.stringify(old)).ok, false);
});

test("one bad field fails the whole file, and the error names the path", () => {
  const file = backup();
  const damaged = { ...file, settings: { ...file.settings, intervalMinutes: 0 } };
  const result = parseBackup(JSON.stringify(damaged));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /settings\.intervalMinutes/);
});

test("a wrong type anywhere fails the file", () => {
  const file = backup();
  const cases: unknown[] = [
    { ...file, settings: { ...file.settings, hideReposted: "yes" } },
    { ...file, settings: { ...file.settings, watches: [{ id: "w1", name: "x", url: "not a url", enabled: true }] } },
    { ...file, settings: { ...file.settings, quietHours: { enabled: true, startMinute: 1440, endMinute: 0 } } },
    { ...file, seen: { "1": "yesterday" } },
    { ...file, jobs: { "1": { ...job(), read: null } } },
  ];
  for (const damaged of cases) {
    assert.equal(parseBackup(JSON.stringify(damaged)).ok, false, JSON.stringify(damaged).slice(0, 80));
  }
});

test("a truncated download fails on the JSON, before it can half-apply", () => {
  const text = asText(backup());
  assert.equal(parseBackup(text.slice(0, Math.floor(text.length / 2))).ok, false);
});

test("a file carrying credentials has them stripped, not honoured", () => {
  // Something other than this extension wrote it. The keys are dropped by the
  // schema, so an import can never take a token from a file.
  const file = backup();
  const meddled = {
    ...file,
    settings: { ...file.settings, push: { enabled: true, botToken: "INJECTED", chatId: "INJECTED" } },
  };
  const result = parseBackup(JSON.stringify(meddled));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.backup.settings.push, { enabled: true });
  const restored = restoredSettings(result.backup.settings, settings());
  assert.equal(restored.push.botToken, "123456:SECRET-TOKEN"); // this browser's, untouched
});

// ── Rule 3: replace, don't merge ─────────────────────────────────────────────

test("restored settings are the file's lists, not a union with what is stored", () => {
  const stored = settings({
    watches: [
      { id: "w1", name: "Tokyo remote", url: "https://www.linkedin.com/jobs/search/?keywords=go", enabled: true },
      { id: "w9", name: "Only here", url: "https://www.linkedin.com/jobs/search/?keywords=rust", enabled: true },
    ],
    blockedCompanies: [
      { display: "Acme Corp", normalized: "acme corp" },
      { display: "Only Here Ltd", normalized: "only here ltd" },
    ],
    blockedTitleKeywords: ["intern", "only-here"],
  });
  const restored = restoredSettings(backup().settings, stored);
  // The point of a restore is that it can remove things, so nothing local survives.
  assert.deepEqual(restored.watches.map((w) => w.id), ["w1"]);
  assert.deepEqual(restored.blockedCompanies.map((c) => c.normalized), ["acme corp"]);
  assert.deepEqual(restored.blockedTitleKeywords, ["intern"]);
});

test("a watch keeps its label and its on/off state", () => {
  const paused = settings({
    watches: [{ id: "w2", name: "Paused search", url: "https://www.linkedin.com/jobs/search/?f_WT=2", enabled: false }],
  });
  const result = parseBackup(asText(backup({ settings: paused })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.backup.settings.watches[0], {
    id: "w2",
    name: "Paused search",
    url: "https://www.linkedin.com/jobs/search/?f_WT=2",
    enabled: false,
  });
});

// ── The view state an import has to reconcile ────────────────────────────────

test("a chip pointing at a watch the import removed goes back to All watches", () => {
  const ui = { ...DEFAULT_UI, activeWatchId: "gone", mode: "new" as const };
  const next = reconcileUi(ui, {}, [{ id: "w1", name: "x", url: "https://x.test/", enabled: true }]);
  assert.equal(next.activeWatchId, null);
  assert.equal(next.mode, "new"); // New-vs-All is about the page, so it survives
});

test("a chip pointing at a watch the import kept is left alone", () => {
  const ui = { ...DEFAULT_UI, activeWatchId: "w1" };
  const next = reconcileUi(ui, {}, [{ id: "w1", name: "x", url: "https://x.test/", enabled: true }]);
  assert.equal(next.activeWatchId, "w1");
});

test("an unanswered apply question about a job that is gone is dropped", () => {
  const ui = { ...DEFAULT_UI, pendingApplyId: "42" };
  assert.equal(reconcileUi(ui, {}, []).pendingApplyId, null);
});

test("an unanswered apply question about a job the file carries is kept", () => {
  const jobs: JobsMap = { "42": job({ id: "42" }) };
  const ui = { ...DEFAULT_UI, pendingApplyId: "42" };
  assert.equal(reconcileUi(ui, jobs, []).pendingApplyId, "42");
});

test("a ui record written before pendingApplyId existed reconciles to null", () => {
  const ui = { activeWatchId: null, mode: null };
  assert.equal(reconcileUi(ui, {}, []).pendingApplyId, null);
});

// ── Saying what is in a file ─────────────────────────────────────────────────

test("the counts are the five things a user would recognise", () => {
  assert.deepEqual(backupCounts(backup()), {
    watches: 1,
    blockedCompanies: 1,
    blockedTitleKeywords: 1,
    jobs: 1,
    seen: 1,
  });
});

test("the phrase names every non-empty category, singular where it should be", () => {
  assert.equal(
    backupPhrase({ watches: 1, blockedCompanies: 1, blockedTitleKeywords: 1, jobs: 1, seen: 1 }),
    "1 watch, 1 blocked company, 1 blocked keyword, 1 job and 1 seen id",
  );
  assert.equal(
    backupPhrase({ watches: 4, blockedCompanies: 12, blockedTitleKeywords: 3, jobs: 128, seen: 4301 }),
    "4 watches, 12 blocked companies, 3 blocked keywords, 128 jobs and 4,301 seen ids",
  );
});

test("empty categories are left out rather than reported as zero", () => {
  assert.equal(
    backupPhrase({ watches: 2, blockedCompanies: 0, blockedTitleKeywords: 0, jobs: 0, seen: 9 }),
    "2 watches and 9 seen ids",
  );
  assert.equal(
    backupPhrase({ watches: 0, blockedCompanies: 0, blockedTitleKeywords: 0, jobs: 0, seen: 5 }),
    "5 seen ids",
  );
});

test("an empty backup says so rather than saying nothing", () => {
  assert.equal(
    backupPhrase({ watches: 0, blockedCompanies: 0, blockedTitleKeywords: 0, jobs: 0, seen: 0 }),
    "no watches, filters or job history",
  );
});

// ── The file on disk ─────────────────────────────────────────────────────────

test("the filename is dated, so a folder of them sorts newest-last", () => {
  assert.equal(backupFilename(NOW), "linkedin-job-watcher-backup-2025-07-30.json");
});

test("the text is indented and newline-terminated, so it can be read and diffed", () => {
  const text = asText(backup());
  assert.match(text, /^\{\n {2}"kind"/);
  assert.match(text, /\n$/);
});

test("the file records what wrote it and when", () => {
  const file = backup({ exportedAt: NOW, extensionVersion: "1.2.3" });
  assert.equal(file.kind, BACKUP_KIND);
  assert.equal(file.version, BACKUP_VERSION);
  assert.equal(file.exportedAt, "2025-07-30T00:00:00.000Z");
  assert.equal(file.extensionVersion, "1.2.3");
});

test("an install with nothing in it still produces a valid file", () => {
  const empty = buildBackup({
    settings: DEFAULT_SETTINGS,
    seen: {},
    jobs: {},
    exportedAt: NOW,
    extensionVersion: "0.1.0",
  });
  const result = parseBackup(asText(empty));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.backup, empty);
});
