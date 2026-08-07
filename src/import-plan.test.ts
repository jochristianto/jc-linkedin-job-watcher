import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_CAP,
  KEEP_MINE,
  confirmSentence,
  furtherAlong,
  importSteps,
  importedPhrase,
  isNoOp,
  mergeBlockedCompanies,
  mergeImportedJobs,
  mergeKeywords,
  mergeSeen,
  mergeSettings,
  mergeWatches,
  normalizeWatchUrl,
  planImport,
  settingChoices,
  stepAfter,
  stepBefore,
  type ImportTarget,
  type SettingChoices,
} from "./import-plan.ts";
import { buildBackup, restoredSettings, type BackupFile } from "./backup.ts";
import { DEFAULT_SETTINGS, type Job, type Settings, type Watch } from "./types.ts";
import type { JobsMap } from "./storage.ts";
import type { SeenMap } from "./dedupe.ts";

// What applying a backup would do, PRD §20 — pure (§14): no chrome.*, no DOM, no
// clock read, so `node --test` proves every conflict rule with plain values. What
// these pin is the three rules the module is built on: one function serves both the
// preview and the write, the page ships decisions rather than a result, and a merge
// only ever adds.

const NOW = 1_753_833_600_000; // 2025-07-30T00:00:00Z
const HOUR = 3_600_000;

const URL_A = "https://www.linkedin.com/jobs/search/?keywords=go&geoId=102478259";
const URL_B = "https://www.linkedin.com/jobs/search/?keywords=rust";

function watch(over: Partial<Watch> = {}): Watch {
  return { id: "w1", name: "Go, Indonesia", url: URL_A, enabled: true, ...over };
}

function settings(over: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    watches: [watch()],
    blockedCompanies: [{ display: "Acme Corp", normalized: "acme corp" }],
    blockedTitleKeywords: ["intern"],
    push: { enabled: true, botToken: "123456:SECRET-TOKEN", chatId: "987654321" },
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
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
    ...over,
  };
}

/** A file, built the only honest way — through `buildBackup`, so it carries what a
 *  real export carries and nothing a hand-written literal might invent. */
function file(over: { settings?: Settings; seen?: SeenMap; jobs?: JobsMap } = {}): BackupFile {
  return buildBackup({
    settings: over.settings ?? settings(),
    seen: over.seen ?? { "1": NOW },
    jobs: over.jobs ?? { "1": job() },
    exportedAt: NOW,
    extensionVersion: "0.1.0",
  });
}

function target(over: Partial<ImportTarget> = {}): ImportTarget {
  return { settings: settings(), seen: { "1": NOW }, jobs: { "1": job() }, ...over };
}

const merge = (f: BackupFile, t: ImportTarget, choices: SettingChoices = KEEP_MINE) =>
  planImport(f, t, "merge", choices);
const replace = (f: BackupFile, t: ImportTarget) => planImport(f, t, "replace", KEEP_MINE);

// ── normalizeWatchUrl: two browsers, one search ──────────────────────────────

test("the same filters in a different order fold to the same search", () => {
  assert.equal(
    normalizeWatchUrl("https://www.linkedin.com/jobs/search/?geoId=102478259&keywords=go"),
    normalizeWatchUrl("https://www.linkedin.com/jobs/search/?keywords=go&geoId=102478259"),
  );
});

test("LinkedIn's click tracking is not part of what a search searches for", () => {
  const clean = normalizeWatchUrl(URL_B);
  for (const junk of [
    "&trk=public_jobs_jserp-result_search-card",
    "&refId=abc123",
    "&trackingId=xyz%3D%3D",
    "&origin=JOB_SEARCH_PAGE_JOB_FILTER",
    "&currentJobId=4123456789",
  ]) {
    assert.equal(normalizeWatchUrl(URL_B + junk), clean, junk);
  }
});

test("host casing and a trailing slash are not a different search", () => {
  assert.equal(
    normalizeWatchUrl("https://WWW.LinkedIn.com/jobs/search/?keywords=rust"),
    normalizeWatchUrl("https://www.linkedin.com/jobs/search?keywords=rust"),
  );
});

