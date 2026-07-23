// List-view mount — the §14 side-effect wrapper for the shared list view.
//
// Reads the `jobs`/`settings`/`health` storage keys, renders the page with the
// pure assembler in view.ts, and delegates clicks off the root: a job click
// marks the job opened *before* the tab opens (PRD §9 — a closing popup can cut
// off a write in flight) and re-renders so the badge decrements immediately.
// It touches chrome.storage, chrome.tabs, chrome.runtime and the DOM, so it is
// not unit-tested; every decision it makes lives tested in view.ts.

import * as storage from "./storage.ts";
import { renderPage, markJobOpened, markAllOpened } from "./view.ts";
import type { ListMode } from "./render.ts";
import type { ScanNowRequest } from "./scan.ts";

/** The storage keys `render` reads. A background cycle rewriting any of them —
 *  the one a "Scan now" click just started, or a routine alarm tick — repaints
 *  an open popup/tab, so "Scanning…" turns back into the list on its own. `ui`
 *  is excluded on purpose: this view writes it, and would only re-render itself. */
const RENDERED_KEYS = ["jobs", "settings", "health", "pushHealth", "scanState"] as const;

/**
 * Mount the list view into `root`, defaulting to `defaultMode` ("new" for the
 * popup, "all" for the tab). The persisted `ui` key (mockups decision 4)
 * overrides that default and the active chip, so reopening the popup restores
 * the last chip + mode. The root already carries its `.view-popup` /
 * `.view-tab` class from the HTML, which is the only thing that differs.
 */
export async function mountListView(
  root: HTMLElement,
  defaultMode: ListMode,
  title: string,
): Promise<void> {
  // Restore the last view (chip + mode); a never-set mode falls back to the
  // view's own default so the popup opens on New and the tab on All.
  const ui = await storage.get("ui");
  let activeWatchId: string | null = ui.activeWatchId;
  let mode: ListMode = ui.mode ?? defaultMode;

  await render();

  // One delegated handler for the whole list — clicks and middle-clicks alike.
  root.addEventListener("click", onClick);
  root.addEventListener("auxclick", onClick);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (RENDERED_KEYS.some((key) => key in changes)) void render();
  });

  async function persistUi(): Promise<void> {
    await storage.set("ui", { activeWatchId, mode });
  }

  async function render(): Promise<void> {
    const [jobs, settings, health, pushHealth, scanState] = await Promise.all([
      storage.get("jobs"),
      storage.get("settings"),
      storage.get("health"),
      storage.get("pushHealth"),
      storage.get("scanState"),
    ]);
    root.innerHTML = renderPage({
      jobs: Object.values(jobs),
      watches: settings.watches,
      mode,
      title,
      activeWatchId,
      scanning: scanState.isScanning,
      scanMode: health.mode,
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

    // Scan now: ask the background for a cycle right away rather than waiting out
    // the interval and quiet hours (PRD §9), and — when health is halted — resume
    // scanning (§16.2). The background replies once the lock is in storage, so the
    // re-render below already shows "Scanning…". A closing popup that loses the
    // reply is harmless: the cycle it started runs in the worker regardless.
    if (target.closest("#scan-now")) {
      e.preventDefault();
      const request: ScanNowRequest = { type: "LJW_SCAN_NOW" };
      await chrome.runtime.sendMessage(request).catch(() => {});
      await render();
      return;
    }

    // Mark all as read: open every job, clear the toolbar badge, and empty New
    // in one action (mockups decision 4).
    if (target.closest("#mark-all-read")) {
      e.preventDefault();
      const jobs = await storage.get("jobs");
      const next = markAllOpened(jobs, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      await chrome.action.setBadgeText({ text: "" });
      await render();
      return;
    }

    // A watch chip: filter the list in place and remember the choice.
    const chip = target.closest<HTMLElement>("button.chip");
    if (chip) {
      e.preventDefault();
      activeWatchId = chip.dataset.watchId || null;
      await persistUi();
      await render();
      return;
    }

    // The New⇄All toggle.
    const toggle = target.closest<HTMLElement>(".toggle button");
    if (toggle) {
      e.preventDefault();
      mode = toggle.dataset.mode === "all" ? "all" : "new";
      await persistUi();
      await render();
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
