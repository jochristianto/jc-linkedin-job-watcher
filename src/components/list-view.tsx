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

import { ApplyPrompt } from "@/components/apply-prompt.tsx";
import { EmptyState, type EmptyStateAction } from "@/components/empty-state.tsx";
import { HealthBanner } from "@/components/health-banner.tsx";
import { JobList } from "@/components/job-list.tsx";
import { ListHeader } from "@/components/list-header.tsx";
import { ScanningBar, ScanSkeletons } from "@/components/scanning.tsx";
import { ScanStatusBar } from "@/components/scan-status.tsx";
import { Toolbar } from "@/components/toolbar.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useArmedBlock } from "@/hooks/use-armed-block.ts";
import { useExtensionState } from "@/hooks/use-extension-state.ts";
import { useNow } from "@/hooks/use-now.ts";
import { cn } from "@/lib/utils";
import { isCompanyBlocked } from "@/filter.ts";
import { focusOrOpenJobsTab } from "@/jobs-tab.ts";
import {
  badgeFor,
  type ScanNowRequest,
  type ScanNowResponse,
  type SetEnabledRequest,
} from "@/scan.ts";
import * as storage from "@/storage.ts";
import {
  appliedPushNotice,
  type AppliedPushRequest,
  type AppliedPushResponse,
} from "@/push.ts";
import {
  clearJobApplied,
  markAllRead,
  markJobApplied,
  markJobOpened,
  selectView,
  setJobRead,
  toggleBlockedCompany,
  unreadCount,
} from "@/view.ts";
import { type ListMode, type ViewVariant } from "@/view-model.ts";

/** How long to wait before re-sending a message no listener took. Long enough for a
 *  cold MV3 worker to evaluate its script and register its handlers, short enough
 *  that a user waiting on the answer doesn't notice it. */
