// Dedupe — PRD §5 "dedupe on job ID alone" / §6 "Seen means evaluated, not shown".
//
// The memory's decision core: parsed jobs go in, and this says which ids the
// extension has never evaluated before. Pure (§14) — no chrome.*, no DOM, no
// network, no clock read (the caller passes `now`) — so `node --test` proves it
// with plain values. The thin `storage.ts` wrapper owns the persistence; this
// owns the "new vs old" logic and stays testable.

import type { Job } from "./types.ts";
import { passesFilters, type FilterRules } from "./filter.ts";

/** `jobId → firstSeenAt (ms)` — the `seen` key of PRD §6. Exported so the
 *  storage wrapper and callers share one name for the shape. */
export type SeenMap = Record<string, number>;

export type DedupeResult = {
  /** Never-before-seen jobs that also pass the filters, deduped by id within
   *  the batch — the list to notify/show (PRD §6). */
  newJobs: Job[];
  /** The updated seen map: every *evaluated* id is present, including ones the
   *  filters rejected. First-seen timestamps already recorded are preserved. */
  seen: SeenMap;
};

/**
 * Tell new from old. Dedupe is on LinkedIn's job id **alone** (§5): the same
 * remote role surfacing under two watches is one new job, not two, and two cards
 * sharing a title+company but not an id are two different jobs.
 *
 * A job is added to `seen` the first time it is evaluated — even if the filters
 * reject it (§6 "Seen means evaluated, not shown") — so later scans never
 * re-discover and re-filter it forever. Only jobs that are both unseen and pass
 * `passesFilters` (filter.ts) come back in `newJobs`.
 *
 * Pure: `now` is the only "clock", injected by the caller, so the result is a
 * function of its inputs alone.
 */
export function dedupe(
  jobs: Job[],
  seen: SeenMap,
  rules: FilterRules,
  now: number,
): DedupeResult {
  const updatedSeen: SeenMap = { ...seen };
  const newJobs: Job[] = [];

  for (const job of jobs) {
    // Already seen — from a previous scan or from earlier in this same batch
    // (the cross-watch duplicate). Skip; its first-seen time stays as recorded.
    if (job.id in updatedSeen) continue;

    updatedSeen[job.id] = now; // evaluated now, regardless of what the filters say
    if (passesFilters(job, rules)) newJobs.push(job);
  }

  return { newJobs, seen: updatedSeen };
}
