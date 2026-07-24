// Component tests — the successors to the old render.test.ts.
//
// The components are rendered to a static string with `react-dom/server` rather
// than mounted into a DOM: the assertions are about *shape* — which state a row
// is in, which button comes first, which icon a status wears — and a string is
// the cheapest thing that answers those. No jsdom, no testing-library, and the
// suite still runs under a bare `node --test` (through tsx, for the JSX).
//
// Behaviour that needs a real click — the two-press Block, the storage writes —
// lives tested as pure functions in view.test.ts, exactly as it did when this
// layer emitted strings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyState } from "./empty-state.tsx";
import { JobList } from "./job-list.tsx";
import { JobRow } from "./job-row.tsx";
import { ListHeader } from "./list-header.tsx";
import { ScanButton } from "./scan-button.tsx";
import { ScanStatusBar } from "./scan-status.tsx";
import { Toolbar } from "./toolbar.tsx";
import { TooltipProvider } from "./ui/tooltip";
import type { ChipWatch, EmptyKind, JobView } from "../view-model.ts";

/** Render to static markup. Radix needs a TooltipProvider in scope for anything
 *  that uses a tooltip, and wrapping unconditionally keeps every call here the
 *  same shape. */
const html = (node: React.ReactElement): string =>
  renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "3901",
    title: "Senior Software Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia",
    postedText: "2 hours ago",
    watchName: "Indonesia",
    url: "https://www.linkedin.com/jobs/view/3901/",
    opened: false,
    read: false,
    blocked: false,
    ...overrides,
  };
}

const noop = () => {};

/** A row on its own, with its three callbacks stubbed. */
const row = (j: JobView, armed = false): string =>
  html(<JobRow job={j} armed={armed} onOpen={noop} onToggleRead={noop} onBlock={noop} />);

const list = (jobs: JobView[], mode: "new" | "all", armedBlockId: string | null = null): string =>
  html(
    <JobList
      jobs={jobs}
      mode={mode}
      armedBlockId={armedBlockId}
      onOpen={noop}
      onToggleRead={noop}
      onBlock={noop}
    />,
  );

// ── JobRow ───────────────────────────────────────────────────────────────────

test("JobRow shows the title and a company/location meta line", () => {
  const h = row(job());
  assert.match(h, /Senior Software Engineer/);
  assert.match(h, /Acme Corp · Jakarta, Indonesia/);
  assert.match(h, /2 hours ago/);
  assert.match(h, /Indonesia/);
});

test("JobRow marks read jobs read — and opening one does NOT read it", () => {
  assert.match(row(job({ read: false })), /data-read="false"/);
  assert.match(row(job({ read: true })), /data-read="true"/);
  // The bug this whole split exists to fix: clicking a row used to dismiss it.
  assert.match(row(job({ opened: true })), /data-read="false"/);
});

test("JobRow flags an opened job so its row can be highlighted, not hidden", () => {
  assert.match(row(job({ opened: false })), /data-opened="false"/);
  assert.match(row(job({ opened: true })), /data-opened="true"/);
});

test("JobRow gives every row its own read and block buttons", () => {
  const h = row(job());
  assert.match(h, /data-action="read"/);
  assert.match(h, /data-action="block"/);
});

test("JobRow's read button is a toggle: mark as read, then back to unread", () => {
  assert.match(row(job({ read: false })), /data-action="read"[^>]*aria-pressed="false"/);
  assert.match(row(job({ read: false })), /title="Mark as read"/);
  assert.match(row(job({ read: true })), /data-action="read"[^>]*aria-pressed="true"/);
  assert.match(row(job({ read: true })), /title="Mark as unread"/);
});

test("JobRow's block button names the company and flips to Unblock", () => {
  assert.match(row(job({ blocked: false })), /title="Block Acme Corp"/);
  assert.match(row(job({ blocked: true })), /title="Unblock Acme Corp"/);
  assert.match(row(job({ blocked: true })), /data-action="block"[^>]*aria-pressed="true"/);
});

