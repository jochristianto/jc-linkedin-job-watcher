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

// Pin the clock to UTC so the posting-date hover — which reads local time by
// design — is the same string wherever the suite runs. `postedAt` is anchored to
// midnight UTC, so in UTC the hover shows exactly that date. Set before any Date.
process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ApplyNote, ApplyPrompt } from "./apply-prompt.tsx";
import { EmptyState } from "./empty-state.tsx";
import { HowItWorks } from "./how-it-works.tsx";
import { JobList } from "./job-list.tsx";
import { JobRow } from "./job-row.tsx";
import { HeaderMenu, ListHeader } from "./list-header.tsx";
import { ScanButton } from "./scan-button.tsx";
import { ScanStatusBar } from "./scan-status.tsx";
import { Toolbar } from "./toolbar.tsx";
import { TooltipProvider } from "./ui/tooltip";
import { WatchList } from "./watch-list.tsx";
import type { ChipWatch, EmptyKind, JobView } from "../view-model.ts";

/** Render to static markup. Radix needs a TooltipProvider in scope for anything
 *  that uses a tooltip, and wrapping unconditionally keeps every call here the
 *  same shape. */
const html = (node: React.ReactElement): string =>
  renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

/** A frozen clock, so the "Found …" chip is a fixed string rather than whatever
 *  the machine's wall clock says when the suite runs. */
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "3901",
    title: "Senior Software Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia",
    postedText: "2 hours ago",
    // Default to the legacy shape — no stored date — so the row falls back to the
    // frozen `postedText` phrase. Tests that exercise the live age set `postedAt`.
    postedAt: null,
    postedPrecision: null,
    linkedInStatus: null,
    isReposted: false,
    watchName: "Indonesia",
    url: "https://www.linkedin.com/jobs/view/3901/",
    foundAt: NOW - 41 * 60_000,
    opened: false,
    read: false,
    blocked: false,
    applied: false,
    notes: "",
    ...overrides,
  };
}

const noop = () => {};

/** The Block and read buttons' own opening tags, out of a rendered row. Just the
 *  tags: everything between one `<button` and the next is most of the row after
 *  it, so asking "does this button carry class X?" of that would answer about the
 *  anchor beside it too. Slicing at the first `>` is safe — React escapes the one
 *  inside class names like `has-[>svg]:px-2.5`. */
const actionTags = (html: string): string[] =>
  html
    .split("<button")
    .filter((c) => /data-action="(block|read)"/.test(c))
    .map((c) => c.slice(0, c.indexOf(">")));

/** A row on its own, with its three callbacks stubbed. Defaults to the tab's
 *  layout; pass "popup" for the stacked one. */
const row = (j: JobView, armed = false, variant: "tab" | "popup" = "tab"): string =>
  html(
    <JobRow
      job={j}
      variant={variant}
      armed={armed}
      now={NOW}
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
  assert.match(h, /Indonesia/);
});

test("JobRow separates the posting's own age from when the watcher found it", () => {
  // Two facts, not one. A 12-hour-old posting found four minutes ago is the loop
  // working; the same posting found eleven hours late is not, and a single
  // "2 hours ago" cannot tell those apart.
  const h = row(job({ postedText: "12 hours ago" }));
  assert.match(h, /Posted 12h ago/);
  assert.match(h, /Found 41m ago/);
  assert.match(h, /lucide-history/);
});

test("JobRow computes a LIVE posting age from postedAt, not the frozen phrase", () => {
  // The whole point of #51: a job found three weeks ago stops insisting it was
  // posted two weeks ago. The stored phrase says "2 weeks ago"; the row reads
  // the date against `now` and says the truth.
  const h = row(
    job({ postedText: "2 weeks ago", postedAt: NOW - 21 * 86_400_000, postedPrecision: "day" }),
  );
  assert.match(h, /Posted 3w ago/);
  assert.doesNotMatch(h, /2w ago/);
});

