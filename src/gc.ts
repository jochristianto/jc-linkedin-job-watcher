// Garbage collection — PRD §7. Storage that does not grow forever, pruned on
// two different lifetimes: the full `jobs` records die young, the `seen` ids that
// stop re-notification live long (§6/§7).
//
// Pure (§14) — no chrome.*, no DOM, no network, no clock read (the caller passes
// `now`) — so `node --test` proves each retention boundary with plain numbers.
// §7's algorithm is lifted verbatim, not rewritten; the thin caller (a daily
// alarm handler, never the scan path) reads the three keys from storage.ts,
// hands them here, and writes the pruned result back.

import type { RetentionConfig } from "./types.ts";
import type { SeenMap } from "./dedupe.ts";
import type { JobsMap, UiState } from "./storage.ts";

const DAY = 86_400_000;

/** The collector's own alarm (§7 "Runs on its own daily alarm"), kept separate
 *  from the scan alarm so pruning never rides the scan path. Named here rather
 *  than in `schedule.ts` because nothing but this module's caller reads it. */
export const GC_ALARM_NAME = "ljw-gc";

/** Daily, per §7. A period rather than a re-armed one-shot: unlike the scan
 *  cadence there is no jitter, no back-off and no quiet window to recompute, so
 *  there is nothing for a re-arm to decide. */
export const GC_PERIOD_MINUTES = 1440;

/** How long after the alarm is first created the first run happens. Not zero —
 *  the alarm is created during install and browser startup, and pruning is not
 *  worth putting in front of the first scan — and not a full day either, so an
 *  install that only ever runs for an hour at a time still gets collected. */
export const GC_FIRST_RUN_DELAY_MINUTES = 1;

/** The slice of §6 storage the collector prunes, plus the retention config that
 *  sets the two lifetimes. `now` is passed separately so this stays pure. */
export type GcState = {
  seen: SeenMap;
  jobs: JobsMap;
  retention: RetentionConfig;
};

/** The pruned `seen` and `jobs` maps, ready to write back to their §6 keys. */
export type GcResult = {
  seen: SeenMap;
  jobs: JobsMap;
};

/**
 * Prune on two lifetimes (§7). A full `jobs` record lives `openedJobDays` once
 * opened or read, `unopenedJobDays` otherwise — measured from `foundAt`. A `seen` id
 * lives `seenDays`, measured from when it was first seen. The two are
 * independent: dropping a job's full record **keeps** its `seen` entry (§6), so
 * a role whose record has aged out is still never re-alerted.
 *
 * The hard cap is a backstop against a date bug silently defeating the age
 * check: if more than `seenHardCap` ids survive the age filter, trim to 80% of
 * the cap, keeping the newest.
 *
 * Pure: the result is a function of `state` and `now` alone; the inputs are not
 * mutated.
 */
export function collectGarbage(state: GcState, now: number): GcResult {
  const { seen, jobs, retention: r } = state;

  // Full records: shorter life once you've dealt with the job — whether that was
  // opening it or dismissing it with the row's tick. Either way the title and
  // company are dead weight sooner than for one you never touched.
  const keptJobs: JobsMap = {};
  for (const [id, job] of Object.entries(jobs)) {
    const handled = job.opened || job.read;
    const limit = (handled ? r.openedJobDays : r.unopenedJobDays) * DAY;
    if (now - job.foundAt < limit) keptJobs[id] = job;
  }

  // Seen IDs: the long-lived record — and never shorter-lived than the job
  // record it belongs to. §7's two lifetimes are independent, and with the
  // default 15 against 30 they cross: for a fortnight an unopened record outlives
  // the memory of it. A posting still live on LinkedIn in that window would come
  // back as new, notify and push — and then show nothing, because `mergeJobs`
  // keeps the record already held. So a surviving record holds its id back.
  let keptSeen = Object.entries(seen).filter(
    ([id, ts]) => now - ts < r.seenDays * DAY || id in keptJobs,
  );

  // Backstop against a date bug silently defeating the age check.
  if (keptSeen.length > r.seenHardCap) {
    keptSeen.sort((a, b) => b[1] - a[1]);
    keptSeen = keptSeen.slice(0, Math.floor(r.seenHardCap * 0.8));
  }

  return { seen: Object.fromEntries(keptSeen), jobs: keptJobs };
}

