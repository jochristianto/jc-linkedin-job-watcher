// List-view state — PRD §4 "a shared component, mounted twice".
//
// The pure bridge between stored `Job` records and the props the React
// components in `components/` take. It resolves a job's watch name, orders the
// list newest-first, counts the unread badge, applies the row actions (open /
// read / block), and decides which of the header, footer and empty states the
// view is in. No chrome.*, no DOM, no React, no clock — `now` is injected — so
// `node --test` proves the badge count and empty-state choice with plain values.
// The side-effect wrapper that reads storage and opens tabs is the `<ListView>`
// component and its hooks (§14, untested).

import type { Job, Watch, HealthState, BlockedCompany, QuietHours } from "./types.ts";
import type { JobsMap } from "./storage.ts";
import { isWithinQuietHours, minutesOfDay } from "./schedule.ts";
// `makeBlockedCompany` is the write-side normalizer the Options blocklist field
// uses too, so a company blocked from a row and one typed into Options end up in
// the identical shape.
import {
  isCompanyBlocked,
  isHiddenAsReposted,
  normalizeCompany,
  makeBlockedCompany,
} from "./filter.ts";
import { PUSH_FAILING_MESSAGE } from "./health.ts";
import type {
  JobView,
  ListMode,
  EmptyKind,
  ScanButtonState,
  ScanStatus,
  ChipWatch,
} from "./view-model.ts";

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
    foundAt: job.foundAt,
    opened: job.opened,
    read: job.read,
    blocked: isCompanyBlocked(job.company, blockedNormalized),
    // Absent on records written before applying was tracked, which reads as "no".
    applied: job.applied === true,
    // Same vintage, same rule: no note recorded reads as an empty one, so the
    // row simply renders no note block rather than a box with nothing in it.
    notes: job.applyNotes ?? "",
  };
}

/** All jobs as views, ordered newest-first by `foundAt` (PRD §5).
 *
 *  `hideReposted` drops rows outright rather than greying them, which is the
 *  difference between this and the blocklist: blocking a company is about that
 *  company from now on, so its rows stay visible with an Unblock button, while
 *  hiding reposts is about what the list should contain. Applied here, on every
 *  render, so flipping the setting takes effect on jobs already found — see
 *  {@link isHiddenAsReposted}. Nothing is deleted: turning it back off brings
 *  the rows straight back. */
export function toJobViews(
  jobs: Job[],
  watches: Watch[],
  blockedNormalized: string[] = [],
  hideReposted = false,
): JobView[] {
  return [...jobs]
    .filter((j) => !isHiddenAsReposted(j, hideReposted))
    .sort((a, b) => b.foundAt - a.foundAt)
    .map((j) => toJobView(j, watches, blockedNormalized));
}

/** The badge number: how many jobs you have not looked at yet and are not
 *  blocked — the same rule the toolbar badge uses (see `unreadCount` in scan.ts).
 *  Both clicking a row and ticking it read take it off this count; the New list
 *  is the looser filter that only the tick empties (see `visibleJobs`).
 *
 *  A job hidden by `hideReposted` is off the count too, and must be: it is not on
 *  the list at all, so counting it would leave a badge promising rows that cannot
 *  be reached by any chip or mode. */
export function unreadCount(
  jobs: Job[],
  blockedNormalized: string[] = [],
  hideReposted = false,
): number {
  return jobs.filter(
    (j) =>
      !j.read &&
      !j.opened &&
      !isCompanyBlocked(j.company, blockedNormalized) &&
      !isHiddenAsReposted(j, hideReposted),
  ).length;
}

