// Import planning — what applying a backup file to *this* browser would actually
// do, and what the wizard asks you about on the way. The pure half (§14): no
// chrome.*, no DOM, no clock read, so `node --test` proves every conflict rule
// with plain values.
//
// `backup.ts` answers "what is in the file, and is it valid?". This answers "what
// would applying it produce, and which of those choices are mine to make?" — the
// same seam `options-form.ts` → `settings-view.ts` already cuts, and the reason
// this is not another 300 lines bolted onto a module that is already carrying
// five concerns.
//
// Three rules shape it:
//
//   1. **One function, called from both sides.** {@link planImport} is what the
//      options page previews with AND what the worker writes with. A preview
//      computed by different code than the write is a preview that can lie; with
//      one function the only thing that can drift is the *input*, and re-reading
//      that under the scan lock is exactly what the worker does.
//
//   2. **The page ships decisions, never a result.** A wizard takes minutes, and
//      `settings` is written from outside the options page while it is open — the
//      popup's master switch and a job row's Block button both write it. A merge
//      computed on the page against a snapshot taken when the file was chosen
//      would silently drop whatever landed in between. So the request carries the
//      file, the mode and the ticked rows, and nothing else.
//
//   3. **Merge only ever adds.** Every list is a union, every timestamp collapses
//      to the earlier one, every "have you dealt with this" flag survives if
//      either side has it set. That makes the merge monotone, which is what lets
//      the wizard show a preview computed a minute ago: a scan finishing in the
//      meantime can only make the real result contain *more*, never less. Replace
//      is the mode that removes, and it says so on every screen.

import { makeBlockedCompany } from "./filter.ts";
import { minutesToTime } from "./options-form.ts";
import { SECTION_LABELS, type SettingsSection } from "./settings-view.ts";
import { restoredSettings, type BackupFile, type ExportedSettings } from "./backup.ts";
import type { SeenMap } from "./dedupe.ts";
import type { JobsMap } from "./storage.ts";
import type { BlockedCompany, Job, PostedPrecision, Settings, Watch } from "./types.ts";

// ── The two ways to apply a file ─────────────────────────────────────────────

/**
 * **Merge** adds what the file has and keeps what you have; nothing is removed.
 * **Replace** makes this browser match the file exactly.
 *
 * Replace is not a legacy mode kept for compatibility — it is the only one that
 * can *remove* something, which is the whole reason you would reach for a backup
 * you took before you broke something. Merge cannot do that job and never will.
 * What changed is that neither happens sight-unseen.
 */
export type ImportMode = "merge" | "replace";

/** Which side of a settings row won. */
export type SettingSide = "mine" | "file";

/**
 * One tickable row on the settings step.
 *
 * Grouped rather than one key per field, because the point of the step is to read
 * in plain words: quiet hours is one decision the user recognises, not three
 * numbers, and taking `startMinute` from the file while leaving `endMinute` here
 * would produce a window neither side ever configured.
 */
export type SettingChoiceKey =
  | "enabled"
  | "hideReposted"
  | "manualOnly"
  | "cadence"
  | "depth"
  | "quietHours"
  | "pacing"
  | "backoff"
  | "retention"
  | "notifyDesktop"
  | "pushEnabled"
  | "thresholds";

/**
 * Which rows were ticked over to the file's value.
 *
 * An **absent key reads as "mine"** — the same absent-means-the-safe-thing idiom
 * `manualOnly`, `notifyDesktop` and `applied` already use. So pressing through the
 * wizard without touching anything sends `{}` and produces a purely additive
 * merge, and the message payload stays two words long.
 */
export type SettingChoices = Partial<Record<SettingChoiceKey, SettingSide>>;

/** Every row left on "mine" — the default, and what a merge does if you press
 *  Next until the end. Empty by construction; see {@link SettingChoices}. */
export const KEEP_MINE: SettingChoices = {};

// ── Saying a setting out loud ────────────────────────────────────────────────
//
// One function per row rather than a generic stringifier. A generic one would
// print `{"enabled":true,"startMinute":1320}` next to a checkbox, and the entire
// promise of the settings step is that you can read what you are choosing between.

const sayOnOff = (on: boolean): string => (on ? "On" : "Off");