test("JobRow marks an estimated date with a tilde and nothing else does", () => {
  const estimated = job({ postedAt: NOW - 21 * 86_400_000, postedPrecision: "estimated" });
  assert.match(row(estimated), /Posted ~3w ago/);
  // "exact" and "day" are both true at the row's resolution, so no tilde.
  const day = job({ postedAt: NOW - 21 * 86_400_000, postedPrecision: "day" });
  assert.match(row(day), /Posted 3w ago/);
  assert.doesNotMatch(row(day), /~/);
});

test("JobRow puts the date in words on hover, per precision", () => {
  const exact = job({ postedAt: Date.UTC(2026, 0, 7, 8, 48), postedPrecision: "exact" });
  assert.match(row(exact), /title="Posted 7 Jan 2026, 08:48"/);
  const day = job({ postedAt: Date.UTC(2026, 0, 7), postedPrecision: "day" });
  assert.match(row(day), /title="Posted 7 Jan 2026"/);
  const estimated = job({ postedAt: Date.UTC(2026, 0, 7), postedPrecision: "estimated" });
  assert.match(
    row(estimated),
    /title="Posted around 7 Jan 2026 — estimated from LinkedIn&#x27;s wording"/,
  );
});

test("JobRow shows 'Seen on LinkedIn' for a viewed card, and never a date beside it", () => {
  // LinkedIn withheld the date because the posting was opened somewhere; the row
  // says so instead of falling silent. A viewed card carries no date.
  const h = row(job({ postedText: "", postedAt: null, linkedInStatus: "viewed" }));
  assert.match(h, /Seen on LinkedIn/);
  assert.doesNotMatch(h, /Posted/);
  // A Lucide icon, not a bare glyph, and not one reused from another action.
  assert.match(h, /lucide-footprints/);
});

test("JobRow renders 'Opened' and 'Seen on LinkedIn' together when a row earns both", () => {
  // "I opened this from here" plus "LinkedIn agrees" — two separate facts.
  const h = row(job({ postedAt: null, linkedInStatus: "viewed", opened: true }));
  assert.match(h, />Opened</);
  assert.match(h, /Seen on LinkedIn/);
});

test("JobRow still shows the frozen phrase when a record has no stored date", () => {
  // Records saved before #48 have no `postedAt`; they keep showing what they
  // always have rather than going blank, and age out within 30 days.
  const h = row(job({ postedText: "5 hours ago", postedAt: null, linkedInStatus: null }));
  assert.match(h, /Posted 5h ago/);
  assert.doesNotMatch(h, /Seen on LinkedIn/);
});

test("JobRow marks a reposted job with an amber chip, and never an unreposted one", () => {
  // The flag has always been parsed and stored; issue #53 is only that the row
  // never showed it. `=== true` — an absent flag reads as "no marker", not yes.
  assert.match(row(job({ isReposted: true })), />Reposted</);
  assert.doesNotMatch(row(job({ isReposted: false })), />Reposted</);
  // Amber, so a reposted row is findable while skimming, not only when read.
  const h = row(job({ isReposted: true }));
  assert.match(h, /var\(--warn\)/);
  // A Lucide icon, not a bare glyph, and not one reused from another action.
  assert.match(h, /lucide-refresh-cw/);
});

test("JobRow's Reposted chip carries an accessible name, not just a hover title", () => {
  // The word alone assumes the reader knows what LinkedIn means by it; the name
  // says what it is evidence of — and a `title` alone gives a span no accessible
  // name at all, so it is spelled out for the screen reader too.
  const h = row(job({ isReposted: true }));
  assert.match(
    h,
    /aria-label="Reposted — re-listed by the employer, the role may be stale or never filled"/,
  );
  assert.match(
    h,
    /title="Re-listed by the employer — the role may be stale or never filled"/,
  );
});

