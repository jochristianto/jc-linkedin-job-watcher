// Backup — exporting the whole configuration to a JSON file, and reading one
// back. The pure half (§14): what goes in the file, what the file is allowed to
// contain, and what importing one turns the stored keys into. No chrome.*, no
// DOM, no clock read (the caller passes `exportedAt`), so `node --test` proves
// every rule here with plain values. The two thin wrappers are the Backup card in
// `options-page.tsx` (which downloads and reads files) and the `LJW_IMPORT`
// handler in `background.ts` (which holds the scan lock and writes the keys).
//
// Three rules shape the whole module:
//
//   1. **The two secrets never leave the browser.** `Settings.push` carries a
//      Telegram bot token and a chat id, and a backup is a file that gets emailed
//      to yourself, dropped in a synced folder and pasted into an issue. The
//      exported shape is `Settings` with those two fields *structurally absent*
//      (see {@link ExportedSettings}) rather than blanked, so leaving them out is
//      something the type system enforces rather than something this file
//      remembers to do.
//
//   2. **All or nothing.** A file is validated in full before a single key is
//      written; one bad field means nothing is written and the message names it.
//      A half-restored install — new watches against old seen ids — is the one
//      outcome worse than a failed import, because nothing tells you it happened.
//
//   3. **Replace, don't merge.** An import is a restore: what the file says
//      becomes the state. Merging blocklists and watches sounds friendlier right
//      up to the point where you cannot use a backup to *remove* the entry you
//      took the backup to get rid of.

import { z } from "zod";
import type { JobsMap, UiState } from "./storage.ts";
import type { SeenMap } from "./dedupe.ts";
import type { Settings, Watch } from "./types.ts";

/** What the file says it is. Checked before anything else, so pointing the import
 *  at the wrong JSON file fails with "that isn't a backup" rather than with a
 *  list of missing fields. */
export const BACKUP_KIND = "linkedin-job-watcher-backup";

/** The format version. Bumped whenever a change would make an older build
 *  misread a newer file — an added optional field does not need it; a renamed or
 *  re-typed one does. {@link parseBackup} refuses anything it is not. */
export const BACKUP_VERSION = 1;

// ── What the file holds ──────────────────────────────────────────────────────

/**
 * `Settings` as it appears in a backup: everything, minus the two Telegram
 * secrets.
 *
 * `push.enabled` stays — it is a preference, not a credential, and dropping it
 * would mean the file could not round-trip a switch the settings page shows. The
 * token and chat id are removed at the type level, so `buildBackup` cannot
 * accidentally spread them through and a future field added to `PushConfig` has
 * to be opted into here before it can ship in a file.
 */
export type ExportedSettings = Omit<Settings, "push"> & {
  push: { enabled: boolean };
};

/**
 * The file itself.
 *
 * `exportedAt` and `extensionVersion` are informational — nothing reads them back
 * — but a backup found in a downloads folder six months later is unusable without
 * them, and they cost two lines.
 */
export type BackupFile = {
  kind: typeof BACKUP_KIND;
  version: number;
  /** ISO 8601, in UTC. */
  exportedAt: string;
  /** `chrome.runtime.getManifest().version` at the time of export. */
  extensionVersion: string;
  settings: ExportedSettings;
  /** The dedupe memory (§6) — `jobId → firstSeenAt`. The reason a restored
   *  install does not re-announce every posting still live on LinkedIn. */
  seen: SeenMap;
  /** The full job records, including `opened`/`read`/`applied` and any notes
   *  typed against them. */
  jobs: JobsMap;
};

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Build the file's contents from the three stored keys.
 *
 * The push secrets are dropped here and nowhere else. `settings` is destructured
 * rather than spread-and-deleted so the omission survives a field being added to
 * `Settings` later: a new field lands in `rest` and ships, a new *credential*
 * field is a type error in `ExportedSettings` until someone decides about it.
 */
export function buildBackup(input: {
  settings: Settings;
  seen: SeenMap;
  jobs: JobsMap;
  exportedAt: number;
  extensionVersion: string;
}): BackupFile {
  const { push, ...rest } = input.settings;
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date(input.exportedAt).toISOString(),
    extensionVersion: input.extensionVersion,
    settings: { ...rest, push: { enabled: push.enabled } },
    seen: input.seen,
    jobs: input.jobs,
  };
}

/** The file's text. Indented rather than minified: the point of choosing JSON
 *  over an opaque blob is that the file can be opened, read and hand-edited, and
 *  a single 400KB line is none of those things. */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** What the download is called: `linkedin-job-watcher-backup-2026-07-30.json`.
 *  Dated, because the first thing you want from a folder of these is the newest;
 *  sortable, because the second thing you want is them in order. */
export function backupFilename(exportedAt: number): string {
  const date = new Date(exportedAt).toISOString().slice(0, 10);
  return `linkedin-job-watcher-backup-${date}.json`;
}

