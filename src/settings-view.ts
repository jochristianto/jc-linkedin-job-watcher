// Settings-page view model — the redesign's derived values, PRD §14's pure half.
//
// The redesigned Options page (`.design/SettingsPage.dc.html`) says more about the
// settings than the settings themselves contain: which section holds an unsaved
// edit, what a saved search's URL actually filters on, one line summarising the
// whole configuration, and roughly how much traffic the current pacing puts on
// LinkedIn in a day. None of that is stored — all of it is read off the form —
// so all of it is a DECISION, and every one lives here where `node --test` can
// prove it without a browser.
//
// `options-form.ts` stays what it was: validation and the storage round-trip.
// This module is the layer above it — nothing here writes, and nothing here
// knows about React or chrome.*.

import { timeToMinutes, type OptionsFormValues } from "./options-form.ts";

// ── Sections (the rail down the left of the page) ────────────────────────────

/** The panels the page is divided into, in the order they are read. The rail
 *  and the scroll-spy both walk this, so adding a section is one entry here plus
 *  the card itself.
 *
 *  "Backup" sits last before the prose, and deliberately nowhere near the fields
 *  it overwrites: importing replaces every setting on the page at once, and a
 *  control that does that should not share a card with the ones it undoes.
 *  "Diagnostics" follows it — both are about files rather than settings, and it is
 *  the one section that reaches out to a live LinkedIn tab rather than to storage. */
