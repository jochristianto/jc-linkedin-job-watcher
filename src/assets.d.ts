// Ambient declarations for non-code assets imported by the page entries.
// Vite turns a `import "./tokens.css"` into a bundled stylesheet + injected
// <link>; TypeScript only needs to know the module exists.
declare module "*.css";

/**
 * Telegram credentials baked in at BUILD time from `.env`, or `null`.
 *
 * `vite.config.ts` always `define`s this, so it is never an undefined global:
 *   • `npm run build`      → always `null` (the shippable bundle holds no secret)
 *   • `npm run build:dev`  → the `.env` values, for local convenience only
 *
 * Structurally identical to `PushPrefill` in options-form.ts, which owns the
 * decision of what to do with it (an ambient declaration cannot import).
 */
declare const __LJW_PREFILL_PUSH__: { botToken: string; chatId: string } | null;
