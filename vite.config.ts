import { defineConfig, loadEnv } from "vite";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Main build (ticket 01). Emits the background service worker as an ES module and
// the three pages as HTML entries, then copies the MV3 manifest verbatim into
// dist/. The content script is a SEPARATE build (vite.content.config.ts) because
// an MV3 content script must be a classic, non-module script — see package.json's
// `build` script, which runs this first, then the content build.
//
// `extension/` (the issue #5 spike) is deliberately not an input here, so it is
// excluded from the shipped bundle.

const root = process.cwd();

// ── The `.env` prefill, and why it is opt-in ─────────────────────────────────
// The Options page runs inside Chrome and can never read a file on disk, so the
// only route from `.env` into it is a build-time constant — which means the
// credential ends up as plain text inside dist/. That is fine for a local
// convenience build and NOT fine for anything you'd share, so the two are split:
//
//   npm run build      → mode "production" → __LJW_PREFILL_PUSH__ = null
//   npm run build:dev  → mode "prefill"    → __LJW_PREFILL_PUSH__ = { … }
//
// The default build is therefore incapable of leaking a token: `null` is not a
// conditional on some env var being unset, it is what "production" always emits.
const PREFILL_MODE = "prefill";

type PushPrefill = { botToken: string; chatId: string } | null;

/** Read the two Telegram values out of `.env`, but only in {@link PREFILL_MODE}.
 *  Returns null when the mode is anything else, or when `.env` set neither value
 *  (so `build:dev` without a `.env` behaves exactly like a normal build). */
function loadPushPrefill(mode: string): PushPrefill {
  if (mode !== PREFILL_MODE) return null;
  // "" = no prefix filter. Vite only exposes VITE_-prefixed vars to client code
  // by default; these are deliberately unprefixed so they can NEVER reach the
  // bundle by accident — only through the explicit `define` below.
  const env = loadEnv(mode, root, "");
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.TELEGRAM_CHAT_ID ?? "";
  return botToken || chatId ? { botToken, chatId } : null;
}

export default defineConfig(({ mode }) => {
  const prefill = loadPushPrefill(mode);

  return {
  // Always defined, in every mode, so the global is never missing at runtime.
  define: {
    __LJW_PREFILL_PUSH__: JSON.stringify(prefill),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(root, "src/background.ts"),
        popup: resolve(root, "popup.html"),
        jobs: resolve(root, "jobs.html"),
        options: resolve(root, "options.html"),
      },
      output: {
        // The manifest references "background.js" at a fixed path, so that one
        // entry keeps a stable name; page scripts are hashed under assets/.
        entryFileNames: (chunk) =>
          chunk.name === "background"
            ? "background.js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [
    {
      name: "ljw-copy-manifest",
      closeBundle() {
        copyFileSync(
          resolve(root, "manifest.json"),
          resolve(root, "dist/manifest.json"),
        );
        // The manifest, action and desktop notification all reference these at a
        // fixed `icons/` path, so ship them verbatim (PRD §3/§9 notification icon).
        mkdirSync(resolve(root, "dist/icons"), { recursive: true });
        for (const size of [16, 48, 128]) {
          copyFileSync(
            resolve(root, `icons/icon-${size}.png`),
            resolve(root, `dist/icons/icon-${size}.png`),
          );
        }
      },
    },
    // A prefill build puts a live credential in dist/ as plain text. Say so, every
    // time, so a `build:dev` output is never mistaken for a shippable one.
    {
      name: "ljw-warn-prefill",
      closeBundle() {
        if (!prefill) return;
        console.warn(
          "\n  ⚠  DEV BUILD — your Telegram credentials from .env are embedded in dist/ as plain text." +
            "\n     Do not share, zip or publish this dist/. Run `npm run build` for a clean one.\n",
        );
      },
    },
  ],
  };
});
