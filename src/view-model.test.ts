// Pin the clock to UTC so the calendar rungs and the hover dates are the same
// strings wherever the suite runs. `postedAt` is anchored to midnight UTC, so in
// UTC "local time" (which the ladder reads by design) is that same date — exactly
// what the author's own +07/+09 timezone sees. Set before any Date is touched.
process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPromptStep,
  companyTone,
  COMPANY_TONES,
  formatAgo,
  metaLine,
  formatCountdown,
  monogram,
  postedAge,
  postedHover,
  shortAge,
  splitLocation,
  visibleJobs,
  type JobView,
} from "./view-model.ts";

// The two pure formatters left over from the string-rendering era. They stayed
// out of the components precisely so they could be proved like this — with plain
// values, no render.

test("metaLine joins present parts with a middot", () => {
  assert.equal(metaLine(["Acme Corp", "Jakarta"]), "Acme Corp · Jakarta");
});

test("metaLine drops missing parts and never leaves a dangling separator", () => {
  assert.equal(metaLine(["Acme Corp", "", null, undefined]), "Acme Corp");
  assert.equal(metaLine([null, "Jakarta"]), "Jakarta");
  assert.equal(metaLine([]), "");
});

test("formatCountdown shows the coarsest two units", () => {
  assert.equal(formatCountdown(45_000), "45s");
  assert.equal(formatCountdown(252_000), "4m 12s");
  assert.equal(formatCountdown(300_000), "5m 0s");
  // Past an hour the seconds are noise, so they go.
  assert.equal(formatCountdown(26_100_000), "7h 15m");
});

test("formatCountdown never reads 0s while there is still time on the clock", () => {
  assert.equal(formatCountdown(1), "1s");
  assert.equal(formatCountdown(999), "1s");
  assert.equal(formatCountdown(0), "0s");
  // A time already past is the `due` state, never a negative countdown.
  assert.equal(formatCountdown(-5_000), "0s");
});

test("applyPromptStep opens the note step for Yes and nothing else", () => {
  // Unanswered is the question itself…
  assert.equal(applyPromptStep(null), "ask");
  // …and No never leaves it: it answers and closes on the click.
  assert.equal(applyPromptStep("no"), "ask");
  assert.equal(applyPromptStep("yes"), "note");
});

/** Only the four fields `visibleJobs` can possibly look at. */
const jobView = (over: Partial<JobView> & { id: string }): JobView =>
  ({ read: false, opened: false, blocked: false, ...over }) as JobView;

test("visibleJobs drops read jobs in 'new' and keeps everything in 'all'", () => {
  const jobs = [jobView({ id: "1" }), jobView({ id: "2", read: true })];
  assert.deepEqual(
    visibleJobs(jobs, "new").map((j) => j.id),
    ["1"],
  );
  assert.deepEqual(
    visibleJobs(jobs, "all").map((j) => j.id),
    ["1", "2"],
  );
});

test("visibleJobs keeps a job you merely opened, and a blocked one, in both modes", () => {
  // Opened is not read — the row stays so you can go back to it — and blocking
  // governs future scans, not rows already on screen.
  const jobs = [jobView({ id: "1", opened: true }), jobView({ id: "2", blocked: true })];
  for (const mode of ["new", "all"] as const) {
    assert.deepEqual(
      visibleJobs(jobs, mode).map((j) => j.id),
      ["1", "2"],
      mode,
    );
  }
});

// ── Row formatters ───────────────────────────────────────────────────────────
// The four rules the redesigned row applies to scraped text. They live in this
// module rather than inside JobRow precisely so they can be held to plain
// strings here, with no render involved.

test("shortAge abbreviates LinkedIn's posted text to what a chip has room for", () => {
  assert.equal(shortAge("12 hours ago"), "12h");
  assert.equal(shortAge("3 minutes ago"), "3m");
  assert.equal(shortAge("1 day ago"), "1d");
  assert.equal(shortAge("2 weeks ago"), "2w");
});

test("shortAge does not abbreviate months to 'm' — that is already minutes", () => {
  // "Posted 3m ago" about a three-month-old posting is a lie in the one
  // direction that matters when you are deciding whether to bother applying.
  assert.equal(shortAge("3 months ago"), "3mo");
});

test("shortAge keeps unparseable text rather than inventing a number", () => {
  // A localised string or a phrasing LinkedIn changed: the row still says
  // something true (PRD §12, fields fail independently).
  assert.equal(shortAge("yesterday"), "yesterday");
  assert.equal(shortAge("Just now ago"), "Just now");
  assert.equal(shortAge("   "), "");
});

test("formatAgo reports one coarse unit, never a false-precision second one", () => {
  assert.equal(formatAgo(41 * 60_000), "41m");
  assert.equal(formatAgo(6 * 3_600_000), "6h");
  assert.equal(formatAgo(3 * 86_400_000), "3d");
});

test("formatAgo never says 0m — something found this second was still found", () => {
  assert.equal(formatAgo(0), "1m");
  assert.equal(formatAgo(-5_000), "1m");
});

// ── postedAge: the live ladder off `postedAt` (issue #51) ────────────────────

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// A fixed "now" at midnight UTC so the day-and-above rungs are pure calendar
// differences with no time-of-day drift.
const NOW = Date.UTC(2026, 7, 7);

/** `postedAge` for a posting whose age is `ms` before `NOW`. */
const ageAt = (ms: number) => postedAge(NOW - ms, NOW);