test("JobRow spells the block action out — the button says Block or Unblock", () => {
  // The word, not just the tooltip: a lone ban icon reads as "not allowed"
  // rather than as a control, and block vs unblock was invisible until hover.
  assert.match(row(job({ blocked: false })), />Block</);
  assert.match(row(job({ blocked: true })), />Unblock</);
});

test("JobRow puts Block before the tick, so the tick sits at the row's edge", () => {
  const h = row(job());
  assert.ok(
    h.indexOf('data-action="block"') < h.indexOf('data-action="read"'),
    "block button should render before the read button",
  );
});

test("JobRow's armed block button asks instead of blocking", () => {
  const armed = row(job(), true);
  assert.match(armed, /data-armed="true"/);
  assert.match(armed, /Sure\?/);
  // The label has to say what the second press does — "Sure?" alone tells a
  // screen reader nothing about which company is about to be blocked.
  assert.match(armed, /aria-label="Block Acme Corp — press again to confirm"/);
});

test("JobRow leaves the block button unarmed by default", () => {
  assert.match(row(job()), /data-armed="false"/);
  assert.doesNotMatch(row(job()), /Sure\?/);
});

test("JobRow's row actions are Lucide icons, and the read one flips", () => {
  assert.match(row(job({ read: false })), /lucide-check/);
  assert.match(row(job({ read: true })), /lucide-rotate-ccw/);
  assert.match(row(job()), /lucide-ban/);
  // The icon is decorative; the button's own aria-label is what gets announced.
  assert.match(row(job()), /aria-label="Mark as read"[^>]*>\s*<svg[^>]*aria-hidden="true"/);
});

test("JobRow drops the block button when no company was parsed", () => {
  // Nothing to blocklist — better no button than one that blocklists "" and
  // silently matches every job (PRD §12: fields fail independently).
  const h = row(job({ company: "   " }));
  assert.doesNotMatch(h, /data-action="block"/);
  assert.match(h, /data-action="read"/);
});

test("JobRow marks a blocked job and says why it is greyed", () => {
  const h = row(job({ blocked: true }));
  assert.match(h, /data-blocked="true"/);
  assert.match(h, />Blocked</);
  assert.doesNotMatch(row(job({ blocked: false })), />Blocked</);
});

test("JobRow shows the Blocked tag even when the foot line is empty", () => {
  assert.match(row(job({ postedText: "", watchName: "", blocked: true })), />Blocked</);
});

test("JobRow keeps the buttons out of the anchor (a button inside <a> is invalid)", () => {
  const h = row(job());
  const anchor = h.slice(h.indexOf("<a "), h.indexOf("</a>"));
  assert.doesNotMatch(anchor, /<button/);
});

test("JobRow carries the job id and url for click handling", () => {
  const h = row(job({ id: "77", url: "https://x/jobs/view/77/" }));
  assert.match(h, /data-job-id="77"/);
  assert.match(h, /href="https:\/\/x\/jobs\/view\/77\/"/);
});