export const SETTINGS_SECTIONS = [
  "watches",
  "filters",
  "scanning",
  "retention",
  "notifications",
  "backup",
  "diagnostics",
  "how",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SECTION_LABELS: Record<SettingsSection, string> = {
  watches: "Watches",
  filters: "Filters",
  scanning: "Scanning",
  retention: "Retention",
  notifications: "Notifications",
  backup: "Backup",
  diagnostics: "Diagnostics",
  how: "How this works",
};

/** Which form fields each section owns. Exhaustive over `OptionsFormValues` by
 *  construction — `sectionOfField` is typed against it, so a field added to the
 *  form without a home here fails to compile rather than silently losing its
 *  unsaved-changes dot. Three sections own nothing and so never carry a dot:
 *  "How this works" is prose, "Backup" writes straight to storage rather than
 *  through the form (an import is saved the moment it lands), and "Diagnostics"
 *  only reads a live tab and writes a file — neither touches a form field. */
const SECTION_OF_FIELD: Record<keyof OptionsFormValues, SettingsSection> = {
  watches: "watches",
  blockedCompanies: "filters",
  blockedTitleKeywords: "filters",
  hideReposted: "filters",
  manualOnly: "scanning",
  intervalMinutes: "scanning",
  jitterMinutes: "scanning",
  pagesPerScan: "scanning",
  catchUpPages: "scanning",
  quietHoursEnabled: "scanning",
  quietStart: "scanning",
  quietEnd: "scanning",
  seenDays: "retention",
  openedJobDays: "retention",
  unopenedJobDays: "retention",
  seenHardCap: "retention",
  notifyDesktop: "notifications",
  pushEnabled: "notifications",
  pushBotToken: "notifications",
  pushChatId: "notifications",
};

/** The section a given form field is edited in. */
export function sectionOfField(key: keyof OptionsFormValues): SettingsSection {
  return SECTION_OF_FIELD[key];
}

/** The sections carrying at least one unsaved edit — what puts the amber dot on
 *  a rail entry. A dot is the only way to tell, from the top of a page several
 *  screens deep, that the thing you changed is still down there unsaved. */
export function dirtySections(changed: (keyof OptionsFormValues)[]): Set<SettingsSection> {
  return new Set(changed.map(sectionOfField));
}

/** The header badge: "3 unsaved changes", counted in fields rather than in
 *  keystrokes. Empty string when there is nothing to save, so the caller can
 *  render the badge on truthiness alone. */
export function unsavedLabel(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 unsaved change" : `${count} unsaved changes`;
}

// ── What a saved search actually searches for ────────────────────────────────

/** The geoIds worth naming. LinkedIn has thousands and no public lookup, so this
 *  is deliberately a short list of the ones a user of this extension plausibly
 *  saved; anything else falls back to showing the raw id, which is still more
 *  than the bare URL said. */
const GEO_NAMES: Record<string, string> = {
  "101355337": "Japan",
  "102478259": "Indonesia",
  "102454443": "Singapore",
  "103644278": "United States",
  "101452733": "Australia",
  "105646813": "Spain",
  "102890719": "Netherlands",
  "101165590": "United Kingdom",
  "100565514": "Germany",
  "106808692": "Malaysia",
};

/** `f_TPR` — how far back the search reaches. */
const DATE_POSTED: Record<string, string> = {
  r3600: "Past hour",
  r86400: "Past 24 hours",
  r604800: "Past week",
  r2592000: "Past month",
};

/** `f_JT` — job type. */
const JOB_TYPES: Record<string, string> = {
  F: "Full-time",
  P: "Part-time",
  C: "Contract",
  T: "Temporary",
  I: "Internship",
  V: "Volunteer",
};

/** `f_WT` — workplace type. */
const WORK_TYPES: Record<string, string> = {
  "1": "On-site",
  "2": "Remote",
  "3": "Hybrid",
};

/**
 * Turn a saved LinkedIn search URL into the handful of chips that say what it
 * filters on — keywords, place, recency, job type, workplace, sort order.
 *
 * A watch row shows its URL, but a LinkedIn search URL is 200 characters of
 * `f_TPR=r86400&geoId=101355337&…` and nobody reads it. These chips are the
 * same URL said out loud, which is what makes two saved searches tellable apart
 * at a glance. Purely presentational: nothing scans off them, so an unrecognised
 * parameter is simply not shown rather than being an error.
 *
 * Never returns an empty array — a URL with no filters, and a URL we cannot
 * parse at all, each get one chip saying so, because a row with no chips reads
 * as "still loading" rather than "nothing to say".
 */
export function watchUrlChips(url: string): string[] {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return ["URL not recognised"];
  }

  const chips: string[] = [];
  const keywords = params.get("keywords");
  // Already decoded by URLSearchParams; quoted so a multi-word search reads as
  // one phrase rather than as several chips run together.
  if (keywords) chips.push(`“${keywords}”`);

  const geoId = params.get("geoId");
  if (geoId) chips.push(GEO_NAMES[geoId] ?? `geo ${geoId}`);

  const location = params.get("location");
  if (location && !geoId) chips.push(location);

  const tpr = DATE_POSTED[params.get("f_TPR") ?? ""];
  if (tpr) chips.push(tpr);

  // Both filters are multi-select on LinkedIn ("F,C"), so each value is mapped
  // on its own and anything unknown is dropped rather than shown raw.
  for (const value of (params.get("f_JT") ?? "").split(",")) {
    if (JOB_TYPES[value]) chips.push(JOB_TYPES[value]);
  }
  for (const value of (params.get("f_WT") ?? "").split(",")) {
    if (WORK_TYPES[value]) chips.push(WORK_TYPES[value]);
  }

  if (params.get("f_E")) chips.push("Experience filtered");
  if (params.get("sortBy") === "DD") chips.push("Newest first");

  return chips.length > 0 ? chips : ["No filters in the URL"];
}

// ── The header's one-line summary ────────────────────────────────────────────

/** Whole hours from one "HH:MM" to another, wrapping past midnight. Used only
 *  for the estimate below, so an unparseable time counts as midnight rather
 *  than failing — the form's own validation is what rejects it on save. */
export function spanHours(start: string, end: string): number {
  const from = timeToMinutes(start) ?? 0;
  const to = timeToMinutes(end) ?? 0;
  const span = to - from;
  return (span > 0 ? span : span + 24 * 60) / 60;
}

