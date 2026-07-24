// List-view mount — the §14 side-effect wrapper for the shared list view.
//
// Reads the `jobs`/`settings`/`health` storage keys, renders the page with the
// pure assembler in view.ts, and delegates clicks off the root: a job click
// marks the job opened *before* the tab opens (PRD §9 — a closing popup can cut
// off a write in flight) and re-renders so the row shows as highlighted
// immediately. It touches chrome.storage, chrome.tabs, chrome.runtime and the
// DOM, so it is not unit-tested; every decision it makes lives tested in view.ts.
//
// Three separate row actions, because they mean three different things: opening
// the posting (click the row), dismissing it (the tick button), and never wanting
// that company again (the Block button). Only the second one empties the list,
// and only the third asks before it commits — see `armBlock`.

import * as storage from "./storage.ts";
import {
  renderPage,
  markJobOpened,
  markAllRead,
  setJobRead,
  scanStatus,
  toggleBlockedCompany,
  unreadCount,
  type ViewContext,
} from "./view.ts";
import { renderScanStatus, BLOCK_CONFIRM_MS, type ListMode } from "./render.ts";
import { SCAN_ALARM_NAME } from "./schedule.ts";
import { badgeFor, type ScanNowRequest } from "./scan.ts";
import { isCompanyBlocked } from "./filter.ts";

/** The storage keys `render` reads. A background cycle rewriting any of them —
 *  the one a "Scan now" click just started, or a routine alarm tick — repaints
 *  an open popup/tab, so "Scanning…" turns back into the list on its own. `ui`
 *  is excluded on purpose: this view writes it, and would only re-render itself. */
const RENDERED_KEYS = ["jobs", "settings", "health", "pushHealth", "scanState"] as const;

/** How often the footer's countdown repaints. The default interval is five
 *  minutes, so a coarser tick would visibly stall on the seconds; only the
 *  footer's contents are rewritten, never the list. */
