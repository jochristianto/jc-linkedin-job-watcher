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
import { OK_HEALTH } from "./health.ts";
import type { SeenMap } from "./dedupe.ts";

/** `jobId → full Job record` — the `jobs` key of §6 (feeds the list view). */
export type JobsMap = Record<string, Job>;

/** The five §6 top-level keys and the shape each holds. */
export type StorageShape = {
  settings: Settings;
  seen: SeenMap;
  jobs: JobsMap;
  scanState: ScanState;
  health: HealthState;
};

/** The documented default each key returns when it is missing (§5/§16/§17). */
const DEFAULTS: StorageShape = {
  settings: DEFAULT_SETTINGS,
  seen: {},
  jobs: {},
  scanState: IDLE_LIFECYCLE,
  health: OK_HEALTH,
};

/**
 * Read one key. Returns a fresh copy of the documented default when the key has
 * never been written, so callers never accidentally mutate the shared default.
 */
export async function get<K extends keyof StorageShape>(key: K): Promise<StorageShape[K]> {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key] as StorageShape[K] | undefined;
  return value ?? structuredClone(DEFAULTS[key]);
}

/** Write one key. Only this key's slot is rewritten (§6 "separate top-level keys"). */
export async function set<K extends keyof StorageShape>(key: K, value: StorageShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}
