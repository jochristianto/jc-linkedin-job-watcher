import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutesToTime,
  timeToMinutes,
  makeBlockedCompany,
  parseWatchInput,
  parseSettingsForm,
  settingsToForm,
  applyPushPrefill,
  changedFormKeys,
  type OptionsFormValues,
} from "./options-form.ts";
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

// The options page's pure half (PRD §3/§6/§7/§15). No chrome.*, no DOM — these
// pin validation, the quiet-hours time mapping, and the §6 normalize-on-write
// rule with plain values, exactly as filter.ts/view.ts do for their tickets.

// A form that is entirely valid — each test mutates a copy to probe one field.
function validForm(overrides: Partial<OptionsFormValues> = {}): OptionsFormValues {
  return {
    watches: [{ id: "w1", name: "Indonesia", url: "https://x", enabled: true }],
    blockedCompanies: [{ display: "Acme", normalized: "acme" }],
    blockedTitleKeywords: ["Intern"],
    hideReposted: true,
    manualOnly: false,
    intervalMinutes: "15",
    jitterMinutes: "1",
    pagesPerScan: "1",
    catchUpPages: "4",
    quietHoursEnabled: true,
    quietStart: "23:00",
    quietEnd: "07:00",
    notifyDesktop: true,
    seenDays: "15",
    openedJobDays: "7",
    unopenedJobDays: "30",
    seenHardCap: "50000",
    pushEnabled: false,
    pushBotToken: "",
    pushChatId: "",
    ...overrides,
  };
}

// ── time helpers ─────────────────────────────────────────────────────────────

test("minutesToTime zero-pads and timeToMinutes round-trips", () => {
  assert.equal(minutesToTime(1380), "23:00");
  assert.equal(minutesToTime(420), "07:00");
  assert.equal(minutesToTime(0), "00:00");
  assert.equal(timeToMinutes("23:00"), 1380);
  assert.equal(timeToMinutes("07:00"), 420);
  assert.equal(timeToMinutes(minutesToTime(931)), 931);
});

test("timeToMinutes rejects nonsense and out-of-range times", () => {
  assert.equal(timeToMinutes("24:00"), null);
  assert.equal(timeToMinutes("12:60"), null);
  assert.equal(timeToMinutes("noon"), null);
  assert.equal(timeToMinutes(""), null);
});

// ── company blocklist: normalize on write (PRD §6) ───────────────────────────

test("makeBlockedCompany stores display and normalized, folding case once on write", () => {
  const b = makeBlockedCompany("  Recruiter Co  ");
  assert.equal(b.display, "Recruiter Co");
  assert.equal(b.normalized, "recruiter co");
});

// ── watch input (Searches — PRD §3) ──────────────────────────────────────────

test("parseWatchInput accepts a nickname + URL and trims them", () => {
  const r = parseWatchInput("  Japan  ", "  https://www.linkedin.com/jobs/search/?x=1  ");
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    name: "Japan",
    url: "https://www.linkedin.com/jobs/search/?x=1",
  });
});

test("parseWatchInput rejects an empty nickname and a bad URL, per field", () => {
  const r = parseWatchInput("", "not-a-url");
  assert.ok(!r.ok);
  assert.ok(r.errors.name);
  assert.ok(r.errors.url);
});

// ── whole-form parse ─────────────────────────────────────────────────────────

test("parseSettingsForm merges a valid form onto the base settings", () => {
  const r = parseSettingsForm(validForm(), DEFAULT_SETTINGS);
  assert.ok(r.ok);
  assert.equal(r.settings.intervalMinutes, 15);
  assert.equal(r.settings.jitterMinutes, 1);
  assert.equal(r.settings.pagesPerScan, 1);
  assert.equal(r.settings.catchUpPages, 4);
  assert.deepEqual(r.settings.quietHours, {
    enabled: true,
    startMinute: 1380,
    endMinute: 420,
  });
  assert.equal(r.settings.retention.seenHardCap, 50000);
  assert.equal(r.settings.hideReposted, true);
  assert.deepEqual(r.settings.blockedCompanies, [{ display: "Acme", normalized: "acme" }]);
});

test("parseSettingsForm carries through fields the page does not edit (pacing, backoff)", () => {
  const r = parseSettingsForm(validForm(), DEFAULT_SETTINGS);
  assert.ok(r.ok);
  assert.deepEqual(r.settings.pacing, DEFAULT_SETTINGS.pacing);
  assert.deepEqual(r.settings.backoff, DEFAULT_SETTINGS.backoff);
});

test("parseSettingsForm reads the Telegram push config off the form (#22), trimming secrets", () => {
  const r = parseSettingsForm(
    validForm({ pushEnabled: true, pushBotToken: "  123:ABC  ", pushChatId: "  42  " }),
    DEFAULT_SETTINGS,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.settings.push, { enabled: true, botToken: "123:ABC", chatId: "42" });
});