/**
 * How the cadence reads in one phrase: the *band* the jitter actually produces,
 * not the bare interval.
 *
 * "Every 33 min" was a description of a setting rather than of the behaviour —
 * no round ever runs exactly 33 minutes after the last one, because the interval
 * is jittered before the alarm is armed (§15). Saying "Every 30–90 min" makes the
 * header describe what the extension does, and makes the jitter field's effect
 * visible in the summary the moment you change it. Zero jitter is the one case
 * where a single number is the truth, so it keeps the plain form.
 *
 * The phrase is capitalised because the summary reads as separate segments split
 * by "·" rather than as one sentence, so each starts like the one before it.
 *
 * The low edge is floored at 1 to match `jitteredDelayMs`, which cannot arm an
 * alarm shorter than a minute whatever the jitter says (issue #3).
 */
function cadencePhrase(form: OptionsFormValues): string {
  // Manual only: the interval and jitter below are still stored, but nothing is
  // reading them, so quoting a band would describe a schedule that isn't running.
  if (form.manualOnly) return "Only when you press Scan now";

  const minutes = Number.parseInt(form.intervalMinutes, 10);
  if (!Number.isFinite(minutes)) return "Interval not set";

  const jitter = Number.parseInt(form.jitterMinutes, 10);
  if (!Number.isFinite(jitter) || jitter <= 0) return `Every ${minutes} min`;

  return `Every ${Math.max(1, minutes - jitter)}–${minutes + jitter} min`;
}

/**
 * The line under the page title: how many searches run, how often, between which
 * hours, and where the result is delivered.
 *
 * It is built from the *form* rather than from storage on purpose — it tracks
 * what you are about to save, so raising the interval moves the summary before
 * you commit to it, and the header stays an honest description of the page.
 */
export function headerSummary(form: OptionsFormValues): string {
  const active = form.watches.filter((w) => w.enabled).length;
  // "No watch" rather than "0 watches": the zero case is the one a reader should
  // notice, and a word stops it looking like just another number in the line.
  const watches = active === 0 ? "No watch" : `${active} ${active === 1 ? "watch" : "watches"}`;

  const every = cadencePhrase(form);

  // The hours it *runs*, not the hours it sleeps. The stored window is the quiet
  // one, so the running window is simply its inverse — scanning resumes when
  // quiet ends and stops when it starts. A zero-width quiet window is never quiet
  // (`isWithinQuietHours`), so it reads as around the clock like a disabled one.
  const zeroWidth = form.quietStart === form.quietEnd;
  const hours =
    form.quietHoursEnabled && !zeroWidth
      ? `from ${form.quietEnd} to ${form.quietStart}`
      : "around the clock";

  // Where a found job actually lands. Both off is worth saying plainly: the
  // toolbar count still moves, but nothing will come and tell you.
  const delivery = form.notifyDesktop
    ? form.pushEnabled
      ? "Desktop + Telegram"
      : "Desktop notification"
    : form.pushEnabled
      ? "Telegram only"
      : "badge only";

  // Quiet hours govern the automatic rounds and nothing else, so under manual-only
  // there is no window to name: "Only when you press Scan now from 07:00 to 23:00"
  // would describe a restriction that isn't there — a manual scan runs whenever
  // you press it, including at 3am.
  const cadence = form.manualOnly ? every : `${every} ${hours}`;

  return `${watches} · ${cadence} · ${delivery}`;
}

// ── How hard the current pacing leans on LinkedIn ────────────────────────────

/** Under this many page loads a day the pacing looks like a person browsing. */
const GENTLE_MAX = 130;
/** Past this it stops being defensible — see the PRD §12 note on real load. */
const HEAVY_MAX = 320;

export type LoadTier = "gentle" | "heavy" | "risky";

