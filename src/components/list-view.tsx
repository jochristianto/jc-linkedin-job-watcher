// The list view — PRD §4 "a shared component, mounted twice", and the §14
// side-effect wrapper that used to be mount.ts.
//
// It reads storage through `useExtensionState`, turns it into props with the
// pure `selectView`, and writes back through the same tested immutable helpers
// the old mount used. Every DECISION it makes still lives tested in view.ts;
// what is here is the wiring — chrome.storage, chrome.tabs, chrome.runtime.
//
// Three separate row actions, because they mean three different things: opening
// the posting (click the row), dismissing it (the tick button), and never
// wanting that company again (the Block button). Only the second empties the
// list, and only the third asks before it commits.

import { useCallback, useEffect, useMemo, useState } from "react";

import { EmptyState } from "@/components/empty-state.tsx";
import { HealthBanner } from "@/components/health-banner.tsx";
import { JobList } from "@/components/job-list.tsx";
import { ListHeader } from "@/components/list-header.tsx";
import { ScanStatusBar } from "@/components/scan-status.tsx";
import { Toolbar } from "@/components/toolbar.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useArmedBlock } from "@/hooks/use-armed-block.ts";
import { useExtensionState } from "@/hooks/use-extension-state.ts";
import { useNow } from "@/hooks/use-now.ts";
import { cn } from "@/lib/utils";
import { isCompanyBlocked } from "@/filter.ts";
import { focusOrOpenJobsTab } from "@/jobs-tab.ts";
import { badgeFor, type ScanNowRequest } from "@/scan.ts";
import * as storage from "@/storage.ts";
import {
  markAllRead,
  markJobOpened,
  selectView,
  setJobRead,
  toggleBlockedCompany,
  unreadCount,
} from "@/view.ts";
import type { ListMode, ViewVariant } from "@/view-model.ts";

export type ListViewProps = {
  variant: ViewVariant;
  /** The mode this view opens in before the user has ever picked one: "new" for
   *  the popup (a glance at what's unread), "all" for the tab (you arrived to
   *  browse everything found). The persisted `ui` key overrides it. */
  defaultMode: ListMode;
  title: string;
};