test("a cleared field leaves `&location=` behind, which filters on nothing", () => {
  assert.equal(normalizeWatchUrl(`${URL_B}&location=`), normalizeWatchUrl(URL_B));
});

test("a fragment is not part of the search either", () => {
  assert.equal(normalizeWatchUrl(`${URL_B}#results`), normalizeWatchUrl(URL_B));
});

test("a URL that cannot be parsed folds to itself rather than throwing", () => {
  assert.equal(normalizeWatchUrl("  Not A Url  "), "not a url");
});

// ── mergeWatches: local wins, and the ids are remapped ───────────────────────

test("a watch the file has and this browser does not is appended", () => {
  const { watches } = mergeWatches([watch()], [watch({ id: "w2", name: "Rust", url: URL_B })]);
  assert.equal(watches.length, 2);
  assert.equal(watches[1]?.name, "Rust");
});

test("the same id keeps the local name and the local on/off state", () => {
  const { watches } = mergeWatches(
    [watch({ name: "My rename", enabled: false })],
    [watch({ name: "Original", enabled: true })],
  );
  assert.equal(watches.length, 1);
  assert.equal(watches[0]?.name, "My rename");
  assert.equal(watches[0]?.enabled, false);
});

test("the same search under two different ids is ONE watch, not two", () => {
  // The failure that would make merging worse than not merging: watch ids are
  // generated where the watch was typed, so two browsers never share one.
  const { watches } = mergeWatches(
    [watch({ id: "mine", url: URL_A })],
    [watch({ id: "theirs", url: `${URL_A}&trk=copied_from_the_address_bar` })],
  );
  assert.equal(watches.length, 1);
  assert.equal(watches[0]?.id, "mine");
});

test("a watch matched by URL leaves an id remap behind", () => {
  const { idMap } = mergeWatches([watch({ id: "mine" })], [watch({ id: "theirs" })]);
  assert.deepEqual(idMap, { theirs: "mine" });
});

test("a watch that survives under its own id needs no remap", () => {
  const { idMap } = mergeWatches([watch()], [watch({ id: "w2", url: URL_B })]);
  assert.deepEqual(idMap, {});
});

test("a file listing the same search twice contributes it once", () => {
  const { watches } = mergeWatches(
    [],
    [watch({ id: "a", url: URL_B }), watch({ id: "b", url: `${URL_B}&refId=1` })],
  );
  assert.equal(watches.length, 1);
});

test("merging the same file twice adds nothing the second time", () => {
  const once = mergeWatches([watch()], [watch({ id: "w2", url: URL_B })]);
  const twice = mergeWatches(once.watches, [watch({ id: "w2", url: URL_B })]);
  assert.deepEqual(twice.watches, once.watches);
});

// ── mergeBlockedCompanies ────────────────────────────────────────────────────

test("a company both sides block keeps the spelling this browser shows", () => {
  const merged = mergeBlockedCompanies(
    [{ display: "Acme Corp", normalized: "acme corp" }],
    [{ display: "ACME CORP", normalized: "acme corp" }],
  );
  assert.deepEqual(merged, [{ display: "Acme Corp", normalized: "acme corp" }]);
});

test("a company only the file blocks arrives trimmed and normalized", () => {
  const merged = mergeBlockedCompanies([], [{ display: "  Globex  ", normalized: "globex" }]);
  assert.deepEqual(merged, [{ display: "Globex", normalized: "globex" }]);
});

test("a hand-edited file whose normalized disagrees with its display is re-derived", () => {
  // §6 normalizes on WRITE and an import is a write. The merge matches on
  // `normalized`, so it has to be the one this build would have produced.
  const merged = mergeBlockedCompanies([], [{ display: "Initech", normalized: "wrong" }]);
  assert.deepEqual(merged, [{ display: "Initech", normalized: "initech" }]);
});

test("an empty company entry is dropped rather than blocking everything", () => {
  assert.deepEqual(mergeBlockedCompanies([], [{ display: "   ", normalized: "" }]), []);
});