test("settingsToForm fills the push fields from stored settings", () => {
  const form = settingsToForm({
    ...DEFAULT_SETTINGS,
    push: { enabled: true, botToken: "123:ABC", chatId: "42" },
  });
  assert.equal(form.pushEnabled, true);
  assert.equal(form.pushBotToken, "123:ABC");
  assert.equal(form.pushChatId, "42");
});

test("manual-only survives the round trip, and the cadence is kept beside it", () => {
  // Switching it on must not zero the interval it suspends: switching it back off
  // has to put back the schedule that was there, not a default.
  const r = parseSettingsForm(validForm({ manualOnly: true, intervalMinutes: "90" }), {
    ...DEFAULT_SETTINGS,
    manualOnly: false,
  });
  assert.ok(r.ok);
  assert.equal(r.settings.manualOnly, true);
  assert.equal(r.settings.intervalMinutes, 90);
  assert.equal(settingsToForm(r.settings).manualOnly, true);
});

test("settingsToForm reads settings saved before manual-only existed as off", () => {
  // An upgrade must keep scanning on its schedule rather than go quiet by default.
  const legacy = { ...DEFAULT_SETTINGS } as Partial<Settings>;
  delete legacy.manualOnly;
  assert.equal(settingsToForm(legacy as Settings).manualOnly, false);
});

test("parseSettingsForm rejects a zero interval and writes nothing", () => {
  const r = parseSettingsForm(validForm({ intervalMinutes: "0" }), DEFAULT_SETTINGS);
  assert.ok(!r.ok);
  assert.ok(r.errors.intervalMinutes);
});

test("parseSettingsForm rejects non-numeric and fractional scanning values", () => {
  const bad = parseSettingsForm(validForm({ pagesPerScan: "abc" }), DEFAULT_SETTINGS);
  assert.ok(!bad.ok);
  assert.ok(bad.errors.pagesPerScan);

  const frac = parseSettingsForm(validForm({ catchUpPages: "2.5" }), DEFAULT_SETTINGS);
  assert.ok(!frac.ok);
  assert.ok(frac.errors.catchUpPages);
});

test("parseSettingsForm allows a zero jitter but not a zero retention", () => {
  const zeroJitter = parseSettingsForm(validForm({ jitterMinutes: "0" }), DEFAULT_SETTINGS);
  assert.ok(zeroJitter.ok);
  assert.equal(zeroJitter.settings.jitterMinutes, 0);

  const zeroSeen = parseSettingsForm(validForm({ seenDays: "0" }), DEFAULT_SETTINGS);
  assert.ok(!zeroSeen.ok);
  assert.ok(zeroSeen.errors.seenDays);
});

test("parseSettingsForm rejects a malformed quiet-hours time", () => {
  const r = parseSettingsForm(validForm({ quietEnd: "7am" }), DEFAULT_SETTINGS);
  assert.ok(!r.ok);
  assert.ok(r.errors.quietEnd);
});

test("parseSettingsForm reports every bad field at once, not just the first", () => {
  const r = parseSettingsForm(
    validForm({ intervalMinutes: "0", seenHardCap: "-5", quietStart: "bad" }),
    DEFAULT_SETTINGS,
  );
  assert.ok(!r.ok);
  assert.ok(r.errors.intervalMinutes);
  assert.ok(r.errors.seenHardCap);
  assert.ok(r.errors.quietStart);
});

// ── unsaved edits (what Reset would throw away) ──────────────────────────────

test("changedFormKeys: a form straight out of storage has nothing to discard", () => {
  assert.deepEqual(changedFormKeys(settingsToForm(DEFAULT_SETTINGS), DEFAULT_SETTINGS), []);
});

test("changedFormKeys spots an edit in every kind of field", () => {
  const stored = settingsToForm(DEFAULT_SETTINGS);
  const edits: Partial<OptionsFormValues>[] = [
    { intervalMinutes: "45" }, // a number typed over
    { quietStart: "22:30" }, // a time
    { hideReposted: !stored.hideReposted }, // a toggle
    { pushBotToken: "123:ABC" }, // a credential
    { blockedTitleKeywords: ["Intern"] }, // a list of strings
    { blockedCompanies: [makeBlockedCompany("Acme")] }, // a list of records
    { watches: [{ id: "w1", name: "Indonesia", url: "https://x", enabled: true }] },
  ];
  for (const edit of edits) {
    assert.deepEqual(
      changedFormKeys({ ...stored, ...edit }, DEFAULT_SETTINGS),
      Object.keys(edit),
      JSON.stringify(edit),
    );
  }
});

