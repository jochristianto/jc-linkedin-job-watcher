// Options page — PRD §11 step 7 (mockups/options.html). The §14 side-effect
// wrapper for the settings form: it reads/writes the `settings` storage key,
// renders the four section cards (Searches, Filters, Scanning, Retention), and
// wires every control. Telegram push is #22, so it is deliberately absent here.
//
// Every DECISION lives tested in options-form.ts — validation, the quiet-hours
// time mapping, and the §6 normalize-on-write rule. This file only reads the DOM
// into that pure layer and paints the result back, so it is not unit-tested
// (the pattern from mount.ts). Save is explicit; a form that fails validation
// shows its errors inline and writes nothing.

import "./tokens.css";
import * as storage from "./storage.ts";
import { esc } from "./render.ts";
import { PUSH_FAILING_MESSAGE, OK_PUSH_HEALTH } from "./health.ts";
import { sendPush, type PushJob } from "./push.ts";
import type { Settings, Watch } from "./types.ts";
import {
  settingsToForm,
  parseSettingsForm,
  parseWatchInput,
  makeBlockedCompany,
  type OptionsFormValues,
} from "./options-form.ts";

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

const root = document.getElementById("app");
if (root) void mount(root);

async function mount(root: HTMLElement): Promise<void> {
  // `base` holds the fields the page doesn't edit (push/pacing/backoff/…) so a
  // save carries them through untouched; `form` is the live editable state.
  let base: Settings = await storage.get("settings");
  let form: OptionsFormValues = settingsToForm(base);
  let editingWatchId: string | null = null;
  // The §16.7 soft warning, read once at load: shown in the Telegram card when push
  // has failed the threshold times in a row. A good Send-test resets it in storage;
  // we don't repaint mid-session (that would drop unsaved edits), so the banner
  // clears on the next open, which is enough — the AC only needs it to appear.
  const pushWarn = (await storage.get("pushHealth")).warn;

  paint();

  function paint(): void {
    root.innerHTML = shell(form, pushWarn);
    renderWatches();
    renderTags("company");
    renderTags("keyword");
    wire();
  }

  // ── dynamic lists ──────────────────────────────────────────────────────────

  function renderWatches(): void {
    const host = byId("watch-list");
    host.innerHTML = form.watches.map(watchRow).join("");
  }

  function watchRow(w: Watch): string {
    if (w.id === editingWatchId) {
      return `
        <div class="watch-row" data-watch-id="${esc(w.id)}">
          <span class="grow">
            <input class="edit-name" type="text" value="${esc(w.name)}" />
            <input class="edit-url" type="text" value="${esc(w.url)}" />
            <div class="field-error" data-err="watch-edit"></div>
          </span>
          <button class="btn sm" data-act="save-edit">Save</button>
          <button class="btn ghost sm" data-act="cancel-edit">Cancel</button>
        </div>`;
    }
    return `
      <div class="watch-row" data-watch-id="${esc(w.id)}">
        <input type="checkbox" data-act="toggle" ${w.enabled ? "checked" : ""} title="Enabled" />
        <span class="grow">
          <div class="name">${esc(w.name)}</div>
          <div class="url">${esc(w.url)}</div>
        </span>
        <button class="btn ghost sm" data-act="edit">Edit</button>
        <button class="btn ghost sm" data-act="remove">Remove</button>
      </div>`;
  }

  function renderTags(kind: "company" | "keyword"): void {
    const host = byId(`${kind}-tags`);
    const labels =
      kind === "company"
        ? form.blockedCompanies.map((c) => c.display)
        : form.blockedTitleKeywords;
    host.innerHTML = labels
      .map(
        (label, i) =>
          `<span class="tag">${esc(label)} <button class="btn ghost sm" data-act="del-${kind}" data-idx="${i}">✕</button></span>`,
      )
      .join("");
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  function wire(): void {
    byId("watch-list").addEventListener("click", onWatchListClick);
    byId("watch-list").addEventListener("change", onWatchToggle);
    byId("add-search").addEventListener("click", onAddSearch);

    byId("company-input").addEventListener("keydown", (e) => onTagKey(e, "company"));
    byId("keyword-input").addEventListener("keydown", (e) => onTagKey(e, "keyword"));
    byId("company-tags").addEventListener("click", (e) => onTagDelete(e, "company"));
    byId("keyword-tags").addEventListener("click", (e) => onTagDelete(e, "keyword"));

    byId("send-test").addEventListener("click", onSendTest);

    byId("save").addEventListener("click", onSave);
    byId("reset").addEventListener("click", onReset);
  }

  /** Prove the Telegram config end-to-end (PRD §8): send one real message with the
   *  values currently in the fields (not the last-saved ones) and report success or
   *  failure inline, so a wrong chat id shows up here instead of failing silently
   *  for days. Forces `enabled: true` for the test — the toggle governs cycle pushes,
   *  not this deliberate check — and a good send clears any §16.7 warning. */
  async function onSendTest(): Promise<void> {
    const cfg = {
      enabled: true,
      botToken: byId<HTMLInputElement>("pushBotToken").value.trim(),
      chatId: byId<HTMLInputElement>("pushChatId").value.trim(),
    };
    if (!cfg.botToken || !cfg.chatId) {
      setTestStatus("Enter a bot token and chat id first.", "err");
      return;
    }
    setTestStatus("Sending…", "");
    const ok = await sendPush(TEST_PUSH_JOBS, cfg);
    if (ok) {
      setTestStatus("Sent — check your phone.", "ok");
      await storage.set("pushHealth", OK_PUSH_HEALTH); // one good send resets §16.7
    } else {
      setTestStatus("Telegram rejected it — re-check the bot token and chat id.", "err");
    }
  }

  function setTestStatus(message: string, kind: "ok" | "err" | ""): void {
    const el = byId("test-status");
    el.textContent = message;
    el.className = `test-result ${kind}`.trim();
  }

  function onWatchListClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const rowEl = btn.closest<HTMLElement>(".watch-row");
    const id = rowEl?.dataset.watchId;
    if (!id) return;

    switch (btn.dataset.act) {
      case "remove":
        form.watches = form.watches.filter((w) => w.id !== id);
        renderWatches();
        break;
      case "edit":
        editingWatchId = id;
        renderWatches();
        break;
      case "cancel-edit":
        editingWatchId = null;
        renderWatches();
        break;
      case "save-edit": {
        const name = (rowEl!.querySelector(".edit-name") as HTMLInputElement).value;
        const url = (rowEl!.querySelector(".edit-url") as HTMLInputElement).value;
        const parsed = parseWatchInput(name, url);
        if (!parsed.ok) {
          const err = rowEl!.querySelector('[data-err="watch-edit"]')!;
          err.textContent = parsed.errors.name ?? parsed.errors.url ?? "Invalid search.";
          return;
        }
        form.watches = form.watches.map((w) =>
          w.id === id ? { ...w, name: parsed.value.name, url: parsed.value.url } : w,
        );
        editingWatchId = null;
        renderWatches();
        break;
      }
    }
  }

  function onWatchToggle(e: Event): void {
    const box = e.target as HTMLInputElement;
    if (box.dataset.act !== "toggle") return;
    const id = box.closest<HTMLElement>(".watch-row")?.dataset.watchId;
    if (!id) return;
    form.watches = form.watches.map((w) =>
      w.id === id ? { ...w, enabled: box.checked } : w,
    );
  }

  function onAddSearch(): void {
    const nameEl = byId<HTMLInputElement>("new-name");
    const urlEl = byId<HTMLInputElement>("new-url");
    const errEl = byId("new-search-error");
    const parsed = parseWatchInput(nameEl.value, urlEl.value);
    if (!parsed.ok) {
      errEl.textContent = parsed.errors.name ?? parsed.errors.url ?? "Invalid search.";
      return;
    }
    errEl.textContent = "";
    form.watches = [
      ...form.watches,
      { id: crypto.randomUUID(), name: parsed.value.name, url: parsed.value.url, enabled: true },
    ];
    nameEl.value = "";
    urlEl.value = "";
    renderWatches();
  }

  function onTagKey(e: KeyboardEvent, kind: "company" | "keyword"): void {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const input = e.target as HTMLInputElement;
    const value = input.value.trim();
    if (!value) return;
    if (kind === "company") {
      form.blockedCompanies = [...form.blockedCompanies, makeBlockedCompany(value)];
    } else {
      form.blockedTitleKeywords = [...form.blockedTitleKeywords, value];
    }
    input.value = "";
    renderTags(kind);
  }

  function onTagDelete(e: Event, kind: "company" | "keyword"): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(`[data-act="del-${kind}"]`);
    if (!btn) return;
    const i = Number(btn.dataset.idx);
    if (kind === "company") {
      form.blockedCompanies = form.blockedCompanies.filter((_, idx) => idx !== i);
    } else {
      form.blockedTitleKeywords = form.blockedTitleKeywords.filter((_, idx) => idx !== i);
    }
    renderTags(kind);
  }

  async function onSave(): Promise<void> {
    // Pull the scalar fields off their inputs; the list fields already live in
    // `form`. The two toggles too.
    form = {
      ...form,
      hideReposted: byId<HTMLInputElement>("hide-reposted").checked,
      quietHoursEnabled: byId<HTMLInputElement>("quiet-enabled").checked,
      intervalMinutes: byId<HTMLInputElement>("intervalMinutes").value,
      jitterMinutes: byId<HTMLInputElement>("jitterMinutes").value,
      pagesPerScan: byId<HTMLInputElement>("pagesPerScan").value,
      catchUpPages: byId<HTMLInputElement>("catchUpPages").value,
      quietStart: byId<HTMLInputElement>("quietStart").value,
      quietEnd: byId<HTMLInputElement>("quietEnd").value,
      seenDays: byId<HTMLInputElement>("seenDays").value,
      openedJobDays: byId<HTMLInputElement>("openedJobDays").value,
      unopenedJobDays: byId<HTMLInputElement>("unopenedJobDays").value,
      seenHardCap: byId<HTMLInputElement>("seenHardCap").value,
      pushEnabled: byId<HTMLInputElement>("push-enabled").checked,
      pushBotToken: byId<HTMLInputElement>("pushBotToken").value,
      pushChatId: byId<HTMLInputElement>("pushChatId").value,
    };

    clearErrors();
    const result = parseSettingsForm(form, base);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.errors)) {
        showError(field, message);
      }
      setStatus("Some values need fixing — nothing was saved.", "err");
      return;
    }

    await storage.set("settings", result.settings);
    base = result.settings; // future saves carry through from what we just wrote
    setStatus("Saved.", "ok");
  }

  function onReset(): void {
    form = settingsToForm(base);
    editingWatchId = null;
    paint();
    setStatus("Reverted to the last saved settings.", "ok");
  }

  // ── error / status helpers ───────────────────────────────────────────────
  function clearErrors(): void {
    root.querySelectorAll<HTMLElement>("[data-err]").forEach((el) => (el.textContent = ""));
    root.querySelectorAll<HTMLElement>("input.invalid").forEach((el) => el.classList.remove("invalid"));
  }
  function showError(field: string, message: string): void {
    const err = root.querySelector<HTMLElement>(`[data-err="${field}"]`);
    if (err) err.textContent = message;
    document.getElementById(field)?.classList.add("invalid");
  }
  function setStatus(message: string, kind: "ok" | "err"): void {
    const el = byId("save-status");
    el.textContent = message;
    el.className = `test-result ${kind}`;
  }

  function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }
}

