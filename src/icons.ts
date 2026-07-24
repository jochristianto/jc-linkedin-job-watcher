// The icon set — Lucide (https://lucide.dev), inlined.
//
// Every glyph in the UI used to be a literal character: ✓ ↺ ⊘ ⚙ ✕ on the
// buttons and emoji (🔍 🌱 ✅ 🔄 ⚠️) on the empty states. Those are fonts, not
// artwork: they render at a different weight, colour and baseline on every
// platform, emoji arrive pre-coloured so they ignore the theme entirely, and a
// few (⊘, ↺) fall back to a tofu box where the system font lacks them. One
// stroked icon family fixes all of that at once.
//
// The icons are **inlined here, not imported from npm**, for the same reason the
// rest of this project has no framework (issue #4, mockups decision 1): the
// markup functions in render.ts are pure string builders that must run under
// `node --test` with no bundler, and the static mockups in mockups/ must open
// from `file://` with no build step at all. A dependency would satisfy neither.
// Inlining is also exactly what `lucide-static` ships — the bodies below are
// copied verbatim from its `icons/<name>.svg`, v1.26.0 (ISC licence).
//
// Adding an icon: copy the inner nodes of the .svg from
// https://lucide.dev/icons/<name> into ICON_BODIES under the same name, and add
// the name to IconName. Nothing else changes — `icon()` supplies the wrapper.

/** The icons this UI actually uses, as data so the tests can walk every one of
 *  them. {@link IconName} is derived from it, so a typo at a call site is a type
 *  error rather than an empty `<svg>` shipped to the popup. */
export const ICON_NAMES = [
  "ban",
  "check",
  "circle-check",
  "clock",
  "moon",
  "refresh-cw",
  "rotate-ccw",
  "search",
  "settings",
  "sprout",
  "triangle-alert",
  "x",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Each icon's `<svg>` body, verbatim from lucide-static v1.26.0. Only the inner
 *  nodes live here; every icon shares the wrapper {@link icon} builds, which is
 *  what makes them one consistent family (24×24 grid, 2px round stroke). */
const ICON_BODIES: Record<IconName, string> = {
  ban: `<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  "circle-check": `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  clock: `<path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="10"/>`,
  moon: `<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>`,
  "refresh-cw": `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  "rotate-ccw": `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`,
  search: `<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>`,
  settings: `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>`,
  sprout: `<path d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3"/><path d="M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4"/><path d="M5 21h14"/>`,
  "triangle-alert": `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
};

/**
 * One icon as an inline `<svg>` string, ready to drop into any of the markup
 * builders.
 *
 * Inline, not `<img src>`, because the icon has to take its colour from the
 * button it sits in: `stroke="currentColor"` is what makes the block button turn
 * red on hover and the read button turn accent-coloured when pressed, with no
 * second copy of the asset per state.
 *
 * `size` writes width/height attributes so the icon is correct even before the
 * stylesheet lands (the popup paints once, immediately); `.lucide` in tokens.css
 * can still override it. Always `aria-hidden` — every icon here sits inside a
 * control that already carries its own `aria-label`/text, so announcing it again
 * would just repeat the label.
 */
export function icon(name: IconName, size = 16): string {
  return (
    `<svg class="lucide lucide-${name}" xmlns="http://www.w3.org/2000/svg"` +
    ` width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
    ` stroke="currentColor" stroke-width="2" stroke-linecap="round"` +
    ` stroke-linejoin="round" aria-hidden="true">${ICON_BODIES[name]}</svg>`
  );
}
