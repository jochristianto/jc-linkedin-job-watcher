import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dirtySections,
  estimateLoad,
  headerSummary,
  loadEstimateLine,
  sectionOfField,
  spanHours,
  unsavedLabel,
  watchUrlChips,
} from "./settings-view.ts";
import { settingsToForm, type OptionsFormValues } from "./options-form.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

// The settings page's derived values, proved without a browser (prd.md §14):
// every input is a plain form value, every output a string, number or set.

const form = (o: Partial<OptionsFormValues> = {}): OptionsFormValues => ({
  ...settingsToForm(DEFAULT_SETTINGS),
  ...o,
});

const watch = (o: Partial<OptionsFormValues["watches"][number]> = {}) => ({
  id: "w1",
  name: "SE @ Japan",
  url: "https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer",
  enabled: true,
  ...o,
});

// ── Sections and the unsaved-changes dots ────────────────────────────────────

test("sectionOfField: every field is edited in the section that shows it", () => {
  assert.equal(sectionOfField("watches"), "watches");
  assert.equal(sectionOfField("blockedCompanies"), "filters");
  assert.equal(sectionOfField("quietStart"), "scanning");
  assert.equal(sectionOfField("notifyDesktop"), "notifications");
  assert.equal(sectionOfField("pushBotToken"), "notifications");
  assert.equal(sectionOfField("seenHardCap"), "retention");
});

test("dirtySections: collapses changed fields onto the sections holding them", () => {
  const sections = dirtySections(["quietStart", "pagesPerScan", "hideReposted"]);
  assert.deepEqual([...sections].sort(), ["filters", "scanning"]);
});

test("dirtySections: nothing changed is no dots at all", () => {
  assert.equal(dirtySections([]).size, 0);
});

test("unsavedLabel: singular, plural, and nothing to say", () => {
  assert.equal(unsavedLabel(0), "");
  assert.equal(unsavedLabel(-1), "");
  assert.equal(unsavedLabel(1), "1 unsaved change");
  assert.equal(unsavedLabel(4), "4 unsaved changes");
});

// ── What a saved search actually searches for ────────────────────────────────

test("watchUrlChips: reads keywords, place, recency, job type and workplace", () => {
  const chips = watchUrlChips(
    "https://www.linkedin.com/jobs/search/?f_JT=F&f_TPR=r86400&f_WT=2&geoId=101355337&keywords=Software%20Engineer&sortBy=DD",
  );
  assert.deepEqual(chips, [
    "“Software Engineer”",
    "Japan",
    "Past 24 hours",
    "Full-time",
    "Remote",
    "Newest first",
  ]);
});

test("watchUrlChips: an unmapped geoId still shows the id rather than nothing", () => {
  assert.deepEqual(watchUrlChips("https://www.linkedin.com/jobs/search/?geoId=999999"), [
    "geo 999999",
  ]);
});

test("watchUrlChips: multi-select filters produce one chip each", () => {
  assert.deepEqual(watchUrlChips("https://www.linkedin.com/jobs/search/?f_JT=F,C&f_WT=2,3"), [
    "Full-time",
    "Contract",
    "Remote",
    "Hybrid",
  ]);
});

test("watchUrlChips: unknown parameter values are dropped, not shown raw", () => {
  assert.deepEqual(watchUrlChips("https://www.linkedin.com/jobs/search/?f_JT=Z&f_TPR=r99"), [
    "No filters in the URL",
  ]);
});

test("watchUrlChips: a free-text location shows when there is no geoId", () => {
  assert.deepEqual(watchUrlChips("https://www.linkedin.com/jobs/search/?location=Osaka"), ["Osaka"]);
});

test("watchUrlChips: a URL with no filters says so rather than showing nothing", () => {
  assert.deepEqual(watchUrlChips("https://www.linkedin.com/jobs/search/"), [
    "No filters in the URL",
  ]);
});

test("watchUrlChips: an unparseable URL is one chip, never a throw", () => {
  assert.deepEqual(watchUrlChips("not a url"), ["URL not recognised"]);
});

// ── The header summary ───────────────────────────────────────────────────────

test("headerSummary: counts only the watches that are switched on", () => {
  const line = headerSummary(
    form({ watches: [watch({ id: "a" }), watch({ id: "b", enabled: false })] }),
  );
  assert.match(line, /^1 watch · /);
});

test("headerSummary: names the hours it runs, which is the inverse of the quiet window", () => {
  assert.match(
    headerSummary(form({ quietHoursEnabled: true, quietStart: "23:00", quietEnd: "07:00" })),
    /from 07:00 to 23:00/,
  );
  assert.match(headerSummary(form({ quietHoursEnabled: false })), /around the clock/);
});

test("headerSummary: a zero-width quiet window runs around the clock, not 23:00 to 23:00", () => {
  // `isWithinQuietHours` is never quiet when start === end, so the header must
  // not claim a window that silences nothing.
  assert.match(
    headerSummary(form({ quietHoursEnabled: true, quietStart: "23:00", quietEnd: "23:00" })),
    /around the clock/,
  );
});

