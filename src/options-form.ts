// Options-form logic — PRD §3/§6/§7/§15, the settings page's pure half.
//
// The options page (mockups/options.html) is a §14 side-effect wrapper in
// options.ts that reads/writes chrome.storage and wires the DOM. Every DECISION
// it makes lives here as plain functions over plain values, so `node --test`
// proves them without a browser: which values are valid, how "HH:MM" maps to a
// minute-of-day, and — the load-bearing §6 rule — that a blocked company is
// normalized on WRITE (once, when saved) and never on read.
//
// This is the reference shape from filter.ts applied to the settings form: pure
// logic in its own module, the chrome.*/DOM shell left thin and untested.

import { z } from "zod";
import type { Settings, Watch, BlockedCompany } from "./types.ts";

// ── Quiet-hours time <-> minute-of-day (PRD §15) ────────────────────────────
// Storage keeps quiet hours as minutes-of-day (0..1439); the UI shows "HH:MM".

/** Minute-of-day → "HH:MM", zero-padded. Inverse of {@link timeToMinutes}. */
export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" → minute-of-day, or `null` when it isn't a real 24-hour time. */
export function timeToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

// ── Company blocklist: normalize on WRITE, never on read (PRD §6) ────────────

// `makeBlockedCompany` lives in filter.ts, next to the matching it feeds. It is
// re-exported here because this module was its original home and the Options
// page still reaches for it here — and because the list view's per-row block
// button needs it too, and must not drag this module's zod import into the
// popup bundle just to normalize one string.
export { makeBlockedCompany } from "./filter.ts";

// ── Watch input (Searches — PRD §3) ─────────────────────────────────────────

export type WatchInputErrors = { name?: string; url?: string };

export type WatchInputResult =
  | { ok: true; value: { name: string; url: string } }
  | { ok: false; errors: WatchInputErrors };

/**
 * Validate the add/edit-search fields: a nickname is required and the URL must
 * be a real URL. Returns the trimmed values on success or per-field messages on
 * failure. The id and `enabled` flag are the wrapper's to assign — this only
 * judges the two things the user types.
 */
export function parseWatchInput(name: string, url: string): WatchInputResult {
  const errors: WatchInputErrors = {};
  const n = name.trim();
  const u = url.trim();
  if (!n) errors.name = "Give the search a nickname.";
  if (!z.url().safeParse(u).success) errors.url = "Enter a valid URL.";
  if (errors.name || errors.url) return { ok: false, errors };
  return { ok: true, value: { name: n, url: u } };
}

// ── The whole settings form ──────────────────────────────────────────────────

/**
 * The editable state the page holds. The list-shaped fields (watches, the two
 * blocklists) are kept as already-structured arrays by the wrapper's chip/row
 * UI; the scalar fields are the raw strings straight off their `<input>`s, still
 * unvalidated. {@link parseSettingsForm} is what turns this into a `Settings`.
 */
export type OptionsFormValues = {
  watches: Watch[];
  blockedCompanies: BlockedCompany[];
  blockedTitleKeywords: string[];
  hideReposted: boolean;
  intervalMinutes: string;
  jitterMinutes: string;
  pagesPerScan: string;
  catchUpPages: string;
  quietHoursEnabled: boolean;
  quietStart: string; // "HH:MM"
  quietEnd: string; // "HH:MM"
  notifyDesktop: boolean; // the desktop pop-up (§3/§9); Telegram is separate
  seenDays: string;
  openedJobDays: string;
  unopenedJobDays: string;
  seenHardCap: string;
  pushEnabled: boolean;
  pushBotToken: string; // Telegram bot token (§8) — never committed, stored per-user
  pushChatId: string; // Telegram chat id (§8)
};

export type FormErrors = Partial<Record<keyof OptionsFormValues, string>>;

export type ParseResult =
  | { ok: true; settings: Settings }
  | { ok: false; errors: FormErrors };

/** Read one whole-number field, collecting a message into `errors` on failure. */
function intField(
  errors: FormErrors,
  key: keyof OptionsFormValues,
  raw: string,
  min: number,
): number | null {
  const r = z.coerce.number().int().gte(min).safeParse(raw);
  if (!r.success) {
    errors[key] = `Enter a whole number ${min === 0 ? "of 0 or more" : `of ${min} or more`}.`;
    return null;
  }
  return r.data;
}

/**
 * Turn the raw form into a full `Settings`, or reject with per-field messages
 * and write nothing (the AC's "invalid values are rejected inline and never
 * written"). Fields the page doesn't edit — pacing, backoff, the lock/warn
 * thresholds — are carried through from `base` untouched, so a save never
 * silently resets them. The Telegram push config (#22) IS edited here: the two
 * secrets are trimmed but not otherwise validated (a bad token/chat id surfaces
 * via Send test message and the §16.7 warning, not an inline form error).
 */
