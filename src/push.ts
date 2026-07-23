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

/** Max jobs listed in one message; the rest are summarised as "+N more". */
const MAX_LISTED = 10;

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
 * Send the new-jobs push. Returns `true` only if Telegram accepted the message.
 *
 * Never throws: an offline phone or a Telegram outage must not stop the scan or
 * the badge update (PRD §8). `fetchImpl` is injectable purely for testing;
 * production callers use the global `fetch`.
 */
export async function sendPush(
  jobs: PushJob[],
  cfg: PushConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId || jobs.length === 0) {
    return false;
  }

  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: buildPushMessage(jobs),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    return res.ok;
  } catch {
    return false; // never let push failure break the scan
  }
}