test("JobRow degrades per-field: a missing field never blanks the row", () => {
  const h = row(job({ company: "", location: "", postedText: "" }));
  // Title still renders — the row is never empty.
  assert.match(h, /Senior Software Engineer/);
  // No dangling separator from the missing company/location.
  assert.doesNotMatch(h, /·\s*<\//);
  assert.doesNotMatch(h, /·\s*·/);
});

test("JobRow falls back to a placeholder when the title itself is missing", () => {
  assert.match(row(job({ title: "" })), /Untitled role/);
});

test("JobRow escapes every field so scraped text cannot break markup", () => {
  // React escapes its children, which is why the old hand-rolled `esc` is gone.
  // The guarantee still matters, so it is still asserted.
  const h = row(job({ title: "R&D <lead>", company: "A<B", watchName: "Q&A" }));
  assert.match(h, /R&amp;D &lt;lead&gt;/);
  assert.match(h, /A&lt;B/);
  assert.match(h, /Q&amp;A/);
  assert.doesNotMatch(h, /<lead>/);
});

test("JobRow escapes the company inside an armed button's label too", () => {
  const h = row(job({ company: 'A&B <"x">' }), true);
  assert.match(h, /title="Block A&amp;B &lt;&quot;x&quot;&gt; — press again to confirm"/);
  assert.doesNotMatch(h, /<"x">/);
});

// ── JobList ──────────────────────────────────────────────────────────────────

test("JobList in 'new' mode hides jobs already read", () => {
  const h = list([job({ id: "1", read: false }), job({ id: "2", read: true })], "new");
  assert.match(h, /data-job-id="1"/);
  assert.doesNotMatch(h, /data-job-id="2"/);
});

test("JobList in 'new' mode KEEPS a job you merely opened", () => {
  // The reported bug: clicking a row made it vanish from New for good. Opening
  // now only highlights it — it stays until you tick it read.
  const h = list([job({ id: "1", opened: true, read: false })], "new");
  assert.match(h, /data-job-id="1"/);
  assert.match(h, /data-opened="true"/);
});

test("JobList in 'all' mode keeps read jobs (they stay on screen, greyed)", () => {
  const h = list([job({ id: "1", read: false }), job({ id: "2", read: true })], "all");
  assert.match(h, /data-job-id="1"/);
  assert.match(h, /data-job-id="2"/);
  assert.match(h, /data-read="true"/);
});

test("JobList keeps blocked jobs in both modes — blocking is not deleting", () => {
  const jobs = [job({ id: "1", blocked: true, read: false })];
  for (const mode of ["new", "all"] as const) {
    assert.match(list(jobs, mode), /data-job-id="1"/, mode);
    assert.match(list(jobs, mode), /data-blocked="true"/, mode);
  }
});

test("JobList arms the Block button on exactly the row that was pressed", () => {
  const h = list([job({ id: "1" }), job({ id: "2" })], "all", "2");
  const rows = h.split("data-job-id=").slice(1);
  assert.doesNotMatch(rows.find((r) => r.startsWith('"1"'))!, /Sure\?/);
  assert.match(rows.find((r) => r.startsWith('"2"'))!, /Sure\?/);
});

test("JobList arms nothing when no row is mid-question", () => {
  assert.doesNotMatch(list([job({ id: "1" })], "all"), /Sure\?/);
  assert.doesNotMatch(list([job({ id: "1" })], "all", null), /Sure\?/);
});

// ── Toolbar: the watch chips and the New⇄All toggle ──────────────────────────

const chipWatches: ChipWatch[] = [
  { id: "w1", name: "Indonesia" },
  { id: "w2", name: "Japan" },
];

const toolbar = (activeWatchId: string | null, mode: "new" | "all" = "new"): string =>
  html(
    <Toolbar
      watches={chipWatches}
      activeWatchId={activeWatchId}
      mode={mode}
      onWatchChange={noop}
      onModeChange={noop}
    />,
  );

test("Toolbar renders an All-watches chip plus one per watch", () => {
  const h = toolbar(null);
  assert.match(h, /data-watch-id=""[^>]*>All watches/);
  assert.match(h, /data-watch-id="w1"[^>]*>Indonesia/);
  assert.match(h, /data-watch-id="w2"[^>]*>Japan/);
});

test("Toolbar marks the All chip active when no watch is selected", () => {
  const h = toolbar(null);
  assert.match(h, /data-watch-id=""[^>]*aria-pressed="true"/);
  assert.match(h, /data-watch-id="w1"[^>]*aria-pressed="false"/);
});

test("Toolbar marks the selected watch chip active, All inactive", () => {
  const h = toolbar("w2");
  assert.match(h, /data-watch-id=""[^>]*aria-pressed="false"/);
  assert.match(h, /data-watch-id="w2"[^>]*aria-pressed="true"/);
  assert.match(h, /data-watch-id="w1"[^>]*aria-pressed="false"/);
});

test("Toolbar escapes watch names and ids", () => {
  const h = html(
    <Toolbar
      watches={[{ id: "a&b", name: "R&D <x>" }]}
      activeWatchId={null}
      mode="new"
      onWatchChange={noop}
      onModeChange={noop}
    />,
  );
  assert.match(h, /R&amp;D &lt;x&gt;/);
  assert.match(h, /data-watch-id="a&amp;b"/);
  assert.doesNotMatch(h, /<x>/);
});

/** One `<button>` out of a rendered fragment, picked by an attribute it carries.
 *  Radix writes `data-state` before the caller's own props, so the two cannot be
 *  matched left-to-right in a single regex. */
function buttonWith(markup: string, attr: string): string {
  const found = markup.split("<button").find((chunk) => chunk.includes(attr));
  assert.ok(found, `no <button> carrying ${attr}`);
  return found;
}

test("Toolbar marks the active mode pressed on the segmented control", () => {
  const asNew = toolbar(null, "new");
  assert.match(buttonWith(asNew, 'data-mode="new"'), /data-state="on"/);
  assert.match(buttonWith(asNew, 'data-mode="all"'), /data-state="off"/);

  const asAll = toolbar(null, "all");
  assert.match(buttonWith(asAll, 'data-mode="all"'), /data-state="on"/);
  assert.match(buttonWith(asAll, 'data-mode="new"'), /data-state="off"/);
});

// ── EmptyState ───────────────────────────────────────────────────────────────

const EMPTY_KINDS = [
  "no-watches",
  "no-jobs-yet",
  "no-new",
  "scanning",
  "scan-error",
] as const satisfies readonly EmptyKind[];

test("EmptyState gives a distinct, actionable message per situation", () => {
  const messages = EMPTY_KINDS.map((k) => html(<EmptyState kind={k} />));
  // All five are distinct.
  assert.equal(new Set(messages).size, 5);
  assert.match(html(<EmptyState kind="no-watches" />), /Options|Add a search/i);
  assert.match(html(<EmptyState kind="no-new" />), /caught up|no new/i);
  assert.match(html(<EmptyState kind="scan-error" />), /failed|broke|selector/i);
});

test("each empty state gets its own Lucide icon, sized as artwork not a button", () => {
  const icons: Record<EmptyKind, RegExp> = {
    "no-watches": /lucide-search/,
    "no-jobs-yet": /lucide-sprout/,
    "no-new": /lucide-circle-check/,
    scanning: /lucide-refresh-cw/,
    "scan-error": /lucide-triangle-alert/,
  };
  for (const kind of EMPTY_KINDS) {
    const h = html(<EmptyState kind={kind} />);
    assert.match(h, icons[kind], kind);
    // `size-7` = 28px, bigger than the 16px a button icon gets.
    assert.match(h, /class="lucide [^"]*size-7/, kind);
    assert.match(h, new RegExp(`data-kind="${kind}"`), kind);
  }
});

