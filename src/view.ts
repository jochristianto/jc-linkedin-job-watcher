// List-view assembly — PRD §4 "a shared component, mounted twice".
//
// The pure bridge between stored `Job` records and the tested markup functions
// in render.ts. It resolves a job's watch name, orders the list newest-first,
// counts the unread badge, applies the row actions (open / read / block), and assembles the whole page
// (header + badge + list-or-empty-state) as one string. No chrome.*, no DOM,
// no clock — `now` is injected — so `node --test` proves the badge count and
// empty-state choice with plain values. The side-effect wrapper that reads
// storage, sets innerHTML and opens tabs lives in mount.ts (§14, untested).

import type { Job, Watch, HealthState, BlockedCompany } from "./types.ts";
import type { JobsMap } from "./storage.ts";
import { PUSH_FAILING_MESSAGE } from "./health.ts";
// `makeBlockedCompany` is the write-side normalizer the Options blocklist field
// uses too, so a company blocked from a row and one typed into Options end up in
// the identical shape.
import { isCompanyBlocked, normalizeCompany, makeBlockedCompany } from "./filter.ts";
import {
  esc,
  renderList,
  renderEmptyState,
  renderScanButton,
  renderToolbar,
  type JobView,
  type ListMode,
  type EmptyKind,
  type ScanButtonState,
} from "./render.ts";

/** Map a stored `Job` to the flat `JobView` the markup functions consume. The
 *  watch name is looked up from settings; an unknown/removed watchId degrades
 *  to a blank name rather than dropping the row (PRD §12, fields fail alone).
 *  `blocked` is derived, never stored: the blocklist is the single source of
 *  truth, so unblocking a company un-greys its rows with no per-job fixup. */
function toJobView(job: Job, watches: Watch[], blockedNormalized: string[]): JobView {
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
    read: job.read,
    blocked: isCompanyBlocked(job.company, blockedNormalized),
  };
}

/** All jobs as views, ordered newest-first by `foundAt` (PRD §5). */
export function toJobViews(
  jobs: Job[],
  watches: Watch[],
  blockedNormalized: string[] = [],
): JobView[] {
  return [...jobs]
    .sort((a, b) => b.foundAt - a.foundAt)
    .map((j) => toJobView(j, watches, blockedNormalized));
}

/** The badge number: how many jobs are still unread and not blocked — the same
 *  rule the toolbar badge uses (see `unreadCount` in scan.ts). Opening a job
 *  doesn't move this; only the row's tick does. */
export function unreadCount(jobs: Job[], blockedNormalized: string[] = []): number {
  return jobs.filter((j) => !j.read && !isCompanyBlocked(j.company, blockedNormalized)).length;
}

/**
 * Mark one job opened at `now`, immutably — the trace of "you clicked this and
 * we opened the posting". It highlights the row and nothing else: the job stays
 * in the list, stays unread, stays on the badge. Returns a new map with just
 * that entry replaced; the original is untouched and an unknown id is a no-op
 * (the same reference comes back). The storage write that persists this happens
 * in mount.ts **before** the tab opens (PRD §9). Re-opening a job keeps the
 * first `openedAt` — it records when you first looked, not most recently.
 */
export function markJobOpened(jobs: JobsMap, id: string, now: number): JobsMap {
  const job = jobs[id];
  if (!job) return jobs;
  if (job.opened) return jobs;
  return { ...jobs, [id]: { ...job, opened: true, openedAt: now } };
}

/**
 * Set one job's read flag, immutably — the row's tick button, which is now the
 * *only* thing that dismisses a job. `read: false` puts it back (the same button
 * toggles), clearing `readAt` so an un-dismissed job is indistinguishable from
 * one never read. Returns the same reference when the flag already matched or
 * the id is unknown, so mount.ts can skip a redundant storage write.
 */
export function setJobRead(jobs: JobsMap, id: string, read: boolean, now: number): JobsMap {
  const job = jobs[id];
  if (!job || job.read === read) return jobs;
  return { ...jobs, [id]: { ...job, read, readAt: read ? now : null } };
}

/**
 * Mark every unread job read at `now`, immutably (the "Mark all as read" action,
 * mockups decision 4). Already-read jobs keep their original `readAt`; only the
 * unread ones flip. Returns the same reference when there was nothing to mark,
 * so mount.ts can skip a redundant storage write. mount.ts persists this and
 * clears the toolbar badge in one action.
 */