/**
 * Mark one job opened at `now`, immutably — the trace of "you clicked this and
 * we opened the posting".
 *
 * Opening is looking, not dismissing, and the two now split the difference: the
 * job comes **off the badge and loses its unread dot** (you have seen it — that
 * is what the count is for), but it **stays on the New list**, greyed with an
 * "Opened" chip, until the row's tick files it away. An inbox works the same way:
 * read mail is still in the inbox, it just stops counting. Dropping it from the
 * list here instead was a reported bug — a click in the popup made the job vanish
 * as the popup closed, with nowhere to get it back from but "All".
 *
 * Returns a new map with just that entry replaced; the original is untouched and
 * an unknown id is a no-op (the same reference comes back). The storage write that
 * persists this happens in `<ListView>` **before** the tab opens (PRD §9).
 * Re-opening a job keeps the first `openedAt` — it records when you first looked,
 * not most recently.
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
 * Record that you applied to a job, immutably — the "Yes" answer to the prompt a
 * row click queues, plus whatever note came with it.
 *
 * Only Yes is ever written. A "No" leaves the record untouched (you may well
 * apply tomorrow, and a stored no would quietly go stale), so this has no
 * `applied: false` direction. `notes` is trimmed and may be empty — the note is
 * optional, the answer is not.
 *
 * An unknown id is a no-op returning the same reference, so the caller can skip
 * the storage write. A job answered twice keeps its first `appliedAt`, for the
 * same reason `markJobOpened` does — it records when you applied, not when you
 * last confirmed it — while the note is overwritten, because a second answer is
 * you correcting the note.
 */
export function markJobApplied(jobs: JobsMap, id: string, notes: string, now: number): JobsMap {
  const job = jobs[id];
  if (!job) return jobs;
  return {
    ...jobs,
    [id]: { ...job, applied: true, appliedAt: job.appliedAt ?? now, applyNotes: notes.trim() },
  };
}

/**
 * Undo an applied record, immutably — the row's own "Applied" tag, tapped.
 *
 * The three fields are *deleted* rather than set to false, so the job comes back
 * to the exact shape it had before it was ever answered: nothing left over to
 * distinguish "I un-applied this" from "never applied", and the question becomes
 * askable again the next time the row is opened. That does discard the note, which
 * is the price of a one-tap undo.
 *
 * Returns the same reference when there was nothing to undo (an unknown id, or a
 * job with no applied record), so the caller can skip the storage write.
 */
export function clearJobApplied(jobs: JobsMap, id: string): JobsMap {
  const job = jobs[id];
  if (!job || job.applied !== true) return jobs;
  // A copy first, then drop the fields from it — the stored record is untouched.
  const cleared = { ...job };
  delete cleared.applied;
  delete cleared.appliedAt;
  delete cleared.applyNotes;
  return { ...jobs, [id]: cleared };
}

/** Which jobs a bulk read is allowed to reach — the list exactly as it is
 *  filtered on screen, so the button can never dismiss a row you cannot see.
 *  Mirrors the two filters `selectView` applies to the list; the New⇄All mode is
 *  deliberately not among them, because every unread job is on the New list by
 *  definition, so the mode cannot change which jobs a read would touch. Blocked
 *  companies aren't either: those rows stay on screen, greyed, so they are part
 *  of what you are looking at. */
export type ReadScope = {
  /** The watch chip filtering the list, or null/absent for "All watches". */
  watchId?: string | null;
  /** `settings.hideReposted` — a job the setting has taken off the list is not
   *  yours to dismiss, and leaving it unread is what makes turning the setting
   *  back off bring it back as the new job it never got shown as. */
  hideReposted?: boolean;
};

/**
 * Mark every unread job in `scope` read at `now`, immutably (the "Mark all as
 * read" action, mockups decision 4).
 *
 * "All" means all of the list in front of you, not all of storage: under a watch
 * chip this reaches that watch's jobs and no others. Clearing four watches you
 * had not looked at because you tidied up one of them is unrecoverable — nothing
 * un-reads in bulk — and the header says which it is doing (`filtered` in
 * `<ListHeader>`). An empty `scope` is the whole map, which is what "All watches"
 * passes.
 *
 * Already-read jobs keep their original `readAt`; only the unread ones in scope
 * flip. Returns the same reference when there was nothing to mark, so the caller
 * can skip a redundant storage write. `<ListView>` persists this and repaints the
 * toolbar badge in one action — and the badge still counts every watch, so a
 * scoped read leaves a number behind on purpose.
 */
