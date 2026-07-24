import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esc,
  metaLine,
  renderJobRow,
  renderList,
  renderEmptyState,
  renderChips,
  renderModeToggle,
  renderScanButton,
  renderToolbar,
  type JobView,
  type ChipWatch,
  type EmptyKind,
} from "./render.ts";

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

test("esc escapes the characters that break HTML embedding", () => {
  assert.equal(esc("Sales & Marketing"), "Sales &amp; Marketing");
  assert.equal(esc("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;");
  assert.equal(esc('a "b"'), "a &quot;b&quot;");
});

test("metaLine joins present parts with a middot", () => {
  assert.equal(metaLine(["Acme Corp", "Jakarta"]), "Acme Corp · Jakarta");
});

test("metaLine drops missing parts and never leaves a dangling separator", () => {
  assert.equal(metaLine(["Acme Corp", "", null, undefined]), "Acme Corp");
  assert.equal(metaLine([null, "Jakarta"]), "Jakarta");
  assert.equal(metaLine([]), "");
});

test("renderJobRow shows the title and a company/location meta line", () => {
  const html = renderJobRow(job());
  assert.match(html, /Senior Software Engineer/);
  assert.match(html, /Acme Corp · Jakarta, Indonesia/);
  assert.match(html, /2 hours ago/);
  assert.match(html, /Indonesia/);
});

test("renderJobRow marks read jobs read — and opening one does NOT read it", () => {
  assert.match(renderJobRow(job({ read: false })), /data-read="false"/);
  assert.match(renderJobRow(job({ read: true })), /data-read="true"/);
  // The bug this whole split exists to fix: clicking a row used to dismiss it.
  assert.match(renderJobRow(job({ opened: true })), /data-read="false"/);
});

test("renderJobRow flags an opened job so its row can be highlighted, not hidden", () => {
  assert.match(renderJobRow(job({ opened: false })), /data-opened="false"/);
  assert.match(renderJobRow(job({ opened: true })), /data-opened="true"/);
});

test("renderJobRow gives every row its own read and block buttons", () => {
  const html = renderJobRow(job());
  assert.match(html, /data-action="read"/);
  assert.match(html, /data-action="block"/);
});

test("renderJobRow's read button is a toggle: mark as read, then back to unread", () => {
  assert.match(renderJobRow(job({ read: false })), /data-action="read" aria-pressed="false"/);
  assert.match(renderJobRow(job({ read: false })), /title="Mark as read"/);
  assert.match(renderJobRow(job({ read: true })), /data-action="read" aria-pressed="true"/);
  assert.match(renderJobRow(job({ read: true })), /title="Mark as unread"/);
});

test("renderJobRow's block button names the company and flips to Unblock", () => {
  assert.match(renderJobRow(job({ blocked: false })), /title="Block Acme Corp"/);
  assert.match(renderJobRow(job({ blocked: true })), /title="Unblock Acme Corp"/);
  assert.match(renderJobRow(job({ blocked: true })), /data-action="block" aria-pressed="true"/);
});

test("renderJobRow's row actions are Lucide icons, and the read one flips", () => {
  assert.match(renderJobRow(job({ read: false })), /lucide-check/);
  assert.match(renderJobRow(job({ read: true })), /lucide-rotate-ccw/);
  assert.match(renderJobRow(job()), /lucide-ban/);
  // The icon is decorative; the button's own aria-label is what gets announced.
  const html = renderJobRow(job());
  assert.match(html, /aria-label="Mark as read"[^>]*><svg[^>]*aria-hidden="true"/);
});

test("renderJobRow escapes the company inside the block button's label", () => {
  const html = renderJobRow(job({ company: 'A&B <"x">' }));
  assert.match(html, /title="Block A&amp;B &lt;&quot;x&quot;&gt;"/);
  assert.doesNotMatch(html, /<"x">/);
});

test("renderJobRow drops the block button when no company was parsed", () => {
  // Nothing to blocklist — better no button than one that blocklists "" and
  // silently matches every job (PRD §12: fields fail independently).
  const html = renderJobRow(job({ company: "   " }));
  assert.doesNotMatch(html, /data-action="block"/);
  assert.match(html, /data-action="read"/);
});

test("renderJobRow marks a blocked job and says why it is greyed", () => {
  const html = renderJobRow(job({ blocked: true }));
  assert.match(html, /data-blocked="true"/);
  assert.match(html, /class="job-tag">Blocked</);
  assert.doesNotMatch(renderJobRow(job({ blocked: false })), /job-tag/);
});

test("renderJobRow shows the Blocked tag even when the foot line is empty", () => {
  const html = renderJobRow(job({ postedText: "", watchName: "", blocked: true }));
  assert.match(html, /class="job-tag">Blocked</);
});

test("renderJobRow keeps the buttons out of the anchor (a button inside <a> is invalid)", () => {
  const html = renderJobRow(job());
  const anchor = html.slice(html.indexOf("<a class=\"job-main\""), html.indexOf("</a>"));
  assert.doesNotMatch(anchor, /<button/);
});

test("renderJobRow carries the job id and url for click handling", () => {
  const html = renderJobRow(job({ id: "77", url: "https://x/jobs/view/77/" }));
  assert.match(html, /data-job-id="77"/);
  assert.match(html, /href="https:\/\/x\/jobs\/view\/77\/"/);
});

test("renderJobRow degrades per-field: a missing field never blanks the row", () => {
  const html = renderJobRow(
    job({ company: "", location: "", postedText: "" }),
  );
  // Title still renders — the row is never empty.
  assert.match(html, /Senior Software Engineer/);
  // No dangling separator from the missing company/location.
  assert.doesNotMatch(html, /·\s*<\//);
  assert.doesNotMatch(html, /·\s*·/);
});

test("renderJobRow falls back to a placeholder when the title itself is missing", () => {
  const html = renderJobRow(job({ title: "" }));
  assert.match(html, /Untitled role/);
});

test("renderJobRow escapes every field so scraped text cannot break markup", () => {
  const html = renderJobRow(
    job({ title: "R&D <lead>", company: "A<B", watchName: "Q&A" }),
  );
  assert.match(html, /R&amp;D &lt;lead&gt;/);
  assert.match(html, /A&lt;B/);
  assert.match(html, /Q&amp;A/);
  assert.doesNotMatch(html, /<lead>/);
});

test("renderList in 'new' mode hides jobs already read", () => {
  const jobs = [
    job({ id: "1", read: false }),
    job({ id: "2", read: true }),
  ];
  const html = renderList(jobs, "new");
  assert.match(html, /data-job-id="1"/);
  assert.doesNotMatch(html, /data-job-id="2"/);
});

test("renderList in 'new' mode KEEPS a job you merely opened", () => {
  // The reported bug: clicking a row made it vanish from New for good. Opening
  // now only highlights it — it stays until you tick it read.
  const html = renderList([job({ id: "1", opened: true, read: false })], "new");
  assert.match(html, /data-job-id="1"/);
  assert.match(html, /data-opened="true"/);
});

test("renderList in 'all' mode keeps read jobs (they stay on screen, greyed)", () => {
  const jobs = [
    job({ id: "1", read: false }),
    job({ id: "2", read: true }),
  ];
  const html = renderList(jobs, "all");
  assert.match(html, /data-job-id="1"/);
  assert.match(html, /data-job-id="2"/);
  assert.match(html, /data-read="true"/);
});

test("renderList keeps blocked jobs in both modes — blocking is not deleting", () => {
  const jobs = [job({ id: "1", blocked: true, read: false })];
  for (const mode of ["new", "all"] as const) {
    assert.match(renderList(jobs, mode), /data-job-id="1"/, mode);
    assert.match(renderList(jobs, mode), /data-blocked="true"/, mode);
  }
});

const chipWatches: ChipWatch[] = [
  { id: "w1", name: "Indonesia" },
  { id: "w2", name: "Japan" },
];

test("renderChips renders an All-watches chip plus one per watch", () => {
  const html = renderChips(chipWatches, null);
  assert.match(html, /data-watch-id=""[^>]*>All watches/);
  assert.match(html, /data-watch-id="w1"[^>]*>Indonesia/);
  assert.match(html, /data-watch-id="w2"[^>]*>Japan/);
});

test("renderChips marks the All chip active when no watch is selected", () => {
  const html = renderChips(chipWatches, null);
  assert.match(html, /data-watch-id=""\s+aria-pressed="true"/);
  assert.match(html, /data-watch-id="w1"\s+aria-pressed="false"/);
});

test("renderChips marks the selected watch chip active, All inactive", () => {
  const html = renderChips(chipWatches, "w2");
  assert.match(html, /data-watch-id=""\s+aria-pressed="false"/);
  assert.match(html, /data-watch-id="w2"\s+aria-pressed="true"/);
  assert.match(html, /data-watch-id="w1"\s+aria-pressed="false"/);
});

test("renderChips escapes watch names and ids", () => {
  const html = renderChips([{ id: "a&b", name: "R&D <x>" }], null);
  assert.match(html, /R&amp;D &lt;x&gt;/);
  assert.match(html, /data-watch-id="a&amp;b"/);
  assert.doesNotMatch(html, /<x>/);
});

test("renderModeToggle marks the active mode pressed", () => {
  const html = renderModeToggle("new");
  assert.match(html, /data-mode="new"\s+aria-pressed="true"/);
  assert.match(html, /data-mode="all"\s+aria-pressed="false"/);

  const all = renderModeToggle("all");
  assert.match(all, /data-mode="all"\s+aria-pressed="true"/);
  assert.match(all, /data-mode="new"\s+aria-pressed="false"/);
});

test("renderToolbar combines chips and the mode toggle in one toolbar row", () => {
  const html = renderToolbar(chipWatches, "w1", "all");
  assert.match(html, /class="toolbar"/);
  assert.match(html, /class="chips"/);
  assert.match(html, /data-watch-id="w1"\s+aria-pressed="true"/);
  assert.match(html, /class="toggle"/);
  assert.match(html, /data-mode="all"\s+aria-pressed="true"/);
});

test("renderEmptyState gives a distinct, actionable message per situation", () => {
  const kinds = [
    "no-watches",
    "no-jobs-yet",
    "no-new",
    "scanning",
    "scan-error",
  ] as const;
  const messages = kinds.map((k) => renderEmptyState(k));
  // All five are distinct.
  assert.equal(new Set(messages).size, 5);
  assert.match(renderEmptyState("no-watches"), /Options|Add a search/i);
  assert.match(renderEmptyState("no-new"), /caught up|no new/i);
  assert.match(renderEmptyState("scan-error"), /failed|broke|selector/i);
});

test("each empty state gets its own Lucide icon, sized as artwork not a button", () => {
  const icons: Record<string, RegExp> = {
    "no-watches": /lucide-search/,
    "no-jobs-yet": /lucide-sprout/,
    "no-new": /lucide-circle-check/,
    scanning: /lucide-refresh-cw/,
    "scan-error": /lucide-triangle-alert/,
  };
  for (const [kind, pattern] of Object.entries(icons)) {
    const html = renderEmptyState(kind as EmptyKind);
    assert.match(html, pattern, kind);
    assert.match(html, /width="28" height="28"/, kind);
  }
});

test("nothing in the rendered markup falls back to an emoji or a bare glyph", () => {
  // Emoji ignore the theme and the ✓ / ⊘ / ↺ family tofu-boxes on some systems;
  // that is what src/icons.ts exists to prevent, so guard against a regression.
  const markup = [
    renderJobRow(job()),
    renderJobRow(job({ read: true, blocked: true })),
    ...(["no-watches", "no-jobs-yet", "no-new", "scanning", "scan-error"] as const).map(
      renderEmptyState,
    ),
  ].join("");
  // Arrows (↺), math operators (⊘), misc symbols (⚙), dingbats (✓ ✕), emoji.
  assert.doesNotMatch(
    markup,
    /[\u{2190}-\u{21FF}\u{2200}-\u{22FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F300}-\u{1FAFF}]/u,
  );
});

// ── renderScanButton: the manual scan control ────────────────────────────────

test("renderScanButton renders a clickable Scan now control when idle", () => {
  const html = renderScanButton("idle");
  assert.match(html, /id="scan-now"/);
  assert.match(html, /data-scan-state="idle"/);
  assert.match(html, />Scan now</);
  assert.doesNotMatch(html, /disabled/);
});

test("renderScanButton is disabled while a cycle already holds the lock", () => {
  const html = renderScanButton("scanning");
  assert.match(html, /disabled/);
  assert.match(html, /Scanning…/);
});

test("renderScanButton labels itself as the manual resume when scanning is halted", () => {
  const html = renderScanButton("halted");
  assert.match(html, /data-scan-state="halted"/);
  assert.match(html, />Resume</);
  // A halted extension can only recover through this button, so it must stay live.
  assert.doesNotMatch(html, /disabled/);
});
