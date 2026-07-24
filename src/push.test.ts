import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appliedPushNotice,
  escapeHtml,
  buildAppliedMessage,
  buildPushMessage,
  sendAppliedPush,
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

test("escapeHtml escapes the characters that break Telegram HTML mode", () => {
  assert.equal(escapeHtml("Sales & Marketing"), "Sales &amp; Marketing");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(escapeHtml('a "b" c'), "a &quot;b&quot; c");
});

test("buildPushMessage renders a single job with singular header", () => {
  const text = buildPushMessage([job()]);
  assert.equal(
    text,
    '<b>1 new job</b>\n\n' +
      '<a href="https://example.com/jobs/1">Senior Engineer</a>\n' +
      "Acme Corp · Jakarta",
  );
});

test("buildPushMessage pluralises the header for multiple jobs", () => {
  const text = buildPushMessage([job(), job({ title: "Lead" })]);
  assert.match(text, /^<b>2 new jobs<\/b>/);
});

test("buildPushMessage escapes job fields so & and < cannot break the message", () => {
  const text = buildPushMessage([
    job({ title: "Senior Engineer & Lead", company: "A<B" }),
  ]);
  assert.match(text, /Senior Engineer &amp; Lead/);
  assert.match(text, /A&lt;B/);
  assert.doesNotMatch(text, /Engineer & Lead/);
});

test("buildPushMessage caps at 10 jobs and reports the remainder", () => {
  const jobs = Array.from({ length: 13 }, (_, i) => job({ title: `Job ${i}` }));
  const text = buildPushMessage(jobs);
  assert.match(text, /^<b>13 new jobs<\/b>/);
  assert.match(text, /<i>\+3 more<\/i>$/);
  assert.equal((text.match(/<a href=/g) ?? []).length, 10);
});

test("buildPushMessage keeps a realistic batch under Telegram's 4096-char cap", () => {
  // Realistic LinkedIn field lengths: ~55-char title, ~30-char company,
  // ~25-char location. slice(0, 10) covers this comfortably (PRD §8).
  const jobs = Array.from({ length: 40 }, (_, i) =>
    job({
      title: `Senior Staff Software Engineer, Platform Team ${i}`,
      company: "Some Reasonably Named Company Ltd",
      location: "Jakarta, Indonesia (Remote)",
    }),
  );
  assert.ok(buildPushMessage(jobs).length < 4096);
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
  assert.match(body.text, /1 new job/);
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
    url: "https://example.com/jobs/1",
    ...overrides,
  };
}

test("buildAppliedMessage is the [Applied] line, the note, and the posting's link", () => {
  assert.equal(
    buildAppliedMessage(applied(), "Referred by Dita"),
    '<b>[Applied]</b> <a href="https://example.com/jobs/1">Senior Engineer</a> at Acme Corp' +
      "\n\nReferred by Dita",
  );
});

test("buildAppliedMessage drops the note, and its blank line, when none was typed", () => {
  const text = buildAppliedMessage(applied(), "   ");
  assert.equal(
    text,
    '<b>[Applied]</b> <a href="https://example.com/jobs/1">Senior Engineer</a> at Acme Corp',
  );
  assert.doesNotMatch(text, /\n/);
});

test("buildAppliedMessage always carries the job link — it is the way back to the posting", () => {
  assert.match(buildAppliedMessage(applied(), ""), /href="https:\/\/example\.com\/jobs\/1"/);
});

test("buildAppliedMessage degrades per field, like the row does", () => {
  // No company parsed: " at " with nothing after it would read as a bug (PRD §12).
  assert.equal(
    buildAppliedMessage(applied({ company: "  " }), ""),
    '<b>[Applied]</b> <a href="https://example.com/jobs/1">Senior Engineer</a>',
  );
  // No title: the anchor still needs visible text, or the link is untappable.
  assert.match(buildAppliedMessage(applied({ title: "" }), ""), />Untitled role</);
  // No url: the text survives without an anchor around it.
  assert.equal(
    buildAppliedMessage(applied({ url: "" }), ""),
    "<b>[Applied]</b> Senior Engineer at Acme Corp",
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
  assert.match(body.text, /^<b>\[Applied\]<\/b> /);
  assert.match(body.text, /Referred by Dita$/);
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
