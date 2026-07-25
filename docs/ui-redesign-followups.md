# UI redesign — what shipped, what didn't, and how the rest would work

Source design: `.design/WatcherApp.dc.html` (the component) and `.design/Job Watcher.dc.html`
(the canvas that frames it). The jobs tab is frame **1a** — `layout="wide"`,
`rowVariant="card"`, list column capped at 880px.

This note exists because the design carries features the extension has no data or
behaviour for yet. Those are drafted here rather than half-built, so the UI change
could land on its own.

---

## Shipped

Everything below is presentational or derivable from data already in storage, so
it went in with the redesign.

| Design element | Where it landed |
| --- | --- |
| App mark, name, unread pill, power switch, Scan now, Mark all read, gear | `components/list-header.tsx` |
| Watch pills that scroll sideways, New⇄All segmented control | `components/toolbar.tsx` |
| Employer monogram with a stable per-company tone | `monogram` / `companyTone` in `view-model.ts` |
| Work-mode chip (Remote / Hybrid / On-site) split off the location | `splitLocation` in `view-model.ts` |
| "Posted 6h ago" and "Found 41m ago" as two separate facts | `shortAge` / `formatAgo`, `Job.foundAt` |
| "Opened" chip on a row you clicked through to | `JobView.opened` |
| The logged note, rendered on the applied row | `JobView.notes` ← `Job.applyNotes` |
| Empty states as an icon tile + title + body + **one action button** | `components/empty-state.tsx` |
| Skeleton rows during a first scan; a scanning bar over a list that already has rows | `components/scanning.tsx` |
| Footer: status left, `N new · M watches` right | `components/scan-status.tsx` |
| End-of-list line with the retention rule | `components/list-view.tsx` |
| Apply prompt: quick-note chips, auto-growing box, Cmd/Ctrl+Enter saves, Esc cancels | `components/apply-prompt.tsx` |
| Full-height shell: pinned header/footer, only the list scrolls, 880px column | `components/list-view.tsx` |

New design tokens: `--success`, `--info`, `--chart-1…5` (`src/tokens.css`, light and dark).

---

## Deferred

### 1. Split layout — list + detail pane (design frame 1b)

The biggest one. In `layout="split"` the first click on a row **selects** it and
previews it in a right-hand pane; "Open on LinkedIn" becomes a deliberate second
step, and the apply question and note editor move into the pane instead of pushing
rows around. The pane also carries an activity trail (posted → found → opened →
applied).

**What it needs**

- A `selectedJobId` in `ListView` state, persisted next to `activeWatchId` in the
  `ui` storage key so a reopened tab lands back on the same job.
- A `layout` prop on `ListView` (`"wide" | "split"`), chosen by width rather than
  by preference — the popup can never be split, and the tab only should be past
  ~1100px. A container query is the honest test, not a media query.
- A `JobDetail` component. Everything it shows already exists on `JobView` except
  the activity trail, which needs `openedAt` and `appliedAt` surfaced (both are
  already stored on `Job`, just not mapped in `toJobView`).
- One real behaviour change: **click no longer opens the posting**. That is the
  whole point of the pane, but it contradicts PRD §3's middle-click/⌘-click
  contract, which relies on the row being a real `<a href>`. The anchor has to
  stay for modifier clicks while a plain left click is intercepted to select.

**Recommendation:** worth doing, but as its own ticket. It changes what clicking a
row means, and that deserves to be reviewed on its own rather than inside a
restyle.

### 2. Toast with Undo, and the row collapsing after a block

The design blocks on the **first** press, fades the row, collapses it away after
`collapseDelay` (~900ms), and offers `Undo` in a toast for a few seconds. Today
blocking takes **two** presses (`useArmedBlock`, "Block" → "Sure?") and the row
stays on screen greyed.

**What it needs**

- A `Toast` component — position `absolute` bottom-right of the shell, dark
  `--foreground` fill, optional Undo button, auto-dismiss ~4s. There is no toast
  primitive in `components/ui/` yet; shadcn's `sonner` would be the drop-in.
- `ListView` gains a `toast: { message, undo?: () => void } | null` state. The
  existing `notice` state (currently rendered as an amber `HealthBanner`) is the
  same idea and should be folded into it — a click that started no scan is a
  toast, not a health banner.
- `onBlock` drops the arm/disarm dance and blocks immediately, pushing an undo
  that calls `toggleBlockedCompany(..., false)`.
- Row collapse is a CSS transition on `max-height` / `opacity` / `margin`, driven
  by a `collapsing` flag held per-row in `ListView`.

**Decision to make first:** two-press-to-arm vs. one-press-plus-undo. They are
alternative answers to the same question and the codebase currently documents the
first one deliberately (`BLOCK_CONFIRM_MS` in `view-model.ts`). Undo is the better
pattern — it costs nothing when you meant it — but it is a behaviour change, not a
restyle, and it would delete `useArmedBlock` and its tests.

### 3. The "manage applied" strip

