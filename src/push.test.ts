import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appliedPushNotice,
  escapeHtml,
  buildAppliedMessage,
  buildFieldBreakPush,
  buildPushMessages,
  sendAppliedPush,
  sendFieldBreakPush,
  sendPush,
  type AppliedJob,
  type PushConfig,
  type PushJob,
} from "./push.ts";

function job(overrides: Partial<PushJob> = {}): PushJob {
  return {
    title: "Senior Engineer",
    company: "Acme Corp",
    location: "Jakarta",
    url: "https://example.com/jobs/1",
    ...overrides,
  };
}

const enabledCfg: PushConfig = {
  enabled: true,
  botToken: "123:ABC",
  chatId: "42",
};

/** Stand-in for the real inter-message pause, so a split batch's test doesn't
 *  spend a second per message. */
const noSleep = async () => {};

test("escapeHtml escapes the characters that break Telegram HTML mode", () => {
  assert.equal(escapeHtml("Sales & Marketing"), "Sales &amp; Marketing");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(escapeHtml('a "b" c'), "a &quot;b&quot; c");
});

test("buildPushMessages renders the [New Job Posts] format, numbered and labelled", () => {
  const [text, ...rest] = buildPushMessages([job(), job({ title: "Lead", location: "Bandung" })]);
  assert.equal(rest.length, 0);
  assert.equal(
    text,
    "<b>[New Job Posts]</b>\n\n" +
      '1. <a href="https://example.com/jobs/1">Senior Engineer</a>\n' +
      "Company: Acme Corp\n" +
      "Location: Jakarta\n\n" +
      '2. <a href="https://example.com/jobs/1">Lead</a>\n' +
      "Company: Acme Corp\n" +
      "Location: Bandung",
  );
});

test("buildPushMessages sends nothing for an empty batch", () => {
  assert.deepEqual(buildPushMessages([]), []);
});

test("buildPushMessages keeps the number outside the link, so only the title is tappable", () => {
  // A number swallowed into the anchor makes the tap target read "1. Senior
  // Engineer" — the link is the way back to the posting, not the list index.
  assert.match(buildPushMessages([job()])[0]!, /\n1\. <a href=/);
});

test("buildPushMessages escapes job fields so & and < cannot break the message", () => {
  const text = buildPushMessages([
    job({ title: "Senior Engineer & Lead", company: "A<B" }),
  ])[0]!;
  assert.match(text, /Senior Engineer &amp; Lead/);
  assert.match(text, /A&lt;B/);
  assert.doesNotMatch(text, /Engineer & Lead/);
});

test("buildPushMessages degrades per field, like the row does", () => {
  // No company parsed: a bare "Company:" label reads as a bug (PRD §12).
  const text = buildPushMessages([job({ company: "  ", location: "" })])[0]!;
  assert.doesNotMatch(text, /Company:/);
  assert.doesNotMatch(text, /Location:/);
  // No title: the anchor still needs visible text, or the link is untappable.
  assert.match(buildPushMessages([job({ title: "" })])[0]!, />Untitled role</);
  // No url: the text survives without an anchor around it.
  assert.match(buildPushMessages([job({ url: "" })])[0]!, /\n1\. Senior Engineer\n/);
});

test("buildPushMessages splits a batch 10 at a time instead of truncating it", () => {
  const jobs = Array.from({ length: 100 }, (_, i) => job({ title: `Job ${i}` }));
  const messages = buildPushMessages(jobs);

  assert.equal(messages.length, 10);
  // Every job is listed — the whole point of splitting rather than "+N more".
  assert.equal(
    messages.reduce((n, m) => n + (m.match(/<a href=/g) ?? []).length, 0),
    100,
  );
  for (const m of messages) assert.match(m, /^<b>\[New Job Posts\]<\/b>\n\n/);
  // Numbering runs across the batch: ten messages are one list continued, not
  // ten lists that each start at 1.
  assert.match(messages[0]!, /\n1\. /);
  assert.match(messages[1]!, /\n11\. /);
  assert.match(messages[9]!, /\n100\. /);
  assert.doesNotMatch(messages[9]!, /\n1\. /);
});

test("buildPushMessages leaves a partial last message rather than padding it", () => {
  const messages = buildPushMessages(Array.from({ length: 13 }, () => job()));
  assert.equal(messages.length, 2);
  assert.equal((messages[1]!.match(/<a href=/g) ?? []).length, 3);
});

