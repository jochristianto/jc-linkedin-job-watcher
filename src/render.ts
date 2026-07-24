// Shared list-view component for the LinkedIn Job Watcher (PRD §4).
//
// The PRD calls the list view "a shared component, mounted twice" — in
// popup.html (toolbar click, ~400px) and jobs.html (notification click, full
// tab). Issue #4 settled the build stack: plain Vite, no framework, plain
// TypeScript. So this component is plain functions that produce markup — no
// React/Preact/Svelte, nothing to cold-start. The page mounts it with a single
// `container.innerHTML = renderList(jobs, mode)` and delegates clicks off the
// container. The popup and the tab render the *same* markup; they diverge only
// through CSS driven by a `.view-popup` / `.view-tab` class on the root.
//
// These functions are pure (string in, string out) so the shape of every row
// and empty state is unit-testable without a DOM or chrome.* — which is exactly
// what the static mockups embed and what production reuses.

import { icon, type IconName } from "./icons.ts";

export type JobView = {
  id: string;
  title: string;
  company: string;
  location: string;
  postedText: string;
  watchName: string;
  url: string;
  /** You clicked this row and we opened the posting. Highlights the row; it
   *  stays in the list either way. */
  opened: boolean;
  /** You dismissed it with the row's tick. Greys the row and drops it out of
   *  "New" — the only thing that does. */
  read: boolean;
  /** Its company is on the blocklist. Greys the row the same way a read job is
   *  greyed; it stays on screen (the blocklist only stops *future* scans from
   *  surfacing it) and the Block button flips to Unblock. */
  blocked: boolean;
};

/** How long an armed Block button waits for its second press before going back
 *  to "Block" on its own. Long enough to read the question, short enough that a
 *  popup you come back to is never still holding a half-pressed button.
 *  mount.ts owns the timer; this is here so the markup and the timeout that
 *  undoes it are one decision. */
export const BLOCK_CONFIRM_MS = 5000;

export type ListMode = "new" | "all";

export type EmptyKind =
  | "no-watches"
  | "no-jobs-yet"
  | "no-new"
  | "scanning"
  | "scan-error";

/** Escape scraped text before embedding it in markup. LinkedIn titles contain
 * `&` and `<` often enough to break the row otherwise (mirrors push.ts). */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Join the present parts with " · ", dropping any that are missing so a blank
 * company or location never leaves a dangling separator (see #9). */
export function metaLine(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" · ");
}

/**
 * One job row: the posting itself as a link, plus the two row actions.
 *
 * The row is a `<div>` wrapping an `<a class="job-main">`, not one big `<a>`,
 * because buttons cannot legally live inside an anchor. The anchor still covers
 * the whole title/meta block, so clicking the row opens the posting exactly as
 * before — it just no longer dismisses it. `data-opened` / `data-read` /
 * `data-blocked` carry the three states for CSS; mount.ts reads `data-job-id`
 * off this element and `data-action` off the buttons.
 *
 * Fields fail independently: a missing company, location or posted time is
 * simply omitted; a missing title falls back to a placeholder so the row is
 * never blank (PRD §12 "each field fails independently").
 *
 * `armedBlock` is this row's Block button mid-question: pressed once, now
 * reading "Sure?" and waiting for the press that commits. It is transient view
 * state, not job state, so it is a parameter rather than a `JobView` field —
 * mount.ts holds which row is armed and clears it on the next click or after
 * `BLOCK_CONFIRM_MS`.
 */
