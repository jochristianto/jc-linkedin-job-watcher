// Verification harness for issue #6 (05) — "Does a Telegram message actually
// land on your phone?"
//
// An automated agent cannot create a bot, obtain a chat ID, or look at a phone;
// those steps are the human's (see the checklist in the issue). This script is
// the one step that CAN be shared: it sends a test push using the exact
// production format from src/push.ts, so the human runs one command instead of
// hand-assembling curl, and the message they check is byte-for-byte what the
// extension will send.
//
// Credentials come from the environment — never hardcode, never commit them.
// Either copy `.env.example` to `.env` and fill it in (the npm script loads it
// via --env-file-if-exists, so it is optional and its absence is not an error),
// or pass them inline:
//
//   TELEGRAM_BOT_TOKEN=123456:ABC... \
//   TELEGRAM_CHAT_ID=987654321 \
//   npm run send-test-message
//
// This is the ONLY place in the project that reads env vars. The extension has
// no build-time config: a bundled secret would sit in dist/ in plain text, so
// the token it uses at runtime is entered in Options and kept in chrome.storage.
//
// Then check the message on your PHONE (not just desktop Telegram): confirm the
// link is tappable and the layout reads well.

import { sendPush, buildPushMessages, type PushJob } from "../src/push.ts";

const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
const chatId = process.env.TELEGRAM_CHAT_ID ?? "";

if (!botToken || !chatId) {
  console.error(
    "Missing credentials. Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, e.g.:\n" +
      "  TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm run send-test-message",
  );
  process.exit(1);
}

// A representative batch: an ampersand and a long title, so the phone view
// exercises HTML escaping and line wrapping — the things most likely to look wrong.
const sampleJobs: PushJob[] = [
  {
    title: "Senior Engineer & Lead",
    company: "Acme Corp",
    location: "Jakarta",
    url: "https://www.linkedin.com/jobs/view/1234567890",
  },
  {
    title: "Staff Software Engineer, Platform",
    company: "PT Contoh Indonesia",
    location: "Remote (Indonesia)",
    url: "https://www.linkedin.com/jobs/view/2234567890",
  },
];

// A batch over ten goes out as several messages (PRD §8), so print each one the
// way it will arrive rather than pretending the body is always a single message.
const bodies = buildPushMessages(sampleJobs);
console.log(`Sending ${bodies.length} message${bodies.length > 1 ? "s" : ""}:\n`);
console.log(bodies.join("\n\n--- (next message) ---\n\n"));
console.log("\n---");

const ok = await sendPush(sampleJobs, {
  enabled: true,
  botToken,
  chatId,
});

if (ok) {
  console.log(
    "Telegram accepted the message. Now open it on your PHONE and confirm the " +
      "links are tappable and the layout reads well.",
  );
} else {
  console.error(
    "Telegram did NOT accept the message. This is the silent-failure case PRD §8 " +
      "warns about — most likely a wrong chat ID or a revoked token. Re-check both.",
  );
  process.exit(1);
}