test("changedFormKeys compares list contents, not identity", () => {
  const saved: Settings = {
    ...DEFAULT_SETTINGS,
    watches: [{ id: "w1", name: "Indonesia", url: "https://x", enabled: true }],
    blockedCompanies: [makeBlockedCompany("Acme")],
    blockedTitleKeywords: ["Intern"],
  };
  // Rebuilt arrays and objects, same values: re-rendering the page must not make
  // it look edited.
  const rebuilt: OptionsFormValues = {
    ...settingsToForm(saved),
    watches: [{ id: "w1", name: "Indonesia", url: "https://x", enabled: true }],
    blockedCompanies: [{ display: "Acme", normalized: "acme" }],
    blockedTitleKeywords: ["Intern"],
  };
  assert.deepEqual(changedFormKeys(rebuilt, saved), []);

  // One field of one record differs, and the lengths still match.
  const toggled = { ...rebuilt, watches: [{ ...rebuilt.watches[0]!, enabled: false }] };
  assert.deepEqual(changedFormKeys(toggled, saved), ["watches"]);

  // A removed entry, and an added one.
  assert.deepEqual(changedFormKeys({ ...rebuilt, blockedTitleKeywords: [] }, saved), [
    "blockedTitleKeywords",
  ]);
  assert.deepEqual(
    changedFormKeys({ ...rebuilt, blockedTitleKeywords: ["Intern", "Junior"] }, saved),
    ["blockedTitleKeywords"],
  );
});

test("changedFormKeys counts a text-only edit that would parse to the same number", () => {
  const stored = settingsToForm(DEFAULT_SETTINGS);
  assert.deepEqual(
    changedFormKeys({ ...stored, intervalMinutes: `0${stored.intervalMinutes}` }, DEFAULT_SETTINGS),
    ["intervalMinutes"],
  );
});

test("changedFormKeys: a .env prefill is an unsaved edit", () => {
  const stored = settingsToForm(DEFAULT_SETTINGS);
  const seeded = applyPushPrefill(stored, { botToken: "123:ABC", chatId: "999" });
  assert.deepEqual(changedFormKeys(seeded, DEFAULT_SETTINGS), ["pushBotToken", "pushChatId"]);
});

// ── round-trip ───────────────────────────────────────────────────────────────

test("settingsToForm then parseSettingsForm reproduces the settings", () => {
  const form = settingsToForm(DEFAULT_SETTINGS);
  const r = parseSettingsForm(form, DEFAULT_SETTINGS);
  assert.ok(r.ok);
  assert.deepEqual(r.settings, DEFAULT_SETTINGS);
});

// ── applyPushPrefill: the build:dev .env seed (defaults, never an override) ───

test("applyPushPrefill is a no-op for a normal build, where the prefill is null", () => {
  const form = validForm({ pushBotToken: "", pushChatId: "" });
  assert.equal(applyPushPrefill(form, null), form); // same reference
});

test("applyPushPrefill fills blank credentials from .env", () => {
  const form = validForm({ pushBotToken: "", pushChatId: "" });
  const out = applyPushPrefill(form, { botToken: "123:ABC", chatId: "999" });
  assert.equal(out.pushBotToken, "123:ABC");
  assert.equal(out.pushChatId, "999");
});

test("applyPushPrefill never clobbers a credential the user already saved", () => {
  const form = validForm({ pushBotToken: "mine", pushChatId: "my-chat" });
  const out = applyPushPrefill(form, { botToken: "from-env", chatId: "env-chat" });
  assert.equal(out.pushBotToken, "mine");
  assert.equal(out.pushChatId, "my-chat");
  assert.equal(out, form); // nothing changed, so the same reference comes back
});

test("applyPushPrefill fills only the blank half when one is already set", () => {
  const form = validForm({ pushBotToken: "mine", pushChatId: "" });
  const out = applyPushPrefill(form, { botToken: "from-env", chatId: "env-chat" });
  assert.equal(out.pushBotToken, "mine");
  assert.equal(out.pushChatId, "env-chat");
});

test("applyPushPrefill leaves the rest of the form untouched", () => {
  const form = validForm({ pushBotToken: "", pushChatId: "" });
  const out = applyPushPrefill(form, { botToken: "123:ABC", chatId: "999" });
  assert.deepEqual(
    { ...out, pushBotToken: "", pushChatId: "" },
    form,
  );
});

test("a prefilled form still round-trips into Settings", () => {
  const form = applyPushPrefill(
    validForm({ pushBotToken: "", pushChatId: "" }),
    { botToken: "123:ABC", chatId: "999" },
  );
  const r = parseSettingsForm(form, DEFAULT_SETTINGS);
  assert.ok(r.ok);
  assert.equal(r.settings.push.botToken, "123:ABC");
  assert.equal(r.settings.push.chatId, "999");
});