In the design, clicking the **Applied** badge opens a strip inside the card:
`Logged as applied · "<note>"` with `Edit note`, `Not applied`, and a close button.
Today the badge is a one-tap undo that silently discards the note.

**What it needs**

- `ListView` gains `manageAppliedId: string | null` (component state; it does not
  need to survive a reopen).
- `ApplyNote` needs to accept an initial value — right now `useState("")` hardcodes
  an empty box, so editing an existing note would blank it. Add a `defaultNotes`
  prop and seed the state from it.
- Saving an edit calls the existing `markJobApplied`, which already overwrites
  `applyNotes` and preserves the first `appliedAt`. **No storage change needed.**
- Decide whether re-saving an edited note re-sends the `[Applied]` Telegram message.
  It should not — the message went out when you applied, and a typo fix chasing it
  to the phone is noise.

**Recommendation:** the cheapest of the four and a real improvement — "undo, and
forget the note" is a harsh thing to hang off the only affordance a logged
application has. Good next ticket.

### 4. Compact rows, grouped by recency (design frame 2b)

> **Partly overtaken.** The popup now has its own row layout — no employer
> monogram (just an unread dot in a narrow column) and the actions on their own
> line under the posting, `JobRow variant="popup"` / `data-actions="below"`. That
> was the actual complaint the compact variant was meant to answer: at 380px the
> tile and the right-hand buttons cost ~100px, so nearly every title wrapped to
> three lines. Titles now fit on one. What is still unbuilt from 2b is the
> **recency grouping** (`Last 3 hours` / `Earlier today` / `Yesterday`) and the
> borderless list chrome; the `groupByRecency` sketch below still stands.

`rowVariant="compact"`: no card chrome, an unread dot instead of a monogram, age
right-aligned, block as an icon, and rows grouped under `Last 3 hours` /
`Earlier today` / `Yesterday`. Roughly twice the jobs per screen.

**What it needs**

- A `density` prop on `ListView` → `JobList` → `JobRow`, and a stored preference
  (`ui.density`) plus somewhere to flip it. The design offers no control for it,
  so that has to be invented — most likely a small toggle in the toolbar.
- A `groupByRecency(jobs, now)` in `view-model.ts`, pure and testable, bucketing on
  `foundAt` (the design buckets on posted age; `foundAt` is the better key — it is
  a real timestamp rather than a scraped string, and the groups are about when the
  list changed).
- `JobRow` grows a second layout. The two variants share the data and almost none
  of the markup, so this is closer to a sibling component than a prop.

**Recommendation:** lowest value of the four for the *tab*, which has the room the
cards want. It is really a popup feature. Park it until someone asks.

### 5. The settings drawer

The design's gear opens a right-hand drawer listing Watches / Scan interval /
Quiet hours / Blocked employers / Notifications — and says so itself: *"Full
settings design comes next — this panel is a placeholder so the gear has somewhere
to go."*

This extension already has a real, complete Options page. **Recommendation: don't
build it.** The gear keeps calling `chrome.runtime.openOptionsPage()`. Revisit only
if the Options page itself gets redesigned into a drawer.

### 6. The `sessionExpired` empty state

The design has an error state specific to a lost LinkedIn session — *"Sign in to
LinkedIn once and the next scan picks up where it stopped"* — with an
`Open LinkedIn to sign in` button. Our `scan-error` kind is about selectors
returning nothing, which is a different failure with a different fix.

`health.ts` already distinguishes the cases internally; the empty state doesn't.
Adding a `session-expired` `EmptyKind` plus an action that opens
`https://www.linkedin.com/login` is small and worth doing — the current copy sends
someone to Options to debug selectors when all they need is to log in.

---

## Deliberate deviations from the design

1. **The Applied badge stays in the row's action cluster**, not inline beside the
   title. In the design it is a `<span role="button">` inside the clickable row
   body; here the row body is a real `<a href>`, and interactive content inside an
   anchor is invalid HTML and unclickable. The `Blocked` badge — which is not
   interactive — did move next to the title as designed.
2. **`Cmd/Ctrl + Enter saves` is spelled out** rather than drawn with a `⌘` glyph.
   The repo has a standing rule against bare glyphs (they tofu-box off macOS), and
   there is a test guarding it.
3. **Blocking still takes two presses.** See deferred item 2.
4. **Opening a row clears its unread dot but does not file it away.** The design
   keeps the dot and adds an "Opened" chip; the old row dropped the *whole row*
   from "New" on open, which was a reported bug — in the popup the job vanished as
   the popup closed, with nowhere to get it back from but "All". This splits the
   difference the two states were always about: the dot and the badge count mean
   "not looked at yet", so a click clears both (`unreadCount` in view.ts and
   scan.ts); the New list means "not finished with yet", so `visibleJobs` still
   filters on `read` alone and only the tick empties it. An inbox draws the same
   line, and the "Opened" chip says which of the two ways a row got quiet.
5. **The popup inherits the redesign.** The design is one component rendered at
   three widths ("Same markup", frame 1c), so restyling the shared `ListView` was
   the change; `variant="popup"` still governs the fixed 380×600 shell and the
   compact "Mark all read".