test("buildPushMessages keeps every message under Telegram's 4096-char cap", () => {
  // Realistic LinkedIn field lengths: ~55-char title, ~30-char company,
  // ~25-char location. Ten per message covers this comfortably (PRD §8).
  const jobs = Array.from({ length: 40 }, (_, i) =>
    job({
      title: `Senior Staff Software Engineer, Platform Team ${i}`,
      company: "Some Reasonably Named Company Ltd",
      location: "Jakarta, Indonesia (Remote)",
    }),
  );
  for (const m of buildPushMessages(jobs)) assert.ok(m.length < 4096, `${m.length} chars`);
});

test("sendPush is a no-op (false) when disabled, unconfigured, or empty", async () => {
  const never = () => {
    throw new Error("fetch should not be called");
  };
  assert.equal(await sendPush([job()], { ...enabledCfg, enabled: false }, never), false);
  assert.equal(await sendPush([job()], { ...enabledCfg, botToken: "" }, never), false);
  assert.equal(await sendPush([job()], { ...enabledCfg, chatId: "" }, never), false);
  assert.equal(await sendPush([], enabledCfg, never), false);
});

test("sendPush POSTs the expected request and returns res.ok", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { ok: true } as Response;
  };

  const ok = await sendPush([job()], enabledCfg, fakeFetch as typeof fetch);

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://api.telegram.org/bot123:ABC/sendMessage",
  );
  assert.equal(calls[0]!.init.method, "POST");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.chat_id, "42");
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.disable_web_page_preview, true);
  assert.match(body.text, /^<b>\[New Job Posts\]<\/b>/);
});

test("sendPush POSTs one request per message for a batch over ten", async () => {
  const texts: string[] = [];
  const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
    texts.push(JSON.parse(String(init?.body)).text);
    return { ok: true } as Response;
  };
  const gaps: number[] = [];

  const ok = await sendPush(
    Array.from({ length: 25 }, (_, i) => job({ title: `Job ${i}` })),
    enabledCfg,
    fakeFetch as typeof fetch,
    async (ms) => void gaps.push(ms),
  );

  assert.equal(ok, true);
  assert.equal(texts.length, 3);
  // Paced between messages, but never before the first: a single-message batch
  // must not be delayed by the splitting rule.
  assert.equal(gaps.length, 2);
  assert.ok(gaps.every((ms) => ms > 0));
  assert.match(texts[0]!, /\n1\. /);
  assert.match(texts[2]!, /\n21\. /);
});

test("sendPush keeps sending after a refusal, and reports the batch as failed", async () => {
  // A transient refusal on one part must not cost the parts after it — but the
  // call still returns false so the §16.7 counter sees the batch didn't land.
  let n = 0;
  const failSecond = async () =>
    (++n === 2
      ? { ok: false, status: 400, text: async () => "" }
      : { ok: true }) as unknown as Response;

  const ok = await sendPush(
    Array.from({ length: 25 }, () => job()),
    enabledCfg,
    failSecond as typeof fetch,
    noSleep,
  );

  assert.equal(ok, false);
  assert.equal(n, 3);
});

test("sendPush returns false (not throwing) when Telegram reports failure", async () => {
  // `status`/`text` are read to log *why* Telegram refused, so the fake carries
  // the same shape a real refusal has.
  const fakeFetch = async () =>
    ({
      ok: false,
      status: 400,
      text: async () => '{"description":"Bad Request: chat not found"}',
    }) as unknown as Response;
  assert.equal(await sendPush([job()], enabledCfg, fakeFetch as typeof fetch), false);
});

test("sendPush swallows network errors so a failed push cannot break the scan", async () => {
  const throwingFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(
    await sendPush([job()], enabledCfg, throwingFetch as typeof fetch),
    false,
  );
});

// ── The [Applied] message ────────────────────────────────────────────────────

function applied(overrides: Partial<AppliedJob> = {}): AppliedJob {
  return {
    title: "Senior Engineer",
    company: "Acme Corp",
    location: "Jakarta",
    url: "https://example.com/jobs/1",
    ...overrides,
  };
}

test("buildAppliedMessage is the [Applied] header, the job block, and the note", () => {
  assert.equal(
    buildAppliedMessage(applied(), "Referred by Dita"),
    "<b>[Applied]</b>\n\n" +
      '<a href="https://example.com/jobs/1">Senior Engineer</a>\n' +
      "Company: Acme Corp\n" +
      "Location: Jakarta\n" +
      "Notes: Referred by Dita",
  );
});

test("buildAppliedMessage lists the job unnumbered — it is one posting, not a list", () => {
  assert.doesNotMatch(buildAppliedMessage(applied(), ""), /1\. /);
});

