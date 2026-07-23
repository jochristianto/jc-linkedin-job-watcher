// Desktop notification — the pure decisions behind the one merged notification a
// cycle fires (PRD §3 "Being told" / §9 "Notification click"). `background.ts` is
// the side-effect wrapper: it calls `chrome.notifications.create` with what
// {@link buildScanNotification} returns and, on a click, focuses-or-opens
// jobs.html using {@link jobsTabToFocus}. Per PRD §14 every choice — the singular/
// plural noun, the "fire nothing on an empty cycle" rule, the reuse-a-tab rule —
// lives here, tested by `node --test`, and none of chrome.* is unit-tested. Same
// shape as push.ts / scan.ts.

/** The fields of a Job (PRD §5) a notification needs — a structural subset, so a
 *  full `Job` record satisfies it and `buildScanNotification(newJobs)` type-checks. */
export type NotificationJob = {
  title: string;
  company: string;
};

/** Stable notification id. Reusing one id means a fresh cycle's notification
 *  replaces the previous one instead of stacking six deep on a busy morning, and
 *  the click handler can recognise ours (PRD §3/§9). */
export const SCAN_NOTIFICATION_ID = "ljw-new-jobs";

/** Max jobs named in the body; the remainder collapses to "+N more" so the
 *  notification stays a glance, not a wall of text. */
const MAX_LISTED = 5;

/** The title + body of the merged desktop notification. `background.ts` folds
 *  this into `chrome.notifications.create` options (adding type/iconUrl). */
export type ScanNotification = {
  title: string;
  message: string;
};

/**
 * Build the ONE merged desktop notification for a cycle's new jobs (PRD §3/§9).
 *
 * Returns null when there are no new jobs — a cycle that found nothing fires
 * nothing (the AC). The caller passes the single cross-watch deduped `newJobs`
 * batch, so there is exactly one notification per cycle, never one per watch.
 */
export function buildScanNotification(jobs: NotificationJob[]): ScanNotification | null {
  if (jobs.length === 0) return null;

  const count = jobs.length;
  const title = `${count} new job${count > 1 ? "s" : ""}`;

  const lines = jobs.slice(0, MAX_LISTED).map((j) => `${j.title} — ${j.company}`);
  if (count > MAX_LISTED) lines.push(`+${count - MAX_LISTED} more`);

  return { title, message: lines.join("\n") };
}

/** A tab as `chrome.tabs.query` returns it, narrowed to the fields the click
 *  handler acts on (both optional in the chrome types). */
export type JobsTabRef = { id?: number; windowId?: number };

/**
 * Pick the existing jobs.html tab to focus, or null if none is open and a new one
 * must be created (PRD §9). Reusing a tab is the whole point: a busy morning of
 * notification clicks must not leave six identical jobs.html tabs. The first tab
 * with a usable id wins — a tab with no id can't be focused, so it is skipped.
 */
export function jobsTabToFocus(tabs: JobsTabRef[]): JobsTabRef | null {
  return tabs.find((t) => t.id !== undefined) ?? null;
}
