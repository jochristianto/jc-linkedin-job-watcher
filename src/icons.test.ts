import { test } from "node:test";
import assert from "node:assert/strict";
import { icon, ICON_NAMES, type IconName } from "./icons.ts";

test("every declared icon has a body — a name can't ship as an empty <svg>", () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    const body = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
    assert.match(body, /^<(path|circle|rect|line|polyline|polygon)/, name);
  }
});

test("no two icons share a body — a copy/paste slip would silently duplicate one", () => {
  const bodies = ICON_NAMES.map((n) => icon(n));
  assert.equal(new Set(bodies).size, ICON_NAMES.length);
});

test("icons carry the Lucide wrapper: 24-grid viewBox, currentColor stroke", () => {
  const svg = icon("check");
  assert.match(svg, /viewBox="0 0 24 24"/);
  // currentColor is what lets one asset serve hover, pressed, disabled and dark
  // mode — the whole reason these are inline SVG rather than <img>.
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /stroke-linecap="round"/);
});

test("icons are aria-hidden — the control around them carries the label", () => {
  for (const name of ICON_NAMES) {
    assert.match(icon(name), /aria-hidden="true"/, name);
  }
});

test("icons are class-tagged by name, so CSS and the tests can find one", () => {
  assert.match(icon("triangle-alert"), /class="lucide lucide-triangle-alert"/);
});

test("size writes both dimensions, defaulting to the 16px button icon", () => {
  assert.match(icon("x"), /width="16" height="16"/);
  assert.match(icon("x", 28), /width="28" height="28"/);
});

test("an unknown name cannot reach icon() — the union is the guard", () => {
  // Type-level assertion: this file failing `npm run typecheck` is the test.
  const name: IconName = "search";
  assert.match(icon(name), /lucide-search/);
});