test("headerSummary: no watch switched on says so in words, not as a zero", () => {
  assert.match(headerSummary(form({ watches: [] })), /^No watch · /);
  assert.match(headerSummary(form({ watches: [watch({ enabled: false })] })), /^No watch · /);
});

test("headerSummary: says where a found job is delivered, in all four combinations", () => {
  const delivery = (notifyDesktop: boolean, pushEnabled: boolean) =>
    headerSummary(form({ notifyDesktop, pushEnabled })).split(" · ")[2];
  assert.equal(delivery(true, true), "Desktop + Telegram");
  assert.equal(delivery(true, false), "Desktop notification");
  assert.equal(delivery(false, true), "Telegram only");
  // Both off still moves the toolbar count, which is what "badge only" means.
  assert.equal(delivery(false, false), "badge only");
});

test("headerSummary: an interval that isn't a number is said, not rendered as NaN", () => {
  assert.match(headerSummary(form({ intervalMinutes: "" })), /Interval not set/);
});

test("headerSummary: the cadence is the jittered band, not the bare interval", () => {
  // No round ever lands exactly on the interval, so the header says the range the
  // two fields actually produce (§15, decision 3).
  assert.match(
    headerSummary(form({ intervalMinutes: "60", jitterMinutes: "30" })),
    /Every 30–90 min/,
  );
  assert.match(
    headerSummary(form({ intervalMinutes: "33", jitterMinutes: "1" })),
    /Every 32–34 min/,
  );
});

test("headerSummary: no jitter is the one case that reads as a single number", () => {
  assert.match(headerSummary(form({ intervalMinutes: "45", jitterMinutes: "0" })), /Every 45 min/);
  assert.match(headerSummary(form({ intervalMinutes: "45", jitterMinutes: "" })), /Every 45 min/);
});

test("headerSummary: a jitter wider than the interval floors the band at 1 min", () => {
  // `jitteredDelayMs` clamps to a 1-minute floor, so the header must not promise
  // a gap of 0 — or a negative one — that the alarm could never honour.
  assert.match(headerSummary(form({ intervalMinutes: "5", jitterMinutes: "20" })), /Every 1–25 min/);
});

// ── The daily load estimate ──────────────────────────────────────────────────

test("spanHours: wraps past midnight", () => {
  assert.equal(spanHours("23:00", "07:00"), 8);
  assert.equal(spanHours("09:00", "17:30"), 8.5);
});

test("estimateLoad: rounds × active watches × pages, over the awake hours", () => {
  const est = estimateLoad(
    form({
      watches: [watch({ id: "a" }), watch({ id: "b" }), watch({ id: "c", enabled: false })],
      intervalMinutes: "30",
      pagesPerScan: "1",
      quietHoursEnabled: true,
      quietStart: "23:00",
      quietEnd: "07:00",
    }),
  );
  assert.equal(est.awakeHours, 16);
  assert.equal(est.rounds, 32);
  assert.equal(est.activeWatches, 2);
  assert.equal(est.loads, 64);
});

test("estimateLoad: quiet hours off means a full 24-hour day", () => {
  const est = estimateLoad(
    form({ watches: [watch()], intervalMinutes: "60", quietHoursEnabled: false }),
  );
  assert.equal(est.awakeHours, 24);
  assert.equal(est.rounds, 24);
});

test("estimateLoad: the three tiers", () => {
  const at = (intervalMinutes: string) =>
    estimateLoad(form({ watches: [watch()], intervalMinutes, quietHoursEnabled: false })).tier;
  assert.equal(at("60"), "gentle"); // 24 loads
  assert.equal(at("5"), "heavy"); // 288 loads
  assert.equal(at("2"), "risky"); // 720 loads
});

test("estimateLoad: a paused watch costs nothing", () => {
  const est = estimateLoad(form({ watches: [watch({ enabled: false })] }));
  assert.equal(est.loads, 0);
  assert.equal(est.tier, "gentle");
});

test("estimateLoad: half-typed fields fall back rather than producing NaN", () => {
  const est = estimateLoad(form({ watches: [watch()], intervalMinutes: "", pagesPerScan: "0" }));
  assert.ok(Number.isFinite(est.loads));
  assert.equal(est.pagesPerScan, 1);
});

test("estimateLoad: a 24-hour quiet window still leaves an hour awake", () => {
  const est = estimateLoad(
    form({
      watches: [watch()],
      quietHoursEnabled: true,
      quietStart: "08:00",
      quietEnd: "08:00",
    }),
  );
  assert.equal(est.awakeHours, 1);
  assert.ok(est.rounds >= 1);
});

test("loadEstimateLine: spells the arithmetic out, and handles no watches", () => {
  const est = estimateLoad(
    form({
      watches: [watch()],
      intervalMinutes: "30",
      pagesPerScan: "2",
      quietHoursEnabled: false,
    }),
  );
  assert.equal(
    loadEstimateLine(est),
    "≈ 96 LinkedIn page loads a day — 48 rounds × 1 active watch × 2 pages, across 24 awake hours.",
  );
  assert.match(loadEstimateLine(estimateLoad(form({ watches: [] }))), /No watches are switched on/);
});