test("buildAppliedMessage drops the Notes line when none was typed", () => {
  const text = buildAppliedMessage(applied(), "   ");
  assert.equal(
    text,
    "<b>[Applied]</b>\n\n" +
      '<a href="https://example.com/jobs/1">Senior Engineer</a>\n' +
      "Company: Acme Corp\n" +
      "Location: Jakarta",
  );
  assert.doesNotMatch(text, /Notes:/);
});

test("buildAppliedMessage always carries the job link — it is the way back to the posting", () => {
  assert.match(buildAppliedMessage(applied(), ""), /href="https:\/\/example\.com\/jobs\/1"/);
});

test("buildAppliedMessage degrades per field, like the row does", () => {
  // No company or location parsed: a bare label would read as a bug (PRD §12).
  assert.equal(
    buildAppliedMessage(applied({ company: "  ", location: "" }), "on it"),
    '<b>[Applied]</b>\n\n<a href="https://example.com/jobs/1">Senior Engineer</a>\nNotes: on it',
  );
  // No title: the anchor still needs visible text, or the link is untappable.
  assert.match(buildAppliedMessage(applied({ title: "" }), ""), />Untitled role</);
  // No url: the text survives without an anchor around it.
  assert.equal(
    buildAppliedMessage(applied({ url: "" }), ""),
    "<b>[Applied]</b>\n\nSenior Engineer\nCompany: Acme Corp\nLocation: Jakarta",
  );
});

test("buildAppliedMessage escapes the job fields AND the note", () => {
  // The note is the one field a human types, so it is the likeliest to hold a <.
  const text = buildAppliedMessage(
    applied({ title: "R&D <lead>", company: "A<B" }),
    'Emailed <hr@a&b.com> about "the offer"',
  );
  assert.match(text, /R&amp;D &lt;lead&gt;/);
  assert.match(text, /A&lt;B/);
  assert.match(text, /&lt;hr@a&amp;b\.com&gt;/);
  assert.match(text, /&quot;the offer&quot;/);
  assert.doesNotMatch(text, /<lead>/);
});

test("sendAppliedPush is a no-op (false) when push is off or unconfigured", async () => {
  const never = () => {
    throw new Error("fetch should not be called");
  };
  const cases: PushConfig[] = [
    { ...enabledCfg, enabled: false },
    { ...enabledCfg, botToken: "" },
    { ...enabledCfg, chatId: "" },
  ];
  for (const cfg of cases) {
    assert.equal(await sendAppliedPush(applied(), "a note", cfg, never as typeof fetch), false);
  }
});

test("sendAppliedPush POSTs the [Applied] text to the same endpoint as the scan push", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { ok: true } as Response;
  };

  const ok = await sendAppliedPush(applied(), "Referred by Dita", enabledCfg, fakeFetch as typeof fetch);

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.telegram.org/bot123:ABC/sendMessage");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.chat_id, "42");
  assert.equal(body.parse_mode, "HTML");
  assert.match(body.text, /^<b>\[Applied\]<\/b>\n\n/);
  assert.match(body.text, /Notes: Referred by Dita$/);
});

test("appliedPushNotice says nothing when the message actually went out", () => {
  assert.equal(appliedPushNotice({ sent: true }), null);
});

test("appliedPushNotice tells the four failures apart — each needs a different fix", () => {
  // The bug this exists to stop: one sentence for every failure sent the user
  // checking credentials that were fine, when the toggle was simply off.
  const lines = (["push-off", "unconfigured", "refused", "unknown-job"] as const).map((reason) =>
    appliedPushNotice({ sent: false, reason }),
  );
  assert.equal(new Set(lines).size, 4);

  assert.match(appliedPushNotice({ sent: false, reason: "push-off" })!, /off in Options/);
  // The trap by name: Send test message reads the live fields and forces the
  // toggle on, so it succeeds against settings that were never saved.
  assert.match(appliedPushNotice({ sent: false, reason: "unconfigured" })!, /Save settings/);
  assert.match(appliedPushNotice({ sent: false, reason: "refused" })!, /refused|Re-check/);
  assert.match(appliedPushNotice({ sent: false, reason: "unknown-job" })!, /no longer in the list/);
});

test("appliedPushNotice leads with the record being safe, except when there is none", () => {
  // Every failure but one happens *after* the application is written, and that is
  // the first thing the user needs to know.
  for (const reason of ["push-off", "unconfigured", "refused"] as const) {
    assert.match(appliedPushNotice({ sent: false, reason })!, /^Saved as applied/, reason);
  }
  // `unknown-job` is the exception: nothing was written, so it must not claim it was.
  assert.doesNotMatch(appliedPushNotice({ sent: false, reason: "unknown-job" })!, /Saved/);
});