export function markAllRead(jobs: JobsMap, now: number, scope: ReadScope = {}): JobsMap {
  const watchId = scope.watchId || null;
  const hideReposted = scope.hideReposted === true;
  let changed = false;
  const next: JobsMap = {};
  for (const [id, job] of Object.entries(jobs)) {
    const onList =
      (watchId === null || job.watchId === watchId) && !isHiddenAsReposted(job, hideReposted);
    if (job.read || !onList) {
      next[id] = job;
    } else {
      next[id] = { ...job, read: true, readAt: now };
      changed = true;
    }
  }
  return changed ? next : jobs;
}

/**
 * Toggle a company on the blocklist — the row's ban button, in both directions.
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
   *  whose company matches and flips their Block button to Unblock; those rows
   *  stay on screen, they just stop counting towards the badge. */
  blockedCompanies?: string[];
  /** `settings.hideReposted` — "Hide jobs marked Reposted". Takes the rows off
   *  the list and off the badge on every render, so turning it on also clears
   *  reposts found before it was on, and turning it off brings them back. */
  hideReposted?: boolean;
  /** The row whose Block button was pressed once and is now asking "Sure?".
   *  Blocking a company is the one row action that changes what future scans
   *  surface, so it takes two presses; mount.ts owns this id and clears it on
   *  the next click or after `BLOCK_CONFIRM_MS`. */
  armedBlockId?: string | null;
  /** A scan cycle is holding the lock right now (`scanState.isScanning`). Only
   *  changes the empty state: with nothing yet to show it reads "Scanning…"
   *  instead of "Nothing scanned yet" (mockups decision 5). */
  scanning?: boolean;
  /** A "Scan now" click whose cycle has not shown up in storage yet — the gap
   *  between the click and `scanning` becoming true. It exists because that gap
   *  is not instant: the click has to wake a sleeping MV3 service worker, which
   *  is often a second or more, and until then every surface still reads "Scan
   *  now / next scan in 3m 14s" — indistinguishable from a click that missed.
   *  Treated exactly like `scanning` everywhere, so the button, the status bar
   *  and the empty state all say so the moment the button is pressed; mount.ts
   *  clears it when the background replies (or fails to). */
  pendingScan?: boolean;
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
  /** A guarded field has stopped reading — present on zero of a page's postings
   *  (issue #52, `fieldHealth.message`), or null/undefined when every field reads.
   *  A different axis from scan health: the list can be `ok` and a selector still
   *  dead, so it renders as its own amber banner. Never a desktop notification
   *  (the Telegram push is #54). */
  fieldBreakMessage?: string | null;
  /** When the armed one-shot alarm is due to fire (`chrome.alarms.get(...)
   *  .scheduledTime`), or null/undefined when no alarm exists. The footer counts
   *  down to it. Read from the alarm rather than recomputed here: jitter, back-off
   *  and the quiet-hours jump were already decided when it was armed, so anything
   *  this view computed for itself would be a *different* draw from the same dice. */
  nextScanAt?: number | null;
  /** `settings.quietHours` — only used to explain a countdown that is hours long
   *  instead of minutes (PRD §15, decision 4). Nothing is suppressed by it; the
   *  alarm already accounts for the window. */
  quietHours?: QuietHours;
  /** The clock, injected so the countdown is a pure function of its inputs
   *  (PRD §14). Defaults to `Date.now()` for callers that render no countdown. */
  now?: number;
  /** The master on/off switch (`settings.enabled`, § master). `false` = the user
   *  paused the whole loop from the header: the footer says "Paused" and the
   *  header hides "Scan now". Absent (settings from before the switch existed)
   *  reads as on, so callers pass `settings.enabled !== false`. */
  enabled?: boolean;
  /** `settings.manualOnly` (§ manual-only) — "Only scan when I press Scan now".
   *  Nothing is armed while it is on, so the footer says so instead of counting
   *  down. Only the status bar reads it: the button, the list and the badge are
   *  deliberately unchanged, because a manual round is a full round. */
  manualOnly?: boolean;
};

