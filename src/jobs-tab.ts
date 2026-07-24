// Focus-or-open the jobs.html tab — the one `chrome.*` wrapper two entry points
// share (PRD §14: orchestration only, so not unit-tested; the rule it enforces
// lives tested in `jobsTabToFocus`).
//
// Two things land the user in our own full-page list: clicking the desktop
// notification (background.ts) and the popup's "Open as a full page" button
// (mount.ts). Both must obey the same rule — reuse the tab that is already open
// rather than stacking a second copy — so both call this rather than each
// keeping their own copy of it to drift apart.

import { jobsTabToFocus } from "./notify.ts";

/** The extension page the list mounts as a full tab. */
export const JOBS_PAGE = "jobs.html";

/**
 * Bring the jobs.html tab to the front, opening it only if none exists (PRD §9).
 * An already-open tab is activated *and* its window raised — on a second monitor
 * an activated tab in a background window is a click that did nothing. Marks no
 * job as opened: this only gets you to the list.
 */
export async function focusOrOpenJobsTab(): Promise<void> {
  const url = chrome.runtime.getURL(JOBS_PAGE);
  const existing = jobsTabToFocus(await chrome.tabs.query({ url }));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
}