test("merging the same blocklist twice adds nothing the second time", () => {
  const once = mergeBlockedCompanies([], [{ display: "Globex", normalized: "globex" }]);
  assert.deepEqual(mergeBlockedCompanies(once, [{ display: "Globex", normalized: "globex" }]), once);
});

// ── mergeKeywords ────────────────────────────────────────────────────────────

test("a keyword both sides block keeps this browser's spelling", () => {
  assert.deepEqual(mergeKeywords(["Senior"], ["senior"]), ["Senior"]);
});

test("a keyword only the file blocks arrives trimmed", () => {
  assert.deepEqual(mergeKeywords([], ["  intern  "]), ["intern"]);
});

test("blank keywords are dropped — one would block every title there is", () => {
  assert.deepEqual(mergeKeywords([], ["", "   "]), []);
});

test("merging the same keywords twice adds nothing the second time", () => {
  assert.deepEqual(mergeKeywords(["intern"], ["intern"]), ["intern"]);
});

// ── mergeSeen: the earlier stamp, always ─────────────────────────────────────

test("every id from both sides survives the merge", () => {
  assert.deepEqual(mergeSeen({ a: NOW }, { b: NOW }), { a: NOW, b: NOW });
});

test("an id both sides remember keeps the EARLIER first-seen stamp", () => {
  assert.deepEqual(mergeSeen({ a: NOW }, { a: NOW - HOUR }), { a: NOW - HOUR });
  assert.deepEqual(mergeSeen({ a: NOW - HOUR }, { a: NOW }), { a: NOW - HOUR });
});

test("merging is commutative, which is what lets a preview be computed early", () => {
  const a: SeenMap = { x: NOW, y: NOW - HOUR };
  const b: SeenMap = { y: NOW, z: NOW + HOUR };
  assert.deepEqual(mergeSeen(a, b), mergeSeen(b, a));
});

test("the earlier stamp means the id expires on its original schedule", () => {
  // `collectGarbage` prunes at `firstSeenAt + seenDays`. Taking the later stamp
  // would renew a memory that was already due to go.
  const merged = mergeSeen({ a: NOW }, { a: NOW + 10 * HOUR });
  assert.equal(merged.a, NOW);
});

// ── furtherAlong: nothing you have already done is forgotten ─────────────────

test("a job neither side opened stays unopened", () => {
  const merged = furtherAlong(job(), job());
  assert.equal(merged.opened, false);
  assert.equal(merged.openedAt, null);
});

test("opened on either side means opened", () => {
  assert.equal(furtherAlong(job(), job({ opened: true, openedAt: NOW })).opened, true);
  assert.equal(furtherAlong(job({ opened: true, openedAt: NOW }), job()).opened, true);
});

test("two opened-at stamps collapse to the earlier one", () => {
  const merged = furtherAlong(
    job({ opened: true, openedAt: NOW }),
    job({ opened: true, openedAt: NOW - HOUR }),
  );
  assert.equal(merged.openedAt, NOW - HOUR);
});

test("opened with no stamp on one side takes the stamp from the other", () => {
  const merged = furtherAlong(job({ opened: true, openedAt: null }), job({ opened: true, openedAt: NOW }));
  assert.equal(merged.openedAt, NOW);
});

test("a job neither side dismissed stays unread", () => {
  const merged = furtherAlong(job(), job());
  assert.equal(merged.read, false);
  assert.equal(merged.readAt, null);
});

test("dismissed on either side means dismissed", () => {
  assert.equal(furtherAlong(job(), job({ read: true, readAt: NOW })).read, true);
  assert.equal(furtherAlong(job({ read: true, readAt: NOW }), job()).read, true);
});

test("two read-at stamps collapse to the earlier one", () => {
  const merged = furtherAlong(job({ read: true, readAt: NOW }), job({ read: true, readAt: NOW - HOUR }));
  assert.equal(merged.readAt, NOW - HOUR);
});

test("dismissed with no stamp on one side takes the stamp from the other", () => {
  const merged = furtherAlong(job({ read: true, readAt: null }), job({ read: true, readAt: NOW }));
  assert.equal(merged.readAt, NOW);
});

