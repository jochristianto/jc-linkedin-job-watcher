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
import { PUSH_FAILING_MESSAGE } from "./health.ts";
import {
  esc,
  renderList,
  renderEmptyState,
  renderToolbar,
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

/**
 * Mark every unopened job opened at `now`, immutably (the "Mark all as read"
 * action, mockups decision 4). Already-opened jobs keep their original
 * `openedAt`; only the unopened ones flip. Returns the same reference when there
 * was nothing to open, so mount.ts can skip a redundant storage write. mount.ts
 * persists this and clears the toolbar badge in one action.
 */
export function markAllOpened(jobs: JobsMap, now: number): JobsMap {
  let changed = false;
  const next: JobsMap = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (job.opened) {
      next[id] = job;
    } else {
      next[id] = { ...job, opened: true, openedAt: now };
      changed = true;
    }
  }
  return changed ? next : jobs;
}

/** Everything the page needs to render itself — assembled by the caller from
 *  the `jobs`, `settings`, `health` and `ui` storage keys. */
export type ViewContext = {
  jobs: Job[];
  watches: Watch[];
  mode: ListMode;
  title: string;
  /** The watch chip currently filtering the list (mockups decision 4), or
   *  null/undefined for "All watches". Filters the *list*; the badge still
   *  counts unopened across every watch. */
  activeWatchId?: string | null;
  /** A scan cycle is holding the lock right now (`scanState.isScanning`). Only
   *  changes the empty state: with nothing yet to show it reads "Scanning…"
   *  instead of "Nothing scanned yet" (mockups decision 5). */
  scanning?: boolean;
  severity?: HealthState["severity"];
  /** The health banner text (PRD §16.8), or null/undefined when healthy. Shown as
   *  a one-line banner above the list, tinted by `severity`. */
  message?: HealthState["message"];
  /** Telegram push has failed `pushFailWarnThreshold` times in a row (PRD §16.7):
   *  show the soft "run Send test message" warning. Independent of scan health —
   *  the read can be fine while a wrong chat id silently drops every push — so it
   *  renders as its own amber banner, alongside any health banner. Never a desktop
   *  notification. */
  pushWarn?: boolean;
};

/** Choose the empty/degraded message when nothing is visible. A broken scan
 *  outranks everything (there may be stale jobs but the read is untrustworthy);
 *  otherwise: no watches → nothing scanned → (New mode) all caught up. */
function pickEmptyKind(ctx: ViewContext, total: number): EmptyKind {
  if (ctx.severity === "error") return "scan-error";
  if (ctx.watches.length === 0) return "no-watches";
  if (total === 0) return ctx.scanning ? "scanning" : "no-jobs-yet";
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
  // The badge always counts unopened across every watch — it mirrors the toolbar
  // action badge, which the chip filter must not change (mockups decision 4).
  const badge = unopenedCount(ctx.jobs);

  // The chip filters the *list*: an active watch drops jobs from other watches.
  const activeWatchId = ctx.activeWatchId ?? "";
  const listJobs = activeWatchId
    ? ctx.jobs.filter((j) => j.watchId === activeWatchId)
    : ctx.jobs;
  const views = toJobViews(listJobs, ctx.watches);
  const visible = ctx.mode === "new" ? views.filter((v) => !v.opened) : views;

  const toolbar = renderToolbar(
    ctx.watches.map((w) => ({ id: w.id, name: w.name })),
    activeWatchId || null,
    ctx.mode,
  );

  const body = visible.length
    ? renderList(views, ctx.mode)
    : renderEmptyState(pickEmptyKind(ctx, views.length));

  const healthBanner = ctx.message
    ? `<div class="banner banner-${ctx.severity ?? "warn"}">${esc(ctx.message)}</div>`
    : "";
  // The push warning is a soft, config-level warning independent of scan health
  // (§16.7), so it stacks under any health banner rather than replacing it.
  const pushBanner = ctx.pushWarn
    ? `<div class="banner banner-warn">${esc(PUSH_FAILING_MESSAGE)}</div>`
    : "";

  return `
    <header class="hdr">
      <span class="hdr-title">${esc(ctx.title)}</span>
      ${badge > 0 ? `<span class="badge">${badge}</span>` : ""}
      <button class="hdr-btn" id="mark-all-read" title="Mark all as read">Mark all read</button>
      <button class="hdr-btn" id="open-options" title="Options" aria-label="Options">⚙</button>
    </header>
    ${toolbar}
    ${healthBanner}
    ${pushBanner}
    <div class="list">${body}</div>`.trim();
}