test("postedAge floors the sub-hour rung to whole minutes, never 0m", () => {
  // Something posted this second was still posted — a chip reading "0m" looks
  // like a bug rather than like news.
  assert.equal(ageAt(0), "1m ago");
  assert.equal(ageAt(12 * MIN), "12m ago");
  assert.equal(ageAt(59 * MIN), "59m ago");
});

test("postedAge crosses from minutes to hours at exactly one hour", () => {
  assert.equal(ageAt(59 * MIN), "59m ago");
  assert.equal(ageAt(60 * MIN), "1h ago");
});

test("postedAge reports whole hours below a day, rounded", () => {
  assert.equal(ageAt(6 * HOUR), "6h ago");
  assert.equal(ageAt(23 * HOUR), "23h ago");
});

test("postedAge switches to the calendar clock at 24 hours — a day reads 'yesterday'", () => {
  // The last duration rung, then the first calendar one: "1d" reads worse and
  // means the same, so a single calendar day is special-cased to a word.
  assert.equal(ageAt(23 * HOUR), "23h ago");
  assert.equal(ageAt(24 * HOUR), "yesterday");
  assert.equal(ageAt(1 * DAY), "yesterday");
});

test("postedAge counts plain days from two up to six", () => {
  assert.equal(ageAt(2 * DAY), "2d ago");
  assert.equal(ageAt(5 * DAY), "5d ago");
  assert.equal(ageAt(6 * DAY), "6d ago");
});

test("postedAge rounds to weeks from seven days to twenty-nine", () => {
  assert.equal(ageAt(7 * DAY), "1w ago");
  assert.equal(ageAt(29 * DAY), "4w ago");
});

test("postedAge rounds weeks half-up, erring older: 24 days is 3w, 25 days is 4w", () => {
  // A stale job that looks fresh costs an application; a fresh one that looks
  // stale costs a glance. The tie breaks towards older.
  assert.equal(ageAt(24 * DAY), "3w ago");
  assert.equal(ageAt(25 * DAY), "4w ago");
});

test("postedAge rounds to months from thirty days to 364, at 30.44 days each", () => {
  assert.equal(ageAt(30 * DAY), "1mo ago");
  assert.equal(ageAt(364 * DAY), "12mo ago");
});

test("postedAge never abbreviates a months-old posting to 'm' — that is minutes", () => {
  // "Posted 3m ago" about a three-month-old posting is the one lie that matters
  // most when deciding whether to bother applying.
  const threeMonths = ageAt(91 * DAY);
  assert.equal(threeMonths, "3mo ago");
  assert.doesNotMatch(threeMonths, /\dm ago/);
});

test("postedAge rounds to years at 365 days and beyond", () => {
  assert.equal(ageAt(365 * DAY), "1y ago");
  assert.equal(ageAt(730 * DAY), "2y ago");
});

// ── postedHover: the date in words, per precision (issue #51) ─────────────────

test("postedHover spells an exact date to the minute", () => {
  const posted = Date.UTC(2026, 7, 7, 8, 48);
  assert.equal(postedHover(posted, "exact"), "Posted 7 Aug 2026, 08:48");
});

test("postedHover spells a day-precise date without a time", () => {
  const posted = Date.UTC(2026, 6, 17);
  assert.equal(postedHover(posted, "day"), "Posted 17 Jul 2026");
});

test("postedHover says an estimated date is a guess, in words", () => {
  // The one case that has to explain itself: the row's `~` carries the guess,
  // the hover says so rather than leave the glyph alone.
  const posted = Date.UTC(2026, 6, 17);
  assert.equal(
    postedHover(posted, "estimated"),
    "Posted around 17 Jul 2026 — estimated from LinkedIn's wording",
  );
});

test("splitLocation lifts the work mode out of its trailing bracket", () => {
  assert.deepEqual(splitLocation("Tokyo, Japan (Hybrid)"), {
    place: "Tokyo, Japan",
    mode: "Hybrid",
  });
  assert.deepEqual(splitLocation("APJ (Remote)"), { place: "APJ", mode: "Remote" });
});

test("splitLocation leaves a bracket-free location entirely alone", () => {
  assert.deepEqual(splitLocation("Jakarta"), { place: "Jakarta", mode: "" });
  assert.deepEqual(splitLocation(""), { place: "", mode: "" });
});

test("splitLocation only reads a TRAILING bracket, not one inside a place name", () => {
  assert.deepEqual(splitLocation("Do (Shizuoka), Japan"), {
    place: "Do (Shizuoka), Japan",
    mode: "",
  });
});

test("monogram takes the employer's first letter, upper-cased", () => {
  assert.equal(monogram("Acme Corp"), "A");
  assert.equal(monogram("micro1"), "M");
  assert.equal(monogram(""), "");
});

test("monogram strips the Japanese corporate prefix before picking a letter", () => {
  // Otherwise every third Japanese employer wears an identical 株 tile, which is
  // exactly the recognition the monogram exists to provide.
  assert.equal(monogram("（株）テイルウィンドシステム"), "テ");
  assert.equal(monogram("株式会社リクルート"), "リ");
});

test("companyTone is stable per company and always in range", () => {
  // Stability is the whole requirement: the same employer must wear the same
  // colour in this scan and the next, with no stored field to keep in sync.
  assert.equal(companyTone("Acme Corp"), companyTone("Acme Corp"));
  for (const name of ["Acme Corp", "", "PT Xendit", "テイルウィンド"]) {
    const tone = companyTone(name);
    assert.ok(tone >= 1 && tone <= COMPANY_TONES, `${name} → ${tone}`);
    assert.equal(Number.isInteger(tone), true);
  }
});