/** "Every 30–90 min", or "Every 60 min" when there is no jitter to spread. */
function sayCadence(s: ExportedSettings): string {
  if (s.jitterMinutes <= 0) return `Every ${s.intervalMinutes} min`;
  return `Every ${s.intervalMinutes - s.jitterMinutes}–${s.intervalMinutes + s.jitterMinutes} min`;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "1 page, 4 on catch-up". */
const sayDepth = (s: ExportedSettings): string =>
  `${plural(s.pagesPerScan, "page")}, ${s.catchUpPages} on catch-up`;

/** "22:00–07:00", or "Off". */
const sayQuietHours = (s: ExportedSettings): string =>
  s.quietHours.enabled
    ? `${minutesToTime(s.quietHours.startMinute)}–${minutesToTime(s.quietHours.endMinute)}`
    : "Off";

const seconds = (ms: [number, number]): string => `${ms[0] / 1000}–${ms[1] / 1000}s`;

/** "3–5s between pages, 8–12s between watches". */
const sayPacing = (s: ExportedSettings): string =>
  `${seconds(s.pacing.pagePauseMs)} between pages, ${seconds(s.pacing.watchPauseMs)} between watches`;

/** "After 3 quiet rounds, up to 240 min". */
const sayBackoff = (s: ExportedSettings): string =>
  `After ${plural(s.backoff.emptyScansBeforeBackoff, "quiet round")}, up to ${s.backoff.maxIntervalMinutes} min`;

/** "15d seen · 7d opened · 30d unopened · 50,000 cap". */
const sayRetention = (s: ExportedSettings): string =>
  `${s.retention.seenDays}d seen · ${s.retention.openedJobDays}d opened · ` +
  `${s.retention.unopenedJobDays}d unopened · ${s.retention.seenHardCap.toLocaleString("en-US")} cap`;

/** "Lock stale after 5 min · warn after 3 push failures". */
const sayThresholds = (s: ExportedSettings): string =>
  `Lock stale after ${Math.round(s.staleLockMs / 60_000)} min · ` +
  `warn after ${plural(s.pushFailWarnThreshold, "push failure")}`;

// ── The rows themselves ──────────────────────────────────────────────────────

/**
 * The heading a row is filed under.
 *
 * Mostly a page section, so the step's headings match the rail down the left of
 * the Options page and a row is findable afterwards. `"advanced"` is the one
 * bucket with no card behind it: `staleLockMs` and `pushFailWarnThreshold` have no
 * field on the page and can only ever differ in a hand-edited file — but the
 * wizard's promise is that nothing is written unseen, and a carve-out breaks that
 * promise in the direction you cannot notice.
 */
export type ChoiceGroup = SettingsSection | "advanced";

export const GROUP_LABELS: Record<ChoiceGroup, string> = {
  ...SECTION_LABELS,
  advanced: "Advanced",
};

/** One row on the settings step: what it is called, where it belongs, and both
 *  sides' current answer in words. */
export type SettingChoice = {
  key: SettingChoiceKey;
  label: string;
  group: ChoiceGroup;
  /** This browser's value, said out loud: `"22:00–07:00"`. */
  mine: string;
  /** The file's, in the same vocabulary. */
  file: string;
};

type ChoiceSpec = {
  key: SettingChoiceKey;
  label: string;
  group: ChoiceGroup;
  /** Both sides go through this, so a row can never compare two things phrased
   *  differently — and comparing the *words* rather than the values is also how
   *  a row that renders identically never appears (a 60-min interval with 0
   *  jitter differs from one with 0 jitter in a field nobody can see). */
  say: (s: ExportedSettings) => string;
  /** Everything the row moves when it is ticked to the file. Whole groups, so a
   *  half-taken quiet-hours window is not expressible. */
  take: (s: ExportedSettings) => Partial<ExportedSettings>;
};

/**
 * Every single-value setting, in the order the Options page reads.
 *
 * The three list-valued settings are deliberately absent: `watches`,
 * `blockedCompanies` and `blockedTitleKeywords` merge on their own without asking,
 * because a union is the answer for all three and a row saying "yours or theirs"
 * would force you to throw one side away to keep the other.
 */
const CHOICE_SPECS: readonly ChoiceSpec[] = [
  {
    key: "enabled",
    label: "Scanning switched on",
    group: "scanning",
    say: (s) => sayOnOff(s.enabled),
    take: (s) => ({ enabled: s.enabled }),
  },
  {
    key: "manualOnly",
    label: "Only scan when I press Scan now",
    group: "scanning",
    say: (s) => sayOnOff(s.manualOnly),
    take: (s) => ({ manualOnly: s.manualOnly }),
  },
  {
    key: "cadence",
    label: "How often it scans",
    group: "scanning",
    say: sayCadence,
    take: (s) => ({ intervalMinutes: s.intervalMinutes, jitterMinutes: s.jitterMinutes }),
  },
  {
    key: "depth",
    label: "How deep it scans",
    group: "scanning",
    say: sayDepth,
    take: (s) => ({ pagesPerScan: s.pagesPerScan, catchUpPages: s.catchUpPages }),
  },
  {
    key: "quietHours",
    label: "Quiet hours",
    group: "scanning",
    say: sayQuietHours,
    take: (s) => ({ quietHours: s.quietHours }),
  },
  {
    key: "pacing",
    label: "Pauses inside a round",
    group: "scanning",
    say: sayPacing,
    take: (s) => ({ pacing: s.pacing }),
  },
  {
    key: "backoff",
    label: "Backing off after quiet rounds",
    group: "scanning",
    say: sayBackoff,
    take: (s) => ({ backoff: s.backoff }),
  },
  {
    key: "hideReposted",
    label: "Hide reposted jobs",
    group: "filters",
    say: (s) => sayOnOff(s.hideReposted),
    take: (s) => ({ hideReposted: s.hideReposted }),
  },
  {
    key: "retention",
    label: "How long history is kept",
    group: "retention",
    say: sayRetention,
    take: (s) => ({ retention: s.retention }),
  },
  {
    key: "notifyDesktop",
    label: "Desktop notification",
    group: "notifications",
    say: (s) => sayOnOff(s.notifyDesktop),
    take: (s) => ({ notifyDesktop: s.notifyDesktop }),
  },
  {
    key: "pushEnabled",
    label: "Also push to Telegram",
    group: "notifications",
    // Only the switch. The bot token and chat id are never in a file and never in
    // a row — `mergeSettings` hands its result to `restoredSettings`, so the rule
    // that this browser's two credentials are what an import keeps still lives in
    // exactly one function.
    say: (s) => sayOnOff(s.push.enabled),
    take: (s) => ({ push: { enabled: s.push.enabled } }),
  },
  {
    key: "thresholds",
    label: "Failure thresholds",
    group: "advanced",
    say: sayThresholds,
    take: (s) => ({
      staleLockMs: s.staleLockMs,
      pushFailWarnThreshold: s.pushFailWarnThreshold,
    }),
  },
];

/**
 * The rows worth showing: every single-value setting the two sides disagree about.
 *
 * Only the differences. Twelve rows would bury the two that matter, and a row
 * offering you a choice between two identical values is a question with one
 * answer. In practice this returns two or three.
 */
export function settingChoices(mine: Settings, file: ExportedSettings): SettingChoice[] {
  const rows: SettingChoice[] = [];
  for (const spec of CHOICE_SPECS) {
    const mineSaid = spec.say(mine);
    const fileSaid = spec.say(file);
    if (mineSaid === fileSaid) continue;
    rows.push({ key: spec.key, label: spec.label, group: spec.group, mine: mineSaid, file: fileSaid });
  }
  return rows;
}

// ── Merging the lists ────────────────────────────────────────────────────────

/** LinkedIn's own click-tracking, which rides along on a URL copied out of the
 *  address bar and says nothing about what the search *is*. Compared lowercased,
 *  because the casing varies by where the link was copied from. */
const TRACKING_PARAMS = new Set([
  "trk",
  "refid",
  "trackingid",
  "origin",
  "origintolandingjobpostings",
  // Which card the split view happened to have selected when the URL was copied.
  // It names a job, not a search, and it is stale within the hour.
  "currentjobid",
]);

/**
 * Fold a saved-search URL into the thing it actually searches for.
 *
 * This exists because watch ids are `crypto.randomUUID()`, generated where the
 * watch was typed. Two browsers configured with the *same* LinkedIn search
 * therefore hold it under two different ids, and matching on id alone would
 * duplicate every watch on every merge — the failure that makes a merge feature
 * worse than no merge feature.
 *
 * An unparseable URL folds to its trimmed lowercase self rather than throwing, the
 * same way `watchUrlChips` degrades to one "URL not recognised" chip: a URL the
 * form let through is not this function's problem to reject.
 */
export function normalizeWatchUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim().toLowerCase();
  }

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  // Sorted, so the same filters pasted in a different order are the same search;
  // empty values dropped, because `&location=` is what a cleared field leaves
  // behind and it filters on nothing.
  const kept: [string, string][] = [];
  for (const [key, value] of parsed.searchParams) {
    if (value === "" || TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.push([key, value]);
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  parsed.search = "";
  for (const [key, value] of kept) parsed.searchParams.append(key, value);

  return parsed.toString();
}

/** A file watch's id → the local watch that stood in for it. See
 *  {@link mergeWatches} for why every merge produces one. */
export type WatchIdMap = Record<string, string>;

/**
 * Union the two watch lists, matching on id and then on what the URL searches for.
 *
 * **The local watch wins, verbatim** — not field by field. It is the one you have
 * been living with: the name you renamed it to, the pause you applied five minutes
 * ago. A six-month-old file overwriting either is a regression, and the honest
 * consequence is worth stating plainly rather than hiding: *a merge cannot rename
 * or re-enable a watch. That is what Replace is for.*
 *
 * The `idMap` is load-bearing, not bookkeeping. When a file's watch is dropped in
 * favour of a local one under a different id, every job in the file carrying the
 * dropped id would otherwise point at a watch that does not exist — and `selectView`
 * degrades a dangling `watchId` to a blank chip, which on a list of freshly imported
 * jobs reads as "the import lost my jobs". Exactly the failure `reconcileUi` exists
 * to prevent, one level down.
 */
export function mergeWatches(mine: Watch[], theirs: Watch[]): { watches: Watch[]; idMap: WatchIdMap } {
  const byId = new Map(mine.map((w) => [w.id, w]));
  const byUrl = new Map(mine.map((w) => [normalizeWatchUrl(w.url), w]));
  const watches = [...mine];
  const idMap: WatchIdMap = {};

  for (const incoming of theirs) {
    const url = normalizeWatchUrl(incoming.url);
    const match = byId.get(incoming.id) ?? byUrl.get(url);
    if (match) {
      if (match.id !== incoming.id) idMap[incoming.id] = match.id;
      continue;
    }
    watches.push(incoming);
    // Registered as we go, so a file that itself lists the same search twice
    // contributes it once.
    byId.set(incoming.id, incoming);
    byUrl.set(url, incoming);
  }

  return { watches, idMap };
}

/**
 * Union the two blocklists on the matching form, keeping the local spelling.
 *
 * The file's entries are **re-derived** with `makeBlockedCompany` rather than
 * trusted. §6's rule is normalize-on-write and an import is a write; a backup is
 * hand-editable by design (that is why `serializeBackup` indents), so a file can
 * carry a `normalized` that does not match its own `display`. Since this function
 * *matches* on `normalized`, deriving it is how it earns the right to compare on it.
 */
export function mergeBlockedCompanies(
  mine: BlockedCompany[],
  theirs: BlockedCompany[],
): BlockedCompany[] {
  const merged = [...mine];
  const have = new Set(mine.map((c) => c.normalized));
  for (const entry of theirs) {
    const fresh = makeBlockedCompany(entry.display);
    if (fresh.normalized === "" || have.has(fresh.normalized)) continue;
    merged.push(fresh);
    have.add(fresh.normalized);
  }
  return merged;
}

/**
 * Union the keyword lists, folded the way `isTitleBlocked` folds them at match
 * time — so "Senior" and "senior" are one entry rather than two that behave
 * identically. The fold is for *dedupe only*: the string that survives is the
 * local spelling when both sides have it, so matching behaviour is unchanged for
 * every entry that was already here.
 */
export function mergeKeywords(mine: string[], theirs: string[]): string[] {
  const merged = [...mine];
  const have = new Set(mine.map((k) => k.trim().toLowerCase()));
  for (const raw of theirs) {
    const keyword = raw.trim();
    if (keyword === "" || have.has(keyword.toLowerCase())) continue;
    merged.push(keyword);
    have.add(keyword.toLowerCase());
  }
  return merged;
}

/**
 * Union the two dedupe memories, keeping the **earlier** first-seen stamp.
 *
 * `dedupe.ts` keeps the *existing* stamp instead, and that is not a contradiction:
 * there, a scan can only ever propose `now`, so the existing one already *is* the
 * earlier one. Across two independent histories that guarantee is gone, and the
 * earlier stamp is right three times over — the field is called `firstSeenAt`;
 * `collectGarbage` prunes at `firstSeenAt + seenDays`, so the later stamp would
 * quietly renew a memory past its retention schedule; and taking the minimum makes
 * the merge commutative, which is what lets a preview computed a minute ago still
 * describe the write.
 */
export function mergeSeen(mine: SeenMap, theirs: SeenMap): SeenMap {
  const merged: SeenMap = { ...mine };
  for (const [id, firstSeenAt] of Object.entries(theirs)) {
    const have = merged[id];
    merged[id] = have === undefined ? firstSeenAt : Math.min(have, firstSeenAt);
  }
  return merged;
}

// ── Merging one job record ───────────────────────────────────────────────────

/** What `apply-prompt.tsx` already joins two quick notes with, so a merged note
 *  reads as one note and not as two run together. */
const NOTE_SEPARATOR = " · ";

/** The earlier of two moments, ignoring the ones that never happened. */
function earliest(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/** How much `postedAt` is worth on each side — see {@link PostedPrecision}. */
const PRECISION_RANK: Record<Exclude<PostedPrecision, null>, number> = {
  exact: 3,
  day: 2,
  estimated: 1,
};
const precisionRank = (p: PostedPrecision | undefined): number =>
  p === null || p === undefined ? 0 : PRECISION_RANK[p];

/**
 * Both sides' notes, kept.
 *
 * This is the one conflict rule that does not pick a winner, and it is deliberate.
 * A note is the only irreplaceable free text in the system — every other value a
 * merge discards can be re-scanned, re-derived or re-typed in seconds, and this
 * one cannot be recovered from anywhere. The README already flags "undo takes the
 * note with it" as §19's harsh edge; losing one *silently*, inside an import that
 * advertised itself as additive, would be strictly worse.
 *
 * Segments are split on the separator and de-duplicated, so importing the same
 * file twice does not double a note that was already joined once.
 */
function joinNotes(mine: string | undefined, theirs: string | undefined): string {
  const segments: string[] = [];
  for (const side of [mine ?? "", theirs ?? ""]) {
    for (const part of side.split(NOTE_SEPARATOR)) {
      const segment = part.trim();
      if (segment !== "" && !segments.includes(segment)) segments.push(segment);
    }
  }
  return segments.join(NOTE_SEPARATOR);
}

/** The fields compared to decide whether a merge actually moved a record. Listed
 *  rather than deep-compared so a field added to `Job` has to be thought about
 *  here — a new field silently excluded from the comparison would make the
 *  "already here / moved further along" split quietly wrong. */
const JOB_FIELDS = [
  "id", "title", "company", "location", "isReposted", "postedAt", "postedPrecision",
  "postedText", "linkedInStatus", "url", "foundAt", "watchId", "opened", "openedAt",
  "read", "readAt", "applied", "appliedAt", "applyNotes",
] as const satisfies readonly (keyof Job)[];

function sameJob(a: Job, b: Job): boolean {
  return JOB_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * The record that is further along, field by field.
 *
 * "Further along" means: if either side says you opened it, dismissed it or applied
 * to it, that sticks. Nothing you have already done to a posting is forgotten by an
 * import, in either direction — which is the whole reason a merge is safe to offer.
 *
 * Timestamps collapse to the **earlier** one, following §19's "first answer wins"
 * ("it records when you applied, not when you last confirmed it"). Descriptive
 * fields keep the local record's, because swapping a title under a row the user is
 * reading is churn with no benefit — with one exception: `postedAt` and
 * `postedPrecision` move together to whichever side is more precise, because that
 * pair is the one place there is an objective better, and taking the date from one
 * side and the confidence from the other would be a lie.
 *
 * Returns `mine` **by identity** when nothing moved. That is what lets the diff
 * count "already here" against "moved further along" without a second comparison,
 * and it keeps a no-op merge from rewriting every record in the store.
 */
export function furtherAlong(mine: Job, theirs: Job): Job {
  const opened = mine.opened || theirs.opened;
  const read = mine.read || theirs.read;
  const applied = mine.applied === true || theirs.applied === true;
  const takeTheirDate = precisionRank(theirs.postedPrecision) > precisionRank(mine.postedPrecision);

  const base: Job = {
    ...mine,
    opened,
    openedAt: opened ? earliest(mine.openedAt, theirs.openedAt) : null,
    read,
    readAt: read ? earliest(mine.readAt, theirs.readAt) : null,
    postedAt: takeTheirDate ? theirs.postedAt ?? null : mine.postedAt ?? null,
    postedPrecision: takeTheirDate ? theirs.postedPrecision ?? null : mine.postedPrecision ?? null,
    // `null` means the footer slot was unreadable, so any answer beats no answer.
    linkedInStatus: mine.linkedInStatus ?? theirs.linkedInStatus ?? null,
    // The direct analogue of `seen`'s `firstSeenAt`, and it keeps the collector
    // honest: `collectGarbage` measures a record's life from `foundAt`, so the
    // earlier value can never resurrect something that should have aged out.
    foundAt: Math.min(mine.foundAt, theirs.foundAt),
  };

  // The three apply fields move as a unit and are ABSENT when neither side
  // applied — §19's undo deletes all three so "never applied" leaves no residue,
  // and a merged record has to be shape-identical to one that was never touched
  // or the invariant leaks into storage.
  const { applied: _a, appliedAt: _b, applyNotes: _c, ...withoutApply } = base;
  const merged: Job = applied
    ? {
        ...withoutApply,
        applied: true,
        appliedAt: earliest(mine.appliedAt, theirs.appliedAt),
        applyNotes: joinNotes(mine.applyNotes, theirs.applyNotes),
      }
    : withoutApply;

  return sameJob(mine, merged) ? mine : merged;
}

/**
 * A record straight out of a file, brought up to the current `Job` shape.
 *
 * Three fields are optional in the backup schema — a file exported before issue
 * #48 shipped carries no `postedAt`, `postedPrecision` or `linkedInStatus` — and
 * `parseBackup` hands back a `JobsMap` that claims otherwise. Filling them here is
 * what stops an absent field reaching storage as `undefined`, where it would read
 * differently from the documented `null` ("never captured").
 *
 * The `watchId` remap is applied on the way past: see {@link mergeWatches}.
 */
function fromFile(job: Job, idMap: WatchIdMap): Job {
  return {
    ...job,
    postedAt: job.postedAt ?? null,
    postedPrecision: job.postedPrecision ?? null,
    linkedInStatus: job.linkedInStatus ?? null,
    watchId: idMap[job.watchId] ?? job.watchId,
  };
}

/** Union the two job maps on LinkedIn's job id — the only key dedupe has ever
 *  used (§5) — resolving every collision with {@link furtherAlong}. */
export function mergeImportedJobs(mine: JobsMap, theirs: JobsMap, idMap: WatchIdMap): JobsMap {
  const merged: JobsMap = { ...mine };
  for (const [id, raw] of Object.entries(theirs)) {
    const incoming = fromFile(raw, idMap);
    const have = merged[id];
    merged[id] = have === undefined ? incoming : furtherAlong(have, incoming);
  }
  return merged;
}

// ── Merging the settings ─────────────────────────────────────────────────────

/**
 * The settings a merge writes, plus the watch id remap the job merge needs.
 *
 * The two come back together because they are one decision: which watches survive
 * determines which ids the file's jobs have to be pointed at, and computing them
 * apart would let the two drift.
 *
 * The result goes through the existing `restoredSettings`, so rule 1 of `backup.ts`
 * — the two Telegram credentials never come from a file, and the ones in this
 * browser are what an import keeps — is still enforced in exactly one place.
 */
export function mergeSettings(
  mine: Settings,
  file: ExportedSettings,
  choices: SettingChoices,
): { settings: Settings; idMap: WatchIdMap } {
  const { watches, idMap } = mergeWatches(mine.watches, file.watches);

  let merged: ExportedSettings = {
    ...mine,
    push: { enabled: mine.push.enabled },
    watches,
    blockedCompanies: mergeBlockedCompanies(mine.blockedCompanies, file.blockedCompanies),
    blockedTitleKeywords: mergeKeywords(mine.blockedTitleKeywords, file.blockedTitleKeywords),
  };

  for (const spec of CHOICE_SPECS) {
    if (choices[spec.key] === "file") merged = { ...merged, ...spec.take(file) };
  }

  return { settings: restoredSettings(merged, mine), idMap };
}

// ── What changes, said in lines you can open up ──────────────────────────────

/** How many names a line will carry. A preview is not a data dump: 50 is enough
 *  to recognise what is in a file and few enough to read, and the rest is counted
 *  rather than listed. Built during the walk, not sliced afterwards — a browser
 *  holding 50,000 seen ids should not allocate 50,000 strings to show you 50. */
export const DETAIL_CAP = 50;

/** Which way a line moves. The component styles `"removed"` as the one that costs
 *  you something; `"advanced"` is the merge-only bucket for records that were
 *  already here and came back knowing more. */
export type DiffLineKind = "added" | "same" | "advanced" | "removed";

export type DiffLine = {
  kind: DiffLineKind;
  /** The whole line, ready to render: `"3 watches added"`. */
  label: string;
  count: number;
  /** Up to {@link DETAIL_CAP} of them, by the name a user would recognise. Empty
   *  for seen ids, which have no name — a line with no names is not expandable. */
  names: string[];
  /** How many more there are than `names` holds. */
  overflow: number;
};

export type DiffGroup = {
  /** The heading: "Watches", "Blocked companies", "Job history". */
  title: string;
  /**
   * Only the buckets with something in them.
   *
   * A zero is not a line. The whole job of this screen is to show what changes,
   * and "0 watches removed" is noise that makes the numbers that do matter harder
   * to find — the same omit-the-empties rule `backupPhrase` and `historyPhrase`
   * already follow. A group with no lines at all is not built either, which is
   * what lets a whole step be skipped.
   */
  lines: DiffLine[];
};

/** The raw numbers behind the lines, for the log and for what the worker reports
 *  back once it has recomputed against the state the write actually landed on. */
export type ImportCounts = {
  watchesAdded: number;
  watchesRemoved: number;
  companiesAdded: number;
  companiesRemoved: number;
  keywordsAdded: number;
  keywordsRemoved: number;
  jobsAdded: number;
  jobsAdvanced: number;
  jobsRemoved: number;
  seenAdded: number;
  seenRemoved: number;
  settingsTaken: number;
};

export type ImportDiff = {
  /** Carried on the diff rather than passed alongside it, so nothing downstream
   *  can describe a merge with a replace's step list. */
  mode: ImportMode;
  counts: ImportCounts;
  /** Watches, blocked companies, blocked keywords. */
  lists: DiffGroup[];
  /** Jobs and seen ids. */
  history: DiffGroup[];
  /** The rows to tick. Always empty under replace — everything comes from the
   *  file, so there is nothing to choose. */
  settings: SettingChoice[];
};

/** Build one line, or nothing at all when the bucket is empty. `names` is already
 *  capped by the caller; `total` is the true count. */
function line(kind: DiffLineKind, label: string, total: number, names: string[]): DiffLine | null {
  if (total === 0) return null;
  return {
    kind,
    label: `${total.toLocaleString("en-US")} ${label}`,
    count: total,
    names,
    overflow: Math.max(0, total - names.length),
  };
}

/**
 * A group, or nothing at all when it holds no change worth a screen.
 *
 * "1 watch already here" is context standing beside an addition, not a reason to
 * make someone press Next. A wizard that shows three screens of things that are
 * *not* changing teaches you to press Next without reading — which is the habit
 * this whole feature exists to break — so a group survives only if at least one of
 * its lines actually moves something. This is also what makes a re-import of a file
 * you already imported two screens long rather than five.
 */
function group(title: string, lines: (DiffLine | null)[]): DiffGroup | null {
  const kept = lines.filter((l): l is DiffLine => l !== null);
  return kept.some((l) => l.kind !== "same") ? { title, lines: kept } : null;
}

/** A bucket being filled: a count that keeps going and a name list that stops.
 *  Capped during the walk rather than sliced afterwards — a browser holding 50,000
 *  seen ids should not build 50,000 strings to show you fifty. */
type Bucket = { count: number; names: string[] };
const bucket = (): Bucket => ({ count: 0, names: [] });
function fill(b: Bucket, name: string): void {
  b.count += 1;
  if (b.names.length < DETAIL_CAP) b.names.push(name);
}

/** What a job is called on a preview line. Title alone is ambiguous across
 *  companies, and the row in the list already reads this way round. */
const jobName = (job: Job): string => `${job.title} — ${job.company}`;

// ── The plan ─────────────────────────────────────────────────────────────────

/** The three keys an import would write against. Read from storage by the worker
 *  under the lock, and snapshotted by the page for the preview. */
export type ImportTarget = { settings: Settings; seen: SeenMap; jobs: JobsMap };

export type ImportPlan = {
  diff: ImportDiff;
  settings: Settings;
  seen: SeenMap;
  jobs: JobsMap;
};

/**
 * What applying this file to this browser, this way, would produce — and what to
 * say about it first.
 *
 * The single entry point, called from both sides (rule 1). `ui` is deliberately
 * not here: it is not in the file, and `reconcileUi` in `backup.ts` already owns
 * pointing the view state at things that still exist.
 *
 * Nothing here mutates `target` or `file`.
 */
export function planImport(
  file: BackupFile,
  target: ImportTarget,
  mode: ImportMode,
  choices: SettingChoices,
): ImportPlan {
  return mode === "replace" ? planReplace(file, target) : planMerge(file, target, choices);
}

function planMerge(file: BackupFile, target: ImportTarget, choices: SettingChoices): ImportPlan {
  const { settings, idMap } = mergeSettings(target.settings, file.settings, choices);
  const seen = mergeSeen(target.seen, file.seen);
  const jobs = mergeImportedJobs(target.jobs, file.jobs, idMap);

  // ── Watches. Matched the same way the merge matched them, so "already here"
  //    means "this search survives", not "this id survives".
  const mineUrls = new Set(target.settings.watches.map((w) => normalizeWatchUrl(w.url)));
  const mineIds = new Set(target.settings.watches.map((w) => w.id));
  const watchesAdded = bucket();
  const watchesSame = bucket();
  for (const watch of file.settings.watches) {
    const known = mineIds.has(watch.id) || mineUrls.has(normalizeWatchUrl(watch.url));
    fill(known ? watchesSame : watchesAdded, watch.name);
  }

  const mineCompanies = new Set(target.settings.blockedCompanies.map((c) => c.normalized));
  const companiesAdded = bucket();
  const companiesSame = bucket();
  for (const entry of file.settings.blockedCompanies) {
    const fresh = makeBlockedCompany(entry.display);
    if (fresh.normalized === "") continue;
    fill(mineCompanies.has(fresh.normalized) ? companiesSame : companiesAdded, fresh.display);
  }

  const mineKeywords = new Set(target.settings.blockedTitleKeywords.map((k) => k.trim().toLowerCase()));
  const keywordsAdded = bucket();
  const keywordsSame = bucket();
  for (const raw of file.settings.blockedTitleKeywords) {
    const keyword = raw.trim();
    if (keyword === "") continue;
    fill(mineKeywords.has(keyword.toLowerCase()) ? keywordsSame : keywordsAdded, keyword);
  }

  // ── Jobs. `furtherAlong` returns `mine` by identity when nothing moved, so the
  //    already-merged map is all that is needed to tell "already here" from
  //    "came back knowing more".
  const jobsAdded = bucket();
  const jobsAdvanced = bucket();
  const jobsSame = bucket();
  for (const [id, incoming] of Object.entries(file.jobs)) {
    const had = target.jobs[id];
    if (had === undefined) fill(jobsAdded, jobName(incoming));
    else if (jobs[id] === had) fill(jobsSame, jobName(had));
    else fill(jobsAdvanced, jobName(had));
  }

  let seenAdded = 0;
  for (const id of Object.keys(file.seen)) if (!(id in target.seen)) seenAdded += 1;

  const settingRows = settingChoices(target.settings, file.settings);
  const counts: ImportCounts = {
    watchesAdded: watchesAdded.count,
    watchesRemoved: 0,
    companiesAdded: companiesAdded.count,
    companiesRemoved: 0,
    keywordsAdded: keywordsAdded.count,
    keywordsRemoved: 0,
    jobsAdded: jobsAdded.count,
    jobsAdvanced: jobsAdvanced.count,
    jobsRemoved: 0,
    seenAdded,
    seenRemoved: 0,
    settingsTaken: settingRows.filter((row) => choices[row.key] === "file").length,
  };

  const diff: ImportDiff = {
    mode: "merge",
    counts,
    lists: [
      group("Watches", [
        line("added", "added", watchesAdded.count, watchesAdded.names),
        line("same", "already here", watchesSame.count, watchesSame.names),
      ]),
      group("Blocked companies", [
        line("added", "added", companiesAdded.count, companiesAdded.names),
        line("same", "already here", companiesSame.count, companiesSame.names),
      ]),
      group("Blocked keywords", [
        line("added", "added", keywordsAdded.count, keywordsAdded.names),
        line("same", "already here", keywordsSame.count, keywordsSame.names),
      ]),
    ].filter((g): g is DiffGroup => g !== null),
    history: [
      group("Jobs", [
        line("added", "new", jobsAdded.count, jobsAdded.names),
        line("advanced", "already here, further along in the file", jobsAdvanced.count, jobsAdvanced.names),
        line("same", "already here, unchanged", jobsSame.count, jobsSame.names),
      ]),
      group("Seen ids", [line("added", "added", seenAdded, [])]),
    ].filter((g): g is DiffGroup => g !== null),
    settings: settingRows,
  };

  return { diff, settings, seen, jobs };
}

function planReplace(file: BackupFile, target: ImportTarget): ImportPlan {
  const settings = restoredSettings(file.settings, target.settings);

  const mineUrls = new Set(target.settings.watches.map((w) => normalizeWatchUrl(w.url)));
  const mineIds = new Set(target.settings.watches.map((w) => w.id));
  const fileUrls = new Set(file.settings.watches.map((w) => normalizeWatchUrl(w.url)));
  const fileIds = new Set(file.settings.watches.map((w) => w.id));
  const watchesAdded = bucket();
  const watchesKept = bucket();
  const watchesRemoved = bucket();
  for (const watch of file.settings.watches) {
    const known = mineIds.has(watch.id) || mineUrls.has(normalizeWatchUrl(watch.url));
    fill(known ? watchesKept : watchesAdded, watch.name);
  }
  for (const watch of target.settings.watches) {
    if (!fileIds.has(watch.id) && !fileUrls.has(normalizeWatchUrl(watch.url))) {
      fill(watchesRemoved, watch.name);
    }
  }

  const mineCompanies = new Set(target.settings.blockedCompanies.map((c) => c.normalized));
  const fileCompanies = new Set(file.settings.blockedCompanies.map((c) => c.normalized));
  const companiesAdded = bucket();
  const companiesKept = bucket();
  const companiesRemoved = bucket();
  for (const entry of file.settings.blockedCompanies) {
    fill(mineCompanies.has(entry.normalized) ? companiesKept : companiesAdded, entry.display);
  }
  for (const entry of target.settings.blockedCompanies) {
    if (!fileCompanies.has(entry.normalized)) fill(companiesRemoved, entry.display);
  }

  const fold = (k: string): string => k.trim().toLowerCase();
  const mineKeywords = new Set(target.settings.blockedTitleKeywords.map(fold));
  const fileKeywords = new Set(file.settings.blockedTitleKeywords.map(fold));
  const keywordsAdded = bucket();
  const keywordsKept = bucket();
  const keywordsRemoved = bucket();
  for (const keyword of file.settings.blockedTitleKeywords) {
    fill(mineKeywords.has(fold(keyword)) ? keywordsKept : keywordsAdded, keyword);
  }
  for (const keyword of target.settings.blockedTitleKeywords) {
    if (!fileKeywords.has(fold(keyword))) fill(keywordsRemoved, keyword);
  }

  const jobsAdded = bucket();
  const jobsKept = bucket();
  const jobsRemoved = bucket();
  for (const [id, incoming] of Object.entries(file.jobs)) {
    fill(id in target.jobs ? jobsKept : jobsAdded, jobName(incoming));
  }
  for (const [id, had] of Object.entries(target.jobs)) {
    if (!(id in file.jobs)) fill(jobsRemoved, jobName(had));
  }

  let seenAdded = 0;
  let seenRemoved = 0;
  for (const id of Object.keys(file.seen)) if (!(id in target.seen)) seenAdded += 1;
  for (const id of Object.keys(target.seen)) if (!(id in file.seen)) seenRemoved += 1;

  const counts: ImportCounts = {
    watchesAdded: watchesAdded.count,
    watchesRemoved: watchesRemoved.count,
    companiesAdded: companiesAdded.count,
    companiesRemoved: companiesRemoved.count,
    keywordsAdded: keywordsAdded.count,
    keywordsRemoved: keywordsRemoved.count,
    jobsAdded: jobsAdded.count,
    jobsAdvanced: 0,
    jobsRemoved: jobsRemoved.count,
    seenAdded,
    seenRemoved,
    settingsTaken: settingChoices(target.settings, file.settings).length,
  };

  const diff: ImportDiff = {
    mode: "replace",
    counts,
    lists: [
      group("Watches", [
        line("added", "added", watchesAdded.count, watchesAdded.names),
        line("same", "kept", watchesKept.count, watchesKept.names),
        line("removed", "removed", watchesRemoved.count, watchesRemoved.names),
      ]),
      group("Blocked companies", [
        line("added", "added", companiesAdded.count, companiesAdded.names),
        line("same", "kept", companiesKept.count, companiesKept.names),
        line("removed", "removed", companiesRemoved.count, companiesRemoved.names),
      ]),
      group("Blocked keywords", [
        line("added", "added", keywordsAdded.count, keywordsAdded.names),
        line("same", "kept", keywordsKept.count, keywordsKept.names),
        line("removed", "removed", keywordsRemoved.count, keywordsRemoved.names),
      ]),
    ].filter((g): g is DiffGroup => g !== null),
    history: [
      group("Jobs", [
        line("added", "new", jobsAdded.count, jobsAdded.names),
        line("same", "kept", jobsKept.count, jobsKept.names),
        line("removed", "removed", jobsRemoved.count, jobsRemoved.names),
      ]),
      group("Seen ids", [
        line("added", "added", seenAdded, []),
        line("removed", "removed", seenRemoved, []),
      ]),
    ].filter((g): g is DiffGroup => g !== null),
    // Nothing to tick: replace takes every setting from the file by definition.
    settings: [],
  };

  return { diff, settings, seen: file.seen, jobs: file.jobs };
}

// ── The steps ────────────────────────────────────────────────────────────────

export type ImportStep = "mode" | "settings" | "lists" | "history" | "confirm";

/**
 * Which screens this particular file, applied this particular way, actually needs.
 *
 * A step with nothing on it is skipped, because a wizard that makes you press Next
 * past three empty screens teaches you to press Next without reading — which is the
 * habit this whole feature exists to break.
 *
 * Two steps are never skipped: `mode`, because every later screen's content depends
 * on the answer, and `confirm`, because that is the only screen that writes.
 *
 * Replace skips only `settings` — there is nothing to tick when every value comes
 * from the file. It keeps `lists` and `history` even when they only hold removals;
 * *especially* then, because the removals are the thing the old one-shot dialog
 * never told anyone, and showing them is Replace's whole justification for surviving.
 */
export function importSteps(diff: ImportDiff): ImportStep[] {
  const steps: ImportStep[] = ["mode"];
  if (diff.settings.length > 0) steps.push("settings");
  if (diff.lists.length > 0) steps.push("lists");
  if (diff.history.length > 0) steps.push("history");
  steps.push("confirm");
  return steps;
}

export function stepAfter(steps: ImportStep[], current: ImportStep): ImportStep | null {
  return steps[steps.indexOf(current) + 1] ?? null;
}

export function stepBefore(steps: ImportStep[], current: ImportStep): ImportStep | null {
  const at = steps.indexOf(current);
  return at > 0 ? steps[at - 1]! : null;
}

export function stepTitle(step: ImportStep, mode: ImportMode): string {
  switch (step) {
    case "mode":
      return "How should this file be applied?";
    case "settings":
      return "Settings you and the file disagree about";
    case "lists":
      return mode === "replace" ? "Watches and filters after replacing" : "Watches and filters after merging";
    case "history":
      return mode === "replace" ? "Job history after replacing" : "Job history after merging";
    case "confirm":
      return mode === "replace" ? "Ready to replace" : "Ready to merge";
  }
}

/** The button that writes. Named for what it does rather than "OK", because it is
 *  the last thing read before something irreversible. */
export const confirmLabel = (mode: ImportMode): string =>
  mode === "replace" ? "Replace everything" : "Merge the file in";

/** True when a merge would write nothing new at all — the file is already inside
 *  this browser. Worth saying out loud rather than letting the user press Import
 *  and see no change. */
export function isNoOp(diff: ImportDiff): boolean {
  const c = diff.counts;
  return (
    diff.mode === "merge" &&
    c.watchesAdded === 0 &&
    c.companiesAdded === 0 &&
    c.keywordsAdded === 0 &&
    c.jobsAdded === 0 &&
    c.jobsAdvanced === 0 &&
    c.seenAdded === 0 &&
    c.settingsTaken === 0
  );
}

/** Counts said out loud, empty categories left out: `"3 watches, 12 blocked
 *  companies and 48 jobs"`. Empty overall reads as "nothing". */
function phrase(parts: string[]): string {
  const last = parts.pop();
  if (last === undefined) return "nothing";
  return parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
}

/** What is about to be added, in words. */
function addedPhrase(c: ImportCounts): string {
  const parts: string[] = [];
  if (c.watchesAdded > 0) parts.push(plural(c.watchesAdded, "watch", "watches"));
  if (c.companiesAdded > 0) parts.push(plural(c.companiesAdded, "blocked company", "blocked companies"));
  if (c.keywordsAdded > 0) parts.push(plural(c.keywordsAdded, "blocked keyword"));
  if (c.jobsAdded > 0) parts.push(plural(c.jobsAdded, "job"));
  if (c.seenAdded > 0) parts.push(plural(c.seenAdded, "seen id"));
  return phrase(parts);
}

/** What is about to go. Replace only — a merge never removes anything. */
function removedPhrase(c: ImportCounts): string {
  const parts: string[] = [];
  if (c.watchesRemoved > 0) parts.push(plural(c.watchesRemoved, "watch", "watches"));
  if (c.companiesRemoved > 0) parts.push(plural(c.companiesRemoved, "blocked company", "blocked companies"));
  if (c.keywordsRemoved > 0) parts.push(plural(c.keywordsRemoved, "blocked keyword"));
  if (c.jobsRemoved > 0) parts.push(plural(c.jobsRemoved, "job"));
  if (c.seenRemoved > 0) parts.push(plural(c.seenRemoved, "seen id"));
  return phrase(parts);
}

/**
 * The one sentence on the confirm step: exactly what the button is about to do.
 *
 * It names the removals first under replace, because that is the part with no undo
 * and the part a person skims past. Under merge it says outright that nothing is
 * removed — the reassurance is the whole reason the mode exists.
 */
export function confirmSentence(diff: ImportDiff): string {
  const c = diff.counts;
  if (diff.mode === "replace") {
    const removed = removedPhrase(c);
    const gone = removed === "nothing" ? "Nothing here is removed" : `${removed} here will be removed`;
    return `${gone}, and this browser is left holding exactly what the file holds — ${addedPhrase(c)} added. There is no undo. Your Telegram bot token and chat id are kept, because a backup never contains them.`;
  }
  if (isNoOp(diff)) {
    return "This file adds nothing you do not already have. Importing it changes nothing — switch to Replace on the first step if what you wanted was to remove something.";
  }
  const taken = c.settingsTaken > 0 ? ` ${plural(c.settingsTaken, "setting")} will be taken from the file.` : "";
  const advanced =
    c.jobsAdvanced > 0
      ? ` ${plural(c.jobsAdvanced, "job")} already here will keep whichever of the two records is further along.`
      : "";
  return `${addedPhrase(c)} will be added, and nothing is removed.${taken}${advanced} Your Telegram bot token and chat id are untouched.`;
}

/** What was actually written, for the status line and the worker's log. Built from
 *  the *recomputed* counts, so it reports what happened rather than what the
 *  preview promised a minute earlier. */
export function importedPhrase(counts: ImportCounts, mode: ImportMode): string {
  if (mode === "replace") {
    const removed = removedPhrase(counts);
    return removed === "nothing"
      ? `replaced with ${addedPhrase(counts)}`
      : `replaced with ${addedPhrase(counts)}, removing ${removed}`;
  }
  const added = addedPhrase(counts);
  const advanced =
    counts.jobsAdvanced > 0 ? `, ${plural(counts.jobsAdvanced, "job")} moved further along` : "";
  const taken = counts.settingsTaken > 0 ? `, ${plural(counts.settingsTaken, "setting")} taken from the file` : "";
  return added === "nothing" && advanced === "" && taken === ""
    ? "merged, and nothing changed"
    : `merged — ${added} added${advanced}${taken}`;
}

// ── The page asking the worker to import ─────────────────────────────────────

/**
 * The options page handing a validated file, and the two decisions made about it,
 * to the worker.
 *
 * It goes through the worker for the reason "Delete all job history" does: an
 * import writes `seen` and `jobs`, and the scan lock is what serialises access to
 * those two keys. Only the worker holds it.
 *
 * What travels is the file plus the **decisions**, never a computed result — see
 * rule 2 at the top of this module. The worker re-reads storage under the lock and
 * calls {@link planImport} itself, so the write is a function of the state it is
 * actually landing on rather than of the snapshot the preview happened to see.
 */
export type ImportBackupRequest = {
  type: "LJW_IMPORT";
  backup: BackupFile;
  mode: ImportMode;
  /** Read only under merge; `{}` is the common case (see {@link SettingChoices}). */
  choices: SettingChoices;
};

/** What was imported, or why nothing was. `scanning` is the one refusal, and it is
 *  the honest answer rather than an import that half-survives a cycle. The counts
 *  are the recomputed ones. */
export type ImportBackupResponse =
  | { imported: true; mode: ImportMode; counts: ImportCounts }
  | { imported: false; reason: "scanning" | "failed" };
