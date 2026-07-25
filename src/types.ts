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
  // Applying is a third thing again, and the only one that means you *acted* on
  // the posting rather than looked at it or dismissed the row. It is stored so
  // the row can say "Applied" afterwards, so the question is never asked twice
  // about the same job, and because the `[Applied]` Telegram message (§8) is
  // built from the job plus whatever note was typed alongside the answer.
  //
  // Optional, unlike `read`: records written before this shipped carry none of
  // the three fields, and an absent `applied` simply reads as "never applied", so
  // no `migrateJobs` branch is needed. Answering "No" writes nothing at all — you
  // might apply tomorrow, and a stored "no" would be a fact with a shelf life.
  applied?: boolean;
  appliedAt?: number | null;
  /** What was typed in the notes box when the answer was Yes; `""` when the box
   *  was left empty (the note is optional, the answer is not). */
  applyNotes?: string;
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
  /** The master on/off switch behind the header toggle. `false` stops the whole
   *  loop — the routine alarm is cleared and "Scan now" is inert — until the user
   *  turns it back on. Distinct from a *per-watch* `enabled` (that silences one
   *  search); this pauses everything at once. Settings written before this field
   *  existed have no `enabled`, which reads as on, so an upgrade never goes dark. */
  enabled: boolean; // default true
  /** "Only scan when I press Scan now" (§15). No routine alarm is ever armed, so
   *  nothing is loaded from LinkedIn until the button is pressed — but everything
   *  else stays live: the watches stay on, "Scan now" runs a full cycle, and the
   *  list, badge and pushes work exactly as before. That is the whole difference
   *  from the master switch above, which stops the manual button too: this hands
   *  the *timing* to the user rather than stopping the loop. Settings written
   *  before this field existed have no `manualOnly`, which reads as off, so an
   *  upgrade keeps the cadence it already had. */
  manualOnly: boolean; // default false
  watches: Watch[];
  blockedCompanies: BlockedCompany[];
  blockedTitleKeywords: string[];
  hideReposted: boolean;
  intervalMinutes: number; // default 60
  jitterMinutes: number; // default 30 — ±this, randomised onto each interval (§15)
  pagesPerScan: number; // default 1 — routine depth (§15); page 2 is mostly stale
  catchUpPages: number; // default 4, used on startup and quiet-hours resume (§9/§15)
  quietHours: QuietHours;
  /** The desktop pop-up that announces a cycle's new jobs (§3/§9). Off silences
   *  that pop-up and nothing else — the toolbar count still moves and Telegram
   *  still delivers, because those are how you find out later rather than now.
   *  Settings written before this field existed have no `notifyDesktop`, which
   *  reads as on, so an upgrade never goes quiet on its own. */
  notifyDesktop: boolean; // default true
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
  enabled: true,
  manualOnly: false,
  watches: [],
  blockedCompanies: [],
  blockedTitleKeywords: [],
  hideReposted: false,
  intervalMinutes: 60,
  jitterMinutes: 30,
  pagesPerScan: 1,
  catchUpPages: 4,
  quietHours: { enabled: true, startMinute: 1380, endMinute: 420 },
  notifyDesktop: true,
  pacing: { pagePauseMs: [3000, 5000], watchPauseMs: [8000, 12000] },
  // The ceiling has to sit above `intervalMinutes`, or the stopping rule is inert:
  // a 60-minute base clamped to a 60-minute maximum can never double (§15, decision 6).
  backoff: { emptyScansBeforeBackoff: 3, maxIntervalMinutes: 240 },
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
