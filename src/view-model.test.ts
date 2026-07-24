import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPromptStep,
  metaLine,
  formatCountdown,
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
