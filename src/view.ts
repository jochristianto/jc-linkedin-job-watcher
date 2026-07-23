// List-view assembly — PRD §4 "a shared component, mounted twice".
//
// The pure bridge between stored `Job` records and the tested markup functions
// in render.ts. It resolves a job's watch name, orders the list newest-first,
// counts the unopened badge, marks a job opened, and assembles the whole page
// (header + badge + list-or-empty-state) as one string. No chrome.*, no DOM,
// no clock — `now` is injected — so `node --test` proves the badge count and
// empty-state choice with plain values. The side-effect wrapper that reads
// storage, sets innerHTML and opens tabs lives in mount.ts (§14, untested).

import type { Job, Watch, HealthState } from "./types.ts";
import type { JobsMap } from "./storage.ts";
import {
  esc,
  renderList,
  renderEmptyState,
  type JobView,
  type ListMode,
  type EmptyKind,
} from "./render.ts";

/** Map a stored `Job` to the flat `JobView` the markup functions consume. The
 *  watch name is looked up from settings; an unknown/removed watchId degrades
 *  to a blank name rather than dropping the row (PRD §12, fields fail alone). */
function toJobView(job: Job, watches: Watch[]): JobView {
  const watch = watches.find((w) => w.id === job.watchId);
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    postedText: job.postedText,
    watchName: watch?.name ?? "",
    url: job.url,
    opened: job.opened,
  };
}

/** All jobs as views, ordered newest-first by `foundAt` (PRD §5). */
export function toJobViews(jobs: Job[], watches: Watch[]): JobView[] {
  return [...jobs]
    .sort((a, b) => b.foundAt - a.foundAt)
    .map((j) => toJobView(j, watches));
}

/** The badge number: how many jobs are still unopened (PRD §5). */
export function unopenedCount(jobs: Job[]): number {
  return jobs.filter((j) => !j.opened).length;
}

/**
 * Mark one job opened at `now`, immutably. Returns a new map with just that
 * entry replaced; the original is untouched and an unknown id is a no-op (the
 * same reference comes back). The storage write that persists this happens in
 * mount.ts **before** the tab opens (PRD §9).
 */
export function markJobOpened(jobs: JobsMap, id: string, now: number): JobsMap {
  const job = jobs[id];
  if (!job) return jobs;
  return { ...jobs, [id]: { ...job, opened: true, openedAt: now } };
}

/** Everything the page needs to render itself — assembled by the caller from
 *  the `jobs`, `settings` and `health` storage keys. */
export type ViewContext = {
  jobs: Job[];
  watches: Watch[];
  mode: ListMode;
  title: string;
  severity?: HealthState["severity"];
};

/** Choose the empty/degraded message when nothing is visible. A broken scan
 *  outranks everything (there may be stale jobs but the read is untrustworthy);
 *  otherwise: no watches → nothing scanned → (New mode) all caught up. */
function pickEmptyKind(ctx: ViewContext, total: number): EmptyKind {
  if (ctx.severity === "error") return "scan-error";
  if (ctx.watches.length === 0) return "no-watches";
  if (total === 0) return "no-jobs-yet";
  if (ctx.mode === "new") return "no-new";
  return "no-jobs-yet";
}

/**
 * The whole view as one markup string: header (title + unopened badge + Options
 * button) over the list. `renderList` filters opened jobs out of "new" mode; if
 * that leaves nothing to show, a distinct empty state takes the list's place.
 * The popup and the tab call this identically — they differ only by the
 * `.view-popup` / `.view-tab` class on the mount root, never by branch here.
 */
export function renderPage(ctx: ViewContext): string {
  const views = toJobViews(ctx.jobs, ctx.watches);
  const badge = views.filter((v) => !v.opened).length;
  const visible = ctx.mode === "new" ? views.filter((v) => !v.opened) : views;

  const body = visible.length
    ? renderList(views, ctx.mode)
    : renderEmptyState(pickEmptyKind(ctx, views.length));

  return `
    <header class="hdr">
      <span class="hdr-title">${esc(ctx.title)}</span>
      ${badge > 0 ? `<span class="badge">${badge}</span>` : ""}
      <button class="hdr-btn" id="open-options" title="Options" aria-label="Options">⚙</button>
    </header>
    <div class="list">${body}</div>`.trim();
}
