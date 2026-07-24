// Shared data shapes — PRD §5, the single home for every type the extension's
// side-effect wrappers (background.ts, content.ts, the pages) pass around.
//
// The prefactor rule (ticket 01): a shape lives in exactly one place. Types that
// already exist inside a tested pure module are RE-EXPORTED here, not redefined —
// `schedule.ts` owns QuietHours/BackoffConfig, `health.ts` owns HealthState,
// `push.ts` owns PushConfig. Everything else in §5 is defined here.

// ── Re-exports: one source of truth per shape (do not redefine below) ────────
export type { QuietHours, BackoffConfig } from "./schedule.ts";
export type { HealthState } from "./health.ts";
export type { PushConfig } from "./push.ts";

import type { QuietHours, BackoffConfig } from "./schedule.ts";
import type { PushConfig } from "./push.ts";

// ── Shapes defined here (PRD §5) ─────────────────────────────────────────────

export type Job = {
  id: string; // LinkedIn's job ID from the URL
  title: string;
  company: string;
  location: string;
  isReposted: boolean;
  postedText: string; // "2 hours ago"
  url: string;
  foundAt: number;
  watchId: string; // which saved search surfaced it
  // `opened` and `read` are two different things, and keeping them apart is the
  // whole point of the row's two states. Opening a job is *looking* at it: the
  // row stays in the list, highlighted, because clicking a title you then want
  // to come back to should not make it vanish. Marking it read is *dismissing*
  // it: only that drops it out of "New" and off the badge, and only the row's
  // own tick button does it.
  opened: boolean;
  openedAt: number | null;
  read: boolean;
  readAt: number | null;
};

export type Watch = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
};

export type BlockedCompany = {
  display: string; // "Acme Corp" — what the options UI shows
  normalized: string; // "acme corp" — what matching uses
};

export type PacingConfig = {
  pagePauseMs: [number, number]; // default [3000, 5000] — pause between pages (§9)
  watchPauseMs: [number, number]; // default [8000, 12000] — pause between watches
};

export type RetentionConfig = {
  seenDays: number; // default 15
  openedJobDays: number; // default 7
  unopenedJobDays: number; // default 30
  seenHardCap: number; // default 50_000
};

export type Settings = {
  watches: Watch[];
  blockedCompanies: BlockedCompany[];
  blockedTitleKeywords: string[];
  hideReposted: boolean;
  intervalMinutes: number; // default 5
  jitterMinutes: number; // default 1 — ±this, randomised onto each interval (§15)
  pagesPerScan: number; // default 1 — routine depth (§15); page 2 is mostly stale
  catchUpPages: number; // default 4, used on startup and quiet-hours resume (§9/§15)
  quietHours: QuietHours;
  pacing: PacingConfig;
  backoff: BackoffConfig;
  retention: RetentionConfig;
  push: PushConfig;
  staleLockMs: number; // default 300_000 (5 min) — lock older than this is stale (§16)
  pushFailWarnThreshold: number; // default 3 — consecutive push failures before warning (§16)
};

export type ScanState = {
  isScanning: boolean;
  startedAt: number | null;
  openTabIds: number[]; // tabs the live cycle has open, for orphan cleanup (§17.2)
  pendingCatchUp: boolean; // next scan runs at catchUpPages depth (§17.5)
};

// ── Shipped defaults (PRD §15, §7, §16) ──────────────────────────────────────
// The single source for every default so no later ticket has to invent one.
export const DEFAULT_SETTINGS: Settings = {
  watches: [],
  blockedCompanies: [],
  blockedTitleKeywords: [],
  hideReposted: false,
  intervalMinutes: 5,
  jitterMinutes: 1,
  pagesPerScan: 1,
  catchUpPages: 4,
  quietHours: { enabled: true, startMinute: 1380, endMinute: 420 },
  pacing: { pagePauseMs: [3000, 5000], watchPauseMs: [8000, 12000] },
  backoff: { emptyScansBeforeBackoff: 3, maxIntervalMinutes: 60 },
  retention: {
    seenDays: 15,
    openedJobDays: 7,
    unopenedJobDays: 30,
    seenHardCap: 50_000,
  },
  push: { enabled: false, botToken: "", chatId: "" },
  staleLockMs: 300_000,
  pushFailWarnThreshold: 3,
};