export function renderJobRow(job: JobView, armedBlock = false): string {
  // Only the title needs a fallback — it's the one field always rendered. The
  // rest (company, location, posted time) are dropped by metaLine when blank.
  const title = job.title.trim() ? esc(job.title) : "Untitled role";
  const meta = metaLine([esc(job.company), esc(job.location)]);
  const foot = metaLine([esc(job.postedText), esc(job.watchName)]);
  // Say *why* the row is greyed — read and blocked look alike otherwise.
  const tag = job.blocked ? `<span class="job-tag">Blocked</span>` : "";

  // Both actions are toggles, so every one of them is undoable from the row it
  // was pressed on. That matters most for Block: the only other way back is
  // hunting the company down in Options.
  // The icon carries the direction: a tick to dismiss, an undo arrow to bring it
  // back. The label is what a screen reader gets — the icon is aria-hidden.
  const readLabel = job.read ? "Mark as unread" : "Mark as read";
  const readBtn = `<button class="job-btn" data-action="read" aria-pressed="${job.read}" title="${readLabel}" aria-label="${readLabel}">${icon(job.read ? "rotate-ccw" : "check")}</button>`;

  // Block says what it does in words. It is the one row action that changes what
  // *future* scans surface, and its row doesn't visibly disappear when pressed,
  // so a bare ban glyph reads as a status ("not allowed") rather than a control
  // you can press — and the difference between block and unblock lived entirely
  // in a tooltip. It also comes first now, with the tick out at the edge where a
  // one-tap dismiss belongs.
  //
  // A card with no company parsed has nothing to block, so it gets no button
  // rather than one that would blocklist the empty string (§12 again).
  const company = job.company.trim();
  const blockLabel = job.blocked ? `Unblock ${company}` : `Block ${company}`;
  // Armed = pressed once, waiting for the second press that commits. Only the
  // blocking direction ever arms — unblocking just puts jobs back, so there is
  // nothing to be sure about — and mount.ts decides which row that is.
  const blockText = armedBlock ? "Sure?" : job.blocked ? "Unblock" : "Block";
  const blockTitle = esc(armedBlock ? `${blockLabel} — press again to confirm` : blockLabel);
  const blockBtn = company
    ? `<button class="job-btn job-btn-block" data-action="block" data-armed="${armedBlock}" aria-pressed="${job.blocked}" title="${blockTitle}" aria-label="${blockTitle}">${icon("ban", 14)}<span class="job-btn-label">${blockText}</span></button>`
    : "";

  return `
    <div class="job" data-job-id="${esc(job.id)}" data-read="${job.read}" data-opened="${job.opened}" data-blocked="${job.blocked}">
      <a class="job-main" href="${esc(job.url)}">
        <span class="job-dot" aria-hidden="true"></span>
        <span class="job-body">
          <span class="job-title">${title}</span>
          ${meta ? `<span class="job-meta">${meta}</span>` : ""}
          ${foot || tag ? `<span class="job-foot">${foot}${tag}</span>` : ""}
        </span>
      </a>
      <span class="job-actions">${blockBtn}${readBtn}</span>
    </div>`.trim();
}

/**
 * The list. In "new" mode *read* jobs are filtered out — read, not opened: a job
 * you clicked open stays here highlighted so you can go back to it, and only the
 * row's tick removes it. In "all" mode every job stays on screen, read ones
 * rendered grey (PRD §3, and #9's read/unread question).
 *
 * Blocked jobs stay in both modes, greyed. The blocklist governs what *future*
 * scans surface; silently deleting rows you can already see would be a second,
 * unasked-for action.
 *
 * `armedBlockId` is the at-most-one row whose Block button is mid-question. One
 * id rather than a set: arming a second button disarms the first, so two rows
 * can never be asking at once.
 */
export function renderList(
  jobs: JobView[],
  mode: ListMode,
  armedBlockId: string | null = null,
): string {
  const visible = mode === "new" ? jobs.filter((j) => !j.read) : jobs;
  return visible.map((j) => renderJobRow(j, j.id === armedBlockId)).join("\n");
}

/** The minimal watch shape the filter chips need: an id to filter on and a name
 * to label the chip. `view.ts` maps the stored `Watch[]` down to this. */
export type ChipWatch = { id: string; name: string };

/**
 * The watch filter chips (mockups decision 4): a leading "All watches" chip
 * (`data-watch-id=""`) then one chip per configured watch. Exactly one is
 * pressed — the All chip when `activeWatchId` is null/empty, otherwise the
 * matching watch. The click handler in mount.ts reads `data-watch-id` to filter
 * the list in place; an empty id means "no filter". Ids and names are escaped.
 */
