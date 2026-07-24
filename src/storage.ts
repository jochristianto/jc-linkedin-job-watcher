// Storage — PRD §6. The single thin wrapper over `chrome.storage.local`: this is
// the *only* module in the codebase that touches `chrome.storage`. Everything
// else reads and writes through the typed `get`/`set` below, so the five §6
// top-level keys (`settings`, `seen`, `jobs`, `scanState`, `health`) have one
// home and one set of missing-key defaults.
//
// This is a §14 side-effect wrapper, not pure logic: it calls a browser API, so
// it is not unit-tested. The decision logic it serves — telling new from old —
// lives testable in `dedupe.ts`. `unlimitedStorage` (§6/§10) lifts the local cap.

import { DEFAULT_SETTINGS, type Settings, type Job, type ScanState, type HealthState } from "./types.ts";
import { IDLE_LIFECYCLE } from "./lifecycle.ts";
import { OK_HEALTH, OK_PUSH_HEALTH, type PushHealthState } from "./health.ts";
import type { SeenMap } from "./dedupe.ts";
import type { ListMode } from "./view-model.ts";

/** `jobId → full Job record` — the `jobs` key of §6 (feeds the list view). */
export type JobsMap = Record<string, Job>;

/**
 * The persisted list-view UI state (mockups decision 4): which watch chip is
 * active and which New/All mode is showing. Restored when the popup reopens so
 * you land back where you left off. `activeWatchId` null = "All watches"; `mode`
 * null = "use the view's default" (New for the popup, All for the tab) — it
 * becomes concrete the first time the user toggles it.
 */
export type UiState = {
  activeWatchId: string | null;
  mode: ListMode | null;
  /** The job whose "Did you apply for this job?" question is still unanswered, or
   *  null when nothing is pending.
   *
   *  It is persisted rather than held in component state because clicking a row
   *  opens LinkedIn in a focused tab — and *that closes the popup*, which would
   *  take the question with it. Stored, the popup asks the next time it is opened
   *  and the jobs tab asks as soon as you come back to it, which is also the only
   *  moment the answer can be known. One id, not a list: a second click replaces
   *  the first, the same way only one row's Block button can be mid-question.
   *
   *  Optional because `ui` records written before this shipped have no such field;
   *  absent reads as "nothing pending". */
  pendingApplyId?: string | null;
};

/** The unset UI state — no chip filter, no chosen mode (each view uses its own
 *  default until the user picks one), no question waiting to be answered. */
export const DEFAULT_UI: UiState = { activeWatchId: null, mode: null, pendingApplyId: null };

/** The §6 top-level keys and the shape each holds. `pushHealth` (§16.7) tracks
 *  consecutive Telegram-push failures separately from scan `health`; `ui` holds
 *  the popup's last chip + mode (mockups decision 4). */
export type StorageShape = {
  settings: Settings;
  seen: SeenMap;
  jobs: JobsMap;
  scanState: ScanState;
  health: HealthState;
  pushHealth: PushHealthState;
  ui: UiState;
};

/** The documented default each key returns when it is missing (§5/§16/§17). */
const DEFAULTS: StorageShape = {
  settings: DEFAULT_SETTINGS,
  seen: {},
  jobs: {},
  scanState: IDLE_LIFECYCLE,
  health: OK_HEALTH,
  pushHealth: OK_PUSH_HEALTH,
  ui: DEFAULT_UI,
};

/**
 * Bring `jobs` records written by an older build up to the current `Job` shape.
 *
 * `read`/`readAt` were added when opening a job and dismissing it became two
 * separate actions. Records written before that have neither field, and TypeScript
 * can't know it — the store is whatever the last version left there. A missing
 * `read` is filled in from `opened`, because back then clicking a job *was*
 * dismissing it: that keeps the list looking exactly as the user left it instead
 * of resurrecting every job they already dealt with back into "New".
 *
 * In-memory only, and idempotent — the migrated shape lands in storage the next
 * time anything writes the key.
 */
export function migrateJobs(jobs: JobsMap): JobsMap {
  let changed = false;
  const next: JobsMap = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (typeof job.read === "boolean") {
      next[id] = job;
    } else {
      next[id] = { ...job, read: job.opened, readAt: job.openedAt };
      changed = true;
    }
  }
  return changed ? next : jobs;
}

/**
 * Read one key. Returns a fresh copy of the documented default when the key has
 * never been written, so callers never accidentally mutate the shared default.
 */
export async function get<K extends keyof StorageShape>(key: K): Promise<StorageShape[K]> {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key] as StorageShape[K] | undefined;
  if (value === undefined) return structuredClone(DEFAULTS[key]);
  // The one shape that has outlived a field change; every other key is read as-is.
  if (key === "jobs") return migrateJobs(value as JobsMap) as StorageShape[K];
  return value;
}

/** Write one key. Only this key's slot is rewritten (§6 "separate top-level keys"). */
export async function set<K extends keyof StorageShape>(key: K, value: StorageShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}
