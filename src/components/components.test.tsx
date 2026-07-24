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

import { ApplyNote, ApplyPrompt } from "./apply-prompt.tsx";
import { EmptyState } from "./empty-state.tsx";
import { HowItWorks } from "./how-it-works.tsx";
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
    applied: false,
    ...overrides,
  };
}

const noop = () => {};

/** A row on its own, with its three callbacks stubbed. */
const row = (j: JobView, armed = false): string =>
  html(
    <JobRow
      job={j}
      armed={armed}
      onOpen={noop}
      onToggleRead={noop}
      onBlock={noop}
      onUnapply={noop}
    />,
  );

const list = (jobs: JobView[], mode: "new" | "all", armedBlockId: string | null = null): string =>
  html(
    <JobList
      jobs={jobs}
      mode={mode}
      armedBlockId={armedBlockId}
      onOpen={noop}
      onToggleRead={noop}
      onBlock={noop}
      onUnapply={noop}
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

test("JobRow tags a job you applied to, so the list is also the record", () => {
  assert.match(row(job({ applied: true })), />Applied</);
  assert.match(row(job({ applied: true })), /data-applied="true"/);
  assert.doesNotMatch(row(job({ applied: false })), />Applied</);
  assert.match(row(job({ applied: false })), /data-applied="false"/);
  // ...and it survives a row with nothing else in its footer.
  assert.match(row(job({ postedText: "", watchName: "", applied: true })), />Applied</);
});

test("JobRow's Applied tag is the undo, and its label admits what it costs", () => {
  const h = row(job({ applied: true }));
  assert.match(h, /data-action="unapply"/);
  // "Applied" alone reads as a label, not a control — the accessible name has to
  // say that pressing it drops the record, note and all.
  assert.match(h, /aria-label="Applied — undo, and forget the note"/);
  assert.match(h, /lucide-badge-check/);
  // Not the read tick's icon: two different actions must not wear one glyph.
  const button = h.split("<button").find((c) => c.includes('data-action="unapply"'))!;
  assert.doesNotMatch(button, /lucide-check\b/);
});

test("JobRow keeps the Applied undo out of the anchor, where it would be unclickable", () => {
  const h = row(job({ applied: true }));
  const anchor = h.slice(h.indexOf("<a "), h.indexOf("</a>"));
  assert.doesNotMatch(anchor, /Applied/);
  // Left of Block, so the two rightmost buttons stay where the hand expects them.
  assert.ok(
    h.indexOf('data-action="unapply"') < h.indexOf('data-action="block"'),
    "the Applied undo should render before the block button",
  );
});

test("JobRow offers no undo on a job that was never applied to", () => {
  assert.doesNotMatch(row(job({ applied: false })), /data-action="unapply"/);
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

/** The list with the apply question pinned to one of its rows. */
const listWithPrompt = (jobs: JobView[], applyPromptJobId: string | null): string =>
  html(
    <JobList
      jobs={jobs}
      mode="all"
      applyPromptJobId={applyPromptJobId}
      applyPrompt={<p data-testid="pinned">pinned</p>}
      onOpen={noop}
      onToggleRead={noop}
      onBlock={noop}
      onUnapply={noop}
    />,
  );

test("JobList pins the apply question inside the card of the job it is about", () => {
  const h = listWithPrompt([job({ id: "1" }), job({ id: "2" })], "2");
  const rows = h.split("data-job-id=").slice(1);
  assert.doesNotMatch(rows.find((r) => r.startsWith('"1"'))!, /data-testid="pinned"/);
  assert.match(rows.find((r) => r.startsWith('"2"'))!, /data-testid="pinned"/);
});

test("JobList pins nothing when no row has a question waiting", () => {
  assert.doesNotMatch(listWithPrompt([job({ id: "1" })], null), /data-testid="pinned"/);
  // And an id for a job that is not on this list pins it to nothing at all,
  // rather than to whichever row happens to be first.
  assert.doesNotMatch(listWithPrompt([job({ id: "1" })], "9"), /data-testid="pinned"/);
});

// ── ApplyPrompt: "Did you apply for this job?" ───────────────────────────────
//
// Two components, one per step, so each can be rendered on its own here — a
// static render has no click to pick Yes with. Which answer opens which is
// `applyPromptStep`'s, proved with plain values in view-model.test.ts; what
// `ApplyPrompt` renders unanswered is the first of the two, asserted below.

const prompt = (over: Partial<React.ComponentProps<typeof ApplyPrompt>> = {}): string =>
  html(
    <ApplyPrompt
      job={{ id: "3901", title: "Senior Software Engineer", company: "Acme Corp" }}
      onAnswer={noop}
      onDismiss={noop}
      {...over}
    />,
  );

const note = (over: Partial<React.ComponentProps<typeof ApplyNote>> = {}): string =>
  html(
    <ApplyNote
      job={{ id: "3901", title: "Senior Software Engineer", company: "Acme Corp" }}
      onSave={noop}
      onDismiss={noop}
      {...over}
    />,
  );

test("ApplyPrompt asks the question, on the row it is asking about", () => {
  const h = prompt();
  assert.match(h, /Did you apply for this job\?/);
  assert.match(h, /data-job-id="3901"/);
  assert.match(h, /data-placement="row"/);
  // Pinned in that job's own card, one line under its title: repeating the title
  // inside the strip would be the same sentence twice.
  assert.doesNotMatch(h, /Senior Software Engineer/);
});

test("ApplyPrompt names the job when it has no row to sit in", () => {
  const h = prompt({ placement: "list" });
  assert.match(h, /data-placement="list"/);
  // Asked minutes later, in a popup you reopened, with the row filtered out from
  // under it — without the job it is asking about nothing in particular.
  assert.match(h, /Senior Software Engineer · Acme Corp/);
});

test("ApplyPrompt is a labelled strip in the layout, not a modal over it", () => {
  const h = prompt();
  assert.match(h, /aria-labelledby="apply-prompt-title"/);
  assert.match(h, /id="apply-prompt-title"/);
  // Inline: the list behind it stays readable and clickable while the question
  // waits, so there is no dialog role, no modal flag and no backdrop to trap in.
  assert.doesNotMatch(h, /role="dialog"/);
  assert.doesNotMatch(h, /aria-modal/);
  assert.doesNotMatch(h, /\bfixed inset-0\b/);
});

test("ApplyPrompt answers with two buttons, not a toggle to be set", () => {
  const h = prompt();
  assert.match(buttonWith(h, 'data-answer="yes"'), />Yes</);
  assert.match(buttonWith(h, 'data-answer="no"'), />No</);
  // Both live from the start, and neither is preselected: this is a question
  // being answered once, not a setting sitting in a position.
  assert.doesNotMatch(buttonWith(h, 'data-answer="yes"'), DISABLED_ATTR);
  assert.doesNotMatch(buttonWith(h, 'data-answer="no"'), DISABLED_ATTR);
  assert.doesNotMatch(h, /data-state="on"/);
});

test("ApplyPrompt asks the question first and nothing else", () => {
  const h = prompt();
  // The notes box and the button that commits it are the second step's; here the
  // strip is the question and its two answers.
  assert.doesNotMatch(h, /<textarea/);
  assert.doesNotMatch(h, /id="apply-notes"/);
  assert.doesNotMatch(h, /data-action="apply-submit"/);
  // And no third way out beside them: No already records nothing, so a "not now"
  // next to it would be the same button twice.
  assert.doesNotMatch(h, /data-action="apply-dismiss"/);
  assert.doesNotMatch(h, />Not now</);
});

test("ApplyPrompt falls back to a placeholder when the title never parsed", () => {
  const h = prompt({ placement: "list", job: { id: "7", title: "  ", company: "Acme Corp" } });
  assert.match(h, /Untitled role/);
});

test("ApplyPrompt escapes the job it names", () => {
  const job = { id: "a&b", title: "R&D <lead>", company: 'A<"B">' };
  const h = prompt({ placement: "list", job });
  assert.match(h, /R&amp;D &lt;lead&gt;/);
  assert.doesNotMatch(h, /<lead>/);
  // The id is an attribute in both placements, whether or not the title is shown.
  assert.match(prompt({ job }), /data-job-id="a&amp;b"/);
});

test("ApplyNote is the second step, and stays where the question was", () => {
  const h = note();
  assert.match(h, /Add a note\?/);
  assert.match(h, /data-placement="row"/);
  assert.match(note({ placement: "list" }), /Senior Software Engineer · Acme Corp/);
  // The question is behind you by now: no Yes/No to answer a second time.
  assert.doesNotMatch(h, /data-answer=/);
});

test("ApplyNote opens the box the note is typed in, empty and enabled", () => {
  const h = note();
  assert.match(h, /<textarea/);
  assert.doesNotMatch(h, /<textarea[^>]*\sdisabled=""/);
  // "Add a note?" above it is the visible label, so this one is for screen
  // readers only — but it is there, rather than leaving the box to a placeholder
  // that disappears the moment you type.
  assert.match(h, /for="apply-notes"/);
  assert.match(h, /id="apply-notes"/);
  assert.match(h, /Notes \(optional\)/);
});

test("ApplyNote commits with Submit, and takes the Yes back with Cancel", () => {
  const h = note();
  assert.match(buttonWith(h, 'data-action="apply-submit"'), />Submit</);
  // Nothing to fill in first — the note is optional, so Submit is live on arrival.
  assert.doesNotMatch(buttonWith(h, 'data-action="apply-submit"'), DISABLED_ATTR);
  // The way out of a Yes that was a misclick: it dismisses, so nothing is recorded.
  assert.match(buttonWith(h, 'data-action="apply-dismiss"'), />Cancel</);
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
  "paused",
] as const satisfies readonly EmptyKind[];

test("EmptyState gives a distinct, actionable message per situation", () => {
  const messages = EMPTY_KINDS.map((k) => html(<EmptyState kind={k} />));
  // All six are distinct.
  assert.equal(new Set(messages).size, 6);
  assert.match(html(<EmptyState kind="no-watches" />), /Options|Add a search/i);
  assert.match(html(<EmptyState kind="no-new" />), /caught up|no new/i);
  assert.match(html(<EmptyState kind="scan-error" />), /failed|broke|selector/i);
  assert.match(html(<EmptyState kind="paused" />), /paused|watching is off/i);
});

test("each empty state gets its own Lucide icon, sized as artwork not a button", () => {
  const icons: Record<EmptyKind, RegExp> = {
    "no-watches": /lucide-search/,
    "no-jobs-yet": /lucide-sprout/,
    "no-new": /lucide-circle-check/,
    scanning: /lucide-refresh-cw/,
    "scan-error": /lucide-triangle-alert/,
    paused: /lucide-power-off/,
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
      enabled={true}
      onToggleEnabled={noop}
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

test("ListHeader renders the master on/off switch, checked while watching", () => {
  const h = header({ enabled: true });
  assert.match(h, /id="master-switch"/);
  assert.match(h, /data-state="checked"/);
});

test("ListHeader hides Scan now while the master switch is off", () => {
  // Nothing to scan while paused, so the manual trigger goes away with the loop;
  // the switch itself is the way back on.
  const off = header({ enabled: false });
  assert.doesNotMatch(off, /id="scan-now"/);
  assert.match(off, /data-state="unchecked"/);
  // ...and it comes back the moment watching resumes.
  assert.match(header({ enabled: true }), /id="scan-now"/);
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

test("ScanStatusBar says Paused when the master switch is off (§ master)", () => {
  // Unlike `off`, this one renders: the user turned it off and the bar confirms it.
  const h = html(<ScanStatusBar status={{ kind: "disabled" }} />);
  assert.match(h, /data-kind="disabled"/);
  assert.match(h, /Paused/);
  assert.match(h, /lucide-power-off/);
});

// ── HowItWorks: the Options-page explainer ───────────────────────────────────

test("HowItWorks starts collapsed, so Options still opens on the settings", () => {
  const h = html(<HowItWorks />);
  assert.match(h, /<details[^>]*id="how-it-works"/);
  // No `open` attribute — the essay is one click away, not in the way.
  assert.doesNotMatch(h, /<details[^>]*\sopen\b/);
});

test("HowItWorks links out to the repo, in a new tab", () => {
  const h = html(<HowItWorks />);
  assert.match(h, /href="https:\/\/github\.com\/jochristianto\/jc-linkedin-job-watcher"/);
  // The Options page is a form with unsaved edits in it — navigating away from
  // it to read the README would throw them away.
  assert.match(h, /id="repo-link"[^>]*target="_blank"/);
  assert.match(h, /rel="noreferrer"/);
});

test("HowItWorks explains the mechanism without jargon or PRD section numbers", () => {
  const h = html(<HowItWorks />);
  // The four claims someone needs before they can trust a background scraper:
  // what it opens, where the data goes, what reaches them, and the ToS risk.
  assert.match(h, /hidden tab/i);
  assert.match(h, /Nothing is sent to a server/i);
  assert.match(h, /one desktop notification for the whole round/i);
  assert.match(h, /against\s+their\s+terms/i);
  // No "PRD §7", no "dedupe pass", no "MV3 service worker".
  assert.doesNotMatch(h, /PRD|§|dedupe|MV3|service worker|chrome\.storage/i);
});