// ── What a file is allowed to contain ────────────────────────────────────────
//
// Written out in full rather than derived from the types: a schema is what stops
// a truncated download or a hand-edit from becoming stored state, and one
// inferred from `Settings` would accept whatever `Settings` happened to be.

const watchSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.url(),
  enabled: z.boolean(),
});

const blockedCompanySchema = z.object({
  display: z.string(),
  normalized: z.string(),
});

/** A `[min, max]` pause range, in milliseconds. */
const pauseRangeSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

/** Minute-of-day, as quiet hours are stored (§15). */
const minuteOfDaySchema = z.number().int().min(0).max(1439);

const jobSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  isReposted: z.boolean(),
  postedText: z.string(),
  url: z.string(),
  foundAt: z.number(),
  watchId: z.string(),
  opened: z.boolean(),
  openedAt: z.number().nullable(),
  read: z.boolean(),
  readAt: z.number().nullable(),
  // The three that a record written before "Did you apply?" shipped does not
  // carry (§5) — absent reads as "never applied", exactly as it does in storage.
  applied: z.boolean().optional(),
  appliedAt: z.number().nullable().optional(),
  applyNotes: z.string().optional(),
});

const exportedSettingsSchema = z.object({
  enabled: z.boolean(),
  manualOnly: z.boolean(),
  watches: z.array(watchSchema),
  blockedCompanies: z.array(blockedCompanySchema),
  blockedTitleKeywords: z.array(z.string()),
  hideReposted: z.boolean(),
  intervalMinutes: z.number().int().min(1),
  jitterMinutes: z.number().int().min(0),
  pagesPerScan: z.number().int().min(1),
  catchUpPages: z.number().int().min(1),
  quietHours: z.object({
    enabled: z.boolean(),
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
  }),
  notifyDesktop: z.boolean(),
  pacing: z.object({
    pagePauseMs: pauseRangeSchema,
    watchPauseMs: pauseRangeSchema,
  }),
  backoff: z.object({
    emptyScansBeforeBackoff: z.number().int().min(1),
    maxIntervalMinutes: z.number().int().min(1),
  }),
  retention: z.object({
    seenDays: z.number().int().min(1),
    openedJobDays: z.number().int().min(1),
    unopenedJobDays: z.number().int().min(1),
    seenHardCap: z.number().int().min(1),
  }),
  // The toggle only. A file carrying a `botToken` or a `chatId` is a file some
  // other tool wrote; the keys are stripped rather than rejected, and the two
  // credentials in this browser are what an import keeps (see {@link restoredSettings}).
  push: z.object({ enabled: z.boolean() }),
  staleLockMs: z.number().int().min(1),
  pushFailWarnThreshold: z.number().int().min(1),
});

const backupSchema = z.object({
  kind: z.literal(BACKUP_KIND),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string(),
  extensionVersion: z.string(),
  settings: exportedSettingsSchema,
  seen: z.record(z.string(), z.number()),
  jobs: z.record(z.string(), jobSchema),
});

// ── Reading a file back ──────────────────────────────────────────────────────

export type ParseBackupResult =
  | { ok: true; backup: BackupFile }
  | { ok: false; error: string };

/** The first thing zod objected to, as a sentence naming the field: `settings.
 *  intervalMinutes: Too small: expected number to be >=1`. One issue rather than
 *  all of them — a truncated file produces dozens, and the first is the one worth
 *  reading. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "the file did not match the expected shape";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Turn a file's text into a `BackupFile`, or say why it isn't one.
 *
 * The three cheap checks come first and in this order, because each produces a
 * message the user can act on where the schema would only produce a heap of
 * missing fields: not JSON at all, JSON that isn't one of ours, and one of ours
 * from a version this build does not read.
 *
 * Nothing here writes, and nothing partially succeeds — a caller either gets a
 * whole valid file or a reason.
 */
export function parseBackup(text: string): ParseBackupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn’t valid JSON." };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "That file doesn’t contain a backup." };
  }

  const record = raw as Record<string, unknown>;
  if (record.kind !== BACKUP_KIND) {
    return {
      ok: false,
      error: "That file isn’t a LinkedIn Job Watcher backup.",
    };
  }
  if (record.version !== BACKUP_VERSION) {
    const found = typeof record.version === "number" ? `v${record.version}` : "an unknown version";
    return {
      ok: false,
      error: `That backup is ${found}; this build reads v${BACKUP_VERSION} files.`,
    };
  }

  const result = backupSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: `The backup is damaged — ${firstIssue(result.error)}.` };
  }
  return { ok: true, backup: result.data as BackupFile };
}

// ── What importing one turns the stored keys into ────────────────────────────

