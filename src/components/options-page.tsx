// Options page — PRD §11 step 7. The §14 side-effect wrapper for the settings
// form: it reads/writes the `settings` storage key, renders the six sections
// (Watches, Filters, Scanning, Retention, Notifications, How this works) beside
// the rail that navigates them, and wires every control.
//
// Every DECISION lives tested elsewhere — validation, the quiet-hours time
// mapping and the §6 normalize-on-write rule in options-form.ts; the derived
// values the redesign added (the URL chips, the header summary, the per-section
// dirty dots, the daily load estimate) in settings-view.ts. This file only moves
// values between React state and those pure layers, so it is not unit-tested (the
// pattern the list view follows too). Save is explicit; a form that fails
// validation shows its errors inline and writes nothing.
//
// The shell is the list view's: header pinned, footer pinned, and only the
// settings between them scroll. On a page this long that is the difference
// between Save being where you left it and Save being something you scroll to
// find — and the header's summary line stays readable while you change the very
// numbers it describes.

import { Camera, Clock, Download, Eraser, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { AppIcon } from "@/components/app-icon.tsx";
import { HowItWorks } from "@/components/how-it-works.tsx";
import { SettingsNav } from "@/components/settings-nav.tsx";
import { TagInput } from "@/components/tag-input.tsx";
import { WatchList } from "@/components/watch-list.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { HealthBanner } from "@/components/health-banner.tsx";
import { cn } from "@/lib/utils";
import {
  backupCounts,
  backupFilename,
  backupPhrase,
  buildBackup,
  parseBackup,
  serializeBackup,
  type BackupFile,
  type ImportBackupRequest,
  type ImportBackupResponse,
} from "@/backup.ts";
import {
  captureFilename,
  captureMessage,
  isLoggedOutUrl,
  pickCaptureTab,
  type CaptureRequest,
  type CaptureResponse,
} from "@/capture.ts";
import {
  historyCounts,
  historyPhrase,
  GC_PERIOD_MINUTES,
  type ClearHistoryRequest,
  type ClearHistoryResponse,
  type HistoryCounts,
} from "@/gc.ts";
import { OK_PUSH_HEALTH, PUSH_FAILING_MESSAGE } from "@/health.ts";
import { useNow } from "@/hooks/use-now.ts";
import { IDLE_LIFECYCLE, recoverStaleLock } from "@/lifecycle.ts";
import {
  applyPushPrefill,
  changedFormKeys,
  makeBlockedCompany,
  parseSettingsForm,
  settingsToForm,
  type FormErrors,
  type OptionsFormValues,
} from "@/options-form.ts";
import {
  dirtySections,
  estimateLoad,
  headerSummary,
  loadEstimateLine,
  SECTION_LABELS,
  SETTINGS_SECTIONS,
  unsavedLabel,
  type LoadTier,
  type SettingsSection,
} from "@/settings-view.ts";
import { sendPush, type PushJob } from "@/push.ts";
import * as storage from "@/storage.ts";
import type { ScanState, Settings } from "@/types.ts";

/** The sample batch the Send-test button pushes (PRD §8): one job that exercises
 *  HTML escaping and a tappable link, so the phone check is representative of a
 *  real cycle's message without needing a scan to have run. */
const TEST_PUSH_JOBS: PushJob[] = [
  {
    title: "Test message ✓ (Senior Engineer & Lead)",
    company: "LinkedIn Job Watcher",
    location: "Send test message",
    url: "https://www.linkedin.com/jobs/",
  },
];

/**
 * Shut the settings tab the header's Close button sits in.
 *
 * `window.close()` alone is not enough: Chrome refuses it for a tab the script
 * did not open itself, and the options page is opened by the browser. So the tab
 * asks for its own id and removes itself, and `window.close()` stays only as the
 * fallback for a context that has no tab of its own to remove.
 */
async function closeSettingsTab(): Promise<void> {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  else window.close();
}

/**
 * Hand a file to the browser's downloader.
 *
 * A blob URL behind a synthetic click, rather than `chrome.downloads` — that API
 * would mean adding a `downloads` permission to the manifest, and a permission is
 * a line on the install prompt for every user forever. This costs nothing and
 * works because the options page is an ordinary tab.
 *
 * The object URL is revoked afterwards: the page is long-lived, and a blob held
 * by a URL nobody released is the whole export sitting in memory until the tab
 * closes.
 */
function downloadTextFile(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type Status = { message: string; kind: "ok" | "err" | "" };

const NO_STATUS: Status = { message: "", kind: "" };

/** How far above a section's top the scroll stops when the rail jumps to it, and
 *  how far into the viewport the spy looks for "the section you are reading". */
const SCROLL_MARGIN = 16;
const SPY_OFFSET = 80;

/** How often the scan lock is re-judged against the clock (see `scanning`). Far
 *  coarser than the list view's one-second countdown: nothing here counts down,
 *  and the only thing that changes on this tick is whether a lock has aged into
 *  staleness — which happens once, five minutes after a worker died. */
const LOCK_TICK_MS = 15_000;

/** The storage keys this page reads *outside* the settings form. The form itself
 *  is deliberately not live — repainting it would throw away unsaved edits —
 *  but these three say what there is to delete and whether deleting is possible,
 *  and both change while the page sits open. */
const RETENTION_KEYS = ["jobs", "seen", "scanState"] as const;

/** The rendered card for a section, found by the id {@link Section} gives it.
 *  Read only from the scroll handler and the rail, both of which run long after
 *  the page has mounted. */
const sectionEl = (id: SettingsSection): HTMLElement | null =>
  document.getElementById(`section-${id}`);

/**
 * One section card: the title the rail names it by, an optional badge, the
 * paragraph saying what the section is for, and the controls.
 *
 * Defined at module level rather than inside `OptionsPage` — a component
 * declared during render is a new type on every render, which would tear down
 * and rebuild every field in it on each keystroke and take the caret with it.
 */
function Section({
  id,
  badge,
  description,
  children,
}: {
  id: SettingsSection;
  badge?: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card id={`section-${id}`} className="gap-4 py-5">
      <CardHeader className="gap-1.5 px-5">
        <CardTitle className="flex flex-wrap items-center gap-2 text-[15px] tracking-tight">
          {SECTION_LABELS[id]}
          {badge}
        </CardTitle>
        <CardDescription className="text-[12.5px] leading-relaxed text-pretty">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}

/** The tone for each load tier — green for a pace that looks like a person
 *  browsing, amber past that, red where it stops being defensible (PRD §12).
 *  `block` tints the whole estimate row, not just its badge: past Gentle the
 *  number is the warning, and a warning the size of a badge gets skimmed. */
const LOAD_TIER_STYLE: Record<
  LoadTier,
  { label: string; className: string; block: string }
> = {
  gentle: {
    label: "GENTLE",
    className: "border-ok/30 bg-ok/10 text-ok",
    block: "bg-muted/50",
  },
  heavy: {
    label: "HEAVY",
    className: "border-warn/40 bg-warn/15 text-warn",
    block: "border-warn/40 bg-warn-weak/70",
  },
  risky: {
    label: "RISKY",
    className: "border-destructive/40 bg-destructive/15 text-destructive",
    block: "border-destructive/40 bg-destructive-weak/70",
  },
};

export function OptionsPage() {
  // `base` holds the fields the page doesn't edit (pacing/backoff/…) so a save
  // carries them through untouched; `form` is the live editable state.
  const [base, setBase] = useState<Settings | null>(null);
  const [form, setForm] = useState<OptionsFormValues | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [prefilled, setPrefilled] = useState(false);
  const [pushWarn, setPushWarn] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Status>(NO_STATUS);
  const [testStatus, setTestStatus] = useState<Status>(NO_STATUS);
  const [clearStatus, setClearStatus] = useState<Status>(NO_STATUS);
  const [backupStatus, setBackupStatus] = useState<Status>(NO_STATUS);
  const [captureStatus, setCaptureStatus] = useState<Status>(NO_STATUS);
  // A file that has been read and validated but not yet applied. Holding it here
  // is what makes the confirm dialog able to say what is actually in the file
  // rather than asking you to agree to an unknown quantity — and it means a
  // damaged file is reported before anything is confirmed, not after.
  const [pendingImport, setPendingImport] = useState<BackupFile | null>(null);
  // What is actually stored right now, so the Retention section can say what
  // deleting it would cost instead of asking you to confirm an unknown quantity.
  const [history, setHistory] = useState<HistoryCounts>({ jobs: 0, seen: 0 });
  // The scan lock, held raw. A cycle in flight is the one state deleting must
  // not happen in, but "in flight" is a judgement about the clock as much as
  // about the flag — see `scanning` below.
  const [scanState, setScanState] = useState<ScanState>(IDLE_LIFECYCLE);
  const [showToken, setShowToken] = useState(false);
  const [section, setSection] = useState<SettingsSection>("watches");

  // The scroll container. The sections themselves are found by id rather than by
  // ref: they are read only from the two event handlers below, and a ref per
  // section would mean a fresh ref callback on every keystroke for no gain.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The hidden `<input type="file">` behind the Import button. A file picker can
  // only be opened by a real user gesture on a real input, so the input exists
  // and is clicked; the visible control is a Button so it matches every other
  // control on the page rather than being the browser's own grey widget.
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => {
      const settings = await storage.get("settings");
      const stored = settingsToForm(settings);
      // A `npm run build:dev` bundle carries the .env credentials; a normal build
      // injects null and this is a no-op. Only blank fields are filled, so a token
      // already saved always wins, and nothing is persisted until the user saves.
      const seeded = applyPushPrefill(stored, __LJW_PREFILL_PUSH__);
      setBase(settings);
      setForm(seeded);
      setPrefilled(seeded !== stored);
      // The §16.7 soft warning, read once at load: shown in the Notifications
      // section when push has failed the threshold times in a row. A good
      // Send-test resets it in storage; not repainting mid-session (that would
      // drop unsaved edits) means the banner clears on the next open, which is
      // enough.
      setPushWarn((await storage.get("pushHealth")).warn);
      await refreshRetentionState();
    })();
  }, []);

  // The settings tab is left open for long stretches, and a cycle finishing in
  // the worker changes both how much there is to delete and whether deleting is
  // possible. Same subscription the list view runs on (use-extension-state.ts),
  // narrowed to the keys this page reads outside the form.
  useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== "local") return;
      if (RETENTION_KEYS.some((key) => key in changes)) void refreshRetentionState();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Which fields differ from storage, and so: whether Reset has anything to throw
  // away, what the header badge counts, and which rail entries wear a dot.
  const changed = useMemo(
    () => (form && base ? changedFormKeys(form, base) : []),
    [form, base],
  );
  const dirty = changed.length > 0;
  const dirtyIn = useMemo(() => dirtySections(changed), [changed]);

  const estimate = useMemo(() => (form ? estimateLoad(form) : null), [form]);

  /**
   * Whether a cycle is really in flight — the state the delete control is
   * unavailable in.
   *
   * Derived against a ticking clock rather than stored as a flag, because the
   * answer changes with time and not only with storage: a worker torn down
   * mid-cycle writes nothing further, so a `scanState` read as "scanning" would
   * stay that way for as long as this page stayed open, and the control would be
   * disabled for good. `recoverStaleLock` — the same reading the worker takes —
   * turns that stuck lock into "not scanning" once it ages past `staleLockMs`,
   * and re-deriving each tick is what lets the page notice.
   *
   * This is only the hint. The worker checks the lock again, holding it, before
   * it deletes anything.
   */
  const now = useNow(LOCK_TICK_MS);
  const scanning = useMemo(
    () =>
      base
        ? recoverStaleLock(scanState, now, base.staleLockMs).state.isScanning
        : false,
    [scanState, now, base],
  );

  if (!form || !base) return null;

  const set = <K extends keyof OptionsFormValues>(
    key: K,
    value: OptionsFormValues[K],
  ): void => setForm({ ...form, [key]: value });

  async function onSave(): Promise<void> {
    if (!form || !base) return;
    setErrors({});
    const result = parseSettingsForm(form, base);
    if (!result.ok) {
      setErrors(result.errors);
      setSaveStatus({
        message: "Some values need fixing — nothing was saved.",
        kind: "err",
      });
      return;
    }
    await storage.set("settings", result.settings);
    setBase(result.settings); // future saves carry through from what we just wrote
    // Re-seed the fields from what was actually written, so what is on screen is
    // what is in storage: " 15 " comes back as "15", a trimmed token as trimmed.
    // Without this the form stays textually different from the saved settings and
    // the page would go on claiming there are unsaved edits right after a save.
    setForm(settingsToForm(result.settings));
    // Any .env prefill is now real stored state, so the "not saved yet" notice
    // has served its purpose and should not reappear.
    setPrefilled(false);
    setSaveStatus({
      message: "Saved — the next round uses these settings.",
      kind: "ok",
    });
  }

  /** Only reached through the confirmation dialog, and only when there is
   *  something to lose — see the Reset button in the save bar. */
  function onReset(): void {
    if (!base) return;
    // Reset means "back to what is stored" — so it drops an unsaved .env prefill
    // along with every other unsaved edit, and the notice goes with it.
    setForm(settingsToForm(base));
    setErrors({});
    setPrefilled(false);
    setSaveStatus({
      message: "Reverted to the last saved settings.",
      kind: "ok",
    });
  }

  /** Prove the Telegram config end-to-end (PRD §8): send one real message with the
   *  values currently in the fields (not the last-saved ones) and report success or
   *  failure inline, so a wrong chat id shows up here instead of failing silently
   *  for days. Forces `enabled: true` for the test — the toggle governs cycle
   *  pushes, not this deliberate check — and a good send clears any §16.7 warning. */
  async function onSendTest(): Promise<void> {
    if (!form) return;
    const cfg = {
      enabled: true,
      botToken: form.pushBotToken.trim(),
      chatId: form.pushChatId.trim(),
    };
    if (!cfg.botToken || !cfg.chatId) {
      setTestStatus({
        message: "Enter a bot token and chat id first.",
        kind: "err",
      });
      return;
    }
    setTestStatus({ message: "Contacting api.telegram.org…", kind: "" });
    if (await sendPush(TEST_PUSH_JOBS, cfg)) {
      setTestStatus({ message: "Sent — check your phone.", kind: "ok" });
      await storage.set("pushHealth", OK_PUSH_HEALTH); // one good send resets §16.7
      setPushWarn(false);
    } else {
      setTestStatus({
        message: "Telegram rejected it — re-check the bot token and chat id.",
        kind: "err",
      });
    }
  }

  /** Re-read the two things the Retention section shows about *stored data*
   *  rather than about settings: how much there is, and the scan lock (which
   *  says whether deleting it is possible right now). Kept raw — the staleness
   *  judgement is derived below, against a clock, so it heals on its own. */
  async function refreshRetentionState(): Promise<void> {
    const [seen, jobs, scanState] = await Promise.all([
      storage.get("seen"),
      storage.get("jobs"),
      storage.get("scanState"),
    ]);
    setHistory(historyCounts(seen, jobs));
    setScanState(scanState);
  }

  /**
   * Ask the worker to delete every job record and every seen id — retention
   * taken to its limit by hand, for when you want to start collecting from
   * scratch. Only reached through the confirmation dialog.
   *
   * The page does not write the two keys itself: the delete has to hold the scan
   * lock or it can land inside a cycle's read-dedupe-write tail and have the
   * records it deleted written straight back (§7), and only the worker holds the
   * lock. So this asks, and reports whichever answer comes back — including the
   * refusal, which is the honest outcome when a round is in flight.
   */
  async function onClearHistory(): Promise<void> {
    setClearStatus({ message: "Deleting…", kind: "" });
    const req: ClearHistoryRequest = { type: "LJW_CLEAR_HISTORY" };
    const res = (await chrome.runtime
      .sendMessage(req)
      .catch(() => undefined)) as ClearHistoryResponse | undefined;
    await refreshRetentionState();

    if (res?.cleared) {
      setClearStatus({
        message: `Deleted ${historyPhrase(res.removed)}.`,
        kind: "ok",
      });
      return;
    }
    setClearStatus({
      message:
        res?.reason === "scanning"
          ? "A scan is running — nothing was deleted. Try again when it finishes."
          : "Nothing was deleted — the extension's background worker did not answer.",
      kind: "err",
    });
  }

  /**
   * Write the whole configuration and both history keys to a JSON file.
   *
   * Exported from **storage**, not from the form: a backup is a record of what
   * the extension is actually doing, and one taken from half-typed fields would
   * restore a state that never ran. Unsaved edits are called out beside the
   * button rather than blocking it — the file is still valid, it is just not the
   * settings on screen.
   *
   * The two Telegram secrets are not in the file. `buildBackup` is what leaves
   * them out, at the type level, and the sentence under the button says so.
   */
  function onExport(): void {
    void (async () => {
      setBackupStatus({ message: "Preparing the file…", kind: "" });
      try {
        const [settings, seen, jobs] = await Promise.all([
          storage.get("settings"),
          storage.get("seen"),
          storage.get("jobs"),
        ]);
        const now = Date.now();
        const file = buildBackup({
          settings,
          seen,
          jobs,
          exportedAt: now,
          extensionVersion: chrome.runtime.getManifest().version,
        });
        downloadTextFile(backupFilename(now), serializeBackup(file));
        setBackupStatus({
          message: `Exported ${backupPhrase(backupCounts(file))}.`,
          kind: "ok",
        });
      } catch {
        setBackupStatus({ message: "The file could not be written.", kind: "err" });
      }
    })();
  }

  /**
   * Read and validate a chosen file, then hand it to the confirm dialog.
   *
   * Validation happens here, before anything is confirmed, so a damaged or
   * foreign file is refused with a message that names the problem instead of
   * opening a dialog about a file that was never going to import.
   *
   * The input's value is cleared at the end: without it, choosing the same file
   * twice in a row fires no `change` event, and re-importing the backup you just
   * fixed would silently do nothing.
   */
  function onFileChosen(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void (async () => {
      setBackupStatus({ message: "Reading the file…", kind: "" });
      const result = parseBackup(await file.text().catch(() => ""));
      if (!result.ok) {
        setBackupStatus({ message: result.error, kind: "err" });
        return;
      }
      setBackupStatus(NO_STATUS);
      setPendingImport(result.backup);
    })();
  }

  /**
   * Apply the file the dialog just confirmed, and repaint the page from what was
   * written.
   *
   * The write goes through the worker for the reason the delete does — it touches
   * `seen` and `jobs`, and only the worker holds the scan lock that serialises
   * them (see `importBackup` in background.ts) — so this reports whichever answer
   * comes back, including the refusal while a round is in flight.
   *
   * On success the form is re-seeded from storage rather than from the file:
   * what lands in `settings` is the file's values with *this browser's* Telegram
   * credentials merged back in, and the fields must show what was actually
   * written. That also drops any unsaved edits, which is correct — a restore
   * replaces the configuration, and half of the old one surviving as a dirty
   * field would be neither state.
   */
  async function onConfirmImport(): Promise<void> {
    const backup = pendingImport;
    setPendingImport(null);
    if (!backup) return;

    setBackupStatus({ message: "Importing…", kind: "" });
    const req: ImportBackupRequest = { type: "LJW_IMPORT", backup };
    const res = (await chrome.runtime
      .sendMessage(req)
      .catch(() => undefined)) as ImportBackupResponse | undefined;

    if (res?.imported) {
      const settings = await storage.get("settings");
      setBase(settings);
      setForm(settingsToForm(settings));
      setErrors({});
      setPrefilled(false);
      setSaveStatus(NO_STATUS);
      await refreshRetentionState();
      setBackupStatus({
        message: `Imported ${backupPhrase(res.counts)}.`,
        kind: "ok",
      });
      return;
    }
    setBackupStatus({
      message:
        res?.reason === "scanning"
          ? "A scan is running — nothing was imported. Try again when it finishes."
          : "Nothing was imported — the extension's background worker did not answer.",
      kind: "err",
    });
  }

  /**
   * Save a copy of the live LinkedIn job-search page (issue #49), so a broken
   * layout can be diagnosed from the actual DOM rather than guessed at.
   *
   * The decisions are all in `capture.ts`: which open tab to capture, what the
   * file is called, and the sentence each outcome shows. This wrapper only does
   * the three side effects the ticket keeps out of the tested layer — find the
   * tabs, ask the content script to scroll and serialise the page, and download
   * the result. A signed-out session that redirected only once the tab was
   * messaged is caught here too (`isLoggedOutUrl`), because the tab URL looked
   * fine when it was picked.
   */
  function onCapturePage(): void {
    void (async () => {
      setCaptureStatus({ message: "Finding your LinkedIn job search…", kind: "" });
      const tabs = await chrome.tabs
        .query({ url: "https://www.linkedin.com/*" })
        .catch(() => [] as chrome.tabs.Tab[]);
      const pick = pickCaptureTab(tabs);
      if (!pick.ok) {
        setCaptureStatus(captureMessage({ kind: pick.reason }));
        return;
      }

      setCaptureStatus({ message: "Scrolling the results so every card loads…", kind: "" });
      const req: CaptureRequest = { type: "LJW_CAPTURE" };
      const res = (await chrome.tabs
        .sendMessage(pick.tabId, req)
        .catch(() => undefined)) as CaptureResponse | undefined;
      if (!res) {
        setCaptureStatus(captureMessage({ kind: "unreachable" }));
        return;
      }
      if (isLoggedOutUrl(res.finalUrl)) {
        setCaptureStatus(captureMessage({ kind: "logged-out" }));
        return;
      }
      if (!res.html) {
        setCaptureStatus(captureMessage({ kind: "failed" }));
        return;
      }

      downloadTextFile(captureFilename(Date.now()), res.html, "text/html");
      setCaptureStatus(captureMessage({ kind: "saved", cardCount: res.cardCount }));
    })();
  }

  /** Jump the scroll container to a section. The rail highlights it immediately
   *  rather than waiting for the scroll handler, so a click on a section already
   *  in view still moves the marker. */
  function goTo(next: SettingsSection): void {
    setSection(next);
    const el = sectionEl(next);
    const container = scrollRef.current;
    if (el && container)
      container.scrollTop = Math.max(0, el.offsetTop - SCROLL_MARGIN);
  }

  /** Which section is being read: the last one whose top has passed a line a
   *  little below the header. Cheap enough to run on every scroll event — six
   *  `offsetTop` reads — and it only calls `setSection` when the answer changes. */
  function onScroll(): void {
    const container = scrollRef.current;
    if (!container) return;
    const line = container.scrollTop + SPY_OFFSET;
    let current: SettingsSection = SETTINGS_SECTIONS[0];
    for (const key of SETTINGS_SECTIONS) {
      const el = sectionEl(key);
      if (el && el.offsetTop <= line) current = key;
    }
    setSection((prev) => (prev === current ? prev : current));
  }

  /** One whole-number field, with its hint and its inline error. `governsCadence`
   *  marks the fields only the automatic rounds read: the manual-only switch dims
   *  and disables those, and leaves the rest (page depth, retention) alone —
   *  a manual round is a full round and reads them exactly as a timed one does. */
  const numField = (
    key: keyof OptionsFormValues,
    label: string,
    min: number,
    hint: string,
    governsCadence = false,
  ) => (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        governsCadence && form.manualOnly && "opacity-50",
      )}
    >
      <Label htmlFor={key} className="text-xs">
        {label}
      </Label>
      <Input
        id={key}
        type="number"
        min={min}
        value={String(form[key])}
        disabled={governsCadence && form.manualOnly}
        aria-invalid={Boolean(errors[key])}
        onChange={(e) =>
          set(key, e.target.value as OptionsFormValues[typeof key])
        }
      />
      {errors[key] ? (
        <p data-err={key} className="text-[11.5px] text-destructive">
          {errors[key]}
        </p>
      ) : (
        <span className="text-[11.5px] leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );

  const activeWatches = form.watches.filter((w) => w.enabled).length;
  const tier = estimate ? LOAD_TIER_STYLE[estimate.tier] : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Pinned. It carries the one-line summary of the whole configuration, so
          it is worth the two lines it costs at every scroll position: change the
          interval down the page and this is what tells you what you just did. */}
      <header className="flex shrink-0 items-center gap-3.5 border-b bg-background px-4 py-2.5 md:px-6">
        {/* The app mark — the extension's own icon, as shipped to the toolbar. */}
        <AppIcon className="size-6.5" />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[15px] font-semibold tracking-tight whitespace-nowrap">
              LinkedIn Job Watcher{" "}
              <span className="font-medium text-muted-foreground">
                — Settings
              </span>
            </h1>
            {dirty && (
              <Badge
                id="unsaved-badge"
                variant="outline"
                className="border-warn/30 bg-warn-weak/70 px-2 py-0 text-[10.5px] text-warn"
              >
                {unsavedLabel(changed.length)}
              </Badge>
            )}
          </div>
          {/* Derived from the form rather than from storage, so it describes what
              you are about to save, not what you saved last. */}
          <span
            id="header-summary"
            className="truncate text-xs text-muted-foreground"
          >
            {headerSummary(form)}
          </span>
        </div>

        {/* The way out: settings open in their own tab, so the way out is to shut
            it rather than to travel somewhere else. */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          id="close-settings"
          onClick={() => void closeSettingsTab()}
          className="shrink-0"
        >
          <X className="size-3.5" />
          Close
        </Button>
      </header>

      {/* The only thing that scrolls: one scrollbar, at the edge of the window,
          for the whole body. `relative` because the spy measures each section's
          `offsetTop` against this box. A shade darker than the header and footer,
          so the cards read as things laid on a surface rather than as strips of
          the page — the same treatment the job list uses. The rail scrolls with
          it in markup only — it is stuck from the first pixel (see
          settings-nav.tsx), so it holds still while the settings move past it. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative flex-1 overflow-y-auto bg-[color-mix(in_oklab,var(--muted)_45%,var(--background))]"
      >
        <div className="mx-auto flex w-full max-w-275 flex-wrap items-start gap-4 p-4 md:p-6">
          <SettingsNav active={section} dirty={dirtyIn} onSelect={goTo} />

          <main className="flex min-w-0 flex-1 basis-115 flex-col gap-3.5">
            <Section
              id="watches"
              badge={
                <Badge
                  variant="secondary"
                  className="px-2 py-0 text-[10.5px] font-medium"
                >
                  {activeWatches} of {form.watches.length} active
                </Badge>
              }
              description="A watch is a saved LinkedIn search with your filters already applied. Every watch runs on the same cycle — switch one off to pause it without losing the URL."
            >
              <WatchList
                watches={form.watches}
                onChange={(w) => set("watches", w)}
              />
            </Section>

            <Section
              id="filters"
              description="Anything matched here never reaches the list or the notification count. Matching is partial and case-insensitive, so “hire” also blocks “Quik Hire Staffing”."
            >
              <div className="flex flex-col gap-5">
                <TagInput
                  id="company"
                  label="Blocked companies"
                  placeholder="Add a company to block, then Enter…"
                  values={form.blockedCompanies.map((c) => c.display)}
                  onAdd={(v) =>
                    set("blockedCompanies", [
                      ...form.blockedCompanies,
                      makeBlockedCompany(v),
                    ])
                  }
                  onRemove={(i) =>
                    set(
                      "blockedCompanies",
                      form.blockedCompanies.filter((_, idx) => idx !== i),
                    )
                  }
                />
                <TagInput
                  id="keyword"
                  label="Blocked title keywords"
                  placeholder="Add a keyword to block, then Enter…"
                  values={form.blockedTitleKeywords}
                  onAdd={(v) =>
                    set("blockedTitleKeywords", [
                      ...form.blockedTitleKeywords,
                      v,
                    ])
                  }
                  onRemove={(i) =>
                    set(
                      "blockedTitleKeywords",
                      form.blockedTitleKeywords.filter((_, idx) => idx !== i),
                    )
                  }
                />
                <ToggleRow
                  id="hide-reposted"
                  label="Hide jobs marked “Reposted”"
                  description="LinkedIn re-lists old postings; they arrive as new but rarely are."
                  checked={form.hideReposted}
                  onChange={(v) => set("hideReposted", v)}
                />
              </div>
            </Section>

            <Section
              id="scanning"
              description="Every page is a real load against LinkedIn, so the shipped depth is deliberately shallow. Raise it only if you find you are actually missing postings."
            >
              <div className="flex flex-col gap-4">
                {/* First in the section because it decides whether anything below
                    it runs at all: the schedule reads differently once you know
                    nothing is on a timer. */}
                <ToggleRow
                  id="manual-only"
                  label="Only scan when I press Scan now"
                  description={
                    form.manualOnly
                      ? "Nothing runs on a timer. Your searches stay switched on and the list, the toolbar count and Telegram all keep working — but LinkedIn is only opened when you press Scan now."
                      : "Rounds run on the schedule below. Switch this on to keep every search but decide yourself when they run — the schedule is kept, just not used."
                  }
                  checked={form.manualOnly}
                  onChange={(v) => set("manualOnly", v)}
                />

                <Separator />

                {/* Two by two rather than one row of four: the four numbers pair
                    up (how often, then how deep), and a 4-wide row squeezes the
                    hints under each field into three-line columns. */}
                <div className="grid gap-3.5 sm:grid-cols-2">
                  {numField(
                    "intervalMinutes",
                    "Interval (minutes)",
                    1,
                    "Gap between rounds. Under 15 gets noticed.",
                    true,
                  )}
                  {numField(
                    "jitterMinutes",
                    "Jitter (± minutes)",
                    0,
                    "Random wobble, so rounds are not clockwork. 60 ± 30 lands anywhere in 30–90 min.",
                    true,
                  )}
                  {numField(
                    "pagesPerScan",
                    "Pages per scan",
                    1,
                    "1 page ≈ 25 postings, newest first.",
                  )}
                  {numField(
                    "catchUpPages",
                    "Catch-up pages",
                    1,
                    "Deeper first round after Chrome starts.",
                  )}
                </div>

                {/* The four numbers above have a combined effect nothing else on
                    the page states: halving the interval and adding a page is a
                    fourfold increase. This is that, as one figure. */}
                {estimate && tier && (
                  <div
                    id="load-estimate"
                    className={cn(
                      "flex flex-wrap items-center gap-2.5 rounded-xl border px-3 py-2.5",
                      tier.block,
                    )}
                  >
                    <Badge
                      variant="outline"
                      className={cn(
                        "px-2 py-0 text-[10.5px] font-semibold tracking-[0.06em]",
                        tier.className,
                      )}
                    >
                      {tier.label}
                    </Badge>
                    <span className="min-w-0 flex-1 basis-60 text-[12.5px] leading-snug">
                      {loadEstimateLine(estimate)}
                    </span>
                  </div>
                )}

                <Separator />

                {/* Quiet hours only ever silenced the automatic rounds, so with
                    manual-only on there is nothing left for them to silence — the
                    whole row goes inert, and keeps the window you set. */}
                <ToggleRow
                  id="quiet-enabled"
                  label="Pause during quiet hours"
                  description={
                    form.manualOnly
                      ? "Nothing to pause while only you start the rounds — a Scan now runs whenever you press it."
                      : form.quietHoursEnabled
                        ? "No rounds between these times; one catch-up round runs when they end."
                        : "Rounds keep running all night, which is the least human-looking pattern."
                  }
                  checked={form.quietHoursEnabled}
                  disabled={form.manualOnly}
                  onChange={(v) => set("quietHoursEnabled", v)}
                >
                  {/* Dimmed and inert rather than hidden when quiet hours are off:
                      the times you set are still the times you would go back to,
                      and a control that vanishes takes its value with it. */}
                  <div
                    className={cn(
                      "mt-2.5 flex flex-wrap gap-3",
                      // Not dimmed again for manual-only: the row above already
                      // fades as a whole, and two stacked opacities read as broken.
                      !form.quietHoursEnabled &&
                        "pointer-events-none opacity-50",
                    )}
                  >
                    <div className="flex w-37 flex-col gap-1.5">
                      <Label htmlFor="quietStart" className="text-xs">
                        Starts
                      </Label>
                      <Input
                        id="quietStart"
                        type="time"
                        value={form.quietStart}
                        disabled={!form.quietHoursEnabled || form.manualOnly}
                        aria-invalid={Boolean(errors.quietStart)}
                        onChange={(e) => set("quietStart", e.target.value)}
                      />
                      {errors.quietStart && (
                        <p
                          data-err="quietStart"
                          className="text-[11.5px] text-destructive"
                        >
                          {errors.quietStart}
                        </p>
                      )}
                    </div>
                    <div className="flex w-37 flex-col gap-1.5">
                      <Label htmlFor="quietEnd" className="text-xs">
                        Ends
                      </Label>
                      <Input
                        id="quietEnd"
                        type="time"
                        value={form.quietEnd}
                        disabled={!form.quietHoursEnabled || form.manualOnly}
                        aria-invalid={Boolean(errors.quietEnd)}
                        onChange={(e) => set("quietEnd", e.target.value)}
                      />
                      {errors.quietEnd && (
                        <p
                          data-err="quietEnd"
                          className="text-[11.5px] text-destructive"
                        >
                          {errors.quietEnd}
                        </p>
                      )}
                    </div>
                  </div>
                </ToggleRow>
              </div>
            </Section>

            <Section
              id="retention"
              description="Seen ids are what stop a job coming back a second time — keep them longer than the age of the postings your searches return."
            >
              <div className="flex flex-col gap-3.5">
                <div className="grid gap-3.5 sm:grid-cols-2">
                  {numField(
                    "seenDays",
                    "Seen ids (days)",
                    1,
                    "How long a job stays “already shown”.",
                  )}
                  {numField(
                    "openedJobDays",
                    "Opened jobs (days)",
                    1,
                    "Rows you opened or ticked off.",
                  )}
                  {numField(
                    "unopenedJobDays",
                    "Unopened jobs (days)",
                    1,
                    "Rows you never touched.",
                  )}
                  {numField(
                    "seenHardCap",
                    "Seen hard cap",
                    1,
                    "A backstop; past it the oldest ids drop first.",
                  )}
                </div>
                {/* When the numbers above are acted on, said plainly: they are
                    enforced once a day rather than the moment you save, so a
                    record you have just put outside its limit lives until the
                    next clean-up. */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock aria-hidden="true" className="size-3.5 shrink-0" />
                  <span>
                    Enforced by a clean-up that runs every{" "}
                    {GC_PERIOD_MINUTES / 60} hours, never during a scan.
                  </span>
                </div>

                <Separator />

                {/* The one control on this page that destroys data outright, so
                    it names the quantity before you agree to lose it and sits
                    behind the same confirm the footer's Reset uses. */}
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
                  <div className="min-w-0 flex-1 basis-65">
                    <p className="text-[13px] font-semibold">
                      Delete all job history
                    </p>
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground text-pretty">
                      Start collecting from scratch. Holding{" "}
                      <span className="font-medium text-foreground">
                        {historyPhrase(history)}
                      </span>{" "}
                      right now. Your settings are not touched.
                      {scanning && " Unavailable while a scan is running."}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <StatusText id="clear-status" status={clearStatus} />
                    {/* Nothing stored is nothing to delete, so the button is
                        disabled rather than opening a dialog about nothing —
                        the rule Reset follows in the save bar. */}
                    <AlertDialog
                      onOpenChange={(open) => {
                        if (open) void refreshRetentionState();
                      }}
                    >
                      <AlertDialogTrigger asChild>
                        {/* Eraser, not the bin: the bin is the Watches list's
                            "remove this one", and one page must not use one icon
                            for two different acts. */}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          id="clear-history"
                          disabled={
                            scanning ||
                            (history.jobs === 0 && history.seen === 0)
                          }
                          className="text-destructive hover:text-destructive"
                        >
                          <Eraser aria-hidden="true" />
                          Delete history
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete all job history?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This deletes {historyPhrase(history)} from this
                            browser, and there is no undo. Your settings —
                            watches, filters, times, Telegram — are left exactly
                            as they are. Because the memory of what has already
                            been shown goes too, the next round will treat
                            postings still live on LinkedIn as new and announce
                            them again.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel id="clear-history-cancel">
                            Keep it
                          </AlertDialogCancel>
                          <AlertDialogAction
                            id="clear-history-confirm"
                            onClick={() => void onClearHistory()}
                            className={cn(
                              buttonVariants({ variant: "destructive" }),
                            )}
                          >
                            Delete history
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>
            </Section>

            <Section
              id="notifications"
              description="One notification per round that found something — never one per job. The toolbar count always updates, whatever you switch off here."
            >
              <div className="flex flex-col gap-4">
                {pushWarn && (
                  <HealthBanner
                    message={PUSH_FAILING_MESSAGE}
                    severity="warn"
                    className="rounded-md border"
                  />
                )}
                {prefilled && (
                  <HealthBanner
                    message="Filled in from your .env by `npm run build:dev` — press Save settings to keep it."
                    severity="warn"
                    className="rounded-md border"
                  />
                )}

                <ToggleRow
                  id="notify-desktop"
                  label="Desktop notification"
                  description="Clicking it opens this extension's own list, not LinkedIn. Off silences the pop-up only — the toolbar count still moves."
                  checked={form.notifyDesktop}
                  onChange={(v) => set("notifyDesktop", v)}
                />

                <Separator />

                <ToggleRow
                  id="push-enabled"
                  label="Also push to Telegram"
                  description="For when you are away from this machine. The token and chat id stay in this browser — they are only ever sent to Telegram, and never committed."
                  checked={form.pushEnabled}
                  onChange={(v) => set("pushEnabled", v)}
                >
                  {/* The credentials stay reachable with the toggle off: Send test
                      message works either way, so you can prove a token before
                      you switch the pushes on. */}
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="flex min-w-0 flex-1 basis-65 flex-col gap-1.5">
                      <Label htmlFor="pushBotToken" className="text-xs">
                        Bot token
                      </Label>
                      <div className="flex items-center gap-1.5">
                        <Input
                          id="pushBotToken"
                          type={showToken ? "text" : "password"}
                          autoComplete="off"
                          value={form.pushBotToken}
                          placeholder="123456:ABC-DEF…"
                          onChange={(e) => set("pushBotToken", e.target.value)}
                        />
                        {/* A token is long, pasted, and impossible to check by
                            eye through dots — so it can be looked at. */}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          id="toggle-token"
                          aria-pressed={showToken}
                          onClick={() => setShowToken((v) => !v)}
                          className="shrink-0 text-muted-foreground"
                        >
                          {showToken ? "Hide" : "Show"}
                        </Button>
                      </div>
                    </div>
                    <div className="flex w-44 flex-col gap-1.5">
                      <Label htmlFor="pushChatId" className="text-xs">
                        Chat id
                      </Label>
                      <Input
                        id="pushChatId"
                        type="text"
                        autoComplete="off"
                        value={form.pushChatId}
                        placeholder="987654321"
                        onChange={(e) => set("pushChatId", e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      id="send-test"
                      onClick={onSendTest}
                    >
                      Send test message
                    </Button>
                  </div>
                  <StatusText
                    id="test-status"
                    status={testStatus}
                    className="mt-2.5 block"
                  />
                </ToggleRow>
              </div>
            </Section>

            <Section
              id="backup"
              description="One JSON file holding everything above — your watches, both blocklists, the schedule, retention, and the job history that stops a posting being announced twice. Your Telegram bot token and chat id are never written to it."
            >
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
                  <div className="min-w-0 flex-1 basis-65">
                    <p className="text-[13px] font-semibold">Export to a file</p>
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground text-pretty">
                      Saves what is{" "}
                      <span className="font-medium text-foreground">stored</span>{" "}
                      right now, including {historyPhrase(history)}.
                      {/* A backup is a record of what the extension is actually
                          doing, so it comes from storage rather than from the
                          fields — worth saying while a dirty badge is showing,
                          because otherwise the file looks like it lost an edit. */}
                      {dirty &&
                        " Your unsaved edits are not in it — press Save settings first if you want them."}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    id="export-backup"
                    onClick={onExport}
                    className="shrink-0"
                  >
                    <Download aria-hidden="true" />
                    Export backup
                  </Button>
                </div>

                <Separator />

                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
                  <div className="min-w-0 flex-1 basis-65">
                    <p className="text-[13px] font-semibold">Import a file</p>
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground text-pretty">
                      Replaces everything in the file — it is a restore, not a
                      merge, so anything not in the file goes. Your Telegram
                      credentials are kept.
                      {scanning && " Unavailable while a scan is running."}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {/* Clicked by the button beside it; never shown, because the
                        browser's own file widget matches nothing else here. */}
                    <input
                      ref={fileRef}
                      type="file"
                      id="import-file"
                      accept="application/json,.json"
                      hidden
                      onChange={onFileChosen}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      id="import-backup"
                      disabled={scanning}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Upload aria-hidden="true" />
                      Import backup
                    </Button>
                  </div>
                </div>

                {/* One line for both halves of the section, under them rather
                    than beside either: the messages are whole sentences — a
                    parse error names a field — and they have no room on a row
                    that already ends in a button. */}
                <StatusText
                  id="backup-status"
                  status={backupStatus}
                  className="block text-right"
                />

                {/* Opened by a file having been read and validated, not by a
                    click — which is why it is controlled rather than wrapped
                    around a trigger. By the time it appears the file's contents
                    are known, so it can name them. */}
                <AlertDialog
                  open={pendingImport !== null}
                  onOpenChange={(open) => {
                    if (!open) setPendingImport(null);
                  }}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Replace your settings and history?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This backup holds{" "}
                        {pendingImport
                          ? backupPhrase(backupCounts(pendingImport))
                          : "nothing"}
                        , and importing it replaces what is in this browser
                        outright — watches, filters, schedule, retention, job
                        records and seen ids. Anything not in the file is
                        removed, and there is no undo. Your Telegram bot token
                        and chat id are the one exception: they are never in a
                        backup, so the ones saved here are kept.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel id="import-cancel">
                        Keep what I have
                      </AlertDialogCancel>
                      <AlertDialogAction
                        id="import-confirm"
                        onClick={() => void onConfirmImport()}
                        className={cn(
                          buttonVariants({ variant: "destructive" }),
                        )}
                      >
                        Import and replace
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </Section>

            <Section
              id="diagnostics"
              description="For when the extension warns that it has stopped reading LinkedIn’s page. Saving a copy of your open job search captures the exact page it is failing on, so the layout change can be diagnosed from the real thing instead of guessed at."
            >
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
                  <div className="min-w-0 flex-1 basis-65">
                    <p className="text-[13px] font-semibold">Save a copy of this page</p>
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground text-pretty">
                      Open your job search on LinkedIn in another tab, then press this. It
                      scrolls the results so every card loads and writes the page to an
                      HTML file.
                      {/* The file is the user's own logged-in search — company names,
                          job titles, everything LinkedIn renders about the account. Said
                          plainly, and *before* the file is written, so it is never shared
                          by surprise. Same class of data as the gitignored fixtures. */}
                      <span className="font-medium text-foreground">
                        {" "}
                        The file holds your own job-search results — company names, job
                        titles and whatever else LinkedIn shows you — so keep it to
                        yourself unless you mean to share it.
                      </span>
                    </p>
                  </div>
                  {/* Camera — a snapshot of the page. Not the Export row's Download,
                      which saves a settings file, nor any other icon on the page:
                      one glyph, one action. */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    id="capture-page"
                    onClick={onCapturePage}
                    className="shrink-0"
                  >
                    <Camera aria-hidden="true" />
                    Save a copy of this page
                  </Button>
                </div>

                {/* Whole-sentence outcomes — a failure names the next step — so the
                    status gets its own line under the row rather than a corner of it,
                    the same as the Backup section. */}
                <StatusText
                  id="capture-status"
                  status={captureStatus}
                  className="block text-right"
                />
              </div>
            </Section>

            <Section
              id="how"
              description="It re-runs your saved searches in the background and tells you when something genuinely new turns up — so you can stop refreshing the tab yourself."
            >
              <HowItWorks />
            </Section>
          </main>
        </div>
      </div>

      {/* Pinned, for the same reason the header is: Save should never be
          somewhere you have to hunt for. Opaque rather than translucent — it
          passes over white cards, and letting those bleed through made it read
          as a rendering artefact instead of a bar. */}
      <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t bg-background px-4 py-2.5 md:px-6 justify-between">
        <p className="min-w-0 flex-1 basis-65 text-xs leading-snug text-faint text-pretty">
          <span className="font-semibold">Personal use only</span> · keep the
          frequency low, and switch watching off when you are not looking for
          work.
        </p>
        {/* The save word and the buttons it belongs to read as one thing, so they
            sit on one line — the message to the left of the button it describes,
            not stacked over it. */}
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          {/* Allowed to shrink and wrap, so a long message narrows itself rather
              than shoving Save off the end of a narrow window. */}
          <StatusText
            id="save-status"
            status={saveStatus}
            className="min-w-0 shrink text-right text-balance"
          />
          <div className="flex shrink-0 items-center gap-2">
            {/* Reset throws away work with no undo, and it stands right next to
              Save — so it asks first. A modal here, unlike the list view's
              in-layout questions: this one is about the page it would change, and
              there is nothing to go on looking at while you answer it. With no
              unsaved edits it has nothing to throw away, so the button is
              disabled rather than opening a dialog about nothing. */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  id="reset"
                  disabled={!dirty}
                >
                  Reset
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Discard your unsaved changes?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Every field goes back to the settings last saved. Anything
                    typed since — watches added, filters, times, Telegram
                    credentials — is lost, and there is no undo. Nothing already
                    saved is deleted, and no jobs are touched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  {/* The way out is the wide, safe one; the act that costs
                    something wears destructive and sits under the thumb. */}
                  <AlertDialogCancel id="reset-cancel">
                    Keep editing
                  </AlertDialogCancel>
                  <AlertDialogAction
                    id="reset-confirm"
                    onClick={onReset}
                    className={cn(buttonVariants({ variant: "destructive" }))}
                  >
                    Discard changes
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {/* Disabled with nothing to save, and saying so: a live Save on an
              untouched form invites a click that does nothing and reports
              success. */}
            <Button type="button" id="save" onClick={onSave} disabled={!dirty}>
              {dirty ? "Save settings" : "Saved"}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** A switch with its label and the sentence that says what switching it off
 *  actually costs — the settings that used to be a bare label each needed one.
 *  `children` is whatever the switch reveals or governs, laid under the text so
 *  it reads as belonging to the row rather than following it. `disabled` is for a
 *  row another switch has made moot: it dims and blocks the control — keyboard
 *  included, which a dimmed wrapper alone would not — while leaving its value be. */
function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
  children,
}: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-3", disabled && "opacity-50")}>
      <div className="pt-0.5">
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </div>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-[13px] font-semibold">
          {label}
        </Label>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
          {description}
        </p>
        {children}
      </div>
    </div>
  );
}

function StatusText({
  id,
  status,
  className,
}: {
  id: string;
  status: Status;
  className?: string;
}) {
  if (!status.message) return null;
  return (
    <span
      id={id}
      role="status"
      className={cn(
        "shrink-0 text-xs",
        status.kind === "ok" && "text-ok",
        status.kind === "err" && "text-destructive",
        status.kind === "" && "text-muted-foreground",
        className,
      )}
    >
      {status.message}
    </span>
  );
}
