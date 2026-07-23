import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  buildPushMessage,
  sendPush,
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
  const fakeFetch = async () => ({ ok: false }) as Response;
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
