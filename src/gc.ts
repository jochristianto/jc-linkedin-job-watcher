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
import type { JobsMap } from "./storage.ts";

const DAY = 86_400_000;

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

  // Seen IDs: the long-lived record.
  let keptSeen = Object.entries(seen).filter(
    ([, ts]) => now - ts < r.seenDays * DAY,
  );

  // Backstop against a date bug silently defeating the age check.
  if (keptSeen.length > r.seenHardCap) {
    keptSeen.sort((a, b) => b[1] - a[1]);
    keptSeen = keptSeen.slice(0, Math.floor(r.seenHardCap * 0.8));
  }

  return { seen: Object.fromEntries(keptSeen), jobs: keptJobs };
}