const COUNTDOWN_TICK_MS = 1000;

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

  // When the armed alarm fires, and the context the last render was built from —
  // both cached so the once-a-second tick below is a string swap rather than a
  // round trip to storage.
  let nextScanAt: number | null = null;
  let lastCtx: ViewContext | null = null;

  // The Block confirmation: which row's Block button is currently asking "Sure?",
  // and the timer that takes the question back down. At most one at a time — see
  // `armBlock`. Deliberately not persisted: a question you walked away from
  // should not still be waiting when you reopen the popup.
  let armedBlockId: string | null = null;
  let armedBlockTimer: ReturnType<typeof setTimeout> | undefined;

  await render();

  // One delegated handler for the whole list — clicks and middle-clicks alike.
  root.addEventListener("click", onClick);
  root.addEventListener("auxclick", onClick);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (RENDERED_KEYS.some((key) => key in changes)) void render();
  });

  // The countdown is the one thing on the page that changes without anything
  // happening, so it needs its own clock. It dies with the page — the popup is
  // disposable, and an open jobs tab is one timer.
  setInterval(tick, COUNTDOWN_TICK_MS);

  async function persistUi(): Promise<void> {
    await storage.set("ui", { activeWatchId, mode });
  }

  /**
   * Put the question to one row's Block button, replacing any other row's — two
   * buttons asking at once is two chances to answer the wrong one. It answers
   * itself with "no" after `BLOCK_CONFIRM_MS`, so a click you meant for the row
   * underneath can't leave a live one-press-to-block button lying around.
   */
  async function armBlock(id: string): Promise<void> {
    clearTimeout(armedBlockTimer);
    armedBlockId = id;
    armedBlockTimer = setTimeout(() => void disarmBlock(), BLOCK_CONFIRM_MS);
    await render();
  }

  /** Take the question back down. A no-op — no repaint at all — when nothing was
   *  armed, which is the normal case for every click on the page. */
  async function disarmBlock(): Promise<void> {
    clearTimeout(armedBlockTimer);
    if (armedBlockId === null) return;
    armedBlockId = null;
    await render();
  }

  async function render(): Promise<void> {
    const [jobs, settings, health, pushHealth, scanState, alarm] = await Promise.all([
      storage.get("jobs"),
      storage.get("settings"),
      storage.get("health"),
      storage.get("pushHealth"),
      storage.get("scanState"),
      // The armed alarm is the schedule — no storage key mirrors it, so this is
      // where "next scan" comes from (PRD §15 decision 3 / schedule.ts).
      chrome.alarms.get(SCAN_ALARM_NAME),
    ]);
    nextScanAt = alarm?.scheduledTime ?? null;
    lastCtx = {
      jobs: Object.values(jobs),
      watches: settings.watches,
      mode,
      title,
      activeWatchId,
      blockedCompanies: settings.blockedCompanies.map((b) => b.normalized),
      scanning: scanState.isScanning,
      scanMode: health.mode,
      severity: health.severity,
      message: health.message,
      pushWarn: pushHealth.warn,
      armedBlockId,
      quietHours: settings.quietHours,
      nextScanAt,
      now: Date.now(),
    };
    root.innerHTML = renderPage(lastCtx);
  }

  /**
   * Repaint ONLY the footer's status line, from the last render's context plus a
   * fresh clock. Everything above it is left exactly as it was: this runs every
   * second, and re-rendering the page that often would fight the user's scroll
   * position and drop focus mid-click.
   */
  function paintStatus(): void {
    const slot = root.querySelector("#statusbar");
    if (!lastCtx || !slot) return;
    slot.innerHTML = renderScanStatus(scanStatus({ ...lastCtx, nextScanAt, now: Date.now() }));
  }

  /**
   * One tick of the countdown.
   *
   * A cycle that has just finished writes `scanState` and only *then* arms the
   * next alarm, so the re-render that storage change triggered read a time that
   * had already passed. Rather than racing that, the tick re-reads the alarm
   * whenever the countdown has run out and lets the footer heal itself within a
   * second. While a cycle is in flight there is nothing to re-read — the alarm
   * stays in the past for the whole 60–90s — so it stays a plain repaint.
   */
  function tick(): void {
    const expired = nextScanAt === null || nextScanAt <= Date.now();
    if (expired && !lastCtx?.scanning) {
      void chrome.alarms.get(SCAN_ALARM_NAME).then((alarm) => {
        nextScanAt = alarm?.scheduledTime ?? null;
        paintStatus();
      });
      return;
    }
    paintStatus();
  }

  /**
   * Repaint the toolbar badge from storage. The background sets it after every
   * scan, but marking a row read (or blocking its company) changes the count
   * from in here, and nothing else would notice until the next cycle. Same
   * `badgeFor` the background uses, so the two can't drift apart.
   */
  async function refreshBadge(): Promise<void> {
    const [jobs, settings, health] = await Promise.all([
      storage.get("jobs"),
      storage.get("settings"),
      storage.get("health"),
    ]);
    const blocked = settings.blockedCompanies.map((b) => b.normalized);
    const { text, color } = badgeFor(unreadCount(Object.values(jobs), blocked), health.severity);
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  }

  async function onClick(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement;

    // Opening a job is *decided* here, at the top, even though it is acted on at
    // the bottom: it is the one branch with a synchronous obligation. A plain
    // left click on a row has to call preventDefault() before this handler's
    // first await, or the browser has already followed the <a href> by the time
    // we come back — and then the tab we open is a second one. Modifier and
    // middle clicks are deliberately left to do exactly that: the browser's own
    // background tab (PRD §3).
    const link = target.closest<HTMLAnchorElement>("a.job-main");
    const background = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey;
    if (link && !background) e.preventDefault();

    // Clicking anywhere else is how you answer "no" to an armed Block button, so
    // that comes next, before any branch below can return early. The repaint it
    // triggers detaches `target`, which is fine: `closest()` still walks the
    // detached row, and every branch below works from ids and storage, never
    // from what is currently on screen.
    const hitBtn = target.closest<HTMLElement>(".job-btn");
    const hitArmedBlock =
      armedBlockId !== null &&
      hitBtn?.dataset.action === "block" &&
      hitBtn.closest<HTMLElement>(".job")?.dataset.jobId === armedBlockId;
    if (!hitArmedBlock) await disarmBlock();

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

    // Mark all as read: dismiss every job, clear the toolbar badge, and empty New
    // in one action (mockups decision 4).
    if (target.closest("#mark-all-read")) {
      e.preventDefault();
      const jobs = await storage.get("jobs");
      const next = markAllRead(jobs, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      await refreshBadge();
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

    // Both row actions live inside the row, so resolve the row once and read
    // which button (if any) was hit off `data-action`.
    const row = target.closest<HTMLElement>(".job");
    if (!row) return;
    const id = row.dataset.jobId;
    if (!id) return;

    const action = target.closest<HTMLElement>(".job-btn")?.dataset.action;

    // Tick / undo — dismiss this one job, or bring it back. The only thing that drops
    // a row out of New, which is the whole point of it being its own button.
    if (action === "read") {
      e.preventDefault();
      const jobs = await storage.get("jobs");
      const next = setJobRead(jobs, id, !jobs[id]?.read, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      await refreshBadge();
      await render();
      return;
    }

    // Block — blocklist this job's company straight from the row, no trip to
    // Options. Existing rows stay on screen greyed; it's future scans that stop
    // surfacing the company (PRD §6). Pressing it again unblocks.
    if (action === "block") {
      e.preventDefault();
      const [jobs, settings] = await Promise.all([
        storage.get("jobs"),
        storage.get("settings"),
      ]);
      const company = jobs[id]?.company;
      if (!company) return;

      // Read the current state from settings rather than the row's
      // `data-blocked`: the markup could be a repaint behind an Options edit,
      // and this way the button can never block something already blocked.
      const wasBlocked = isCompanyBlocked(
        company,
        settings.blockedCompanies.map((b) => b.normalized),
      );

      // Blocking takes two presses. It hides every future job from a company
      // and the row it was pressed on stays put, greyed — so a mis-click looks
      // like nothing much happened, and you find out weeks later by the jobs you
      // never saw. The first press only arms the button; this one is it.
      // Unblocking is single-press: it can only put jobs back.
      if (!wasBlocked && armedBlockId !== id) {
        await armBlock(id);
        return;
      }
      clearTimeout(armedBlockTimer);
      armedBlockId = null;

      const blockedCompanies = toggleBlockedCompany(
        settings.blockedCompanies,
        company,
        !wasBlocked,
      );
      if (blockedCompanies !== settings.blockedCompanies) {
        await storage.set("settings", { ...settings, blockedCompanies });
      }
      await refreshBadge();
      await render();
      return;
    }

    // Nothing but the posting itself is left: mark it opened, then open the tab
    // (a background click already has its tab — see the top of this handler).
    if (!link) return;
    await openJob(id, background);
  }

  async function openJob(id: string, background: boolean): Promise<void> {
    const jobs = await storage.get("jobs");
    const job = jobs[id];
    if (!job) return;

    // Write first (PRD §9), then re-render so the row shows as opened. The badge
    // does NOT move here — opening is not dismissing, and the job is still in the
    // list waiting for you to come back to it.
    const next = markJobOpened(jobs, id, Date.now());
    if (next !== jobs) await storage.set("jobs", next);
    await render();

    // A background click already opened the tab natively; only the foreground
    // click needs us to open it.
    if (!background) chrome.tabs.create({ url: job.url, active: true });
  }
}
