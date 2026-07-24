import { useCallback, useEffect, useState } from "react";

import * as storage from "@/storage.ts";
import { SCAN_ALARM_NAME } from "@/schedule.ts";
import type { JobsMap } from "@/storage.ts";
import type { HealthState, ScanState, Settings } from "@/types.ts";
import type { PushHealthState } from "@/health.ts";

/** The storage keys the list view renders from. A background cycle rewriting any
 *  of them — the one a "Scan now" click just started, or a routine alarm tick —
 *  repaints an open popup/tab, so "Scanning…" turns back into the list on its
 *  own. `ui` is excluded on purpose: this view writes it, and subscribing would
 *  only make it re-render itself. */
const RENDERED_KEYS = ["jobs", "settings", "health", "pushHealth", "scanState"] as const;

export type ExtensionState = {
  jobs: JobsMap;
  settings: Settings;
  health: HealthState;
  pushHealth: PushHealthState;
  scanState: ScanState;
  /** When the armed one-shot alarm is due to fire, or null when no alarm exists.
   *  Read from `chrome.alarms` rather than storage because no key mirrors it —
   *  and rather than recomputed, because jitter, back-off and the quiet-hours
   *  jump were all decided when it was armed (PRD §15 decision 3). */
  nextScanAt: number | null;
};

/**
 * The whole of what the list view reads, kept in step with storage.
 *
 * Returns `null` until the first read lands, which is the one frame the page has
 * nothing to show. Everything after that is driven by `chrome.storage.onChanged`,
 * so a scan finishing in the service worker repaints an open popup with no
 * polling.
 *
 * `refreshAlarm` is separate because the alarm is *not* in storage and therefore
 * fires no change event: a cycle that has just finished writes `scanState` and
 * only then arms the next alarm, so the re-render triggered by that write read a
 * time already in the past. The caller re-reads on the countdown's own tick and
 * the footer heals itself within a second.
 */
export function useExtensionState(): {
  state: ExtensionState | null;
  reload: () => Promise<void>;
  refreshAlarm: () => Promise<void>;
} {
  const [state, setState] = useState<ExtensionState | null>(null);

  const reload = useCallback(async () => {
    const [jobs, settings, health, pushHealth, scanState, alarm] = await Promise.all([
      storage.get("jobs"),
      storage.get("settings"),
      storage.get("health"),
      storage.get("pushHealth"),
      storage.get("scanState"),
      chrome.alarms.get(SCAN_ALARM_NAME),
    ]);
    setState({
      jobs,
      settings,
      health,
      pushHealth,
      scanState,
      nextScanAt: alarm?.scheduledTime ?? null,
    });
  }, []);

  const refreshAlarm = useCallback(async () => {
    const alarm = await chrome.alarms.get(SCAN_ALARM_NAME);
    const nextScanAt = alarm?.scheduledTime ?? null;
    // Bail when it hasn't moved, so a poll that finds the same time doesn't
    // re-render the page every second while the loop sits idle.
    setState((prev) =>
      prev === null || prev.nextScanAt === nextScanAt ? prev : { ...prev, nextScanAt },
    );
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== "local") return;
      if (RENDERED_KEYS.some((key) => key in changes)) void reload();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [reload]);

  return { state, reload, refreshAlarm };
}
