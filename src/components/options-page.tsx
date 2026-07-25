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

import { Clock, Eye, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import { OK_PUSH_HEALTH, PUSH_FAILING_MESSAGE } from "@/health.ts";
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
import type { Settings } from "@/types.ts";

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

type Status = { message: string; kind: "ok" | "err" | "" };

const NO_STATUS: Status = { message: "", kind: "" };

/** How far above a section's top the scroll stops when the rail jumps to it, and
 *  how far into the viewport the spy looks for "the section you are reading". */
const SCROLL_MARGIN = 16;
const SPY_OFFSET = 80;

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

/** The badge tone for each load tier — green for a pace that looks like a person
 *  browsing, amber past that, red where it stops being defensible (PRD §12). */
const LOAD_TIER_STYLE: Record<LoadTier, { label: string; className: string }> =
  {
    gentle: { label: "Gentle", className: "border-ok/30 bg-ok/10 text-ok" },
    heavy: {
      label: "Heavy",
      className: "border-warn/30 bg-warn-weak/70 text-warn",
    },
    risky: {
      label: "Risky",
      className:
        "border-destructive/30 bg-destructive-weak/70 text-destructive",
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
  const [showToken, setShowToken] = useState(false);
  const [section, setSection] = useState<SettingsSection>("watches");

  // The scroll container. The sections themselves are found by id rather than by
  // ref: they are read only from the two event handlers below, and a ref per
  // section would mean a fresh ref callback on every keystroke for no gain.
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
    })();
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
        {/* The app mark: the watching eye, the one thing this extension does. */}
        <span
          aria-hidden="true"
          className="flex size-6.5 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <Eye className="size-3.5" />
        </span>

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

                <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
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
                    className="flex flex-wrap items-center gap-2.5 rounded-xl border bg-muted/50 px-3 py-2.5"
                  >
                    <Badge
                      variant="outline"
                      className={cn("px-2 py-0 text-[10.5px]", tier.className)}
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
                <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
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
                {/* Said out loud because the alternative is a section of controls
                    that quietly does nothing — the collector is written and tested
                    (gc.ts) but nothing calls it yet, so these values are stored and
                    not yet acted on. See the README's known limitations. */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock aria-hidden="true" className="size-3.5 shrink-0" />
                  <span>
                    The daily clean-up is not wired up yet — these are saved,
                    and take effect as soon as it is.
                  </span>
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
