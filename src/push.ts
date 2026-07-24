// Telegram push — PRD §8 "Push to phone (Telegram)".
//
// This is the code that produces the message that lands on a phone. It is kept
// deliberately self-contained (no chrome.* dependency, an injectable `fetch`)
// so the message format can be unit-tested and so `scripts/send-test-message.ts`
// can drive a real send end-to-end — the checklist in issue #6 (05).

/** The Telegram credentials, as stored in Settings.push (PRD §5). */
export type PushConfig = {
  enabled: boolean;
  botToken: string;
  chatId: string;
};

/**
 * The fields of a Job (PRD §5) that a push message needs. A structural subset:
 * the full `Job` record satisfies this type, so `sendPush(newJobs, ...)` type-checks.
 */
export type PushJob = {
  title: string;
  company: string;
  location: string;
  url: string;
};

/**
 * The fields of a Job the `[Applied]` message needs — the same structural-subset
 * trick as {@link PushJob}, so a full `Job` record satisfies it. The same four
 * fields as {@link PushJob}: both messages carry the identical job block, so a
 * posting reads the same whether it arrived as new or as one you applied to.
 */
export type AppliedJob = PushJob;

/**
 * The message the list view sends the background when you answer "Yes" to "Did
 * you apply for this job?".
 *
 * The payload is only the id: the page writes the record — `applied`, `appliedAt`
 * and the note — to storage *before* this goes out, so the worker reads the job it
 * names and builds the message from that. It travels to the worker rather than
 * being fetched from the page because the popup is destroyed the moment it loses
 * focus, which would cut off a request in flight, and because the worker owns the
 * §16.7 push-failure counter.
 */
export type AppliedPushRequest = { type: "LJW_APPLIED"; jobId: string };

/**
 * Why an `[Applied]` message did not go out. A bare `false` is not enough: "switch
 * push on", "press Save", and "your token is wrong" are three different jobs for
 * the user, and one sentence covering all three sends them looking in the wrong
 * place — which is exactly what happened the first time this shipped.
 *
 * - `push-off`     — credentials are saved, the "Send new jobs to Telegram" toggle
 *                    is off. Note that Options' **Send test message** forces
 *                    `enabled: true` and reads the *unsaved* fields, so it succeeds
 *                    in this state while every real push is skipped.
 * - `unconfigured` — no bot token or no chat id in **saved** settings. Same trap
 *                    from the other side: typing them and testing is not saving them.
 * - `refused`      — Telegram was asked and said no (wrong chat id, revoked token,
 *                    a message it wouldn't parse). `postMessage` logs its reason.
 * - `unknown-job`  — the id named no stored job, so there was nothing to build a
 *                    message from. Means the record was not written either.
 */
export type AppliedPushFailure = "push-off" | "unconfigured" | "refused" | "unknown-job";

/** Whether Telegram accepted the `[Applied]` message, and if not, which of the
 *  four reasons it was. */
export type AppliedPushResponse = { sent: boolean; reason?: AppliedPushFailure };

/** Jobs listed per message. A batch longer than this is split across several
 *  messages rather than truncated — 100 new jobs arrive as 10 messages of 10, so
 *  nothing is summarised away as "+N more" and every posting keeps its link. Ten
 *  also keeps each message far under Telegram's 4096-char cap (PRD §8). */
export const JOBS_PER_MESSAGE = 10;

/** Pause between the messages of one split batch. Telegram tolerates bursts but
 *  throttles a bot posting to the same chat at roughly a message a second, and a
 *  429 here would drop part of the batch silently — the PRD's own advice for
 *  sending everything: "chunk with a delay between" (§8). */
const MESSAGE_GAP_MS = 1000;

/** Stand-in when a posting somehow carries no title, so the message's link is
 *  never invisible, untappable anchor text. The same words the row falls back to. */
const UNTITLED = "Untitled role";

