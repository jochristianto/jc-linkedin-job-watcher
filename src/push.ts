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
 * trick as {@link PushJob}, so a full `Job` record satisfies it.
 */
export type AppliedJob = {
  title: string;
  company: string;
  url: string;
};

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

/** Max jobs listed in one message; the rest are summarised as "+N more". */
const MAX_LISTED = 10;

/** Stand-in when a posting somehow carries no title, so the message's link is
 *  never invisible, untappable anchor text. The same words the row falls back to. */
const UNTITLED = "Untitled role";

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
 * Build the HTML message body for a batch of new jobs. Lists up to
 * {@link MAX_LISTED} jobs, then summarises the remainder — this is what keeps
 * the message under Telegram's 4096-char cap (PRD §8).
 */
export function buildPushMessage(jobs: PushJob[]): string {
  const lines = jobs
    .slice(0, MAX_LISTED)
    .map(
      (j) =>
        `<a href="${j.url}">${escapeHtml(j.title)}</a>\n` +
        `${escapeHtml(j.company)} · ${escapeHtml(j.location)}`,
    );
  if (jobs.length > MAX_LISTED) {
    lines.push(`<i>+${jobs.length - MAX_LISTED} more</i>`);
  }

  const header = `<b>${jobs.length} new job${jobs.length > 1 ? "s" : ""}</b>`;
  return `${header}\n\n${lines.join("\n\n")}`;
}

/**
 * Build the message for a job you have just told the extension you applied to:
 *
 *     [Applied] {jobTitle} at {companyName}
 *
 *     {notes}
 *
 * The title carries the posting's link, so the message doubles as the way back to
 * the job from a phone — that link is the whole reason it is worth pushing rather
 * than only writing down. Both halves degrade independently (PRD §12): a job whose
 * company never parsed drops the " at …" instead of trailing off mid-sentence, and
 * an empty note drops its blank line instead of padding the message with one.
 */
export function buildAppliedMessage(job: AppliedJob, notes: string): string {
  const title = escapeHtml(job.title.trim() || UNTITLED);
  const link = job.url ? `<a href="${job.url}">${title}</a>` : title;
  const company = job.company.trim();
  const at = company ? ` at ${escapeHtml(company)}` : "";
  const note = notes.trim();
  return `<b>[Applied]</b> ${link}${at}` + (note ? `\n\n${escapeHtml(note)}` : "");
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

/** Send the new-jobs push (PRD §8). An empty batch sends nothing — a cycle that
 *  found nothing pushes nothing, the same rule the desktop notification follows. */
export async function sendPush(
  jobs: PushJob[],
  cfg: PushConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!canPush(cfg) || jobs.length === 0) return false;
  return postMessage(buildPushMessage(jobs), cfg, fetchImpl);
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
