# Popup & settings mockups — answer to issue #10

PRD §4 names the list view as "a shared component, mounted twice"
(`popup.html` and `jobs.html`) but never says what it's built with or what it
looks like. These static mockups make both concrete so an unattended agent
doesn't invent them.

## Open them

Static HTML with fake data — no extension, no storage, nothing to run. Open the
files directly in a browser (`file://…`):

| File | What it shows |
| --- | --- |
| [`popup.html`](./popup.html) | The list view as the **popup** — 380px, New mode, unread rows, a field-missing row |
| [`jobs.html`](./jobs.html) | The **same** component as the full **tab** — an 880px column, All mode, read rows on screen |
| [`states.html`](./states.html) | The **empty / degraded** states side by side |
| [`options.html`](./options.html) | The **settings** page — see the note on fidelity at the bottom |
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

**2. Popup vs full tab — one component, one `variant` prop.** `popup` is a fixed
380×600 panel, titles truncate, defaults to **New**, and folds its header
controls into a menu button because 380px cannot hold five of them in a row.
`tab` is a full-height shell with a **centered 880px column**, defaults to **All**
(you arrived from a notification to browse), and lays those controls out with
labels. Both pin the header and the status footer and scroll only the list
between them.

This used to be a root CSS class because the two views shared a single markup
string and could not branch; a component can, so "open as a full page" is simply
not rendered in the tab rather than hidden by a `.view-tab` rule.

**3. The job card.** Not a row of stacked lines any more — the redesign
(`docs/ui-redesign-followups.md`) made it a card:

- An **employer monogram** tile, tinted from a stable per-company tone, with the
  unread dot on its corner. The popup drops the tile and keeps just the dot: at
  380px the tile plus the right-hand buttons cost ~100px, and nearly every title
  wrapped to three lines.
- **Title**, then **company · location**.
- A meta line of chips: the **work mode** split off the location (Remote /
  Hybrid / On-site), the **source watch**, **Posted 6h ago** and **Found 41m
  ago** as two separate facts, plus **Blocked** and the logged note where they
  apply.
- Actions on the right: **Applied** (when answered), **Block**, and the eye
  button that marks the job read. In the popup they move to their own line under
  the posting.

Missing fields still fail independently (PRD §12): a missing company or location
drops out with no dangling separator, a missing posted time drops from the meta
line, and a missing title falls back to "Untitled role" so the card is never
blank. The card body is a real `<a href>`, so middle-click / ctrl-click opens in
a background tab (PRD §3) — which is also why the interactive **Applied** tag
sits outside it, in the action cluster.

**4. Filter chips + New/All toggle.** A toolbar row under the header: watch chips
on the left (All watches / Indonesia / Japan), a New⇄All segmented toggle on the
right. State (active chip + toggle) persists in a `ui` key in
`chrome.storage.local`, so reopening the popup restores your last view.

**5. Empty states — distinct, actionable messages** (`states.html`,
`EmptyState`): **no watches** → "Add a search in Options"; **nothing scanned
yet** (first run pending); **no new** (all caught up, points to All);
**scanning** (skeleton cards, so the space says "rows are coming"); **scan
broken** (selectors returned nothing, points to Options). A sixth, **paused**,
covers the master switch being off and takes the place of the list, toolbar and
footer together — `ListView` renders it directly rather than through
`pickEmptyKind`, which is why it is not in `states.html`.

Each is an icon tile, a title, a body and **one** action button. They're separate
because each wants a different next action.

**6. Read / unread / opened.** Unread = an accent dot and a white card. Clicking
marks the job opened first (PRD §9 "write before opening the tab"), which clears
the dot and the badge count — but the card **stays in New**. Only the eye button
drops it out and greys it.

That split is deliberate and was a bug fix. The old row left "New" the moment you
opened it, so in the popup the job vanished as the popup closed, with nowhere to
get it back from but "All". The dot and the badge mean "not looked at yet"; the
New list means "not finished with yet". An inbox draws the same line.

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

**8. Settings page — a pinned shell with a section rail.** *Revised.* This
originally read "one long plain page, no tabs", on the reasoning that a rarely
opened page should lean plain. It stopped being true once the page grew past two
screens: with the save button somewhere below the fold, "did that save?" became a
scroll rather than a glance.

The shell now pins the header and the save bar and scrolls only the sections
between them. Down the left is a rail that jumps to any section **and marks the
ones holding unsaved edits** — the only way to tell, from the top of a page
several screens deep, that the thing you changed is still down there. The header
carries a one-line summary of the whole configuration, tracking what you are
*about* to save rather than what you saved last.

Six sections, in reading order: **Watches** (add/edit/toggle/remove, each row
reading its own URL back as chips), **Filters** (company + title-keyword
blocklists, hide-reposted), **Scanning** (manual-only, interval, jitter, pages,
catch-up, quiet hours, and the Gentle/Heavy/Risky load estimate),
**Retention** (the four PRD §7 day settings + hard cap, and **Delete all job
history** — the page's one destructive control, behind a confirm), **Notifications**
(desktop toggle, Telegram enable/token/chat ID, **Send test message** with inline
pass/fail — the fix for silent-failure in PRD §8), and **How this works** (prose,
no fields).

Save is still explicit, and **Reset** reverts to the last-saved values rather
than to defaults — it asks first, and greys out when there is nothing to discard.
Everything the page *derives* lives in [`src/settings-view.ts`](../src/settings-view.ts),
pure and tested per PRD §14.

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
displays. Load the unpacked extension to see the real thing — or look at the
screenshot in [the README](../README.md#settings).