test("appliedPushNotice covers a worker that never answered, and an unknown reason", () => {
  // Names the fix, because the overwhelmingly common cause is a service worker
  // still running the script from before the last build.
  assert.match(appliedPushNotice(null)!, /worker didn't answer/);
  assert.match(appliedPushNotice(null)!, /Reload the extension/);
  // A reply from a future/older build with a reason this one doesn't know still
  // says something true rather than falling through to silence.
  assert.match(appliedPushNotice({ sent: false })!, /didn't go out/);
});

test("sendAppliedPush swallows failures — the record is already saved either way", async () => {
  const refused = async () =>
    ({ ok: false, status: 400, text: async () => "" }) as unknown as Response;
  const throwing = async () => {
    throw new Error("network down");
  };
  assert.equal(await sendAppliedPush(applied(), "", enabledCfg, refused as typeof fetch), false);
  assert.equal(await sendAppliedPush(applied(), "", enabledCfg, throwing as typeof fetch), false);
});

// ── The field-break alarm (issue #54, §8 / §16.4) ────────────────────────────

test("buildFieldBreakPush matches the copy: names the field, gives 0 of N, says jobs still arrive, points at Options", () => {
  assert.equal(
    buildFieldBreakPush(["company"], 25),
    "⚠️ LinkedIn's job list changed\n\n" +
      "Company names stopped reading — 0 of the 25 jobs on the last scan had one.\n\n" +
      "Everything else still works. Jobs are still being found and sent to you.\n\n" +
      "To get it fixed, save a copy of your job-search page while you're logged in. " +
      "The extension's Options page has a button for it.",
  );
});

test("buildFieldBreakPush says jobs have STOPPED arriving when a load-bearing field broke", () => {
  // A dead `location` is cosmetic; a dead `title` (or `url`) means no job is saved
  // at all, and that is the one thing the reader needs to know (issue #54, job 3).
  const title = buildFieldBreakPush(["title"], 25)!;
  assert.match(title, /Job titles stopped reading — 0 of the 25 jobs/);
  assert.doesNotMatch(title, /still being found/);
  assert.match(title, /can't be read while this is broken/);

  assert.match(buildFieldBreakPush(["url"], 25)!, /can't be read while this is broken/);
});

test("buildFieldBreakPush names every broken field when a deploy kills more than one", () => {
  const text = buildFieldBreakPush(["company", "location"], 25)!;
  assert.match(text, /Company names and Locations stopped reading/);
  // Plural pronoun once more than one field is named.
  assert.match(text, /had them\./);
  // company+location are both cosmetic, so jobs are still arriving.
  assert.match(text, /still being found/);
});

test("buildFieldBreakPush names the date-or-label invariant readably, not as a raw key", () => {
  assert.match(buildFieldBreakPush(["dateOrLabel"], 25)!, /Posting dates stopped reading/);
});

test("buildFieldBreakPush is null when nothing is broken — there is nothing to alarm about", () => {
  assert.equal(buildFieldBreakPush([], 25), null);
});

test("sendFieldBreakPush is a no-op (false) when push is off or unconfigured", async () => {
  const never = () => {
    throw new Error("fetch should not be called");
  };
  const cases: PushConfig[] = [
    { ...enabledCfg, enabled: false },
    { ...enabledCfg, botToken: "" },
    { ...enabledCfg, chatId: "" },
  ];
  for (const cfg of cases) {
    assert.equal(await sendFieldBreakPush("⚠️ …", cfg, never as typeof fetch), false);
  }
});

test("sendFieldBreakPush POSTs the alarm to the same endpoint as every other push", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { ok: true } as Response;
  };

  const text = buildFieldBreakPush(["company"], 25)!;
  const ok = await sendFieldBreakPush(text, enabledCfg, fakeFetch as typeof fetch);

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.telegram.org/bot123:ABC/sendMessage");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.chat_id, "42");
  assert.equal(body.text, text);
});

test("sendFieldBreakPush swallows failures — a dead phone must not break the scan that noticed the break", async () => {
  const refused = async () =>
    ({ ok: false, status: 400, text: async () => "" }) as unknown as Response;
  const throwing = async () => {
    throw new Error("network down");
  };
  assert.equal(await sendFieldBreakPush("⚠️ …", enabledCfg, refused as typeof fetch), false);
  assert.equal(await sendFieldBreakPush("⚠️ …", enabledCfg, throwing as typeof fetch), false);
});