/** The real pause between messages; injectable in {@link sendPush} purely so
 *  tests don't spend a second per message. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Escape the characters that would otherwise break Telegram's HTML parse mode.
 * Required, not optional — job titles contain `&` and `<` often enough to
 * corrupt the message (PRD §8).
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * One job as it appears in either message — the shared block that makes the two
 * formats read alike:
 *
 *     {prefix}{jobTitle}
 *     Company: {companyName}
 *     Location: {location}
 *
 * The title always carries the posting's link, so the message doubles as the way
 * back to the job from a phone; that link is the whole reason a message is worth
 * pushing rather than only writing down. `prefix` is the list number in the
 * new-jobs message ("1. ") and empty in the `[Applied]` one, and stays *outside*
 * the anchor so the tappable text is the title alone.
 *
 * Every line degrades on its own (PRD §12): a job whose company never parsed
 * drops the `Company:` line rather than showing an empty label, and a job with no
 * url keeps its title as plain text rather than an anchor with nothing behind it.
 */
function jobBlock(job: PushJob, prefix = ""): string {
  const title = escapeHtml(job.title.trim() || UNTITLED);
  const link = job.url ? `<a href="${job.url}">${title}</a>` : title;
  const lines = [`${prefix}${link}`];
  const company = job.company.trim();
  if (company) lines.push(`Company: ${escapeHtml(company)}`);
  const location = job.location.trim();
  if (location) lines.push(`Location: ${escapeHtml(location)}`);
  return lines.join("\n");
}

/**
 * Build the messages for a batch of new jobs:
 *
 *     [New Job Posts]
 *
 *     1. {jobTitle}
 *     Company: {companyName}
 *     Location: {location}
 *
 *     2. {jobTitle}
 *     …
 *
 * Returns one string per message: the batch is split {@link JOBS_PER_MESSAGE} at
 * a time, so a 100-job catch-up scan arrives as ten messages instead of one list
 * cut off at ten with the rest lost. Numbering runs across the whole batch rather
 * than restarting per message, so ten messages read as one list continued (…10,
 * then 11…) instead of ten lists that all begin at 1. An empty batch yields no
 * messages at all.
 */
export function buildPushMessages(jobs: PushJob[]): string[] {
  const messages: string[] = [];
  for (let start = 0; start < jobs.length; start += JOBS_PER_MESSAGE) {
    const blocks = jobs
      .slice(start, start + JOBS_PER_MESSAGE)
      .map((job, i) => jobBlock(job, `${start + i + 1}. `));
    messages.push(`<b>[New Job Posts]</b>\n\n${blocks.join("\n\n")}`);
  }
  return messages;
}

/**
 * Build the message for a job you have just told the extension you applied to:
 *
 *     [Applied]
 *
 *     {jobTitle}
 *     Company: {companyName}
 *     Location: {location}
 *     Notes: {notes}
 *
 * The same {@link jobBlock} as a new job, unnumbered — it is one posting, not a
 * list — plus whatever was typed alongside the answer. An empty note drops its
 * line instead of leaving a bare `Notes:` label.
 */
export function buildAppliedMessage(job: AppliedJob, notes: string): string {
  const note = notes.trim();
  return (
    `<b>[Applied]</b>\n\n${jobBlock(job)}` + (note ? `\nNotes: ${escapeHtml(note)}` : "")
  );
}

/** Is push configured enough to attempt a send at all (PRD §8)? Shared by both
 *  senders so "off", "no token" and "no chat id" mean the same thing everywhere. */
function canPush(cfg: PushConfig): boolean {
  return cfg.enabled && cfg.botToken !== "" && cfg.chatId !== "";
}

/**
 * The line the list view shows after recording an application: `null` when the
 * message went out (nothing to say), otherwise what to do about it. `res` is
 * `null` when the worker never answered at all.
 *
 * The record is always already saved by the time this is read, so every line says
 * so first — the application is not at risk, only the message — and then names the
 * one thing that would fix it. Kept here as a pure function so the wording of a
 * failure the user will actually meet is covered by `node --test`, not left to a
 * string literal buried in a component.
 */
