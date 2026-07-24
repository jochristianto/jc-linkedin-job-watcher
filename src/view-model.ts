// The list view's view-model — PRD §4, §14.
//
// Was `render.ts`, back when this layer produced markup strings. The UI is now
// React components in `components/`, so everything that emitted HTML moved
// there and what is left is the part that never needed a DOM: the shapes the
// components take as props, and the two pure formatters that turn stored values
// into the words on screen.
//
// Keeping these here rather than inside the components is what lets `node --test`
// prove the meta-line's separator rule and the countdown's rounding with plain
// strings, no render involved. The escaping helper this file used to carry is
// gone with the markup — React escapes its children, which is the whole reason
// `esc` existed.

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
  /** You answered Yes to "Did you apply for this job?" after opening it. Tags the
   *  row so the list is also a record of what you have applied to, and stops the
   *  question being asked about this job a second time. */
  applied: boolean;
};

/** The answer to "Did you apply for this job?". `null` is a real third state, not
 *  a missing value: it is the question as first asked, unanswered. `"no"` barely
 *  lives here at all — it closes the question the moment it is clicked (see
 *  `ApplyPrompt`), so only `"yes"` is ever held. */
export type ApplyAnswer = "yes" | "no" | null;

/** Which of the apply prompt's two dialogs is on screen. `"ask"` is the question
 *  itself, two buttons and nothing else; `"note"` is the one Yes opens. */
export type ApplyPromptStep = "ask" | "note";

/**
 * The dialog a given answer puts on screen — the "the note belongs to Yes" rule,
 * provable with plain values. The component holds the answer in `useState` and
 * renders what this returns; nothing about the rule lives in JSX.
 *
 * There is nothing to note about a job you did not apply to, so No never reaches
 * the second dialog: it answers and closes the question on the click.
 */
export function applyPromptStep(answer: ApplyAnswer): ApplyPromptStep {
  return answer === "yes" ? "note" : "ask";
}

/** How long an armed Block button waits for its second press before going back
 *  to "Block" on its own. Long enough to read the question, short enough that a
 *  popup you come back to is never still holding a half-pressed button.
 *  `useArmedBlock` owns the timer; this is here so the button and the timeout
 *  that undoes it are one decision. */
export const BLOCK_CONFIRM_MS = 5000;

export type ListMode = "new" | "all";

export type EmptyKind =
  | "no-watches"
  | "no-jobs-yet"
  | "no-new"
  | "scanning"
  | "scan-error"
  // The master switch is off (§ master): the list, toolbar and footer are all
  // hidden and this takes their place. Never produced by `pickEmptyKind` — the
  // `<ListView>` renders it directly, ahead of the normal empty-state logic.
  | "paused";

/** The two places the list view mounts (PRD §4). The popup is a fixed 380px
 *  panel that closes on an outside click; the tab is a full page. It is the only
 *  thing that differs between them — previously a `.view-popup` / `.view-tab`
 *  class read by CSS, now a prop, because a component can simply not render the
 *  "open as a full page" button when it already is one. */
export type ViewVariant = "popup" | "tab";

/** The minimal watch shape the filter chips need: an id to filter on and a name
 *  to label the chip. `view.ts` maps the stored `Watch[]` down to this. */
export type ChipWatch = { id: string; name: string };

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
 * - `disabled`    — the user flipped the master switch off (§ master). The whole
 *                   loop is paused on purpose, so the bar says "Paused" rather
 *                   than counting down to a scan that isn't coming.
 */
export type ScanStatus =
  | { kind: "scanning" }
  | { kind: "waiting"; remainingMs: number; quiet: boolean }
  | { kind: "due" }
  | { kind: "halted" }
  | { kind: "unscheduled" }
  | { kind: "off" }
  | { kind: "disabled" };

/** Join the present parts with " · ", dropping any that are missing so a blank
 * company or location never leaves a dangling separator (see #9). */
export function metaLine(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" · ");
}

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
