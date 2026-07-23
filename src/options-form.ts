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
import { normalizeCompany } from "./filter.ts";
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

/**
 * Build a `BlockedCompany` from what the user typed. The `display` is the
 * trimmed original the UI shows back; `normalized` is folded once here, on
 * write, so a scan compares like-for-like without re-lowercasing the list
 * (PRD §6). Shares {@link normalizeCompany} with the filter so both sides agree.
 */
export function makeBlockedCompany(display: string): BlockedCompany {
  const trimmed = display.trim();
  return { display: trimmed, normalized: normalizeCompany(trimmed) };
}

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
    seenDays: String(s.retention.seenDays),
    openedJobDays: String(s.retention.openedJobDays),
    unopenedJobDays: String(s.retention.unopenedJobDays),
    seenHardCap: String(s.retention.seenHardCap),
    pushEnabled: s.push.enabled,
    pushBotToken: s.push.botToken,
    pushChatId: s.push.chatId,
  };
}