const WAKE_RETRY_MS = 250;

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
  // The job whose "Did you apply for this job?" question is still open. Hydrated
  // from storage because the click that queued it also closed the popup — see
  // `UiState.pendingApplyId`.
  const [pendingApplyId, setPendingApplyId] = useState<string | null>(null);
  useEffect(() => {
    void storage.get("ui").then((ui) => {
      setActiveWatchId(ui.activeWatchId);
      setMode(ui.mode ?? defaultMode);
      setPendingApplyId(ui.pendingApplyId ?? null);
    });
  }, [defaultMode]);

  // A "Scan now" click that has been sent but not yet answered — see `pendingScan`
  // in view.ts. It is what lets the button say "Scanning…" from the click rather
  // than from the reply.
  const [pendingScan, setPendingScan] = useState(false);

  // A short-lived line explaining something the background answered but nothing
  // else would show: a click that started no *new* scan (the worker was
  // unreachable, or a cycle was already running), or an applied record that saved
  // but never reached Telegram. Without it those replies are silent and the button
  // just blinks. Cleared on the next action and after a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Merge a patch into the persisted view state. A patch rather than the whole
   *  record because three separate things write it now — the chip, the mode, and
   *  the pending apply question — and each knows only its own field. */
  const persistUi = useCallback(async (patch: Partial<storage.UiState>) => {
    const ui = await storage.get("ui");
    await storage.set("ui", { ...ui, ...patch });
  }, []);

  /**
   * Close the open apply question, recording nothing — which is the whole of what
   * a "No" does, since only Yes is ever written. Four things mean exactly this and
   * share it: No itself, the note step's Cancel, and the two ways of ticking a job
   * read (see `onToggleRead`).
   *
   * The question does not come back on its own — being asked again on every reopen
   * would make the popup unusable — but clicking the row re-queues it.
   */
  const closeApplyQuestion = useCallback(async () => {
    setPendingApplyId(null);
    await persistUi({ pendingApplyId: null });
  }, [persistUi]);

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
      // Absent (settings from before the master switch existed) reads as on.
      enabled: state.settings.enabled !== false,
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
    setNotice(null);
    setPendingScan(true);
    try {
      // `null` = the message reached no listener. Right after a reload the MV3
      // worker can be torn down and miss the first wake, so retry once before
      // blaming it. A `started: false` reply is the worker answering that it did
      // not begin a *new* cycle — most often because one is already running,
      // which is not an error (the scan the click asked for is under way).
      const send = () =>
        chrome.runtime
          .sendMessage({ type: "LJW_SCAN_NOW" } as ScanNowRequest)
          .then((r) => r as ScanNowResponse, () => null);
      let res = await send();
      if (res == null) res = await send();

      if (res == null) {
        setNotice("Couldn't reach the scanner — reload the extension and try again.");
      } else if (!res.started) {
        setNotice(
          res.reason === "already-scanning"
            ? "A scan is already running — hang tight."
            : "Couldn't start the scan — try again in a moment.",
        );
      }
    } finally {
      setPendingScan(false);
      await reload();
    }
  }, [pendingScan, reload]);

  /**
   * The header's master on/off switch (§ master). Flip `settings.enabled` in
   * storage first so every open surface repaints the switch and the footer at
   * once — `settings` is a rendered key — then wake the background to reconcile
   * the alarm (arm it on, clear it off), which only the service worker can do.
   *
   * The message is retried once for the same reason "Scan now" is: a click can
   * land while Chrome has torn the MV3 worker down and miss the first wake. If
   * both miss, an alarm left armed after an OFF is swept by `onAlarm`'s own
   * self-heal on its next tick, and turning it back ON simply re-sends this.
   */
  const onToggleEnabled = useCallback(
    async (next: boolean) => {
      const settings = await storage.get("settings");
      await storage.set("settings", { ...settings, enabled: next });
      const send = () =>
        chrome.runtime
          .sendMessage({ type: "LJW_SET_ENABLED", enabled: next } as SetEnabledRequest)
          .then(() => true, () => false);
      if (!(await send())) await send();
      await reload();
    },
    [reload],
  );

  const onMarkAllRead = useCallback(async () => {
    const jobs = await storage.get("jobs");
    const next = markAllRead(jobs, Date.now());
    if (next !== jobs) await storage.set("jobs", next);
    // Whatever the open question was about is among the jobs just dismissed, so it
    // is answered too — same rule as the single tick in `onToggleRead`.
    await closeApplyQuestion();
    await refreshBadge();
    await reload();
  }, [closeApplyQuestion, refreshBadge, reload]);

  /** Mark the job opened *before* the tab opens (PRD §9 — a closing popup can cut
   *  off a write in flight). The badge drops by one: you have looked at the job,
   *  which is all the badge ever claimed to count. The row itself stays put, still
   *  on the New list waiting for you to come back to it — see `markJobOpened` for
   *  why those two are not the same thing. */
  const onOpen = useCallback(
    async (id: string, background: boolean) => {
      disarm();
      const jobs = await storage.get("jobs");
      const job = jobs[id];
      if (!job) return;
      const next = markJobOpened(jobs, id, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      // Queue "Did you apply for this job?" for this posting, unless it is already
      // answered. Written to storage for the same reason the line above is: the tab
      // opened below takes focus, and a popup that loses focus is destroyed — so a
      // question kept in component state would never be asked at all.
      if (job.applied !== true) {
        setPendingApplyId(id);
        await persistUi({ pendingApplyId: id });
      }
      // Opening takes the job off the count, so the toolbar has to be repainted
      // from here — nothing else would notice until the next scan.
      await refreshBadge();
      await reload();
      // A background click already opened the tab natively; only the foreground
      // click needs us to open it.
      if (!background) chrome.tabs.create({ url: job.url, active: true });
    },
    [disarm, persistUi, refreshBadge, reload],
  );

  /**
   * The answer to "Did you apply for this job?".
   *
   * Only Yes writes anything, and it writes the record *before* asking the worker
   * to push: a Telegram outage, a wrong chat id or a popup that closes mid-send can
   * then only cost the message, never the fact that you applied. The message is the
   * part allowed to fail — and a failure is said out loud rather than swallowed,
   * naming which of the four things went wrong (`appliedPushNotice`), because a
   * silent non-delivery is exactly the failure §16.7 exists to stop and "it didn't
   * send" on its own sends you looking in the wrong place.
   *
   * No records nothing at all (you may apply tomorrow); either answer closes the
   * question, and clicking the row again re-queues it.
   */
  const onAnswerApply = useCallback(
    async (applied: boolean, notes: string) => {
      const id = pendingApplyId;
      if (!id) return;
      setNotice(null);
      await closeApplyQuestion();
      if (!applied) return;

      const jobs = await storage.get("jobs");
      const next = markJobApplied(jobs, id, notes, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      await reload();

      // Retried once for the same reason "Scan now" is: the message may have to wake
      // an MV3 worker Chrome tore down, and the first one can miss it. Unlike "Scan
      // now" the retry waits a moment first — a cold worker has to evaluate its
      // script before any listener exists, and a retry fired in the same tick races
      // exactly the gap it is meant to cover.
      const send = () =>
        chrome.runtime
          .sendMessage({ type: "LJW_APPLIED", jobId: id } as AppliedPushRequest)
          .then((r) => r as AppliedPushResponse, () => null);
      let res = await send();
      if (res == null) {
        await new Promise((r) => setTimeout(r, WAKE_RETRY_MS));
        res = await send();
      }
      // Which failure it was decides what the user has to do about it, so the reason
      // comes back with the reply and `appliedPushNotice` turns it into the sentence.
      const line = appliedPushNotice(res);
      if (line) setNotice(line);
    },
    [closeApplyQuestion, pendingApplyId, reload],
  );

  /** The row's "Applied" tag, tapped: throw the record away — flag, timestamp and
   *  note — and let the question be asked again next time the row is opened. No
   *  message goes out: Telegram already has the `[Applied]` one, and a correction
   *  chasing it to the phone is noise. Nothing is confirmed first, which is the
   *  deal with a one-tap undo; the note is the thing that cannot come back. */
  const onUnapply = useCallback(
    async (id: string) => {
      disarm();
      const jobs = await storage.get("jobs");
      const next = clearJobApplied(jobs, id);
      if (next !== jobs) await storage.set("jobs", next);
      await reload();
    },
    [disarm, reload],
  );

  /**
   * The job the open question is about, checked against the raw `jobs` map rather
   * than the rendered list: the question outlives a chip switch, a mode switch and
   * the popup itself. A job that has since been garbage-collected (PRD §7) leaves
   * nothing to ask about, and the prompt simply doesn't render.
   *
   * Being *rendered* is `JobList`'s: the question is pinned in this job's own card
   * and nowhere else, so if a chip, a New⇄All switch or a paused list has the row
   * off screen, the question is not asked yet — it waits in `pendingApplyId` and is
   * asked the next time that row is in front of you. It used to fall back to a band
   * under the header, which is how the question ended up hovering over a list it was
   * no longer about — or, as in a paused popup, over no list at all.
   */
  const pendingApplyJobId = useMemo(
    () => (pendingApplyId && state?.jobs[pendingApplyId] ? pendingApplyId : null),
    [state, pendingApplyId],
  );

  const applyPrompt = pendingApplyJobId && (
    <ApplyPrompt
      // Keyed by the job: a question about a different posting starts from
      // unanswered, never with the previous one's typed note.
      key={pendingApplyJobId}
      jobId={pendingApplyJobId}
      onAnswer={onAnswerApply}
      // The note step's "Cancel": a Yes cancelled at the note is a Yes taken back,
      // which lands in exactly the same place a No does — nothing recorded.
      onDismiss={closeApplyQuestion}
    />
  );

  /**
   * The row's tick — the only thing that dismisses a job — and, on the row with a
   * question waiting, the answer to it as well.
   *
   * Ticking a job read while it is still asking "Did you apply for this job?" is
   * an answer: you are done with the posting. It counts as No, because No is what
   * records nothing — so the tick can never write an applied record you didn't ask
   * for, and a job you *did* apply to is still one Yes away right up until you
   * dismiss it. Without this the tick would file the job away and leave its
   * question homeless, to reappear stranded above the list.
   *
   * Only the read direction answers: un-ticking a job puts it back on the list
   * with nothing waiting on it.
   */
  const onToggleRead = useCallback(
    async (id: string) => {
      disarm();
      const jobs = await storage.get("jobs");
      const read = !jobs[id]?.read;
      const next = setJobRead(jobs, id, read, Date.now());
      if (next !== jobs) await storage.set("jobs", next);
      if (read && id === pendingApplyId) await closeApplyQuestion();
      await refreshBadge();
      await reload();
    },
    [closeApplyQuestion, disarm, pendingApplyId, refreshBadge, reload],
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

  /**
   * The one thing to do about the empty state currently on screen.
   *
   * Every one of these messages used to be a dead end — "add a search in Options"
   * with no way to reach Options, "switch to All to see everything" with the
   * switch two controls away and unmentioned. Each situation has exactly one
   * obvious way out, and this is it, wired to the handler that already existed
   * for the control the user would otherwise have had to go and find.
   *
   * `scanning` gets none on purpose: waiting is the action.
   */
  const emptyAction = useMemo((): EmptyStateAction | undefined => {
    switch (view?.emptyKind) {
      case "no-watches":
        return { label: "Create your first watch", onClick: onOpenOptions };
      case "no-jobs-yet":
        return { label: "Scan now", onClick: onScan };
      // Not broken, just filtered — a sideways move, so the quieter button.
      case "no-new":
        return { label: "Show all jobs", onClick: () => onModeChange("all"), variant: "outline" };
      case "scan-error":
        return { label: "Open Options", onClick: onOpenOptions };
      default:
        return undefined;
    }
  }, [view?.emptyKind, onModeChange, onOpenOptions, onScan]);

  // How long a job you have opened survives before the garbage collector takes
  // it (PRD §7). The list's closing line says so, because "where did last week's
  // jobs go?" is otherwise a question the UI never answers.
  const openedJobDays = state?.settings.retention.openedJobDays ?? 7;

  return (
    <TooltipProvider delayDuration={400}>
      {/* Header and footer are pinned; the list between them is the only thing
          that scrolls, at every width. In the tab that means the page itself
          never scrolls — the countdown in the footer stays where you can see it
          however far down the list you are. */}
      <div
        data-variant={variant}
        className={cn(
          "flex flex-col overflow-hidden bg-background",
          variant === "popup" ? "h-150 min-h-120 w-95" : "h-screen",
        )}
      >
        {view && (
          <>
            <ListHeader
              title={view.title}
              badge={view.badge}
              scanButton={view.scanButton}
              variant={variant}
              enabled={view.enabled}
              onToggleEnabled={onToggleEnabled}
              onScan={onScan}
              onMarkAllRead={onMarkAllRead}
              onOpenTab={onOpenTab}
              onOpenOptions={onOpenOptions}
            />

            {/* Nothing between the header and the toolbar: "Did you apply for this
                job?" is asked in the job's own card further down, never as a band up
                here (see `pendingApplyJobId`). */}

            {/* Paused (§ master): the whole app body collapses to one message —
                no toolbar, no list, no footer — so the switch in the header is
                the only thing to act on. Everything below is watching-on. */}
            {view.enabled ? (
              <>
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

                {/* A transient heads-up for a click that started no new scan, or an
                    applied record whose message never left. Amber, the softest
                    banner tier — none of those cases is an error. */}
                {notice && <HealthBanner message={notice} severity="warn" />}

                {/* The list scrolls; the header above and the status bar below stay
                    put. It sits a shade darker than the header and footer so the
                    white cards read as things laid on a surface rather than as
                    strips of the page, and the column stops at 880px — a job title
                    stretched across a 27" monitor is unreadable, not spacious. */}
                <div className="flex-1 overflow-y-auto bg-[color-mix(in_oklab,var(--muted)_45%,var(--background))]">
                  <div className="mx-auto w-full max-w-220 p-2.5 md:p-3.5">
                    {/* A scan running over a list you are already reading. The
                        empty case gets skeletons below instead — replacing rows
                        you were reading with grey boxes would be worse than
                        leaving them alone. */}
                    {view.status.kind === "scanning" && view.emptyKind !== "scanning" && (
                      <ScanningBar />
                    )}

                    {view.emptyKind === "scanning" ? (
                      <ScanSkeletons />
                    ) : view.emptyKind ? (
                      <EmptyState kind={view.emptyKind} action={emptyAction} />
                    ) : (
                      <>
                        <JobList
                          jobs={view.jobs}
                          mode={view.mode}
                          variant={variant}
                          now={now}
                          armedBlockId={view.armedBlockId}
                          applyPromptJobId={pendingApplyJobId}
                          applyPrompt={applyPrompt}
                          onOpen={onOpen}
                          onToggleRead={onToggleRead}
                          onBlock={onBlock}
                          onUnapply={onUnapply}
                        />
                        {/* The end of the list, said out loud. Without it a list
                            that stops has two readings — "that's everything" and
                            "the rest hasn't loaded" — and the retention rule is
                            the answer to where last month's jobs went. Only worth
                            saying once there is enough list to scroll. */}
                        {view.visibleCount > 2 && (
                          <div className="px-1 pt-3.5 pb-1 text-center text-xs text-muted-foreground">
                            {view.visibleCount} shown · opened jobs are cleared after{" "}
                            {openedJobDays} days
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <ScanStatusBar
                  status={view.status}
                  unread={view.badge}
                  watchCount={view.chips.length}
                />
              </>
            ) : (
              <div className="flex flex-1 flex-col overflow-y-auto">
                <EmptyState
                  kind="paused"
                  action={{ label: "Turn watching on", onClick: () => onToggleEnabled(true) }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