export function markAllRead(jobs: JobsMap, now: number): JobsMap {
  let changed = false;
  const next: JobsMap = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (job.read) {
      next[id] = job;
    } else {
      next[id] = { ...job, read: true, readAt: now };
      changed = true;
    }
  }
  return changed ? next : jobs;
}

/**
 * Toggle a company on the blocklist — the row's ⊘ button, in both directions.
 *
 * Blocking appends the same `{display, normalized}` pair the Options field
 * writes. Unblocking removes **every entry that matches this company**, not just
 * an exact-name one: entries match as substrings (PRD §6, so one "acme" catches
 * "PT Acme Indonesia"), and leaving a fragment behind that still blocks the
 * company would make the button look broken. The cost is that unblocking via a
 * row can widen further than that one company — which is inherent to a substring
 * blocklist, and visible in Options.
 *
 * Returns the same reference when nothing changed (a blank company, or a block
 * of something already blocked), so the caller can skip the settings write.
 */
export function toggleBlockedCompany(
  blocked: BlockedCompany[],
  company: string,
  block: boolean,
): BlockedCompany[] {
  const normalized = normalizeCompany(company);
  if (!normalized) return blocked;

  if (block) {
    if (isCompanyBlocked(company, blocked.map((b) => b.normalized))) return blocked;
    return [...blocked, makeBlockedCompany(company.trim())];
  }

  const kept = blocked.filter((b) => !normalized.includes(b.normalized));
  return kept.length === blocked.length ? blocked : kept;
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
   *  counts unread across every watch. */
  activeWatchId?: string | null;
  /** `settings.blockedCompanies`, already-normalized fragments. Greys the rows
   *  whose company matches and flips their ⊘ button to Unblock; those rows stay
   *  on screen, they just stop counting towards the badge. */
  blockedCompanies?: string[];
  /** A scan cycle is holding the lock right now (`scanState.isScanning`). Only
   *  changes the empty state: with nothing yet to show it reads "Scanning…"
   *  instead of "Nothing scanned yet" (mockups decision 5). */
  scanning?: boolean;
  /** The persisted scan mode (`health.mode`). Only the manual scan control reads
   *  it: a `halted` cycle (§16.2) turns "Scan now" into "Resume scanning". */
  scanMode?: HealthState["mode"];
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
 * Which state the header's manual scan control renders in. An in-flight cycle
 * wins over everything — while the lock is held there is nothing to start, even
 * if health is halted — otherwise a halted cycle labels the control as the
 * manual resume it is (§16.2). Everything else is the plain idle button.
 */
export function scanButtonState(ctx: ViewContext): ScanButtonState {
  if (ctx.scanning) return "scanning";
  if (ctx.scanMode === "halted") return "halted";
  return "idle";
}

/**
 * The whole view as one markup string: header (title + unopened badge + Scan
 * now + Options button) over the list. `renderList` filters opened jobs out of "new" mode; if
 * that leaves nothing to show, a distinct empty state takes the list's place.
 * The popup and the tab call this identically — they differ only by the
 * `.view-popup` / `.view-tab` class on the mount root, never by branch here.
 */
export function renderPage(ctx: ViewContext): string {
  const blockedCompanies = ctx.blockedCompanies ?? [];

  // The badge always counts unread across every watch — it mirrors the toolbar
  // action badge, which the chip filter must not change (mockups decision 4).
  const badge = unreadCount(ctx.jobs, blockedCompanies);

  // The chip filters the *list*: an active watch drops jobs from other watches.
  const activeWatchId = ctx.activeWatchId || null;
  const listJobs = activeWatchId
    ? ctx.jobs.filter((j) => j.watchId === activeWatchId)
    : ctx.jobs;
  const views = toJobViews(listJobs, ctx.watches, blockedCompanies);
  const visible = ctx.mode === "new" ? views.filter((v) => !v.read) : views;

  const toolbar = renderToolbar(
    ctx.watches.map((w) => ({ id: w.id, name: w.name })),
    activeWatchId,
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
      ${renderScanButton(scanButtonState(ctx))}
      <button class="hdr-btn" id="mark-all-read" title="Mark all as read">Mark all read</button>
      <button class="hdr-btn" id="open-options" title="Options" aria-label="Options">⚙</button>
    </header>
    ${toolbar}
    ${healthBanner}
    ${pushBanner}
    <div class="list">${body}</div>`.trim();
}