test("JobRow puts the Reposted chip after the posting age and ahead of Found", () => {
  // The date and the repost are both facts about the posting's own history; Found
  // is a fact about the watcher, so the line groups them that way.
  const h = row(job({ isReposted: true, postedAt: NOW - 21 * 86_400_000, postedPrecision: "day" }));
  assert.ok(
    h.indexOf("Posted 3w ago") < h.indexOf("Reposted"),
    "the Reposted chip should follow the posting age",
  );
  assert.ok(
    h.indexOf("Reposted") < h.indexOf("Found 41m ago"),
    "the Reposted chip should come before Found",
  );
});

test("JobRow shows the Reposted chip on a card with no date at all", () => {
  // It must not depend on the age slot being filled: a reposted card LinkedIn
  // withheld the date from still gets the chip, sitting after `Seen on LinkedIn`.
  const seen = row(job({ isReposted: true, postedAt: null, linkedInStatus: "viewed" }));
  assert.match(seen, />Reposted</);
  assert.ok(
    seen.indexOf("Seen on LinkedIn") < seen.indexOf("Reposted"),
    "the Reposted chip should follow the Seen on LinkedIn chip",
  );
  assert.ok(
    seen.indexOf("Reposted") < seen.indexOf("Found 41m ago"),
    "the Reposted chip should come before Found even with no date",
  );
  // And with no date and no viewed status either — a bare reposted card.
  const bare = row(job({ isReposted: true, postedAt: null, postedText: "", linkedInStatus: null }));
  assert.match(bare, />Reposted</);
});

test("JobRow spells the full word 'Reposted' out, never an abbreviation, on both surfaces", () => {
  for (const variant of ["tab", "popup"] as const) {
    const h = row(job({ isReposted: true }), false, variant);
    assert.match(h, />Reposted</, variant);
    // The popup wraps the meta line rather than shortening the word to hold height.
    assert.doesNotMatch(h, />Repost</, variant);
  }
});

test("JobRow leads with the employer monogram, blocking being an employer choice", () => {
  assert.match(row(job({ company: "Acme Corp" })), />A</);
  // The Japanese corporate prefix is stripped, or every third employer wears
  // an identical 株 tile.
  assert.match(row(job({ company: "（株）テイルウィンド" })), />テ</);
  assert.match(row(job()), /data-actions="inline"/);
});

test("JobRow in the popup drops the monogram and stacks the actions below", () => {
  // 380px is not enough for a tile, a title and three buttons on one line: the
  // decorations were costing ~100px and nearly every title wrapped to three
  // lines because of it. The popup spends that width on the job instead.
  const h = row(job({ company: "Acme Corp" }), false, "popup");
  assert.match(h, /data-actions="below"/);
  // No employer tile — the `size-7.5` box is the tab layout's alone.
  assert.doesNotMatch(h, /size-7\.5/);
  assert.match(row(job()), /size-7\.5/);
  // The unread marker survives it, in a column of its own so read and unread
  // titles still start on the same vertical line.
  assert.match(h, /bg-unread/);
  assert.doesNotMatch(row(job({ read: true }), false, "popup"), /bg-unread/);
});