/**
 * Is a scan under way as far as this view is concerned? Either the lock is
 * genuinely held (`scanning`) or the user just pressed the button and we are
 * waiting on the worker (`pendingScan`). The two are deliberately one answer:
 * from the user's side "I asked for a scan" and "a scan is running" are the same
 * situation, and showing them differently would only advertise the round trip.
 */
export function isScanning(ctx: ViewContext): boolean {
  return ctx.scanning === true || ctx.pendingScan === true;
}

/** Choose the empty/degraded message when nothing is visible. A broken scan
 *  outranks everything (there may be stale jobs but the read is untrustworthy);
 *  otherwise: no watches → nothing scanned → (New mode) all caught up. */
export function pickEmptyKind(ctx: ViewContext, total: number): EmptyKind {
  if (ctx.severity === "error") return "scan-error";
  if (ctx.watches.length === 0) return "no-watches";
  if (total === 0) return isScanning(ctx) ? "scanning" : "no-jobs-yet";
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
  if (isScanning(ctx)) return "scanning";
  if (ctx.scanMode === "halted") return "halted";
  return "idle";
}

/**
 * What the footer status bar says — the answer to "is this thing still running?".
 *
 * The order is the priority order. A live cycle wins over everything: while the
 * lock is held the extension *is* scanning, whatever the schedule or the health
 * record say — and a just-clicked "Scan now" counts as live from the click, not
 * from the worker's reply (see `pendingScan`), so the countdown can never keep
 * ticking under a button you already pressed. A halted loop comes next, because there is genuinely nothing armed
 * to count down to (§16.2 waits for a manual resume). With no enabled search
 * there is nothing to scan either, so the bar goes away entirely rather than
 * promise a scan that would find nothing. Only then is it a countdown — and a
 * `nextScanAt` already in the past means the alarm has fired but its cycle hasn't
 * reached storage yet, which is `due`, not a negative number. Between those two:
 * the manual-only switch, which replaces the countdown with the standing state it
 * is, because under it there is no next scan until a human asks for one.
 *
 * A `paused` (logged-out) loop deliberately gets a normal countdown: §16.1 keeps
 * scanning so a later `ok` scan can auto-resume it, so the next scan really is
 * coming. The health banner above already explains the situation.
 */
export function scanStatus(ctx: ViewContext): ScanStatus {
  if (isScanning(ctx)) return { kind: "scanning" };
  // The master switch (§ master) outranks the schedule and the health record: a
  // loop the user turned off is paused whatever a stale halt or armed alarm says.
  // A cycle already in flight still wins above — it finishes, then this takes over.
  if (ctx.enabled === false) return { kind: "disabled" };
  if (ctx.scanMode === "halted") return { kind: "halted" };
  if (!ctx.watches.some((w) => w.enabled)) return { kind: "off" };
  // Manual only (§ manual-only) outranks the countdown rather than falling through
  // to `unscheduled`: it is a state the user chose, and it must win even in the
  // seconds where an alarm armed before the switch was flipped is still around —
  // counting down to a wake that will only clear itself would be a lie.
  if (ctx.manualOnly === true) return { kind: "manual" };
  if (ctx.nextScanAt == null) return { kind: "unscheduled" };

  const now = ctx.now ?? Date.now();
  const remainingMs = ctx.nextScanAt - now;
  if (remainingMs <= 0) return { kind: "due" };

  // Quiet hours are a local-clock window (§15), hence the Date round-trip.
  const quiet = ctx.quietHours
    ? isWithinQuietHours(minutesOfDay(new Date(now)), ctx.quietHours)
    : false;
  return { kind: "waiting", remainingMs, quiet };
}

