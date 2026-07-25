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