test("JobRow's popup actions take the whole line, split evenly between them", () => {
  // Two buttons on a line of their own at 380px: half a card each is a target
  // you hit without aiming, and two equal halves read as one control rather
  // than as buttons trailing off the right edge.
  const h = row(job(), false, "popup");
  const buttons = actionTags(h);
  assert.equal(buttons.length, 2);
  // `flex-1` off a zero basis is what makes it 50:50 regardless of the two
  // labels' different lengths — the line itself is full width.
  for (const b of buttons) assert.match(b, /\bflex-1\b/);
  // A rule with room to breathe under it. The *amount* of room is deliberately
  // not pinned to a number: this assertion read `py-1.5` and broke on a redesign
  // that only retuned the padding, which is a test failing over a decision it was
  // never making. What must not silently go away is the padded strip itself —
  // buttons crammed against the rule is the thing worth catching.
  assert.match(h, /data-actions="below"[\s\S]*?<div class="[^"]*\bborder-t\b[^"]*\bpy-\d/);
});

test("JobRow fences the popup's action line off from the posting with a rule", () => {
  // Without it the buttons sat straight under "Found 4h ago · Opened" — grey,
  // small, the same size as the labels beside them — and the chips read as the
  // start of the action line rather than the end of the posting.
  const h = row(job(), false, "popup");
  // Inset from the card's edges (`mx-3`) rather than run wall to wall, so the
  // rule starts where the posting's text starts and reads as dividing the
  // card's contents rather than as a second card boundary.
  assert.match(h, /<div class="[^"]*\bborder-t\b[^"]*\bmx-3\b/);
  // The rule is the popup's alone: in the tab the buttons are beside the
  // posting, so there are no two halves to separate.
  assert.doesNotMatch(row(job()), /border-t/);
});

test("JobRow leaves the tab's actions their natural size, centred on the row", () => {
  // Beside the posting they are a margin, not a line: stretching them there
  // would take width off the job itself, which is the whole point of the tab.
  const h = row(job());
  const buttons = actionTags(h);
  assert.equal(buttons.length, 2);
  for (const b of buttons) assert.doesNotMatch(b, /\bflex-1\b/);
  // The card is as tall as its chips and its note; buttons pinned to the top of
  // that read as belonging to the title alone.
  assert.match(h, /data-actions="inline"[\s\S]*?<span class="[^"]*\bself-center\b/);
});

test("JobRow keeps all three controls, and their order, in both layouts", () => {
  for (const variant of ["tab", "popup"] as const) {
    const h = row(job({ applied: true }), false, variant);
    assert.match(h, /data-action="unapply"/, variant);
    assert.match(h, /data-action="block"/, variant);
    assert.match(h, /data-action="read"/, variant);
    // Moving them to their own line must not reshuffle them: the tick stays
    // last, out at the edge where a one-tap dismiss belongs.
    assert.ok(
      h.indexOf('data-action="unapply"') < h.indexOf('data-action="block"'),
      `${variant}: the Applied undo comes before Block`,
    );
    assert.ok(
      h.indexOf('data-action="block"') < h.indexOf('data-action="read"'),
      `${variant}: Block comes before the tick`,
    );
    // And they stay outside the anchor in both — a <button> inside <a> is invalid.
    const anchor = h.slice(h.indexOf("<a "), h.indexOf("</a>"));
    assert.doesNotMatch(anchor, /<button/, variant);
  }
});

test("JobRow gives the work mode its own tinted chip, split off the location", () => {
  const h = row(job({ location: "Tokyo, Japan (Remote)" }));
  assert.match(h, />Remote</);
  // The full location still reads as one line above it — the chip is a second
  // view of the same field, not a replacement for it.
  assert.match(h, /Acme Corp · Tokyo, Japan \(Remote\)/);
});

test("JobRow marks a job you clicked through to without dismissing it", () => {
  const h = row(job({ opened: true }));
  assert.match(h, />Opened</);
  assert.doesNotMatch(row(job({ opened: false })), />Opened</);
});

test("JobRow shows the note an applied job was logged with", () => {
  // The whole reason the note is stored is reading it back off the list months
  // later, and until this redesign nothing ever displayed it.
  const h = row(job({ applied: true, notes: "Referred by Mika" }));
  assert.match(h, /Referred by Mika/);
  // No empty note box on a job answered Yes with nothing typed.
  assert.doesNotMatch(row(job({ applied: true, notes: "" })), />Note</);
});

test("JobRow marks read jobs read — and opening one does NOT read it", () => {
  assert.match(row(job({ read: false })), /data-read="false"/);
  assert.match(row(job({ read: true })), /data-read="true"/);
  // The bug this whole split exists to fix: clicking a row used to dismiss it.
  // It clears the unread dot (see below) but the row is not read, not greyed,
  // and — the part that was the bug — not gone from the New list.
  assert.match(row(job({ opened: true })), /data-read="false"/);
});

test("JobRow drops the unread dot on a job you clicked, not just one you ticked", () => {
  // The dot means "not looked at yet", so it answers to the same rule the badge
  // counts by — otherwise the header says 2 new over a list showing no dots.
  assert.match(row(job({ opened: false, read: false })), /bg-unread/);
  assert.doesNotMatch(row(job({ opened: true, read: false })), /bg-unread/);
  assert.doesNotMatch(row(job({ opened: false, read: true })), /bg-unread/);
  // What survives on a clicked row is the "Opened" chip: the dot is gone, but
  // the row still says which of the two ways it got that way.
  assert.match(row(job({ opened: true, read: false })), />Opened</);
  // Blocked never carries one either way — it is off the badge count, so a dot
  // would be claiming a job that isn't.
  assert.doesNotMatch(row(job({ blocked: true })), /bg-unread/);
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

test("JobRow spells the tick out in the popup and leaves it bare in the tab", () => {
  // On its own half-width line there is room for the word, and a lone icon in a
  // button that size is a lot of target for no explanation. Beside a three-line
  // posting it is one label too many, so the tab keeps only the tooltip and the
  // accessible name — which is where the word is actually wanted.
  assert.match(row(job(), false, "popup"), />Mark as read</);
  assert.doesNotMatch(row(job()), />Mark as read</);
  assert.match(row(job()), /data-action="read"[^>]*aria-label="Mark as read"/);
  assert.match(row(job({ read: true })), /data-action="read"[^>]*aria-label="Mark as unread"/);
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

test("JobRow's row actions are Lucide icons, never a font glyph", () => {
  // The tick wears the state it would take you *to*, so the two directions are
  // two icons: an unread row offers the closing eye, a read one offers the open
  // eye that brings it back. This used to expect `lucide-eye-off` for both, which
  // asserted the opposite of what the button does.
  assert.match(row(job({ read: false })), /lucide-eye-off/);
  assert.match(row(job({ read: true })), /lucide-eye\b/);
  assert.doesNotMatch(row(job({ read: true })), /lucide-eye-off/);
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
  // The reported bug: clicking a row made it vanish from New for good — and in
  // the popup it vanished as the popup closed, so you never saw it go. Opening
  // takes the job off the badge count and clears its dot, but the row itself
  // stays put until you tick it read.
  const h = list([job({ id: "1", opened: true, read: false })], "new");
  assert.match(h, /data-job-id="1"/);
  assert.match(h, /data-opened="true"/);
  assert.doesNotMatch(h, /bg-unread/);
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
  html(<ApplyPrompt jobId="3901" onAnswer={noop} onDismiss={noop} {...over} />);

const note = (over: Partial<React.ComponentProps<typeof ApplyNote>> = {}): string =>
  html(<ApplyNote jobId="3901" onSave={noop} onDismiss={noop} {...over} />);

test("ApplyPrompt asks the question, on the row it is asking about", () => {
  const h = prompt();
  assert.match(h, /Did you apply for this job\?/);
  // The one thing the strip carries about the job: which one it is, for the row
  // it is pinned inside. The title is a line above it in that same card, so the
  // strip naming it too would be the same sentence twice — and there is no
  // second placement that has to.
  assert.match(h, /data-job-id="3901"/);
  assert.doesNotMatch(h, /data-placement/);
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

test("ApplyPrompt escapes the id it carries", () => {
  // A LinkedIn id is digits, but it is a parsed string and it lands in an
  // attribute, so it is escaped like every other one.
  assert.match(prompt({ jobId: 'a&b"c' }), /data-job-id="a&amp;b&quot;c"/);
});

test("ApplyNote is the second step, and stays where the question was", () => {
  const h = note();
  assert.match(h, /Add a note\?/);
  // Same strip, same card, same job — only the contents change.
  assert.match(h, /data-job-id="3901"/);
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

test("ApplyNote commits with Save, and takes the Yes back with Cancel", () => {
  const h = note();
  assert.match(buttonWith(h, 'data-action="apply-submit"'), />Save</);
  // Nothing to fill in first — the note is optional, so Save is live on arrival.
  assert.doesNotMatch(buttonWith(h, 'data-action="apply-submit"'), DISABLED_ATTR);
  // The way out of a Yes that was a misclick: it dismisses, so nothing is recorded.
  assert.match(buttonWith(h, 'data-action="apply-dismiss"'), />Cancel</);
});

test("ApplyNote offers the common notes as one tap each", () => {
  // A Yes with no note is a record you can do nothing with in three months, and
  // an empty box asked for a sentence. These are the four cases pre-typed.
  const h = note();
  const chips = h.split("<button").filter((c) => c.includes('data-action="apply-quick-note"'));
  assert.equal(chips.length, 4);
  assert.match(h, /Referral/);
  assert.match(h, /Take-home sent/);
});

test("ApplyNote says how to commit and back out from the keyboard", () => {
  // The box swallows Enter, so the shortcut that saves has to be written down —
  // and spelled out rather than drawn with a ⌘ glyph that tofu-boxes off macOS.
  assert.match(note(), /Cmd\/Ctrl \+ Enter saves · Esc cancels/);
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

/** The header. Defaults to the tab, which is the view that still lays its
 *  controls out in a row — the popup's are behind {@link menu} now. */
const header = (over: Partial<React.ComponentProps<typeof ListHeader>> = {}): string =>
  html(
    <ListHeader
      title="New jobs"
      badge={0}
      scanButton="idle"
      variant="tab"
      enabled={true}
      filtered={false}
      onToggleEnabled={noop}
      onScan={noop}
      onMarkAllRead={noop}
      onOpenTab={noop}
      onOpenOptions={noop}
      {...over}
    />,
  );

/** The popup menu's contents, rendered on their own. A Radix dialog renders
 *  nothing until it opens and nothing through `renderToStaticMarkup` even then —
 *  its portal has no DOM to portal into — which is exactly why `HeaderMenu` is
 *  exported apart from the dialog that holds it. */
const menu = (over: Partial<React.ComponentProps<typeof HeaderMenu>> = {}): string =>
  html(
    <HeaderMenu
      enabled={true}
      filtered={false}
      onToggleEnabled={noop}
      onMarkAllRead={noop}
      onOpenOptions={noop}
      {...over}
    />,
  );

test("ListHeader renders a Mark all as read control", () => {
  assert.match(header(), /id="mark-all-read"/);
  assert.match(menu(), /id="mark-all-read"/);
});

test("ListHeader says 'these', not 'all', while a watch chip filters the list", () => {
  // The action only reaches the filtered list (see `markAllRead`), and it is the
  // one control here with no bulk undo — so the words have to match the scope.
  const h = header({ filtered: true });
  assert.match(h, />Mark these read</);
  assert.match(h, /id="mark-all-read"[^>]*aria-label="Mark these as read"/);
  assert.match(menu({ filtered: true }), />Mark these as read</);

  // Unfiltered, it is the whole list and says so.
  assert.match(header({ filtered: false }), />Mark all read</);
  assert.match(menu({ filtered: false }), />Mark all as read</);
});

test("ListHeader's Options control is a labelled gear icon, not a glyph", () => {
  const h = header();
  // Icon-only in the tab, so the label lives on the button — the <svg> is aria-hidden.
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

test("ListHeader folds the popup's control cluster into a hamburger", () => {
  // 380px could not hold a title and five controls on one line, so the header
  // wrapped to two. Three buttons fit beside the title; the three fold in.
  const h = header({ variant: "popup" });
  assert.match(h, /id="header-menu"/);
  assert.match(h, /lucide-menu/);
  for (const id of ["mark-all-read", "open-options", "master-switch"]) {
    assert.doesNotMatch(h, new RegExp(`id="${id}"`), id);
  }
});

test("ListHeader keeps Scan now out of the popup's menu and in the header", () => {
  // It is the control you press most — skipping the wait is the entire point of
  // it — so it does not go behind a click. Icon-only beside the other two, with
  // the label kept as the accessible name.
  const h = header({ variant: "popup" });
  assert.match(h, /id="scan-now"[^>]*aria-label="Scan now"/);
  assert.ok(
    h.indexOf('id="scan-now"') < h.indexOf('id="open-tab"'),
    "the scan button should render before the expand button",
  );
  assert.doesNotMatch(menu(), /id="scan-now"/);
});

test("ListHeader's popup scan button drops the words, not the meaning", () => {
  // A 380px row of icons has no space for a label, so `compact` takes it off the
  // button — but the state still has to be readable, hence the name and title.
  const h = header({ variant: "popup", scanButton: "halted" });
  assert.doesNotMatch(h, />Resume</);
  assert.match(h, /id="scan-now"[^>]*aria-label="Resume"/);
  assert.match(h, /data-scan-state="halted"/);
});

test("ListHeader keeps the way out of the popup out of the popup's menu", () => {
  // "Open as a full page" is the escape from the cramped surface; putting the
  // exit inside the thing you are escaping is a click too many. It sits beside
  // the hamburger, and before it — the menu is the last thing on the row.
  const h = header({ variant: "popup" });
  assert.match(h, /id="open-tab"[^>]*aria-label="Open as a full page"/);
  assert.ok(
    h.indexOf('id="open-tab"') < h.indexOf('id="header-menu"'),
    "the expand button should render before the menu button",
  );
  // And it is not duplicated inside the menu.
  assert.doesNotMatch(menu(), /id="open-tab"/);
});

test("ListHeader leaves the tab's controls in a row, with no menu button", () => {
  // The tab has the width the popup does not, so nothing is worth hiding here.
  const h = header({ variant: "tab" });
  assert.doesNotMatch(h, /id="header-menu"/);
  for (const id of ["scan-now", "mark-all-read", "open-options", "master-switch"]) {
    assert.match(h, new RegExp(`id="${id}"`), id);
  }
});

test("ListHeader's menu button admits when watching is paused", () => {
  // A shut menu says nothing about the state of what is inside it, and "the loop
  // is off" is the one thing you must not have to open a menu to find out.
  assert.match(header({ variant: "popup", enabled: false }), /id="header-menu"[^>]*aria-label="Menu — watching is paused"/);
  assert.match(header({ variant: "popup", enabled: true }), /id="header-menu"[^>]*aria-label="Menu"/);
});

test("HeaderMenu spells every control out in words, not icons alone", () => {
  // The reason for folding them in here at all: as a row of icons in a 380px
  // header, most of them were a guess until you hovered. A list has the room.
  const h = menu();
  for (const label of ["Mark all as read", "Options"]) {
    assert.match(h, new RegExp(`>${label}<`), label);
  }
});

test("ListHeader renders the master on/off switch, checked while watching", () => {
  for (const h of [header({ enabled: true }), menu({ enabled: true })]) {
    assert.match(h, /id="master-switch"/);
    assert.match(h, /data-state="checked"/);
  }
});

test("ListHeader hides Scan now while the master switch is off", () => {
  // Nothing to scan while paused, so the manual trigger goes away with the loop;
  // the switch itself is the way back on.
  for (const variant of ["tab", "popup"] as const) {
    assert.doesNotMatch(header({ variant, enabled: false }), /id="scan-now"/, variant);
    // ...and it comes back the moment watching resumes.
    assert.match(header({ variant, enabled: true }), /id="scan-now"/, variant);
  }
  assert.match(menu({ enabled: false }), /data-state="unchecked"/);
});

test("HeaderMenu says what the master switch is currently doing", () => {
  // The header only ever had a tooltip for this. A list row has room to say it
  // outright, and the switch is the one control here worth a sentence.
  assert.match(menu({ enabled: true }), />Watching for jobs</);
  assert.match(menu({ enabled: false }), />Paused</);
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

test("ScanStatusBar reads manual-only as a standing state, not a missing schedule", () => {
  // Deliberately not the `unscheduled` wording: nothing is wrong here, so the bar
  // must not say "no scan scheduled" as if something had gone missing.
  const h = html(<ScanStatusBar status={{ kind: "manual" }} unread={2} watchCount={3} />);
  assert.match(h, /data-kind="manual"/);
  assert.match(h, /Manual only — press Scan now/);
  assert.doesNotMatch(h, /No scan scheduled/);
  // The counts stay: a manual round is a full round, so the unread total is as
  // real here as under a countdown — only `disabled` replaces it with "Paused".
  assert.match(h, /2 new · 3 watches/);
});

// ── HowItWorks: the Options-page explainer ───────────────────────────────────

test("HowItWorks is always open — the last section, not a disclosure", () => {
  const h = html(<HowItWorks />);
  assert.match(h, /id="how-it-works"/);
  // It is a section of the page now, reached from the rail like every other one.
  // Nothing collapses, so there is no state to keep and nothing to re-open.
  assert.doesNotMatch(h, /<details|<summary/);
});

test("HowItWorks runs the prose in two columns, headed and in order", () => {
  const h = html(<HowItWorks />);
  // What happens, then what surprises people about it — the second column is the
  // one that answers "why did it do that?" without a trip to the README.
  assert.match(h, /Every round/);
  assert.match(h, /Worth knowing/);
  assert.ok(h.indexOf("Every round") < h.indexOf("Worth knowing"));
  // The steps are numbered by position, so the order is carried by the markup
  // rather than typed into each sentence.
  assert.match(h, />1</);
  assert.match(h, />5</);
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

// ── WatchList: the saved searches on the Options page ────────────────────────

const watch = {
  id: "w1",
  name: "Indonesia",
  url: "https://www.linkedin.com/jobs/?f=1&k=x",
  enabled: true,
};

test("WatchList makes the saved search URL a link, opened in a new tab", () => {
  const h = html(<WatchList watches={[watch]} onChange={() => {}} />);
  assert.match(h, /<a[^>]*href="https:\/\/www\.linkedin\.com\/jobs\/\?f=1&amp;k=x"/);
  // Same reasoning as the repo link: Options is a form with unsaved edits in it,
  // so checking a search must never navigate this page away.
  assert.match(h, /<a[^>]*target="_blank"[^>]*data-act="open-url"/);
  assert.match(h, /<a[^>]*rel="noreferrer"/);
  // Truncated to one line, so the full URL has to be reachable some other way.
  assert.match(h, /<a[^>]*title="https:\/\/www\.linkedin\.com\/jobs\/\?f=1&amp;k=x"/);
});

test("WatchList says what a search filters on, so two rows are tellable apart", () => {
  const h = html(
    <WatchList
      watches={[
        {
          ...watch,
          url: "https://www.linkedin.com/jobs/search/?f_WT=2&geoId=102478259&keywords=Software%20Engineer",
        },
      ]}
      onChange={() => {}}
    />,
  );
  // The query string read back as words — the URL itself tells a human nothing.
  assert.match(h, /“Software Engineer”/);
  assert.match(h, /Indonesia/);
  assert.match(h, /Remote/);
});

test("WatchList pauses a watch with a switch, and says so on the row", () => {
  const on = html(<WatchList watches={[watch]} onChange={() => {}} />);
  const off = html(<WatchList watches={[{ ...watch, enabled: false }]} onChange={() => {}} />);
  // A switch, not a checkbox: it pauses a search rather than selecting it.
  assert.match(on, /data-act="toggle"[^>]*role="switch"|role="switch"[^>]*data-act="toggle"/);
  // Greyed alone reads as "the last one" rather than "this one is off".
  assert.doesNotMatch(on, />Paused</);
  assert.match(off, />Paused</);
  assert.match(off, /data-act="toggle"[^>]*aria-label="Resume Indonesia"/);
});

test("WatchList offers the add form as the empty list's one thing to click", () => {
  const h = html(<WatchList watches={[]} onChange={() => {}} />);
  assert.match(h, /id="add-search"/);
  assert.match(h, /Add a watch/);
  // Closed until asked for — one form on the page, never two sets of fields.
  assert.doesNotMatch(h, /id="watch-form"/);
});