export function appliedPushNotice(res: AppliedPushResponse | null): string | null {
  if (res == null) {
    // No listener took the message, twice. In development that is almost always a
    // stale service worker: the popup and the jobs page are re-read from disk every
    // time they open, so a fresh `npm run build` shows new page code immediately —
    // while Chrome keeps running the worker script it registered when the extension
    // was last loaded, handlers and all. Reloading the extension re-registers it.
    return "Saved as applied — the background worker didn't answer. Reload the extension at chrome://extensions, then undo and answer again.";
  }
  if (res.sent) return null;
  switch (res.reason) {
    case "push-off":
      return "Saved as applied. “Send new jobs to Telegram” is off in Options, so nothing was sent.";
    case "unconfigured":
      return "Saved as applied. Add your Telegram bot token and chat id in Options and press Save settings — testing them is not saving them.";
    case "refused":
      return "Saved as applied — Telegram refused the message. Re-check the bot token and chat id in Options.";
    case "unknown-job":
      return "That job is no longer in the list, so nothing was saved or sent.";
    default:
      return "Saved as applied — but the Telegram message didn't go out. Check Telegram push in Options.";
  }
}

/**
 * POST one message to the Bot API. Returns `true` only if Telegram accepted it,
 * and never throws: an offline phone or a Telegram outage must not stop the scan,
 * the badge update, or an applied record already written to storage (PRD §8).
 * `fetchImpl` is injectable purely for testing; production callers use the global
 * `fetch`.
 */
async function postMessage(
  text: string,
  cfg: PushConfig,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    // A refusal's *reason* is in the body, not the status: Telegram answers 400 with
    // `{"description":"Bad Request: chat not found"}` — the difference between a
    // wrong chat id and a message it couldn't parse. Logged, because otherwise the
    // only symptom is a message that never arrives. The URL is deliberately not
    // logged: it carries the bot token.
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[ljw] Telegram refused the message (${res.status}): ${detail}`);
    }
    return res.ok;
  } catch (err) {
    console.warn("[ljw] Telegram push failed to send:", err);
    return false; // never let push failure break the caller
  }
}

/**
 * Send the new-jobs push (PRD §8). An empty batch sends nothing — a cycle that
 * found nothing pushes nothing, the same rule the desktop notification follows.
 *
 * A batch over {@link JOBS_PER_MESSAGE} goes out as several messages, one after
 * another with {@link MESSAGE_GAP_MS} between them so Telegram doesn't throttle
 * the tail of a big catch-up batch away. A refused message does not abandon the
 * ones after it — a transient 4xx on part 3 must not cost parts 4-10 — but it
 * does make the whole call return `false`, so the §16.7 failure counter still
 * sees a batch that didn't fully land. `sleepImpl` is injectable for the same
 * reason `fetchImpl` is: so the tests don't wait out the real gap.
 */
export async function sendPush(
  jobs: PushJob[],
  cfg: PushConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<boolean> {
  if (!canPush(cfg) || jobs.length === 0) return false;
  let allSent = true;
  for (const [i, text] of buildPushMessages(jobs).entries()) {
    if (i > 0) await sleepImpl(MESSAGE_GAP_MS);
    if (!(await postMessage(text, cfg, fetchImpl))) allSent = false;
  }
  return allSent;
}

/** Send the `[Applied]` push for one job. Same credential, same swallowed
 *  failures, same silent-failure mode as {@link sendPush} — hence the shared POST
 *  and the shared §16.7 counter on the calling side. */
export async function sendAppliedPush(
  job: AppliedJob,
  notes: string,
  cfg: PushConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!canPush(cfg)) return false;
  return postMessage(buildAppliedMessage(job, notes), cfg, fetchImpl);
}