test("neither side applied leaves all three apply fields STRUCTURALLY ABSENT", () => {
  // §19's undo deletes all three so "never applied" leaves no residue. A merged
  // record has to be shape-identical to one that was never touched.
  const merged = furtherAlong(job(), job());
  assert.equal("applied" in merged, false);
  assert.equal("appliedAt" in merged, false);
  assert.equal("applyNotes" in merged, false);
});

test("applied on one side carries its stamp and its note across", () => {
  const merged = furtherAlong(
    job(),
    job({ applied: true, appliedAt: NOW, applyNotes: "Referred by Sam" }),
  );
  assert.equal(merged.applied, true);
  assert.equal(merged.appliedAt, NOW);
  assert.equal(merged.applyNotes, "Referred by Sam");
});

test("applied on both sides records when you applied, not when you last confirmed", () => {
  const merged = furtherAlong(
    job({ applied: true, appliedAt: NOW, applyNotes: "" }),
    job({ applied: true, appliedAt: NOW - HOUR, applyNotes: "" }),
  );
  assert.equal(merged.appliedAt, NOW - HOUR);
});

test("two different notes are both kept, this browser's first", () => {
  // The one conflict rule that does not pick a winner: a note is the only
  // irreplaceable free text in the system.
  const merged = furtherAlong(
    job({ applied: true, appliedAt: NOW, applyNotes: "Referred by Sam" }),
    job({ applied: true, appliedAt: NOW, applyNotes: "Recruiter call booked" }),
  );
  assert.equal(merged.applyNotes, "Referred by Sam · Recruiter call booked");
});

test("the same note on both sides is kept once, not twice", () => {
  const merged = furtherAlong(
    job({ applied: true, appliedAt: NOW, applyNotes: "Referred by Sam" }),
    job({ applied: true, appliedAt: NOW, applyNotes: "Referred by Sam" }),
  );
  assert.equal(merged.applyNotes, "Referred by Sam");
});

test("one empty note joins with no dangling separator", () => {
  const merged = furtherAlong(
    job({ applied: true, appliedAt: NOW, applyNotes: "" }),
    job({ applied: true, appliedAt: NOW, applyNotes: "Recruiter call booked" }),
  );
  assert.equal(merged.applyNotes, "Recruiter call booked");
});

test("importing the same file twice does not double an already-joined note", () => {
  const mine = job({ applied: true, appliedAt: NOW, applyNotes: "Referred by Sam · Recruiter call booked" });
  const theirs = job({ applied: true, appliedAt: NOW, applyNotes: "Recruiter call booked" });
  assert.equal(furtherAlong(mine, theirs).applyNotes, "Referred by Sam · Recruiter call booked");
});

test("the descriptive fields keep the record the list is already rendering", () => {
  const merged = furtherAlong(
    job({ title: "Staff Engineer", company: "Acme Corp", location: "Remote" }),
    job({ title: "Senior Engineer", company: "Acme Corporation", location: "Jakarta" }),
  );
  assert.equal(merged.title, "Staff Engineer");
  assert.equal(merged.company, "Acme Corp");
  assert.equal(merged.location, "Remote");
});

test("postedAt and postedPrecision move together to the more precise side", () => {
  const merged = furtherAlong(
    job({ postedAt: NOW, postedPrecision: "estimated" }),
    job({ postedAt: NOW - HOUR, postedPrecision: "exact" }),
  );
  assert.equal(merged.postedAt, NOW - HOUR);
  assert.equal(merged.postedPrecision, "exact");
});

test("a record with no date loses to one that has one", () => {
  const merged = furtherAlong(job(), job({ postedAt: NOW, postedPrecision: "day" }));
  assert.equal(merged.postedAt, NOW);
  assert.equal(merged.postedPrecision, "day");
});

test("equal precision keeps this browser's date", () => {
  const merged = furtherAlong(
    job({ postedAt: NOW, postedPrecision: "day" }),
    job({ postedAt: NOW - HOUR, postedPrecision: "day" }),
  );
  assert.equal(merged.postedAt, NOW);
});

