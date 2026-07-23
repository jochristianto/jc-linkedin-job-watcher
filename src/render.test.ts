import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esc,
  metaLine,
  renderJobRow,
  renderList,
  renderEmptyState,
  type JobView,
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

test("renderJobRow marks unopened jobs unread and opened jobs read", () => {
  assert.match(renderJobRow(job({ opened: false })), /data-read="false"/);
  assert.match(renderJobRow(job({ opened: true })), /data-read="true"/);
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

test("renderList in 'new' mode hides jobs already opened", () => {
  const jobs = [
    job({ id: "1", opened: false }),
    job({ id: "2", opened: true }),
  ];
  const html = renderList(jobs, "new");
  assert.match(html, /data-job-id="1"/);
  assert.doesNotMatch(html, /data-job-id="2"/);
});

test("renderList in 'all' mode keeps opened jobs (they stay on screen, read)", () => {
  const jobs = [
    job({ id: "1", opened: false }),
    job({ id: "2", opened: true }),
  ];
  const html = renderList(jobs, "all");
  assert.match(html, /data-job-id="1"/);
  assert.match(html, /data-job-id="2"/);
  assert.match(html, /data-read="true"/);
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