test("nothing in the rendered markup falls back to an emoji or a bare glyph", () => {
  // Emoji ignore the theme and the ✓ / ⊘ / ↺ family tofu-boxes on some systems;
  // that is what the Lucide icon set exists to prevent, so guard the regression.
  const markup = [
    row(job()),
    row(job({ read: true, blocked: true })),
    ...EMPTY_KINDS.map((k) => html(<EmptyState kind={k} />)),
  ].join("");
  // Arrows (↺), math operators (⊘), misc symbols (⚙), dingbats (✓ ✕), emoji.
  assert.doesNotMatch(
    markup,
    /[\u{2190}-\u{21FF}\u{2200}-\u{22FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F300}-\u{1FAFF}]/u,
  );
});

// ── ListHeader ───────────────────────────────────────────────────────────────

const header = (over: Partial<React.ComponentProps<typeof ListHeader>> = {}): string =>
  html(
    <ListHeader
      title="New jobs"
      badge={0}
      scanButton="idle"
      variant="popup"
      onScan={noop}
      onMarkAllRead={noop}
      onOpenTab={noop}
      onOpenOptions={noop}
      {...over}
    />,
  );

test("ListHeader renders a Mark all as read control", () => {
  assert.match(header(), /id="mark-all-read"/);
});

test("ListHeader's Options control is a labelled gear icon, not a glyph", () => {
  const h = header();
  // Icon-only, so the label lives on the button — the <svg> is aria-hidden.
  assert.match(h, /id="open-options"[^>]*aria-label="Options"/);
  assert.match(h, /lucide-settings/);
  assert.doesNotMatch(h, /⚙/);
});