// ── static shell (scalar inputs bound to current values) ──────────────────────

function numField(id: string, label: string, value: string, min: number): string {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <input id="${id}" type="number" min="${min}" value="${esc(value)}" />
      <div class="field-error" data-err="${id}"></div>
    </div>`;
}

function shell(f: OptionsFormValues, pushWarn: boolean): string {
  return `
    <div class="opt-wrap">
      <h1>LinkedIn Job Watcher — Settings</h1>

      <section class="section">
        <h2>Searches</h2>
        <p class="hint">
          Saved LinkedIn job-search URLs with your filters already applied. Each
          runs on the same cycle; toggle any off to pause it.
        </p>
        <div id="watch-list"></div>
        <div class="field-row" style="margin-top: 12px">
          <div class="field">
            <label for="new-name">Nickname</label>
            <input id="new-name" type="text" placeholder="e.g. Singapore" />
          </div>
          <div class="field" style="flex: 2">
            <label for="new-url">Search URL</label>
            <input id="new-url" type="text" placeholder="https://www.linkedin.com/jobs/search/?…" />
          </div>
        </div>
        <div class="field-error" id="new-search-error"></div>
        <button class="btn" id="add-search">Add search</button>
      </section>

      <section class="section">
        <h2>Filters</h2>
        <p class="hint">Company names match partially, case-insensitive.</p>
        <div class="field">
          <label>Blocked companies</label>
          <div id="company-tags"></div>
          <input id="company-input" type="text" placeholder="Add a company to block, then Enter…" />
        </div>
        <div class="field">
          <label>Blocked title keywords</label>
          <div id="keyword-tags"></div>
          <input id="keyword-input" type="text" placeholder="Add a keyword to block, then Enter…" />
        </div>
        <label class="switch">
          <input id="hide-reposted" type="checkbox" ${f.hideReposted ? "checked" : ""} />
          Hide jobs marked “Reposted”
        </label>
      </section>

      <section class="section">
        <h2>Scanning</h2>
        <p class="hint">
          Lower the depth if you don't need it — every page is a real load
          against LinkedIn (PRD §12).
        </p>
        <div class="field-row">
          ${numField("intervalMinutes", "Interval (minutes)", f.intervalMinutes, 1)}
          ${numField("jitterMinutes", "Jitter (± minutes)", f.jitterMinutes, 0)}
        </div>
        <div class="field-row">
          ${numField("pagesPerScan", "Pages per scan", f.pagesPerScan, 1)}
          ${numField("catchUpPages", "Catch-up pages (on startup)", f.catchUpPages, 1)}
        </div>
        <label class="switch" style="display: block; margin: 8px 0">
          <input id="quiet-enabled" type="checkbox" ${f.quietHoursEnabled ? "checked" : ""} />
          Pause scanning during quiet hours
        </label>
        <div class="field-row">
          <div class="field">
            <label for="quietStart">Quiet hours start</label>
            <input id="quietStart" type="time" value="${esc(f.quietStart)}" />
            <div class="field-error" data-err="quietStart"></div>
          </div>
          <div class="field">
            <label for="quietEnd">Quiet hours end</label>
            <input id="quietEnd" type="time" value="${esc(f.quietEnd)}" />
            <div class="field-error" data-err="quietEnd"></div>
          </div>
        </div>
      </section>

      <section class="section">
        <h2>Telegram push</h2>
        <p class="hint">
          Optional: also deliver new jobs to your phone via a Telegram bot,
          additive to the desktop notification (PRD §8). Nothing here is stored
          anywhere but this browser — never committed. Use <b>Send test message</b>
          to confirm the credentials before trusting it.
        </p>
        ${pushWarn ? `<div class="banner banner-warn">${esc(PUSH_FAILING_MESSAGE)}</div>` : ""}
        <label class="switch" style="display: block; margin: 8px 0">
          <input id="push-enabled" type="checkbox" ${f.pushEnabled ? "checked" : ""} />
          Send new jobs to Telegram
        </label>
        <div class="field">
          <label for="pushBotToken">Bot token</label>
          <input id="pushBotToken" type="password" autocomplete="off" value="${esc(f.pushBotToken)}" placeholder="123456:ABC-DEF…" />
        </div>
        <div class="field">
          <label for="pushChatId">Chat id</label>
          <input id="pushChatId" type="text" autocomplete="off" value="${esc(f.pushChatId)}" placeholder="987654321" />
        </div>
        <div class="field-row" style="align-items: center; gap: 12px">
          <button class="btn ghost" id="send-test">Send test message</button>
          <span id="test-status" class="test-result"></span>
        </div>
      </section>

      <section class="section">
        <h2>Retention</h2>
        <p class="hint">How long records are kept before daily clean-up prunes them (PRD §7).</p>
        <div class="field-row">
          ${numField("seenDays", "Seen IDs (days)", f.seenDays, 1)}
          ${numField("openedJobDays", "Opened jobs (days)", f.openedJobDays, 1)}
        </div>
        <div class="field-row">
          ${numField("unopenedJobDays", "Unopened jobs (days)", f.unopenedJobDays, 1)}
          ${numField("seenHardCap", "Seen hard cap", f.seenHardCap, 1)}
        </div>
      </section>

      <div class="save-bar">
        <span id="save-status" class="test-result"></span>
        <button class="btn ghost" id="reset">Reset</button>
        <button class="btn" id="save">Save settings</button>
      </div>
      <p class="foot-note">
        Personal single-user tool · against LinkedIn's ToS · keep the depth low.
      </p>
    </div>`;
}
