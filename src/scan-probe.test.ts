import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jobIdOf,
  extractJobIds,
  pollUntilSettled,
  type CardLike,
  type PollDeps,
} from "./scan-probe.ts";

/** A minimal stand-in for a job-card element: just its attributes. */
function card(attrs: Record<string, string>): CardLike {
  return { getAttribute: (name) => attrs[name] ?? null };
}

test("jobIdOf reads data-job-id (authenticated /jobs/search DOM, per issue #2)", () => {
  assert.equal(jobIdOf(card({ "data-job-id": "4012345678" })), "4012345678");
});

test("jobIdOf falls back to data-occludable-job-id on the enclosing <li>", () => {
  assert.equal(
    jobIdOf(card({ "data-occludable-job-id": "4099999999" })),
    "4099999999",
  );
});

test("jobIdOf falls back to parsing the /jobs/view/<id>/ href", () => {
  assert.equal(
    jobIdOf(card({ href: "https://www.linkedin.com/jobs/view/4055555555/?foo=1" })),
    "4055555555",
  );
});

test("jobIdOf returns null when no numeric id can be recovered", () => {
  assert.equal(jobIdOf(card({})), null);
  assert.equal(jobIdOf(card({ "data-job-id": "" })), null);
  assert.equal(jobIdOf(card({ "data-job-id": "not-a-number" })), null);
  assert.equal(jobIdOf(card({ href: "https://www.linkedin.com/feed/" })), null);
});

test("extractJobIds dedupes on the job id alone (PRD §5) and preserves order", () => {
  const ids = extractJobIds([
    card({ "data-job-id": "1" }),
    card({ "data-job-id": "2" }),
    card({ "data-job-id": "1" }), // dup of the first
    card({ href: "https://www.linkedin.com/jobs/view/3/" }),
  ]);
  assert.deepEqual(ids, ["1", "2", "3"]);
});

test("extractJobIds skips cards with no recoverable id (fail-independent, PRD §12)", () => {
  const ids = extractJobIds([
    card({ "data-job-id": "1" }),
    card({}), // e.g. a promoted/ghost slot — must not count or crash
    card({ "data-job-id": "2" }),
  ]);
  assert.deepEqual(ids, ["1", "2"]);
});

/**
 * Build PollDeps whose sample() walks a fixed script, one entry per call.
 * A bare number is shorthand for "this many postings accumulated, and the walk
 * has reached the end" — the ordinary case; a tuple spells out `atEnd` for the
 * cases that turn on it.
 */
function scriptedDeps(script: (number | [count: number, atEnd: boolean])[]): PollDeps & { calls: number } {
  let i = 0;
  let clock = 0;
  const deps = {
    calls: 0,
    sample: async () => {
      deps.calls++;
      const entry = script[Math.min(i, script.length - 1)]!;
      i++;
      const [count, atEnd] = typeof entry === "number" ? [entry, true] : entry;
      return { count, expected: 0, atEnd };
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return deps;
}

const OPTS = { intervalMs: 500, timeoutMs: 20_000, stableSamples: 3 };

test("pollUntilSettled settles once the walk hits the end and stops finding postings", async () => {
  // 0,0 -> not rendered yet; grows as the walk materialises rows; 25 three times -> settled.
  const deps = scriptedDeps([0, 0, 12, 20, 25, 25, 25, 25]);
  const r = await pollUntilSettled(deps, OPTS);
  assert.equal(r.settled, true);
  assert.equal(r.count, 25);
  // Stops the first time it sees 3 equal non-zero counts; does not keep sampling.
  assert.equal(deps.calls, 7);
});

test("pollUntilSettled keeps walking while the count is stable but the end is not reached", async () => {
  // The shipped bug: LinkedIn paints 11 rows, nothing scrolls them, so the count
  // is trivially "stable" from the very first sample. Stability alone must not
  // settle — there is more list below, and those postings are the missed ones.
  const deps = scriptedDeps([
    [11, false], [11, false], [11, false], [11, false],
    [18, false], [25, false], [25, true], [25, true], [25, true],
  ]);
  const r = await pollUntilSettled(deps, OPTS);
  assert.equal(r.settled, true);
  assert.equal(r.count, 25);
});

test("pollUntilSettled reports settled=false when the walk never reaches the end", async () => {
  // Stable count, but the column keeps scrolling forever: an incomplete read, and
  // it must say so rather than passing 11 postings off as the whole list.
  const deps = scriptedDeps([[11, false]]);
  const r = await pollUntilSettled(deps, { ...OPTS, timeoutMs: 2_000 });
  assert.equal(r.settled, false);
  assert.equal(r.count, 11);
});

test("pollUntilSettled reports settled=false on an empty page (question #1 = no)", async () => {
  // A backgrounded tab that never renders anything: all zeros until timeout.
  const deps = scriptedDeps([0]);
  const r = await pollUntilSettled(deps, { ...OPTS, timeoutMs: 2_000 });
  assert.equal(r.settled, false);
  assert.equal(r.count, 0);
});

test("pollUntilSettled times out when the count never stabilises", async () => {
  // Count keeps changing every sample: never 3-in-a-row equal before the deadline.
  const deps = scriptedDeps([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const r = await pollUntilSettled(deps, { ...OPTS, timeoutMs: 2_000 });
  assert.equal(r.settled, false);
  assert.ok(r.elapsedMs >= 2_000);
});

test("pollUntilSettled carries the page's declared slot count through to the caller", async () => {
  const deps: PollDeps = {
    sample: async () => ({ count: 11, expected: 25, atEnd: true }),
    sleep: async () => {},
    now: () => 0,
  };
  const r = await pollUntilSettled(deps, { ...OPTS, timeoutMs: 0 });
  assert.equal(r.expected, 25);
});