/**
 * The settings an import writes: the file's, with this browser's Telegram
 * credentials carried through untouched.
 *
 * The file cannot contain them (rule 1), so they have to come from somewhere, and
 * "the ones already here" is the only answer that neither invents a secret nor
 * destroys one. The consequence is worth stating plainly: restoring a backup onto
 * a *fresh* browser can switch `push.enabled` on with no token behind it. That is
 * left as it is deliberately — the alternative is silently overriding a
 * preference the file explicitly recorded, and the extension already handles the
 * case, because `firePush` skips an unconfigured push and the §16.7 banner says
 * why.
 */
export function restoredSettings(exported: ExportedSettings, current: Settings): Settings {
  return {
    ...exported,
    push: {
      enabled: exported.push.enabled,
      botToken: current.push.botToken,
      chatId: current.push.chatId,
    },
  };
}

/**
 * Point the view state at things that still exist.
 *
 * `ui` is not in the file — it is about this browser's current moment, not about
 * the configuration — but a wholesale replacement of `watches` and `jobs` can
 * leave it pointing at neither. A dangling `activeWatchId` shows the list filtered
 * to a chip that is no longer there, which reads as "the import lost my jobs"; a
 * dangling `pendingApplyId` leaves "Did you apply for this job?" hanging over a
 * record that no longer exists, the same reason `clearHistory` nulls it.
 *
 * `mode` survives: New-vs-All is about the page, and every possible value of it
 * stays meaningful whatever was imported.
 */
export function reconcileUi(ui: UiState, jobs: JobsMap, watches: Watch[]): UiState {
  const watchExists = ui.activeWatchId !== null && watches.some((w) => w.id === ui.activeWatchId);
  const jobExists =
    ui.pendingApplyId !== null && ui.pendingApplyId !== undefined && ui.pendingApplyId in jobs;
  return {
    ...ui,
    activeWatchId: watchExists ? ui.activeWatchId : null,
    pendingApplyId: jobExists ? ui.pendingApplyId : null,
  };
}

// ── Saying what is in a file ─────────────────────────────────────────────────

/** What a backup holds, per thing a user would recognise. */
export type BackupCounts = {
  watches: number;
  blockedCompanies: number;
  blockedTitleKeywords: number;
  jobs: number;
  seen: number;
};

export function backupCounts(backup: BackupFile): BackupCounts {
  return {
    watches: backup.settings.watches.length,
    blockedCompanies: backup.settings.blockedCompanies.length,
    blockedTitleKeywords: backup.settings.blockedTitleKeywords.length,
    jobs: Object.keys(backup.jobs).length,
    seen: Object.keys(backup.seen).length,
  };
}

/** `n` of a thing, pluralised, with thousands separated. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

/**
 * A backup's contents said out loud: `"4 watches, 12 blocked companies, 128 jobs
 * and 4,301 seen ids"`.
 *
 * The import dialog asks you to replace everything you have, and "replace your
 * settings?" asks you to confirm against a quantity you have not been told. Empty
 * categories are left out rather than reported as `0`, the same rule
 * `historyPhrase` follows, so the sentence only mentions things that are actually
 * in the file.
 */
export function backupPhrase(counts: BackupCounts): string {
  const parts: string[] = [];
  if (counts.watches > 0) parts.push(count(counts.watches, "watch", "watches"));
  if (counts.blockedCompanies > 0) {
    parts.push(count(counts.blockedCompanies, "blocked company", "blocked companies"));
  }
  if (counts.blockedTitleKeywords > 0) {
    parts.push(count(counts.blockedTitleKeywords, "blocked keyword"));
  }
  if (counts.jobs > 0) parts.push(count(counts.jobs, "job"));
  if (counts.seen > 0) parts.push(count(counts.seen, "seen id"));

  const last = parts.pop();
  if (last === undefined) return "no watches, filters or job history";
  return parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
}

// ── The page asking the worker to import ─────────────────────────────────────

/**
 * The options page handing a validated file to the worker.
 *
 * It goes through the worker for the reason "Delete all job history" does: an
 * import writes `seen` and `jobs`, and the scan lock is what serialises access to
 * those two keys. A page that wrote them itself could land inside a cycle's
 * read-dedupe-write tail and have the imported ids overwritten by the cycle's —
 * which would silently re-announce every restored posting. Only the worker holds
 * the lock.
 *
 * The whole validated file travels rather than a filename: parsing happens on the
 * page, where the file was read and where an error has somewhere to be shown, so
 * the worker only ever receives something already known to be well-formed.
 */
export type ImportBackupRequest = { type: "LJW_IMPORT"; backup: BackupFile };

/** What was imported, or why nothing was. `scanning` is the one refusal, and it
 *  is the honest answer rather than an import that half-survives a cycle. */
export type ImportBackupResponse =
  | { imported: true; counts: BackupCounts }
  | { imported: false; reason: "scanning" | "failed" };
