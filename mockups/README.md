# Popup & settings mockups — answer to issue #10

PRD §4 names the list view as "a shared component, mounted twice" (`popup.html`
+ `jobs.html`) but never says what it's built with or what it looks like. These
static mockups make both concrete so an unattended agent doesn't invent them.

## Open them

Static HTML with fake data — no extension, no storage, nothing to run. Open the
files directly in a browser (`file://…`):

| File | What it shows |
| --- | --- |
| [`popup.html`](./popup.html) | The list view as the **popup** — ~380px, New mode, unread rows, a field-missing row |
| [`jobs.html`](./jobs.html) | The **same** component as the full **tab** — wider, All mode, read rows on screen, mid-scan status bar |
| [`states.html`](./states.html) | All five **empty / degraded** states side by side |
| [`options.html`](./options.html) | The **options** page — one long scroll, sectioned |
| [`../src/components/`](../src/components/) | The shared component itself — **the production source** |

These four files are **generated**, not hand-written: `npm run build:mockups`
renders the real components with fake data and inlines the real compiled
stylesheet. Do not edit them by hand — regenerate. Run the tests with `npm test`;
they check that the generated pages still cover every state worth seeing.

## Decisions (the 8 questions)

**1. How it's built — React 19 + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com).**
This reverses the original decision (plain TypeScript, string templates into
`innerHTML`, no framework) and its rationale, which was issue #4's "fewest moving
parts an agent can get wrong" plus the popup's cold-start feel. The cost is real
and was accepted deliberately: the popup's JS went from ~13 kB to ~320 kB
(~100 kB gzipped). What it buys is one consistent, accessible component set
instead of hand-rolled controls — focus rings, keyboard behaviour and ARIA come
from Radix rather than from remembering to add them.

The registry components live unmodified in [`src/components/ui/`](../src/components/ui/)
so `npx shadcn add` can be re-run over them; app-specific styling goes in the
components that *use* them. Everything the view decides stays pure and tested in
[`src/view.ts`](../src/view.ts) (`selectView`) — the components only map props to
JSX.

**2. Popup vs full tab — one component, one `variant` prop.** `popup` is 380px,
capped height, titles truncate to one line, defaults to **New**. `tab` is a
centered 720px column, defaults to **All** (you arrived from a notification to
browse). This used to be a root CSS class because the two views shared a single
markup string and could not branch; a component can, so "open as a full page"
is simply not rendered in the tab rather than hidden by a `.view-tab` rule.

**3. The job row.** Three stacked lines: **title** (bold), **company · location**
(muted), **posted time · watch** (faint). An unread dot sits to the left.
Missing fields fail independently (PRD §12): a missing company or location drops
from the middle line with no dangling separator (`metaLine()`); a missing posted
time drops from the foot; a missing title falls back to "Untitled role" so the
row is never blank. The whole row is an `<a href>` so middle-click / ctrl-click
opens in a background tab (PRD §3).

**4. Filter chips + New/All toggle.** A toolbar row under the header: watch chips
on the left (All watches / Indonesia / Japan), a New⇄All segmented toggle on the
right. State (active chip + toggle) persists in a `ui` key in
`chrome.storage.local`, so reopening the popup restores your last view.

**5. Empty states — five distinct, actionable messages** (`states.html`,
`renderEmptyState()`): **no watches** → "Add a search in Options"; **nothing
scanned yet** (first run pending); **no new** (All-caught-up, points to All);
**scanning** (non-blocking banner, list stays visible); **scan broken** (warning
that selectors returned nothing, points to Options). They're separate because
each wants a different next action.

**6. Read / unread.** Unread = filled dot + bold title. On click the row is
marked opened first (PRD §9 "write before opening the tab"), then: in **New**
mode it drops out of the list; in **All** mode it stays on screen but goes
dimmed, no dot, un-bold. The badge count decrements either way.

**7. Styling — Tailwind v4 with shadcn's token names, light and dark.** Tokens
live in [`src/tokens.css`](../src/tokens.css): the palette is this project's own
(the warm grey page, LinkedIn blue) converted to OKLCH, under shadcn's semantic
names (`--background`, `--primary`, `--muted-foreground`, …) so registry
components drop in unchanged. Note `--primary` is the brand blue and `--accent`
is shadcn's *subtle tint* role, not the brand.

Dark mode still follows the OS with zero JS: shadcn ships `dark:` as a `.dark`
class variant that needs a toggle, so `@custom-variant dark` re-binds it to
`@media (prefers-color-scheme: dark)` and the class is never needed.

Icons are **[Lucide](https://lucide.dev)** via `lucide-react`, which is shadcn's
own icon set — the same artwork the old hand-inlined `src/icons.ts` copied out of
`lucide-static`. They replaced literal characters (`✓ ↺ ⊘ ⚙ ✕`) and empty-state
emoji, which rendered at a different weight on every platform and — emoji
especially — arrived pre-coloured, ignoring the theme. Every icon is stroked in
`currentColor` and marked `aria-hidden`: the control around it carries the label.

**8. Options page — one long plain page, labelled section cards, no tabs.** It's
rarely opened, so it leans plain (per the issue). Sections: **Searches**
(watchlist add/edit/toggle/remove), **Filters** (company + title-keyword
blocklists, hide-reposted), **Scanning** (interval, pages, catch-up), **Retention**
(the four PRD §7 day settings + hard cap), **Telegram push** (enable, token, chat
ID, **Send test message** with inline pass/fail — the fix for silent-failure in
PRD §8). Save is explicit.

## Note on fidelity

The HTML *is* the compiled component now. It used to be hand-authored markup
mirroring `render.ts`, which was affordable while the component was a string
template — against React + Tailwind, where the classes come out of the components
and the CSS out of the compiler, a hand-kept copy would be a guaranteed lie.

`npm run build:mockups` renders the production components and inlines the
production stylesheet, so the pages cannot drift. They stay committed and
`file://`-openable, which is what the original decision was protecting.

One exception: **`options.html`** is a live form over `chrome.storage` and cannot
be rendered headlessly, so it shows only the two banners a healthy page never
displays. Load the unpacked extension to see the real thing.