test("an unreadable footer slot takes the file's answer, a readable one does not", () => {
  assert.equal(furtherAlong(job(), job({ linkedInStatus: "promoted" })).linkedInStatus, "promoted");
  assert.equal(
    furtherAlong(job({ linkedInStatus: "viewed" }), job({ linkedInStatus: "promoted" })).linkedInStatus,
    "viewed",
  );
});

test("foundAt takes the earlier of the two, so the collector cannot be fooled", () => {
  assert.equal(furtherAlong(job({ foundAt: NOW }), job({ foundAt: NOW - HOUR })).foundAt, NOW - HOUR);
});

test("a record already here keeps pointing at the watch it was found under", () => {
  assert.equal(furtherAlong(job({ watchId: "mine" }), job({ watchId: "theirs" })).watchId, "mine");
});

test("a record that moves nowhere comes back by identity", () => {
  // What lets the diff tell "already here" from "further along" without a second
  // comparison, and what keeps a no-op merge from rewriting the whole store.
  const mine = job();
  assert.equal(furtherAlong(mine, job()), mine);
});

// ── mergeImportedJobs ────────────────────────────────────────────────────────

test("a job only the file has lands whole", () => {
  const merged = mergeImportedJobs({}, { "2": job({ id: "2", title: "SRE" }) }, {});
  assert.equal(merged["2"]?.title, "SRE");
});

test("a job only this browser has is left exactly as it was", () => {
  const mine = job();
  const merged = mergeImportedJobs({ "1": mine }, {}, {});
  assert.equal(merged["1"], mine);
});

test("a file job's watchId is remapped onto the watch that survived", () => {
  const merged = mergeImportedJobs({}, { "2": job({ id: "2", watchId: "theirs" }) }, { theirs: "mine" });
  assert.equal(merged["2"]?.watchId, "mine");
});

test("a merged never-applied job carries no `applied` key at all", () => {
  const merged = mergeImportedJobs({ "1": job() }, { "1": job({ opened: true, openedAt: NOW }) }, {});
  assert.equal("applied" in merged["1"]!, false);
});

// ── The settings rows ────────────────────────────────────────────────────────

test("the three list settings never get a row — a union needs no question", () => {
  const rows = settingChoices(
    settings({ watches: [watch()], blockedTitleKeywords: ["intern"] }),
    { ...settings({ watches: [], blockedTitleKeywords: ["senior"] }), push: { enabled: true } },
  );
  assert.deepEqual(rows, []);
});

test("a setting the two sides agree about is not a row", () => {
  assert.deepEqual(settingChoices(settings(), { ...settings(), push: { enabled: true } }), []);
});