export function ListView({ variant, defaultMode, title }: ListViewProps) {
  const { state, reload, refreshAlarm } = useExtensionState();
  const { armedBlockId, arm, disarm } = useArmedBlock();
  const now = useNow();

  // The persisted view (chip + mode), restored so reopening the popup lands you
  // back where you left off (mockups decision 4). `null` mode = never chosen, so
  // this view's own default stands.
  const [activeWatchId, setActiveWatchId] = useState<string | null>(null);
  const [mode, setMode] = useState<ListMode>(defaultMode);
  useEffect(() => {
    void storage.get("ui").then((ui) => {
      setActiveWatchId(ui.activeWatchId);
      setMode(ui.mode ?? defaultMode);
    });
  }, [defaultMode]);

  // A "Scan now" click that has been sent but not yet answered — see `pendingScan`
  // in view.ts. It is what lets the button say "Scanning…" from the click rather
  // than from the reply.
  const [pendingScan, setPendingScan] = useState(false);

  const persistUi = useCallback(
    (next: { activeWatchId: string | null; mode: ListMode }) => storage.set("ui", next),
    [],
  );

  /** Repaint the toolbar badge from storage. The background sets it after every
   *  scan, but marking a row read (or blocking its company) changes the count
   *  from in here, and nothing else would notice until the next cycle. Same
   *  `badgeFor` the background uses, so the two can't drift apart. */
  const refreshBadge = useCallback(async () => {
    const [jobs, settings, health] = await Promise.all([
      storage.get("jobs"),
      storage.get("settings"),
      storage.get("health"),
    ]);
    const blocked = settings.blockedCompanies.map((b) => b.normalized);
    const { text, color } = badgeFor(unreadCount(Object.values(jobs), blocked), health.severity);
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  }, []);

  const view = useMemo(() => {
    if (!state) return null;
    return selectView({
      jobs: Object.values(state.jobs),
      watches: state.settings.watches,
      mode,
      title,
      activeWatchId,
      blockedCompanies: state.settings.blockedCompanies.map((b) => b.normalized),
      scanning: state.scanState.isScanning,
      pendingScan,
      scanMode: state.health.mode,
      severity: state.health.severity,
      message: state.health.message,
      pushWarn: state.pushHealth.warn,
      armedBlockId,
      quietHours: state.settings.quietHours,
      nextScanAt: state.nextScanAt,
      now,
    });
  }, [state, mode, title, activeWatchId, pendingScan, armedBlockId, now]);

  // The alarm is not in storage, so nothing tells us when it moves. Re-read it
  // whenever the countdown has run out and no cycle is in flight; while one is,
  // the alarm stays in the past for the whole 60–90s and there is nothing to
  // learn. `refreshAlarm` no-ops when the time is unchanged, so this is quiet.
  const scanning = state?.scanState.isScanning ?? false;
  const nextScanAt = state?.nextScanAt ?? null;
  useEffect(() => {
    if (!scanning && (nextScanAt === null || nextScanAt <= now)) void refreshAlarm();
  }, [now, nextScanAt, scanning, refreshAlarm]);

  /**
   * Ask the background for a scan right away rather than waiting out the interval
   * and quiet hours (PRD §9), and — when health is halted — resume scanning (§16.2).
   *
   * The optimistic flag comes first because the reply does not: the click has to
   * wake an MV3 service worker Chrome may have torn down, and the round trip runs
   * into whole seconds. `pendingScan` covers exactly that gap, then storage takes
   * over — the background writes the lock before it replies, so the reload below
   * reads a real `scanning` and nothing flickers back to idle. A closing popup
   * that loses the reply is harmless: the cycle it started runs in the worker
   * regardless. If the message fails outright the flag is cleared either way and
   * the button honestly goes back to "Scan now".
   */
  const onScan = useCallback(async () => {
    if (pendingScan) return;
    setPendingScan(true);
    try {
      const request: ScanNowRequest = { type: "LJW_SCAN_NOW" };
      await chrome.runtime.sendMessage(request).catch(() => {});
    } finally {
      setPendingScan(false);
      await reload();
    }
  }, [pendingScan, reload]);

  const onMarkAllRead = useCallback(async () => {
    const jobs = await storage.get("jobs");
    const next = markAllRead(jobs, Date.now());
    if (next !== jobs) await storage.set("jobs", next);
    await refreshBadge();
    await reload();
  }, [refreshBadge, reload]);

  /** Mark the job opened *before* the tab opens (PRD §9 — a closing popup can cut
   *  off a write in flight). The badge does NOT move: opening is not dismissing,
   *  and the job is still in the list waiting for you to come back to it. */
  const onOpen = useCallback(
    async (id: string, background: boolean) => {
      disarm();
      const jobs = await storage.get("jobs");
      const job = jobs[id];
      if (!job) return;
      const next = markJobOpened(jobs, id, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      await reload();
      // A background click already opened the tab natively; only the foreground
      // click needs us to open it.
      if (!background) chrome.tabs.create({ url: job.url, active: true });
    },
    [disarm, reload],
  );

  const onToggleRead = useCallback(
    async (id: string) => {
      disarm();
      const jobs = await storage.get("jobs");
      const next = setJobRead(jobs, id, !jobs[id]?.read, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      await refreshBadge();
      await reload();
    },
    [disarm, refreshBadge, reload],
  );

  /** Blocklist this job's company straight from the row, no trip to Options.
   *  Existing rows stay on screen greyed; it's future scans that stop surfacing
   *  the company (PRD §6). Pressing it again unblocks. */
  const onBlock = useCallback(
    async (id: string) => {
      const [jobs, settings] = await Promise.all([
        storage.get("jobs"),
        storage.get("settings"),
      ]);
      const company = jobs[id]?.company;
      if (!company) return;

      // Read the current state from settings rather than the row's props: the
      // render could be a repaint behind an Options edit, and this way the button
      // can never block something already blocked.
      const wasBlocked = isCompanyBlocked(
        company,
        settings.blockedCompanies.map((b) => b.normalized),
      );

      // The first press only arms the button; the second is the one that commits.
      if (!wasBlocked && armedBlockId !== id) {
        arm(id);
        return;
      }
      disarm();

      const blockedCompanies = toggleBlockedCompany(
        settings.blockedCompanies,
        company,
        !wasBlocked,
      );
      if (blockedCompanies !== settings.blockedCompanies) {
        await storage.set("settings", { ...settings, blockedCompanies });
      }
      await refreshBadge();
      await reload();
    },
    [armedBlockId, arm, disarm, refreshBadge, reload],
  );

  const onWatchChange = useCallback(
    (id: string | null) => {
      disarm();
      setActiveWatchId(id);
      void persistUi({ activeWatchId: id, mode });
    },
    [disarm, mode, persistUi],
  );

  const onModeChange = useCallback(
    (next: ListMode) => {
      disarm();
      setMode(next);
      void persistUi({ activeWatchId, mode: next });
    },
    [activeWatchId, disarm, persistUi],
  );

  /** The popup is a 380px panel that closes the instant you click anything
   *  outside it, which is the wrong container for reading a long list. Reuses an
   *  already-open jobs.html rather than stacking a second copy — the same rule a
   *  notification click follows — then closes the popup, so what you are left
   *  looking at is the tab and not two copies of the same list. */
  const onOpenTab = useCallback(async () => {
    await focusOrOpenJobsTab();
    window.close();
  }, []);

  const onOpenOptions = useCallback(() => chrome.runtime.openOptionsPage(), []);

  return (
    <TooltipProvider delayDuration={400}>
      <div
        data-variant={variant}
        className={cn(
          "flex flex-col bg-background",
          variant === "popup"
            ? "h-[600px] min-h-[480px] w-[380px]"
            : "mx-auto min-h-screen max-w-[720px] border-x",
        )}
      >
        {view && (
          <>
            <ListHeader
              title={view.title}
              badge={view.badge}
              scanButton={view.scanButton}
              variant={variant}
              onScan={onScan}
              onMarkAllRead={onMarkAllRead}
              onOpenTab={onOpenTab}
              onOpenOptions={onOpenOptions}
            />

            <Toolbar
              watches={view.chips}
              activeWatchId={view.activeWatchId}
              mode={view.mode}
              onWatchChange={onWatchChange}
              onModeChange={onModeChange}
            />

            {view.banners.map((b) => (
              <HealthBanner key={b.message} message={b.message} severity={b.severity} />
            ))}

            {/* The list scrolls; the header above and the status bar below stay put. */}
            <div className="flex flex-1 flex-col overflow-y-auto px-2 pb-2">
              {view.emptyKind ? (
                <EmptyState kind={view.emptyKind} />
              ) : (
                <JobList
                  jobs={view.jobs}
                  mode={view.mode}
                  armedBlockId={view.armedBlockId}
                  onOpen={onOpen}
                  onToggleRead={onToggleRead}
                  onBlock={onBlock}
                />
              )}
            </div>

            <ScanStatusBar status={view.status} />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