export type LoadEstimate = {
  /** Nothing runs on a schedule — every load below is one the user asked for by
   *  pressing Scan now, so the *daily* figure is 0 and the honest number is the
   *  per-press one. */
  manual: boolean;
  /** Scan rounds in a day, after quiet hours are taken out. 0 under `manual`. */
  rounds: number;
  /** Watches that are switched on — a paused watch costs nothing. */
  activeWatches: number;
  pagesPerScan: number;
  /** Hours a day the extension is scanning at all. */
  awakeHours: number;
  /** Rounds × active watches × pages: real page loads against LinkedIn per day. */
  loads: number;
  tier: LoadTier;
};

/**
 * Roughly how many LinkedIn page loads a day the settings currently on screen
 * would cause (PRD §12).
 *
 * The page already tells you to keep the frequency low, and then offers four
 * fields whose combined effect is not obvious: halving the interval and adding a
 * second page is a fourfold increase, and nothing said so. This turns the four
 * numbers into the one figure that matters, with a tier so the answer is legible
 * without doing arithmetic on it.
 *
 * Deliberately an over-estimate of the steady state: it ignores the backoff that
 * stretches the interval after quiet rounds (§15) and the jitter that blurs the
 * edges, because a *ceiling* is the useful number when the question is "is this
 * too much?". Chrome being closed makes the real figure lower again.
 */
export function estimateLoad(form: OptionsFormValues): LoadEstimate {
  const parse = (raw: string, fallback: number, min: number): number => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };

  const interval = parse(form.intervalMinutes, 60, 1);
  const pagesPerScan = parse(form.pagesPerScan, 1, 1);
  const activeWatches = form.watches.filter((w) => w.enabled).length;

  // Quiet hours that cover the whole day would divide the estimate down to
  // nothing, which is not what a 24-hour quiet window means in practice (the
  // catch-up round still runs), so the awake window never falls below an hour.
  const awakeHours = form.quietHoursEnabled
    ? Math.max(1, 24 - spanHours(form.quietStart, form.quietEnd))
    : 24;

  // Manual only: no round happens without a press, so a *daily* number would be a
  // prediction about how often the user will press the button — which this cannot
  // know and should not guess. Zero rounds is the truthful answer; the per-press
  // cost is what {@link loadEstimateLine} reports instead.
  const manual = form.manualOnly === true;
  const rounds = manual ? 0 : Math.max(1, Math.round((awakeHours * 60) / interval));
  const loads = rounds * activeWatches * pagesPerScan;

  return {
    manual,
    rounds,
    activeWatches,
    pagesPerScan,
    awakeHours: Math.round(awakeHours),
    loads,
    tier: loads <= GENTLE_MAX ? "gentle" : loads <= HEAVY_MAX ? "heavy" : "risky",
  };
}

/** The estimate as the sentence the Scanning card shows, with the arithmetic
 *  spelled out so it is checkable rather than a number to be taken on faith. */
export function loadEstimateLine(est: LoadEstimate): string {
  if (est.activeWatches === 0) {
    return "No watches are switched on, so nothing is being loaded from LinkedIn.";
  }
  const watches = `${est.activeWatches} active ${est.activeWatches === 1 ? "watch" : "watches"}`;
  const pages = `${est.pagesPerScan} ${est.pagesPerScan === 1 ? "page" : "pages"}`;

  // Manual only: the same arithmetic, priced per press instead of per day — the
  // one number that still means something when nothing runs on its own.
  if (est.manual) {
    const perPress = est.activeWatches * est.pagesPerScan;
    return (
      `≈ ${perPress.toLocaleString("en-US")} LinkedIn page loads each time you press Scan now — ` +
      `${watches} × ${pages}. Nothing is loaded until you do.`
    );
  }

  return (
    `≈ ${est.loads.toLocaleString("en-US")} LinkedIn page loads a day — ` +
    `${est.rounds} rounds × ${watches} × ${pages}, across ${est.awakeHours} awake hours.`
  );
}
