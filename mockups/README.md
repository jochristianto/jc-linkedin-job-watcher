# Popup & settings mockups — answer to issue #10

PRD §4 names the list view as "a shared component, mounted twice" (`popup.html`
+ `jobs.html`) but never says what it's built with or what it looks like. These
static mockups make both concrete so an unattended agent doesn't invent them.

## Open them

Static HTML with fake data — no extension, no storage, no build step. Open the
files directly in a browser (`file://…`):

| File | What it shows |
| --- | --- |
| [`popup.html`](./popup.html) | The list view as the **popup** — ~380px, New mode, unread rows, a field-missing row |
| [`jobs.html`](./jobs.html) | The **same** component as the full **tab** — wider, All mode, read rows on screen, scanning banner |
| [`states.html`](./states.html) | All five **empty / degraded** states side by side |
| [`options.html`](./options.html) | The **options** page — one long scroll, sectioned |
| [`tokens.css`](./tokens.css) | Design tokens + component styles, light **and** dark |
| [`render.ts`](./render.ts) | The shared component as tested plain-TS functions (what production mirrors) |

`render.ts` / `render.test.ts` are the reference implementation of the shared
component; the HTML files embed exactly the markup those functions emit. Run the
tests with `npm test`.

## Decisions (the 8 questions)

**1. How it's built — plain TypeScript, string templates into `innerHTML`. No
framework.** Issue #4 already settled the stack at plain Vite with the fewest
moving parts an agent can get wrong; a framework runtime works against that and
against the popup's cold-start feel. The list is a pure map from `Job[]` to
markup (see `render.ts`) — the page does `container.innerHTML = renderList(...)`
and delegates clicks off the container. Every field is escaped (`esc()`), same
as `push.ts`, because scraped titles carry `&` and `<`.

**2. Popup vs full tab — one component, one set of markup; they diverge only
through a root class.** `.view-popup` is 380px, capped height, titles truncate
to one line, defaults to **New**. `.view-tab` is a centered 720px column, titles
wrap, defaults to **All** (you arrived from a notification to browse). No
per-view markup branches — cheaper to keep correct.

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

**7. Styling — plain CSS with one design-token file, light and dark.** Tokens
live in `:root` and are redefined under `@media (prefers-color-scheme: dark)`, so
the extension follows the OS with zero JS. Both themes ship. No CSS framework.

**8. Options page — one long plain page, labelled section cards, no tabs.** It's
rarely opened, so it leans plain (per the issue). Sections: **Searches**
(watchlist add/edit/toggle/remove), **Filters** (company + title-keyword
blocklists, hide-reposted), **Scanning** (interval, pages, catch-up), **Retention**
(the four PRD §7 day settings + hard cap), **Telegram push** (enable, token, chat
ID, **Send test message** with inline pass/fail — the fix for silent-failure in
PRD §8). Save is explicit.

## Note on fidelity

The HTML is hand-authored static markup mirroring `render.ts` — it is not the
compiled component, because the issue asks for something openable with no build
step. The row/empty-state shapes are the tested source of truth; the pages are
the picture.