test("ListHeader shows the badge only when something is unread", () => {
  assert.match(header({ badge: 2 }), />2</);
  assert.doesNotMatch(header({ badge: 0 }), /badge/);
});

test("ListHeader escapes the title", () => {
  assert.match(header({ title: "A & B" }), /A &amp; B/);
});

test("ListHeader offers to open the popup's list as a full page", () => {
  const h = header({ variant: "popup" });
  // Icon-only, so the label lives on the button — the <svg> is aria-hidden.
  assert.match(h, /id="open-tab"[^>]*aria-label="Open as a full page"/);
  assert.match(h, /lucide-external-link/);
});

test("ListHeader omits the expand control in the tab, which already is one", () => {
  // This used to be emitted in both views and hidden by a `.view-tab #open-tab`
  // CSS rule, because the popup and the tab shared one markup string and could
  // not branch. A component can, so the button the tab must never show simply
  // isn't rendered — and the load-bearing CSS rule is gone with it.
  assert.doesNotMatch(header({ variant: "tab" }), /id="open-tab"/);
});

// ── ScanButton: the manual scan control ──────────────────────────────────────

/** The real `disabled` attribute, not the `disabled:` Tailwind variants that
 *  every shadcn Button carries in its class list. */
const DISABLED_ATTR = /\sdisabled=""/;

test("ScanButton renders a clickable Scan now control when idle", () => {
  const h = html(<ScanButton state="idle" onScan={noop} />);
  assert.match(h, /id="scan-now"/);
  assert.match(h, /data-scan-state="idle"/);
  assert.match(h, />Scan now</);
  assert.doesNotMatch(h, DISABLED_ATTR);
});

test("ScanButton is disabled while a cycle already holds the lock", () => {
  const h = html(<ScanButton state="scanning" onScan={noop} />);
  assert.match(h, DISABLED_ATTR);
  assert.match(h, /Scanning…/);
});

test("ScanButton labels itself as the manual resume when scanning is halted", () => {
  const h = html(<ScanButton state="halted" onScan={noop} />);
  assert.match(h, /data-scan-state="halted"/);
  assert.match(h, />Resume</);
  // A halted extension can only recover through this button, so it must stay live.
  assert.doesNotMatch(h, DISABLED_ATTR);
});

// ── ScanStatusBar: the footer status bar ─────────────────────────────────────

test("ScanStatusBar says it is scanning while a cycle is in flight", () => {
  const h = html(<ScanStatusBar status={{ kind: "scanning" }} />);
  assert.match(h, /data-kind="scanning"/);
  // The same word the header button and the empty state use — one name for one
  // thing, or the two controls read as two different mechanisms.
  assert.match(h, /Scanning for new jobs…/);
  // This text lands once and stays, so it is safe to announce.
  assert.match(h, /role="status"/);
});

test("ScanStatusBar counts down to the next scan", () => {
  const h = html(
    <ScanStatusBar status={{ kind: "waiting", remainingMs: 252_000, quiet: false }} />,
  );
  assert.match(h, /data-kind="waiting"/);
  assert.match(h, /Next scan in 4m 12s/);
  // The countdown must NOT be a live region: it would be announced every second.
  assert.doesNotMatch(h, /role="status"/);
});

test("ScanStatusBar explains an hours-long countdown as quiet hours", () => {
  const h = html(
    <ScanStatusBar status={{ kind: "waiting", remainingMs: 26_100_000, quiet: true }} />,
  );
  assert.match(h, /Quiet hours · next scan in 7h 15m/);
  assert.match(h, /lucide-moon/);
});

test("ScanStatusBar covers the gap between an alarm firing and its cycle", () => {
  assert.match(html(<ScanStatusBar status={{ kind: "due" }} />), /any moment/);
});

test("ScanStatusBar points a halted loop at the button that revives it", () => {
  const h = html(<ScanStatusBar status={{ kind: "halted" }} />);
  assert.match(h, /data-kind="halted"/);
  assert.match(h, /Resume/);
});

test("ScanStatusBar renders nothing at all when there is nothing to scan", () => {
  // Not "no scans scheduled" — no bar, so the footer takes up no room.
  assert.equal(html(<ScanStatusBar status={{ kind: "off" }} />), "");
});