export function renderChips(watches: ChipWatch[], activeWatchId: string | null): string {
  const active = activeWatchId ?? "";
  const chip = (id: string, name: string): string =>
    `<button class="chip" data-watch-id="${esc(id)}" aria-pressed="${id === active}">${esc(name)}</button>`;
  return `
    <div class="chips">
      ${chip("", "All watches")}
      ${watches.map((w) => chip(w.id, w.name)).join("\n      ")}
    </div>`.trim();
}

/**
 * The New⇄All segmented toggle (mockups decision 6). Two buttons carrying
 * `data-mode`; the active one is pressed. mount.ts reads `data-mode` on click,
 * persists it to the `ui` key, and re-renders — in New an opened row drops out,
 * in All it stays on screen but dimmed.
 */
export function renderModeToggle(mode: ListMode): string {
  const btn = (m: ListMode, label: string): string =>
    `<button data-mode="${m}" aria-pressed="${m === mode}">${label}</button>`;
  return `
    <div class="toggle">
      ${btn("new", "New")}
      ${btn("all", "All")}
    </div>`.trim();
}

/** The toolbar row under the header: watch chips on the left, the New⇄All toggle
 * on the right (mockups decision 4). One string so the popup and tab share it. */
export function renderToolbar(
  watches: ChipWatch[],
  activeWatchId: string | null,
  mode: ListMode,
): string {
  return `
    <div class="toolbar">
      ${renderChips(watches, activeWatchId)}
      ${renderModeToggle(mode)}
    </div>`.trim();
}

/**
 * What the manual scan control in the header is currently showing:
 *
 * - `idle`     — ready; a click starts a cycle immediately instead of waiting
 *                for the next alarm (PRD §9/§15 — the cadence is 5 minutes and
 *                skips quiet hours, so "right now" needs its own trigger).
 * - `scanning` — a cycle already holds the scan lock, so the control is inert.
 * - `halted`   — a verification challenge stopped scanning (§16.2). That state
 *                waits for the user to "manually resume", and a halted extension
 *                can never scan its own way back to healthy, so this control is
 *                that resume and says so rather than pretending nothing is wrong.
 */
export type ScanButtonState = "idle" | "scanning" | "halted";

const SCAN_BUTTON: Record<ScanButtonState, { label: string; title: string }> = {
  idle: { label: "Scan now", title: "Scan every enabled search right now" },
  scanning: { label: "Scanning…", title: "A scan is already running" },
  // Short on purpose: the header is only 380px wide in the popup, and the health
  // banner directly below already says "…clear it, then resume" (§16.8).
  halted: { label: "Resume", title: "Clear the halt and scan right now" },
};

/**
 * The manual scan control in the header. mount.ts sends `LJW_SCAN_NOW` to the
 * background on click; `data-scan-state` is for styling only. Disabled *only*
 * while a cycle is in flight — it stays live in every failure state, including
 * `halted`, because otherwise the service-worker console is the user's only way
 * to trigger a scan.
 */
export function renderScanButton(state: ScanButtonState): string {
  const { label, title } = SCAN_BUTTON[state];
  const disabled = state === "scanning" ? " disabled" : "";
  return `<button class="hdr-btn" id="scan-now" data-scan-state="${state}" title="${esc(title)}"${disabled}>${label}</button>`;
}

/**
 * What the footer status bar is saying about the scan loop:
 *
 * - `scanning`    — a cycle is scanning right now (`scanState.isScanning`).
 * - `waiting`     — the next scan is armed; `remainingMs` counts down to it, and
 *                   `quiet` means we are inside the quiet-hours window (PRD §15,
 *                   decision 4), which is why that number is hours and not minutes.
 * - `due`         — the armed time has passed but the cycle hasn't shown up in
 *                   storage yet: the seconds between the alarm firing and the lock
 *                   being taken, and the moment after a cycle ends but before the
 *                   next alarm is armed.
 * - `halted`      — a verification challenge stopped the loop (§16.2). Nothing is
 *                   scheduled; the header's Resume button is the only way on.
 * - `unscheduled` — no alarm exists at all. Shouldn't happen (§17 decision 5 keeps
 *                   one armed), so it says so rather than showing a fake countdown.
 * - `off`         — no enabled search, so there is nothing to scan and a countdown
 *                   would be a promise the loop can't keep. Renders nothing.
 */
