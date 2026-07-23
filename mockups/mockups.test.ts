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

test("the tab shows read jobs staying on screen in All mode", () => {
  const html = read("./jobs.html");
  assert.match(html, /data-read="true"/);
  assert.match(html, /data-read="false"/);
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

test("styling ships both light and dark via prefers-color-scheme, no framework", () => {
  const css = read("./tokens.css");
  assert.match(css, /:root\s*{/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
});
