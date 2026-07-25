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
  /** When *your watcher* first saw this posting (`Job.foundAt`), as an epoch ms.
   *  The row shows it next to the posting's own age because the two answer
   *  different questions: "Posted 6h ago" is how old the job is, "Found 41m ago"
   *  is how long it has been sitting here unread. A scan that picks up a 12-hour-old
   *  posting minutes after it appeared is the loop working; one that finds it
   *  eleven hours late is not, and only the second number says which happened. */
  foundAt: number;
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
  /** The note typed alongside that Yes (`Job.applyNotes`), or "" when the box was
   *  left empty. Rendered under the posting on an applied row: the whole reason
   *  the note is worth storing is being able to read it back off the list weeks
   *  later, and until now nothing ever showed it. */
  notes: string;
};

/** The answer to "Did you apply for this job?". `null` is a real third state, not
 *  a missing value: it is the question as first asked, unanswered. `"no"` barely
 *  lives here at all — it closes the question the moment it is clicked (see
 *  `ApplyPrompt`), so only `"yes"` is ever held. */
export type ApplyAnswer = "yes" | "no" | null;

/** Which of the apply prompt's two steps is on screen. `"ask"` is the question
 *  itself, two buttons and nothing else; `"note"` is the one Yes opens. */
export type ApplyPromptStep = "ask" | "note";

/**
 * The step a given answer puts on screen — the "the note belongs to Yes" rule,
 * provable with plain values. The component holds the answer in `useState` and
 * renders what this returns; nothing about the rule lives in JSX.
 *
 * There is nothing to note about a job you did not apply to, so No never reaches
 * the second step: it answers and closes the question on the click.
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

/**
 * The rows a mode actually puts on screen: "new" drops the *read* ones, "all"
 * keeps everything.
 *
 * Read, not opened — a job you clicked open stays here, dot cleared and "Opened"
 * chipped, so you can go back to it; only the row's tick removes it. That is the
 * one place this filter and the badge count part company on purpose: `unreadCount`
 * drops a job the moment you look at it, this keeps it until you say you are done
 * with it. An inbox draws the same line, and the alternative — a click in the popup
 * making the row vanish as the popup closes — was a reported bug.
 *
 * Blocked jobs stay in both modes too, greyed: the blocklist governs what future
 * scans surface, and silently deleting rows you can already see would be a second,
 * unasked-for action.
 *
 * Here rather than inside `JobList` because two callers need the same answer: the
 * list renders these, and the apply prompt has to know whether the row it belongs
 * under is among them before it can attach itself to one.
 */
export function visibleJobs(jobs: JobView[], mode: ListMode): JobView[] {
  return mode === "new" ? jobs.filter((j) => !j.read) : jobs;
}

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
 * - `manual`      — "Only scan when I press Scan now" is on (§ manual-only). Like
 *                   `unscheduled` there is no alarm to count down to, but here that
 *                   is the setting working, not a fault, so it reads as a standing
 *                   state rather than as something missing.
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
  | { kind: "manual" }
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

// ── Row formatters ───────────────────────────────────────────────────────────
// The four things the redesigned row derives from a job rather than stores. All
// pure, all here rather than inside `JobRow`, for the same reason `metaLine` is:
// they are rules about scraped text, and `node --test` can hold them to plain
// strings without rendering anything.

/** Which unit letter each LinkedIn age word abbreviates to. `month` is the one
 *  that cannot take its own first letter — `m` is already minutes — and a row
 *  that said "Posted 3m ago" about a three-month-old posting would be a lie in
 *  the direction that matters most. */
const AGE_UNITS: Record<string, string> = {
  second: "s",
  minute: "m",
  hour: "h",
  day: "d",
  week: "w",
  month: "mo",
  year: "y",
};

/**
 * LinkedIn's posted text as the short form the row's chip has room for:
 * `"12 hours ago"` → `"12h"`, `"3 minutes ago"` → `"3m"`, `"1 month ago"` → `"1mo"`.
 *
 * Anything that doesn't parse — a localised string, a phrasing LinkedIn changed —
 * falls back to the text with its trailing "ago" dropped, so the row still says
 * *something* true rather than a number invented from a failed match (PRD §12,
 * fields fail independently). An empty input stays empty and the chip is dropped.
 */
export function shortAge(postedText: string): string {
  const text = postedText.trim();
  if (!text) return "";
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(text);
  const unit = m ? AGE_UNITS[m[2]!.toLowerCase()] : undefined;
  // A match with a unit this table doesn't carry is the same situation as no
  // match at all: better the original words than a number with no unit on it.
  if (!m || !unit) return text.replace(/\s*ago\s*$/i, "").trim();
  return m[1]! + unit;
}

/**
 * An elapsed duration as one coarse unit: `"41m"`, `"6h"`, `"3d"`.
 *
 * Unlike {@link formatCountdown} this is looking backwards, at something that
 * already happened, so a second unit would be false precision — "found 41m 12s
 * ago" is not a fact anyone acts on. Floors below an hour and rounds above it,
 * and never returns "0m": something found this second was still found, and a
 * chip reading "Found 0m ago" looks like a bug rather than like news.
 */
export function formatAgo(ms: number): string {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Split LinkedIn's location into the place and the work mode it carries in
 * brackets: `"Tokyo, Japan (Hybrid)"` → `{ place: "Tokyo, Japan", mode: "Hybrid" }`.
 *
 * The mode gets its own tinted chip in the row because it is the one part of a
 * location people filter on by eye — Remote and On-site are different jobs, and
 * buried at the end of a grey line they read as punctuation. Only a trailing
 * bracket counts: `"Do, Shizuoka (Japan), Japan"` is a place name, not a mode.
 * A location with no bracket keeps the whole string as the place and returns an
 * empty mode, and the chip is simply not rendered.
 */
export function splitLocation(location: string): { place: string; mode: string } {
  const text = location.trim();
  const m = /\(([^()]+)\)\s*$/.exec(text);
  if (!m) return { place: text, mode: "" };
  return {
    place: text.slice(0, m.index).replace(/[,\s]+$/, "").trim(),
    mode: (m[1] ?? "").trim(),
  };
}

/**
 * The employer monogram: the first character of the company name, upper-cased.
 *
 * A leading Japanese corporate prefix is stripped first — `（株）テイルウィンド`
 * is not the "株" company, and every third Japanese employer would otherwise
 * wear the identical tile. Non-Latin scripts keep their character as-is (there
 * is no upper case to apply), and a blank company yields "" so the caller can
 * fall back rather than render an empty box.
 */
export function monogram(company: string): string {
  const clean = company
    .replace(/^[（(]\s*(株|有|合|同)\s*[）)]\s*/, "")
    .replace(/^(株式会社|有限会社)\s*/, "")
    .trim();
  const first = [...clean][0] ?? "";
  return first.toUpperCase();
}

/** How many monogram tones there are (`--chart-1` … `--chart-N` in tokens.css). */
export const COMPANY_TONES = 5;

/**
 * A stable tone index (1…{@link COMPANY_TONES}) for a company, from a plain
 * character-sum hash of its name.
 *
 * Stable is the whole requirement: the same employer has to wear the same colour
 * in this scan and the next one, across both surfaces, with no stored field to
 * keep in sync — that is what turns the tile into something you recognise before
 * you have read the name. Collisions are fine and expected; the tile carries the
 * letter too, and this is decoration, not identity.
 */
export function companyTone(company: string): number {
  let sum = 0;
  for (let i = 0; i < company.length; i++) sum += company.charCodeAt(i);
  return (sum % COMPANY_TONES) + 1;
}