export type ScanStatus =
  | { kind: "scanning" }
  | { kind: "waiting"; remainingMs: number; quiet: boolean }
  | { kind: "due" }
  | { kind: "halted" }
  | { kind: "unscheduled" }
  | { kind: "off" };

/**
 * A duration as the coarsest two units that still read as a countdown: `45s`,
 * `4m 12s`, `7h 12m`. Seconds are dropped past an hour — a quiet-hours wait
 * measured to the second is noise — and rounded UP so a wait that is still on
 * never reads "0s" (it counts down to 1s, then the state flips to `due`).
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The icon and sentence for each status. Split out from the markup so the copy
 *  is one table to read, the same way SCAN_BUTTON and EMPTY_STATES are. */
function statusFace(status: ScanStatus): { icon: IconName; text: string } {
  switch (status.kind) {
    case "scanning":
      return { icon: "refresh-cw", text: "Scanning for new jobs…" };
    case "waiting":
      return status.quiet
        ? { icon: "moon", text: `Quiet hours · next scan in ${formatCountdown(status.remainingMs)}` }
        : { icon: "clock", text: `Next scan in ${formatCountdown(status.remainingMs)}` };
    case "due":
      return { icon: "clock", text: "Next scan due any moment" };
    case "halted":
      return { icon: "triangle-alert", text: "Scanning stopped — press Resume" };
    case "unscheduled":
      return { icon: "clock", text: "No scan scheduled — press Scan now" };
    case "off":
      return { icon: "clock", text: "" };
  }
}

/**
 * The footer status bar: what the scan loop is doing, and how long until it does
 * it again. It answers the question the rest of the view can't — a list that
 * hasn't changed in ten minutes looks identical whether the loop is healthy,
 * asleep for quiet hours, or dead.
 *
 * Returns the empty string for `off`, which leaves the footer element childless
 * so `.statusbar:empty` can collapse it — no bar rather than a bar saying nothing.
 *
 * `role="status"` is set ONLY while scanning: that text lands once and is worth
 * announcing, whereas a live region wrapped around a ticking countdown would read
 * the whole sentence out loud every second.
 */
export function renderScanStatus(status: ScanStatus): string {
  if (status.kind === "off") return "";
  const { icon: name, text } = statusFace(status);
  const live = status.kind === "scanning" ? ` role="status"` : "";
  return `<div class="scan-status" data-kind="${status.kind}"${live}>${icon(name, 13)}<span class="scan-status-text">${esc(text)}</span></div>`;
}

/** The empty-state artwork, at the 28px the `.empty-icon` block reserves for it.
 *  Bigger than a button icon and thinner-looking as a result, which is the point:
 *  it reads as an illustration, not a control you can press. */
const EMPTY_ICON_SIZE = 28;

const EMPTY_STATES: Record<EmptyKind, { icon: IconName; title: string; body: string }> = {
  "no-watches": {
    icon: "search",
    title: "No searches yet",
    body: "Add a LinkedIn job search in Options to start watching.",
  },
  "no-jobs-yet": {
    icon: "sprout",
    title: "Nothing scanned yet",
    body: "The first scan hasn't finished. New jobs will show up here.",
  },
  "no-new": {
    icon: "circle-check",
    title: "All caught up",
    body: "No new jobs. Switch to All to see everything found.",
  },
  scanning: {
    icon: "refresh-cw",
    title: "Scanning…",
    body: "Checking your searches. This list updates when it's done.",
  },
  "scan-error": {
    icon: "triangle-alert",
    title: "Last scan failed",
    body: "LinkedIn's page may have changed — selectors returned nothing. See Options.",
  },
};

/** A distinct, actionable message for each empty/degraded situation (PRD §5 of
 * the issue): no watches, nothing scanned, nothing new, mid-scan, scan broken. */
export function renderEmptyState(kind: EmptyKind): string {
  const s = EMPTY_STATES[kind];
  return `
    <div class="empty" data-kind="${kind}">
      <div class="empty-icon">${icon(s.icon, EMPTY_ICON_SIZE)}</div>
      <div class="empty-title">${s.title}</div>
      <div class="empty-body">${s.body}</div>
    </div>`.trim();
}