/** Everything `<ListView>` puts on screen, already decided. See {@link selectView}. */
export type ViewProps = {
  title: string;
  /** Unread across every watch, for the header badge. 0 = no badge. */
  badge: number;
  /** The watch chips and which one is pressed (null = "All watches"). */
  chips: ChipWatch[];
  activeWatchId: string | null;
  mode: ListMode;
  /** How many rows the current chip + mode actually put on screen. The footer's
   *  end-of-list line counts these — the number you can see — while `badge`
   *  above keeps counting unread across every watch, which is a different
   *  number on purpose. */
  visibleCount: number;
  /** Every row the list could show, already ordered and mapped. `<JobList>`
   *  applies the mode filter itself so an "all caught up" list still knows how
   *  many rows it is hiding. */
  jobs: JobView[];
  /** Non-null when the list is empty and this message takes its place instead. */
  emptyKind: EmptyKind | null;
  scanButton: ScanButtonState;
  status: ScanStatus;
  /** The master on/off switch (§ master). `false` = the user paused everything:
   *  the header hides "Scan now" and the whole body collapses to the paused
   *  message. `ctx.enabled` absent (pre-switch settings) reads as on. */
  enabled: boolean;
  /** The health banner and the §16.7 push warning, in the order they stack. Both
   *  can be present at once — a broken read and a broken push are independent. */
  banners: { message: string; severity: NonNullable<HealthState["severity"]> }[];
  armedBlockId: string | null;
};

/**
 * Every decision the page makes, as plain data — the pure half of what used to
 * be `renderPage`. It resolves the badge, applies the chip filter, orders the
 * rows, picks the empty state, and stacks the banners; `<ListView>` then does
 * nothing but map the result to JSX.
 *
 * The split is what keeps the page testable: `node --test` can assert that a
 * blocked company is off the badge, or that an errored scan outranks an empty
 * list, without rendering a single element.
 */
export function selectView(ctx: ViewContext): ViewProps {
  const blockedCompanies = ctx.blockedCompanies ?? [];
  const hideReposted = ctx.hideReposted === true;

  // The badge always counts unread across every watch — it mirrors the toolbar
  // action badge, which the chip filter must not change (mockups decision 4).
  const badge = unreadCount(ctx.jobs, blockedCompanies, hideReposted);

  // The chip filters the *list*: an active watch drops jobs from other watches.
  const activeWatchId = ctx.activeWatchId || null;
  const listJobs = activeWatchId
    ? ctx.jobs.filter((j) => j.watchId === activeWatchId)
    : ctx.jobs;
  const jobs = toJobViews(listJobs, ctx.watches, blockedCompanies, hideReposted);
  const visible = ctx.mode === "new" ? jobs.filter((v) => !v.read) : jobs;

  const banners: ViewProps["banners"] = [];
  if (ctx.message) banners.push({ message: ctx.message, severity: ctx.severity ?? "warn" });
  // A field break is a different axis from scan health (issue #52) — the page can
  // read `ok` and still have a dead selector — so it stacks as its own amber
  // banner rather than being ranked against the health one.
  if (ctx.fieldBreakMessage) banners.push({ message: ctx.fieldBreakMessage, severity: "warn" });
  // The push warning is a soft, config-level warning independent of scan health
  // (§16.7), so it stacks under any health banner rather than replacing it.
  if (ctx.pushWarn) banners.push({ message: PUSH_FAILING_MESSAGE, severity: "warn" });

  return {
    title: ctx.title,
    badge,
    chips: ctx.watches.map((w) => ({ id: w.id, name: w.name })),
    activeWatchId,
    mode: ctx.mode,
    visibleCount: visible.length,
    jobs,
    emptyKind: visible.length ? null : pickEmptyKind(ctx, jobs.length),
    scanButton: scanButtonState(ctx),
    status: scanStatus(ctx),
    enabled: ctx.enabled !== false,
    banners,
    armedBlockId: ctx.armedBlockId ?? null,
  };
}
