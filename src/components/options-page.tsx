// Options page — PRD §11 step 7. The §14 side-effect wrapper for the settings
// form: it reads/writes the `settings` storage key, renders the five section
// cards (Searches, Filters, Scanning, Telegram push, Retention), and wires every
// control.
//
// Every DECISION lives tested in options-form.ts — validation, the quiet-hours
// time mapping, and the §6 normalize-on-write rule. This file only moves values
// between React state and that pure layer, so it is not unit-tested (the pattern
// the list view follows too). Save is explicit; a form that fails validation
// shows its errors inline and writes nothing.

import { useEffect, useState } from "react";

import { TagInput } from "@/components/tag-input.tsx";
import { WatchList } from "@/components/watch-list.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { HealthBanner } from "@/components/health-banner.tsx";
import { cn } from "@/lib/utils";
import { OK_PUSH_HEALTH, PUSH_FAILING_MESSAGE } from "@/health.ts";
import {
  applyPushPrefill,
  makeBlockedCompany,
  parseSettingsForm,
  parseWatchInput,
  settingsToForm,
  type FormErrors,
  type OptionsFormValues,
} from "@/options-form.ts";
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

type Status = { message: string; kind: "ok" | "err" | "" };

const NO_STATUS: Status = { message: "", kind: "" };

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
  const [newWatch, setNewWatch] = useState({ name: "", url: "" });
  const [newWatchError, setNewWatchError] = useState("");

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
      // The §16.7 soft warning, read once at load: shown in the Telegram card when
      // push has failed the threshold times in a row. A good Send-test resets it in
      // storage; not repainting mid-session (that would drop unsaved edits) means
      // the banner clears on the next open, which is enough.
      setPushWarn((await storage.get("pushHealth")).warn);
    })();
  }, []);

  if (!form || !base) return null;

  const set = <K extends keyof OptionsFormValues>(key: K, value: OptionsFormValues[K]): void =>
    setForm({ ...form, [key]: value });

  async function onSave(): Promise<void> {
    if (!form || !base) return;
    setErrors({});
    const result = parseSettingsForm(form, base);
    if (!result.ok) {
      setErrors(result.errors);
      setSaveStatus({ message: "Some values need fixing — nothing was saved.", kind: "err" });
      return;
    }
    await storage.set("settings", result.settings);
    setBase(result.settings); // future saves carry through from what we just wrote
    // Any .env prefill is now real stored state, so the "not saved yet" notice
    // has served its purpose and should not reappear.
    setPrefilled(false);
    setSaveStatus({ message: "Saved.", kind: "ok" });
  }

  function onReset(): void {
    if (!base) return;
    // Reset means "back to what is stored" — so it drops an unsaved .env prefill
    // along with every other unsaved edit, and the notice goes with it.
    setForm(settingsToForm(base));
    setErrors({});
    setPrefilled(false);
    setSaveStatus({ message: "Reverted to the last saved settings.", kind: "ok" });
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
      setTestStatus({ message: "Enter a bot token and chat id first.", kind: "err" });
      return;
    }
    setTestStatus({ message: "Sending…", kind: "" });
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

  function onAddSearch(): void {
    const parsed = parseWatchInput(newWatch.name, newWatch.url);
    if (!parsed.ok) {
      setNewWatchError(parsed.errors.name ?? parsed.errors.url ?? "Invalid search.");
      return;
    }
    setNewWatchError("");
    set("watches", [
      ...form!.watches,
      { id: crypto.randomUUID(), name: parsed.value.name, url: parsed.value.url, enabled: true },
    ]);
    setNewWatch({ name: "", url: "" });
  }

  /** One whole-number field, with its inline error. */
  const numField = (key: keyof OptionsFormValues, label: string, min: number) => (
    <div className="flex flex-1 flex-col gap-1.5">
      <Label htmlFor={key}>{label}</Label>
      <Input
        id={key}
        type="number"
        min={min}
        value={String(form[key])}
        aria-invalid={Boolean(errors[key])}
        onChange={(e) => set(key, e.target.value as OptionsFormValues[typeof key])}
      />
      {errors[key] && (
        <p data-err={key} className="text-xs text-destructive">
          {errors[key]}
        </p>
      )}
    </div>
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
      <h1 className="text-xl font-semibold">LinkedIn Job Watcher — Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Searches</CardTitle>
          <CardDescription>
            Saved LinkedIn job-search URLs with your filters already applied. Each runs on the
            same cycle; toggle any off to pause it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <WatchList watches={form.watches} onChange={(w) => set("watches", w)} />
          <div className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex flex-col gap-1.5 sm:w-48">
                <Label htmlFor="new-name">Nickname</Label>
                <Input
                  id="new-name"
                  value={newWatch.name}
                  placeholder="e.g. Singapore"
                  onChange={(e) => setNewWatch({ ...newWatch, name: e.target.value })}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="new-url">Search URL</Label>
                <Input
                  id="new-url"
                  value={newWatch.url}
                  placeholder="https://www.linkedin.com/jobs/search/?…"
                  onChange={(e) => setNewWatch({ ...newWatch, url: e.target.value })}
                />
              </div>
            </div>
            {newWatchError && (
              <p id="new-search-error" className="text-xs text-destructive">
                {newWatchError}
              </p>
            )}
            <Button type="button" id="add-search" onClick={onAddSearch} className="self-start">
              Add search
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Company names match partially, case-insensitive.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <TagInput
            id="company"
            label="Blocked companies"
            placeholder="Add a company to block, then Enter…"
            values={form.blockedCompanies.map((c) => c.display)}
            onAdd={(v) => set("blockedCompanies", [...form.blockedCompanies, makeBlockedCompany(v)])}
            onRemove={(i) =>
              set("blockedCompanies", form.blockedCompanies.filter((_, idx) => idx !== i))
            }
          />
          <TagInput
            id="keyword"
            label="Blocked title keywords"
            placeholder="Add a keyword to block, then Enter…"
            values={form.blockedTitleKeywords}
            onAdd={(v) => set("blockedTitleKeywords", [...form.blockedTitleKeywords, v])}
            onRemove={(i) =>
              set("blockedTitleKeywords", form.blockedTitleKeywords.filter((_, idx) => idx !== i))
            }
          />
          <ToggleRow
            id="hide-reposted"
            label="Hide jobs marked “Reposted”"
            checked={form.hideReposted}
            onChange={(v) => set("hideReposted", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scanning</CardTitle>
          <CardDescription>
            Lower the depth if you don't need it — every page is a real load against LinkedIn
            (PRD §12).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            {numField("intervalMinutes", "Interval (minutes)", 1)}
            {numField("jitterMinutes", "Jitter (± minutes)", 0)}
          </div>
          <div className="flex flex-col gap-4 sm:flex-row">
            {numField("pagesPerScan", "Pages per scan", 1)}
            {numField("catchUpPages", "Catch-up pages (on startup)", 1)}
          </div>
          <ToggleRow
            id="quiet-enabled"
            label="Pause scanning during quiet hours"
            checked={form.quietHoursEnabled}
            onChange={(v) => set("quietHoursEnabled", v)}
          />
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="quietStart">Quiet hours start</Label>
              <Input
                id="quietStart"
                type="time"
                value={form.quietStart}
                aria-invalid={Boolean(errors.quietStart)}
                onChange={(e) => set("quietStart", e.target.value)}
              />
              {errors.quietStart && (
                <p data-err="quietStart" className="text-xs text-destructive">
                  {errors.quietStart}
                </p>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="quietEnd">Quiet hours end</Label>
              <Input
                id="quietEnd"
                type="time"
                value={form.quietEnd}
                aria-invalid={Boolean(errors.quietEnd)}
                onChange={(e) => set("quietEnd", e.target.value)}
              />
              {errors.quietEnd && (
                <p data-err="quietEnd" className="text-xs text-destructive">
                  {errors.quietEnd}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telegram push</CardTitle>
          <CardDescription>
            Optional: also deliver new jobs to your phone via a Telegram bot, additive to the
            desktop notification (PRD §8). Nothing here is stored anywhere but this browser —
            never committed. Use <b>Send test message</b> to confirm the credentials before
            trusting it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
            id="push-enabled"
            label="Send new jobs to Telegram"
            checked={form.pushEnabled}
            onChange={(v) => set("pushEnabled", v)}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pushBotToken">Bot token</Label>
            <Input
              id="pushBotToken"
              type="password"
              autoComplete="off"
              value={form.pushBotToken}
              placeholder="123456:ABC-DEF…"
              onChange={(e) => set("pushBotToken", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pushChatId">Chat id</Label>
            <Input
              id="pushChatId"
              type="text"
              autoComplete="off"
              value={form.pushChatId}
              placeholder="987654321"
              onChange={(e) => set("pushChatId", e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" id="send-test" onClick={onSendTest}>
              Send test message
            </Button>
            <StatusText id="test-status" status={testStatus} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retention</CardTitle>
          <CardDescription>
            How long records are kept before daily clean-up prunes them (PRD §7).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            {numField("seenDays", "Seen IDs (days)", 1)}
            {numField("openedJobDays", "Opened jobs (days)", 1)}
          </div>
          <div className="flex flex-col gap-4 sm:flex-row">
            {numField("unopenedJobDays", "Unopened jobs (days)", 1)}
            {numField("seenHardCap", "Seen hard cap", 1)}
          </div>
        </CardContent>
      </Card>

      {/* The save bar sticks: the page is a long scroll and Save should never be
          somewhere you have to hunt for. Opaque rather than the usual translucent
          treatment — it passes over white section cards, and letting those bleed
          through made it read as a rendering artefact instead of a bar. */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t bg-background px-4 py-3 shadow-[0_-4px_12px_-6px_rgb(0_0_0/0.15)]">
        <StatusText id="save-status" status={saveStatus} />
        <Button type="button" variant="outline" id="reset" onClick={onReset}>
          Reset
        </Button>
        <Button type="button" id="save" onClick={onSave}>
          Save settings
        </Button>
      </div>

      <p className="text-center text-xs text-faint">
        Personal single-user tool · against LinkedIn's ToS · keep the depth low.
      </p>
    </div>
  );
}

/** A switch with its label, laid out the way every toggle on this page is. */
function ToggleRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

function StatusText({ id, status }: { id: string; status: Status }) {
  if (!status.message) return null;
  return (
    <span
      id={id}
      role="status"
      className={cn(
        "text-xs",
        status.kind === "ok" && "text-ok",
        status.kind === "err" && "text-destructive",
        status.kind === "" && "text-muted-foreground",
      )}
    >
      {status.message}
    </span>
  );
}
