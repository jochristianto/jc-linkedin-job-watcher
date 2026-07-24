import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

// These guard that the static HTML mockups actually cover every screen and
// state the issue asks about — so the mockups can't quietly drift out of sync
// with the questions they answer.

test("popup mounts the list as the ~400px popup view, defaulting to New", () => {
  const html = read("./popup.html");
  assert.match(html, /class="view-popup"/);
  assert.match(html, /<link[^>]+tokens\.css/);
});

test("jobs tab reuses the same component in the wider tab view", () => {
  const html = read("./jobs.html");
  assert.match(html, /class="view-tab"/);
  assert.match(html, /<link[^>]+tokens\.css/);
});

test("both popup and tab carry the watch chips and the New/All toggle", () => {
  for (const name of ["./popup.html", "./jobs.html"]) {
    const html = read(name);
    assert.match(html, /class="chip"/, `${name} chips`);
    assert.match(html, /class="toggle"/, `${name} toggle`);
    assert.match(html, />New</, `${name} New`);
    assert.match(html, />All</, `${name} All`);
  }
});

test("both popup and tab carry the manual Scan now control in the header", () => {
  for (const name of ["./popup.html", "./jobs.html"]) {
    const html = read(name);
    assert.match(html, /data-scan-state="idle"/, `${name} scan state`);
    assert.match(html, />Scan now</, `${name} label`);
  }
});

test("the tab shows read jobs staying on screen in All mode", () => {
  const html = read("./jobs.html");
  assert.match(html, /data-read="true"/);
  assert.match(html, /data-read="false"/);
});

test("both views show an opened job staying on screen, highlighted rather than gone", () => {
  for (const name of ["./popup.html", "./jobs.html"]) {
    const html = read(name);
    // data-opened + data-read="false" on the same row is the whole point: you
    // clicked through to it and it is still in the list.
    assert.match(html, /data-read="false" data-opened="true"/, name);
  }
});

test("every row carries its own read and block buttons", () => {
  for (const name of ["./popup.html", "./jobs.html"]) {
    const html = read(name);
    assert.match(html, /data-action="read"/, `${name} read`);
    assert.match(html, /data-action="block"/, `${name} block`);

    // The buttons sit outside the anchor — a <button> inside <a> is invalid
    // HTML. Check each anchor's own body, not the file as a whole, or the match
    // runs past </a> into the next row's buttons.
    for (const [, body] of html.matchAll(/<a class="job-main"[^>]*>([\s\S]*?)<\/a>/g)) {
      assert.doesNotMatch(body!, /<button/, `${name} button inside anchor`);
    }
  }
});

test("both views show a blocked company greyed and tagged, still on screen", () => {
  for (const name of ["./popup.html", "./jobs.html"]) {
    const html = read(name);
    assert.match(html, /data-blocked="true"/, `${name} state`);
    assert.match(html, /class="job-tag">Blocked</, `${name} tag`);
    // Blocking is undoable from the row it was pressed on.
    assert.match(html, /data-action="block" aria-pressed="true"/, `${name} unblock`);
  }
});

test("the tab shows the read toggle flipped to its undo state", () => {
  const html = read("./jobs.html");
  assert.match(html, /data-action="read" aria-pressed="true"[^>]*title="Mark as unread"/);
});

test("a job row degrades when a field is missing (no dangling separator)", () => {
  const html = read("./popup.html");
  // The mockup includes a row whose meta is company-only (location missing).
  assert.match(html, /class="job-meta">Momo Financial</);
});

test("all five empty/degraded states are present in the showcase", () => {
  const html = read("./states.html");
  for (const kind of [
    "no-watches",
    "no-jobs-yet",
    "no-new",
    "scanning",
    "scan-error",
  ]) {
    assert.match(html, new RegExp(`data-kind="${kind}"`), kind);
  }
});

test("options page has every settings section including the Telegram test button", () => {
  const html = read("./options.html");
  for (const heading of [
    "Searches",
    "Filters",
    "Scanning",
    "Retention",
    "Telegram push",
  ]) {
    assert.match(html, new RegExp(`<h2>${heading}</h2>`), heading);
  }
  assert.match(html, /Send test message/);
});

test("every mockup draws its icons as inline Lucide SVG, never a font glyph", () => {
  // The mockups are hand-authored copies of what render.ts emits (see the
  // fidelity note in README.md), so they are the one place an emoji could creep
  // back in unnoticed — the production markup is guarded in render.test.ts.
  const glyphs = /[\u{2190}-\u{21FF}\u{2200}-\u{22FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F300}-\u{1FAFF}]/u;
  for (const name of ["./popup.html", "./jobs.html", "./states.html", "./options.html"]) {
    const html = read(name);
    assert.match(html, /class="lucide lucide-/, `${name} has Lucide icons`);
    assert.doesNotMatch(html, glyphs, `${name} has no leftover glyph or emoji`);
  }
});

test("the mockups' icons match what render.ts emits, icon for icon", () => {
  const rows = read("./popup.html") + read("./jobs.html");
  assert.match(rows, /data-action="read"[^>]*>\s*<svg[^>]*lucide-check/);
  assert.match(rows, /data-action="read"[^>]*>\s*<svg[^>]*lucide-rotate-ccw/);
  assert.match(rows, /data-action="block"[^>]*>\s*<svg[^>]*lucide-ban/);
  assert.match(rows, /lucide-settings/);

  const states = read("./states.html");
  for (const name of ["search", "sprout", "circle-check", "refresh-cw", "triangle-alert"]) {
    assert.match(states, new RegExp(`lucide-${name}`), name);
  }
});

test("styling ships both light and dark via prefers-color-scheme, no framework", () => {
  const css = read("./tokens.css");
  assert.match(css, /:root\s*{/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
});