export function parseSettingsForm(raw: OptionsFormValues, base: Settings): ParseResult {
  const errors: FormErrors = {};

  const intervalMinutes = intField(errors, "intervalMinutes", raw.intervalMinutes, 1);
  const jitterMinutes = intField(errors, "jitterMinutes", raw.jitterMinutes, 0);
  const pagesPerScan = intField(errors, "pagesPerScan", raw.pagesPerScan, 1);
  const catchUpPages = intField(errors, "catchUpPages", raw.catchUpPages, 1);
  const seenDays = intField(errors, "seenDays", raw.seenDays, 1);
  const openedJobDays = intField(errors, "openedJobDays", raw.openedJobDays, 1);
  const unopenedJobDays = intField(errors, "unopenedJobDays", raw.unopenedJobDays, 1);
  const seenHardCap = intField(errors, "seenHardCap", raw.seenHardCap, 1);

  const startMinute = timeToMinutes(raw.quietStart);
  if (startMinute === null) errors.quietStart = "Enter a time as HH:MM.";
  const endMinute = timeToMinutes(raw.quietEnd);
  if (endMinute === null) errors.quietEnd = "Enter a time as HH:MM.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const settings: Settings = {
    ...base,
    watches: raw.watches,
    blockedCompanies: raw.blockedCompanies,
    blockedTitleKeywords: raw.blockedTitleKeywords,
    hideReposted: raw.hideReposted,
    intervalMinutes: intervalMinutes!,
    jitterMinutes: jitterMinutes!,
    pagesPerScan: pagesPerScan!,
    catchUpPages: catchUpPages!,
    quietHours: {
      enabled: raw.quietHoursEnabled,
      startMinute: startMinute!,
      endMinute: endMinute!,
    },
    notifyDesktop: raw.notifyDesktop,
    retention: {
      ...base.retention,
      seenDays: seenDays!,
      openedJobDays: openedJobDays!,
      unopenedJobDays: unopenedJobDays!,
      seenHardCap: seenHardCap!,
    },
    // The Telegram section (#22) — trim the secrets, no further validation (see above).
    push: {
      enabled: raw.pushEnabled,
      botToken: raw.pushBotToken.trim(),
      chatId: raw.pushChatId.trim(),
    },
  };
  return { ok: true, settings };
}

/** The reverse: fill the form from stored `Settings` (page load and Reset). */
export function settingsToForm(s: Settings): OptionsFormValues {
  return {
    watches: s.watches,
    blockedCompanies: s.blockedCompanies,
    blockedTitleKeywords: s.blockedTitleKeywords,
    hideReposted: s.hideReposted,
    intervalMinutes: String(s.intervalMinutes),
    jitterMinutes: String(s.jitterMinutes),
    pagesPerScan: String(s.pagesPerScan),
    catchUpPages: String(s.catchUpPages),
    quietHoursEnabled: s.quietHours.enabled,
    quietStart: minutesToTime(s.quietHours.startMinute),
    quietEnd: minutesToTime(s.quietHours.endMinute),
    // Absent (settings saved before the switch existed) reads as on — the same
    // rule the master `enabled` switch follows, so an upgrade never goes quiet.
    notifyDesktop: s.notifyDesktop !== false,
    seenDays: String(s.retention.seenDays),
    openedJobDays: String(s.retention.openedJobDays),
    unopenedJobDays: String(s.retention.unopenedJobDays),
    seenHardCap: String(s.retention.seenHardCap),
    pushEnabled: s.push.enabled,
    pushBotToken: s.push.botToken,
    pushChatId: s.push.chatId,
  };
}

// ── Unsaved edits (what Reset would throw away) ──────────────────────────────

/** Structural equality over the shapes a form field can hold — strings,
 *  booleans, and the three lists of plain records. Written out rather than
 *  reached for from a library because the values are this small, and because a
 *  field added to `OptionsFormValues` later is covered without touching it. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

/**
 * WHICH fields differ from what is stored — the unsaved edits, named.
 *
 * One function rather than a yes/no predicate beside it, because the page asks
 * the same question three ways and they must never disagree: Reset is enabled
 * when this is non-empty, the header badge counts it, and `settings-view.ts`
 * maps the names onto sections to put a dot on the rail.
 *
 * Compared against `settingsToForm(saved)` rather than against `saved` itself,
 * so the comparison happens in the form's own vocabulary: "23:00" against
 * "23:00", "15" against "15". That makes a *textual* difference count as an
 * edit even when it would parse to the same number — typing "015" over "15"
 * leaves the field genuinely unsaved, and saying otherwise would disable Reset
 * on a form the user can see they have touched.
 *
 * A build-time .env prefill counts too: it fills blank fields and writes
 * nothing, which is exactly an unsaved edit (see {@link applyPushPrefill}).
 */
export function changedFormKeys(
  form: OptionsFormValues,
  saved: Settings,
): (keyof OptionsFormValues)[] {
  const stored = settingsToForm(saved);
  return (Object.keys(form) as (keyof OptionsFormValues)[]).filter(
    (key) => !sameValue(form[key], stored[key]),
  );
}

// ── Build-time .env prefill (the `npm run build:dev` path) ───────────────────

/**
 * The Telegram credentials a *development* build may have baked in from `.env`,
 * or `null` — which is what the ordinary `npm run build` always injects, so the
 * shippable bundle never carries a secret (see README, "Testing the push from
 * the terminal"). The extension cannot read a file at runtime; a build-time
 * constant is the only route from `.env` into the Options page.
 */
export type PushPrefill = { botToken: string; chatId: string } | null;

/**
 * Seed the two Telegram fields from a `build:dev` prefill, filling ONLY what the
 * user has left blank. A stored credential always wins, so rebuilding can never
 * clobber a token typed by hand — the prefill is a *default*, exactly like
 * DEFAULT_SETTINGS, not an override.
 *
 * Nothing is written to storage by this: it populates the form, and the user
 * still presses Save. That keeps a build-time value from silently becoming
 * saved state, and leaves Reset meaning "back to what is stored".
 *
 * Returns the same reference when there is nothing to fill, so the caller can
 * cheaply tell whether a prefill actually applied.
 */
export function applyPushPrefill(
  form: OptionsFormValues,
  prefill: PushPrefill,
): OptionsFormValues {
  if (!prefill) return form;
  const pushBotToken = form.pushBotToken || prefill.botToken;
  const pushChatId = form.pushChatId || prefill.chatId;
  if (pushBotToken === form.pushBotToken && pushChatId === form.pushChatId) {
    return form;
  }
  return { ...form, pushBotToken, pushChatId };
}