test("quiet hours are ONE row, read as a window rather than as three numbers", () => {
  const rows = settingChoices(settings(), {
    ...settings({ quietHours: { enabled: true, startMinute: 1_380, endMinute: 360 } }),
    push: { enabled: true },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.key, "quietHours");
  assert.equal(rows[0]?.mine, "23:00–07:00");
  assert.equal(rows[0]?.file, "23:00–06:00");
});

test("the interval and its jitter are one row, phrased as the band they produce", () => {
  const rows = settingChoices(settings(), {
    ...settings({ intervalMinutes: 30, jitterMinutes: 10 }),
    push: { enabled: true },
  });
  assert.equal(rows[0]?.key, "cadence");
  assert.equal(rows[0]?.mine, "Every 30–90 min");
  assert.equal(rows[0]?.file, "Every 20–40 min");
});

test("retention is one row, in the units the page uses", () => {
  const rows = settingChoices(settings(), {
    ...settings({ retention: { seenDays: 30, openedJobDays: 7, unopenedJobDays: 30, seenHardCap: 50_000 } }),
    push: { enabled: true },
  });
  assert.equal(rows[0]?.key, "retention");
  assert.match(rows[0]!.file, /^30d seen · 7d opened · 30d unopened · 50,000 cap$/);
});

test("an absent choice reads as `mine`", () => {
  const mine = settings({ intervalMinutes: 60 });
  const theirs = { ...settings({ intervalMinutes: 15 }), push: { enabled: true } };
  assert.equal(mergeSettings(mine, theirs, KEEP_MINE).settings.intervalMinutes, 60);
});

test("a row ticked to the file moves EVERY field it groups", () => {
  const mine = settings({ intervalMinutes: 60, jitterMinutes: 30 });
  const theirs = { ...settings({ intervalMinutes: 15, jitterMinutes: 5 }), push: { enabled: true } };
  const { settings: merged } = mergeSettings(mine, theirs, { cadence: "file" });
  assert.equal(merged.intervalMinutes, 15);
  assert.equal(merged.jitterMinutes, 5);
});

test("the Telegram credentials survive whichever way the push row is ticked", () => {
  const mine = settings();
  const theirs = { ...settings(), push: { enabled: false } };
  for (const choices of [KEEP_MINE, { pushEnabled: "file" } as const]) {
    const { settings: merged } = mergeSettings(mine, theirs, choices);
    assert.equal(merged.push.botToken, "123456:SECRET-TOKEN");
    assert.equal(merged.push.chatId, "987654321");
  }
  assert.equal(mergeSettings(mine, theirs, { pushEnabled: "file" }).settings.push.enabled, false);
  assert.equal(mergeSettings(mine, theirs, KEEP_MINE).settings.push.enabled, true);
});

test("a file exported from this browser merges back to identical settings", () => {
  const mine = settings();
  const { settings: merged } = mergeSettings(mine, file({ settings: mine }).settings, KEEP_MINE);
  assert.deepEqual(merged, mine);
});

// ── planImport: merge ────────────────────────────────────────────────────────

test("a merge never loses a watch, a job or a seen id", () => {
  const t = target({
    settings: settings({ watches: [watch({ id: "mine", url: URL_B, name: "Only mine" })] }),
    seen: { onlyMine: NOW },
    jobs: { onlyMine: job({ id: "onlyMine" }) },
  });
  const { settings: s, seen, jobs } = merge(file(), t);
  assert.ok(s.watches.some((w) => w.id === "mine"));
  assert.ok("onlyMine" in seen);
  assert.ok("onlyMine" in jobs);
  assert.equal(s.watches.length, 2);
});

test("a merge reports what it adds and never reports a removal", () => {
  const t = target({ settings: settings({ watches: [] }), seen: {}, jobs: {} });
  const { diff } = merge(file(), t);
  assert.equal(diff.counts.watchesAdded, 1);
  assert.equal(diff.counts.jobsAdded, 1);
  assert.equal(diff.counts.seenAdded, 1);
  assert.equal(diff.counts.watchesRemoved, 0);
  assert.equal(diff.counts.jobsRemoved, 0);
  assert.equal(diff.counts.seenRemoved, 0);
  for (const g of [...diff.lists, ...diff.history]) {
    assert.ok(!g.lines.some((l) => l.kind === "removed"), g.title);
  }
});

test("a job already here that comes back knowing more is counted as advanced", () => {
  const t = target({ jobs: { "1": job() } });
  const f = file({ jobs: { "1": job({ opened: true, openedAt: NOW }) } });
  const { diff } = merge(f, t);
  assert.equal(diff.counts.jobsAdvanced, 1);
  assert.equal(diff.counts.jobsAdded, 0);
});

test("a job already here and identical is not counted as advanced", () => {
  const { diff } = merge(file(), target());
  assert.equal(diff.counts.jobsAdvanced, 0);
  assert.equal(diff.counts.jobsAdded, 0);
});

test("importing into an empty browser is all additions", () => {
  const t = target({ settings: { ...DEFAULT_SETTINGS }, seen: {}, jobs: {} });
  const { diff } = merge(file(), t);
  assert.equal(diff.counts.watchesAdded, 1);
  assert.equal(diff.counts.companiesAdded, 1);
  assert.equal(diff.counts.keywordsAdded, 1);
});

test("an empty file changes nothing under merge", () => {
  const t = target();
  const empty = file({ settings: { ...DEFAULT_SETTINGS }, seen: {}, jobs: {} });
  const plan = merge(empty, t);
  assert.deepEqual(plan.seen, t.seen);
  assert.deepEqual(plan.jobs, t.jobs);
  assert.deepEqual(plan.settings.watches, t.settings.watches);
});

test("merging the same file twice is a no-op the second time", () => {
  const t = target({ settings: settings({ watches: [] }), seen: {}, jobs: {} });
  const once = merge(file(), t);
  const twice = merge(file(), { settings: once.settings, seen: once.seen, jobs: once.jobs });
  assert.deepEqual(twice.settings, once.settings);
  assert.deepEqual(twice.seen, once.seen);
  assert.deepEqual(twice.jobs, once.jobs);
  assert.ok(isNoOp(twice.diff));
});

test("planning does not mutate the browser's state or the file", () => {
  const t = target();
  const f = file();
  const before = structuredClone({ t, f });
  merge(f, t);
  replace(f, t);
  assert.deepEqual({ t, f }, before);
});

test("a line names at most DETAIL_CAP of them and counts the rest", () => {
  const many: JobsMap = {};
  for (let i = 0; i < DETAIL_CAP + 12; i += 1) many[`j${i}`] = job({ id: `j${i}`, title: `Role ${i}` });
  const { diff } = merge(file({ jobs: many }), target({ jobs: {} }));
  const added = diff.history[0]?.lines.find((l) => l.kind === "added");
  assert.equal(added?.count, DETAIL_CAP + 12);
  assert.equal(added?.names.length, DETAIL_CAP);
  assert.equal(added?.overflow, 12);
});

test("the names on a line are the words a user recognises", () => {
  const { diff } = merge(file(), target({ settings: settings({ watches: [] }), jobs: {} }));
  const watches = diff.lists.find((g) => g.title === "Watches");
  assert.deepEqual(watches?.lines[0]?.names, ["Go, Indonesia"]);
  const jobs = diff.history.find((g) => g.title === "Jobs");
  assert.deepEqual(jobs?.lines[0]?.names, ["Staff Engineer — Acme Corp"]);
});

test("seen ids are counted but never named — there is nothing to read", () => {
  const { diff } = merge(file({ seen: { a: NOW } }), target({ seen: {} }));
  const seen = diff.history.find((g) => g.title === "Seen ids");
  assert.deepEqual(seen?.lines[0]?.names, []);
});

// ── planImport: replace, unchanged ───────────────────────────────────────────

test("replace still produces exactly what the old restore produced", () => {
  // The regression guard. Replace is the mode that survived this feature intact,
  // and the whole argument for keeping it rests on it behaving as it always did.
  const t = target({ settings: settings({ intervalMinutes: 5 }), seen: { old: NOW }, jobs: {} });
  const f = file();
  const plan = replace(f, t);
  assert.deepEqual(plan.settings, restoredSettings(f.settings, t.settings));
  assert.deepEqual(plan.seen, f.seen);
  assert.deepEqual(plan.jobs, f.jobs);
});

test("replace keeps this browser's Telegram credentials, as it always has", () => {
  const plan = replace(file({ settings: { ...DEFAULT_SETTINGS } }), target());
  assert.equal(plan.settings.push.botToken, "123456:SECRET-TOKEN");
  assert.equal(plan.settings.push.chatId, "987654321");
});

test("replace names what it is about to remove", () => {
  const t = target({
    settings: settings({ watches: [watch({ id: "gone", url: URL_B, name: "Doomed" })] }),
    seen: { old: NOW },
    jobs: { old: job({ id: "old", title: "Old role", company: "Initech" }) },
  });
  const { diff } = replace(file(), t);
  assert.equal(diff.counts.watchesRemoved, 1);
  assert.equal(diff.counts.jobsRemoved, 1);
  assert.equal(diff.counts.seenRemoved, 1);
  const removedWatch = diff.lists[0]?.lines.find((l) => l.kind === "removed");
  assert.deepEqual(removedWatch?.names, ["Doomed"]);
  const removedJob = diff.history[0]?.lines.find((l) => l.kind === "removed");
  assert.deepEqual(removedJob?.names, ["Old role — Initech"]);
});

// ── The steps ────────────────────────────────────────────────────────────────

test("a merge that changes nothing is two screens: choose, then confirm", () => {
  const { diff } = merge(file(), target());
  assert.deepEqual(importSteps(diff), ["mode", "confirm"]);
  assert.ok(isNoOp(diff));
});

test("a merge where only a setting differs skips the list and history screens", () => {
  const t = target({ settings: settings({ intervalMinutes: 5 }) });
  const { diff } = merge(file(), t);
  assert.deepEqual(importSteps(diff), ["mode", "settings", "confirm"]);
});

test("replace never shows the settings screen — there is nothing to tick", () => {
  const t = target({ settings: settings({ intervalMinutes: 5 }) });
  const { diff } = replace(file(), t);
  assert.equal(diff.settings.length, 0);
  assert.ok(!importSteps(diff).includes("settings"));
});

test("replace keeps the list screen when all it has to show is a removal", () => {
  // Which is the point: the removals are what the old one-shot dialog never said.
  const t = target({
    settings: settings({ watches: [watch(), watch({ id: "gone", url: URL_B, name: "Doomed" })] }),
  });
  const { diff } = replace(file(), t);
  assert.ok(importSteps(diff).includes("lists"));
});

test("stepAfter and stepBefore stop at the ends rather than wrapping", () => {
  const steps = importSteps(merge(file(), target()).diff);
  assert.equal(stepBefore(steps, "mode"), null);
  assert.equal(stepAfter(steps, "mode"), "confirm");
  assert.equal(stepAfter(steps, "confirm"), null);
  assert.equal(stepBefore(steps, "confirm"), "mode");
});

test("the confirm sentence under replace names the removals and the lack of undo", () => {
  const t = target({ jobs: { old: job({ id: "old" }), ...target().jobs } });
  const sentence = confirmSentence(replace(file(), t).diff);
  assert.match(sentence, /1 job here will be removed/);
  assert.match(sentence, /no undo/i);
});

test("the confirm sentence under merge promises outright that nothing goes", () => {
  const t = target({ settings: settings({ watches: [] }), seen: {}, jobs: {} });
  const sentence = confirmSentence(merge(file(), t).diff);
  assert.match(sentence, /nothing is removed/);
  assert.doesNotMatch(sentence, /removed,/);
});

test("a no-op merge says so, and points at the mode that would do something", () => {
  const sentence = confirmSentence(merge(file(), target()).diff);
  assert.match(sentence, /adds nothing you do not already have/);
  assert.match(sentence, /Replace/);
});

// ── What it did, said out loud ───────────────────────────────────────────────

test("the phrase leaves out the categories that are empty", () => {
  const t = target({ settings: { ...DEFAULT_SETTINGS }, seen: {}, jobs: {} });
  const said = importedPhrase(merge(file(), t).diff.counts, "merge");
  assert.match(said, /1 watch, 1 blocked company, 1 blocked keyword, 1 job and 1 seen id/);
  assert.doesNotMatch(said, /\b0\b/);
});

test("a merge that changed nothing says that, rather than listing zeroes", () => {
  assert.equal(importedPhrase(merge(file(), target()).diff.counts, "merge"), "merged, and nothing changed");
});

test("a replace that removed something says what went", () => {
  const t = target({ jobs: { old: job({ id: "old" }) } });
  assert.match(importedPhrase(replace(file(), t).diff.counts, "replace"), /removing .*1 job/);
});

test("one of a thing is singular, and thousands are separated", () => {
  const many: SeenMap = {};
  for (let i = 0; i < 1_200; i += 1) many[`s${i}`] = NOW;
  const t = target({ settings: settings({ watches: [] }), seen: {}, jobs: {} });
  const said = importedPhrase(merge(file({ seen: many }), t).diff.counts, "merge");
  assert.match(said, /1 watch\b/);
  assert.match(said, /1,200 seen ids/);
});
