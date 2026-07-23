// List-view mount — the §14 side-effect wrapper for the shared list view.
//
// Reads the `jobs`/`settings`/`health` storage keys, renders the page with the
// pure assembler in view.ts, and delegates clicks off the root: a job click
// marks the job opened *before* the tab opens (PRD §9 — a closing popup can cut
// off a write in flight) and re-renders so the badge decrements immediately.
// It touches chrome.storage, chrome.tabs, chrome.runtime and the DOM, so it is
// not unit-tested; every decision it makes lives tested in view.ts.

import * as storage from "./storage.ts";
import { renderPage, markJobOpened } from "./view.ts";
import type { ListMode } from "./render.ts";

/**
 * Mount the list view into `root`, defaulting to `mode` ("new" for the popup,
 * "all" for the tab). The root already carries its `.view-popup` / `.view-tab`
 * class from the HTML, which is the only thing that differs between the two.
 */
export async function mountListView(
  root: HTMLElement,
  mode: ListMode,
  title: string,
): Promise<void> {
  await render();

  // One delegated handler for the whole list — clicks and middle-clicks alike.
  root.addEventListener("click", onClick);
  root.addEventListener("auxclick", onClick);

  async function render(): Promise<void> {
    const [jobs, settings, health, pushHealth] = await Promise.all([
      storage.get("jobs"),
      storage.get("settings"),
      storage.get("health"),
      storage.get("pushHealth"),
    ]);
    root.innerHTML = renderPage({
      jobs: Object.values(jobs),
      watches: settings.watches,
      mode,
      title,
      severity: health.severity,
      message: health.message,
      pushWarn: pushHealth.warn,
    });
  }

  async function onClick(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement;

    const options = target.closest("#open-options");
    if (options) {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
      return;
    }

    const link = target.closest<HTMLAnchorElement>("a.job");
    if (!link) return;

    // Modifier / middle clicks let the browser's own <a href> open a background
    // tab (PRD §3). A plain left click we handle ourselves so we can write the
    // opened state first, then open the tab in the foreground.
    const background =
      e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey;
    if (!background) e.preventDefault(); // must be synchronous, before any await

    const id = link.dataset.jobId;
    if (!id) return;
    await openJob(id, background);
  }

  async function openJob(id: string, background: boolean): Promise<void> {
    const jobs = await storage.get("jobs");
    const job = jobs[id];
    if (!job) return;

    // Write first (PRD §9), then re-render so the badge drops by one.
    await storage.set("jobs", markJobOpened(jobs, id, Date.now()));
    await render();

    // A background click already opened the tab natively; only the foreground
    // click needs us to open it.
    if (!background) chrome.tabs.create({ url: job.url, active: true });
  }
}