// ── How much a run removed ───────────────────────────────────────────────────

/** A count of stored records, per §6 key. Used both for what a collection
 *  removed and for what is currently there to delete. */
export type HistoryCounts = {
  jobs: number;
  seen: number;
};

/** How much of each key is stored. One place counts, so the daily run's log, the
 *  Retention section's "holding this much" line and the confirm dialog all count
 *  the same way. */
export function historyCounts(seen: SeenMap, jobs: JobsMap): HistoryCounts {
  return { jobs: Object.keys(jobs).length, seen: Object.keys(seen).length };
}

/**
 * What a collection actually dropped, per key.
 *
 * The daily alarm reads this to decide whether to write at all: §6 has no
 * partial updates, so writing back an unchanged `seen` re-serialises the whole
 * map for nothing, every day, forever. It is also what the run logs — a
 * collector that prunes silently is indistinguishable from one that never ran.
 */
export function removedCounts(before: GcState, after: GcResult): HistoryCounts {
  const from = historyCounts(before.seen, before.jobs);
  const to = historyCounts(after.seen, after.jobs);
  return { jobs: from.jobs - to.jobs, seen: from.seen - to.seen };
}

// ── Deleting the lot, by hand ────────────────────────────────────────────────

/** Everything "Delete all job history" writes: the two emptied §6 keys, plus the
 *  view state it has to touch on the way past. */
export type ClearedHistory = {
  seen: SeenMap;
  jobs: JobsMap;
  ui: UiState;
};

/**
 * Retention taken to its limit on demand: drop every job record and every seen
 * id, as though nothing had ever been scanned.
 *
 * Settings are deliberately not part of this. The two are separate things to
 * want — starting the collection over is not the same as un-configuring the
 * extension — and rolling them together would make one button the only way to
 * do either.
 *
 * `ui.pendingApplyId` goes with the jobs: it names the job whose "Did you apply
 * for this job?" is still unanswered, and a question about a record that no
 * longer exists can only ever hang there. The rest of the view state — which
 * watch chip and which New/All mode you left the list on — is about the page,
 * not the data, so it survives.
 */
export function clearHistory(ui: UiState): ClearedHistory {
  return { seen: {}, jobs: {}, ui: { ...ui, pendingApplyId: null } };
}

/** The options page asking the worker to delete the lot. It goes through the
 *  worker rather than being written from the page because the *scan lock* is
 *  what serialises access to `seen` and `jobs`, and only the worker holds it —
 *  a page that wrote the two keys itself could do so in the middle of a cycle
 *  and have every record it deleted written straight back (§7). */
export type ClearHistoryRequest = { type: "LJW_CLEAR_HISTORY" };

/** What was deleted, or why nothing was. `scanning` is the one refusal: a cycle
 *  holds the lock, and the honest answer is "not now" rather than a deletion
 *  that half-survives. */
export type ClearHistoryResponse =
  | { cleared: true; removed: HistoryCounts }
  | { cleared: false; reason: "scanning" | "failed" };

/**
 * The stored records said out loud: `"42 jobs and 1,203 seen ids"`.
 *
 * Deleting everything is worth being specific about — "delete all data?" asks
 * you to confirm a quantity you have not been told — and the same phrase says
 * afterwards what went, and says in the log what a daily collection took.
 *
 * A key holding nothing is left out rather than reported as `0`, so the sentence
 * only ever mentions things that exist; with both empty there is nothing to
 * delete, and the phrase says so.
 */
export function historyPhrase(counts: HistoryCounts): string {
  const parts: string[] = [];
  if (counts.jobs > 0) {
    parts.push(`${counts.jobs.toLocaleString("en-US")} ${counts.jobs === 1 ? "job" : "jobs"}`);
  }
  if (counts.seen > 0) {
    parts.push(
      `${counts.seen.toLocaleString("en-US")} seen ${counts.seen === 1 ? "id" : "ids"}`,
    );
  }
  return parts.length > 0 ? parts.join(" and ") : "nothing";
}
