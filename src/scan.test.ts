import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enabledWatches,
  repeatsPreviousPage,
  scanPageUrl,
  stampJobs,
  mergeJobs,
  unreadCount,
  badgeText,
  withScanToken,
  readScanToken,
  scanTokenMatches,
  badgeColor,
  badgeFor,
  sameSearchPage,
} from "./scan.ts";
import type { JobsMap } from "./storage.ts";
import type { Job, Watch } from "./types.ts";

function watch(overrides: Partial<Watch> & { id: string }): Watch {
  return {
    name: overrides.id,
    url: `https://www.linkedin.com/jobs/search/?keywords=remote&sortBy=DD`,
    enabled: true,
    ...overrides,
  };
}

function job(overrides: Partial<Job> & { id: string }): Job {
  return {
    title: "Staff Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia",
    isReposted: false,
    postedText: "2 hours ago",
    url: `https://www.linkedin.com/jobs/view/${overrides.id}/`,
    foundAt: 0,
    watchId: "",
    opened: false,
    openedAt: null,
    read: false,
    readAt: null,
    ...overrides,
  };
}

test("enabledWatches keeps only enabled watches, in order", () => {
  const ws = [
    watch({ id: "a", enabled: true }),
    watch({ id: "b", enabled: false }),
    watch({ id: "c", enabled: true }),
  ];
  assert.deepEqual(
    enabledWatches(ws).map((w) => w.id),
    ["a", "c"],
  );
});

test("scanPageUrl page 1 sets start=0 and keeps the saved search's query", () => {
  const url = scanPageUrl("https://www.linkedin.com/jobs/search/?keywords=remote&sortBy=DD", 1);
  const u = new URL(url);
  assert.equal(u.searchParams.get("start"), "0");
  assert.equal(u.searchParams.get("keywords"), "remote");
  assert.equal(u.searchParams.get("sortBy"), "DD");
});

test("scanPageUrl page N sets start=(N-1)*25", () => {
  assert.equal(new URL(scanPageUrl("https://www.linkedin.com/jobs/search/?k=x", 2)).searchParams.get("start"), "25");
  assert.equal(new URL(scanPageUrl("https://www.linkedin.com/jobs/search/?k=x", 3)).searchParams.get("start"), "50");
});

test("scanPageUrl overrides an existing start= rather than appending a second one", () => {
  const url = scanPageUrl("https://www.linkedin.com/jobs/search/?keywords=remote&start=99", 2);
  const params = new URL(url).searchParams.getAll("start");
  assert.deepEqual(params, ["25"]);
});

test("repeatsPreviousPage flags a page whose first id repeats the previous page's (issue #30 item 2)", () => {
  // The signature of `&start=` no longer paginating: page 2 opens on the same
  // first posting as page 1, so everything past position 25 is unreachable.
  assert.equal(repeatsPreviousPage("4012345678", "4012345678"), true);
});

test("repeatsPreviousPage is false for two genuinely different pages", () => {
  assert.equal(repeatsPreviousPage("4099999999", "4012345678"), false);
});

test("repeatsPreviousPage never flags on a null/empty first id — an empty page is a different fault", () => {
  // A quiet or empty page has no first id; that is classifyPage's business, not a
  // pagination stall, so it must not be mistaken for a repeat (including page 1,
  // where there is no previous first id to compare against).
  assert.equal(repeatsPreviousPage(null, null), false);
  assert.equal(repeatsPreviousPage("", ""), false);
  assert.equal(repeatsPreviousPage(null, "4012345678"), false);
  assert.equal(repeatsPreviousPage("4012345678", null), false);
});

test("stampJobs fills the scan-context fields the parser left neutral", () => {
  const stamped = stampJobs([job({ id: "1" }), job({ id: "2" })], "watch-x", 12345);
  assert.deepEqual(
    stamped.map((j) => ({ id: j.id, watchId: j.watchId, foundAt: j.foundAt })),
    [
      { id: "1", watchId: "watch-x", foundAt: 12345 },
      { id: "2", watchId: "watch-x", foundAt: 12345 },
    ],
  );
});

test("stampJobs does not mutate the input jobs", () => {
  const input = job({ id: "1" });
  stampJobs([input], "w", 1);
  assert.equal(input.watchId, "");
  assert.equal(input.foundAt, 0);
});

test("mergeJobs adds new jobs keyed by id", () => {
  const merged = mergeJobs({}, [job({ id: "1" }), job({ id: "2" })]);
  assert.deepEqual(Object.keys(merged).sort(), ["1", "2"]);
});

test("mergeJobs preserves an existing job's opened state rather than resetting it on re-scan", () => {
  const existing: JobsMap = { "1": job({ id: "1", opened: true, openedAt: 500 }) };
  const merged = mergeJobs(existing, [job({ id: "1", opened: false, openedAt: null })]);
  assert.equal(merged["1"]!.opened, true);
  assert.equal(merged["1"]!.openedAt, 500);
});

test("mergeJobs preserves an existing job's read state too — a re-scan can't un-dismiss it", () => {
  const existing: JobsMap = { "1": job({ id: "1", read: true, readAt: 500 }) };
  const merged = mergeJobs(existing, [job({ id: "1", read: false, readAt: null })]);
  assert.equal(merged["1"]!.read, true);
  assert.equal(merged["1"]!.readAt, 500);
});

test("unreadCount counts the jobs you have not looked at — clicked or ticked, both clear", () => {
  const jobs: JobsMap = {
    "1": job({ id: "1", read: false }),
    "2": job({ id: "2", read: true }),
    // Clicked open but never ticked: off the badge, still on the New list. The
    // badge counts what you have not seen, `visibleJobs` keeps what you have not
    // finished with, and those are two different questions.
    "3": job({ id: "3", opened: true, read: false }),
  };
  assert.equal(unreadCount(jobs), 1);
});

test("unreadCount skips blocked companies so blocking a row quiets the badge", () => {
  const jobs: JobsMap = {
    "1": job({ id: "1", company: "Acme Corp" }),
    "2": job({ id: "2", company: "Globex" }),
  };
  assert.equal(unreadCount(jobs, []), 2);
  assert.equal(unreadCount(jobs, ["acme"]), 1);
});

test("badgeText is empty for zero, the number below 100, and 99+ above", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
});

test("badgeColor maps severity to default / amber / red (§16.8)", () => {
  // The contract is that the three severities read as three distinct colours.
  const colors = new Set([badgeColor("ok"), badgeColor("warn"), badgeColor("error")]);
  assert.equal(colors.size, 3);
});

test("badgeFor: an error shows a red '!' even with zero unopened jobs (§16.8)", () => {
  const b = badgeFor(0, "error");
  assert.equal(b.text, "!");
  assert.equal(b.color, badgeColor("error"));
});

test("badgeFor: a healthy badge is just the unopened count in the default colour", () => {
  assert.deepEqual(badgeFor(3, "ok"), { text: "3", color: badgeColor("ok") });
  assert.deepEqual(badgeFor(0, "ok"), { text: "", color: badgeColor("ok") });
});

test("badgeFor: a soft warning keeps the count but colours it amber", () => {
  assert.deepEqual(badgeFor(2, "warn"), { text: "2", color: badgeColor("warn") });
  // With nothing unopened, a warning still shows a marker so the amber is visible.
  assert.deepEqual(badgeFor(0, "warn"), { text: "!", color: badgeColor("warn") });
});

test("withScanToken stamps the one-time token onto the URL fragment, not the query", () => {
  const url = withScanToken("https://www.linkedin.com/jobs/search/?keywords=remote&start=0", "abc123");
  const u = new URL(url);
  // The token rides the fragment (never sent to LinkedIn), leaving the query intact.
  assert.equal(u.searchParams.get("keywords"), "remote");
  assert.equal(u.searchParams.get("start"), "0");
  assert.equal(u.searchParams.has("ljw_token"), false);
  assert.equal(readScanToken(u.hash), "abc123");
});

test("readScanToken returns null when the URL carries no token (a hand-opened tab)", () => {
  assert.equal(readScanToken(""), null);
  assert.equal(readScanToken("#"), null);
  assert.equal(readScanToken("#currentJobId=42"), null);
});

test("scanTokenMatches accepts only an exact non-empty match", () => {
  assert.equal(scanTokenMatches("abc123", "abc123"), true);
  assert.equal(scanTokenMatches("abc123", "nope"), false);
  // A hand-opened tab has no page token: nothing a stray message carries can match.
  assert.equal(scanTokenMatches(null, "abc123"), false);
  assert.equal(scanTokenMatches("", ""), false);
  assert.equal(scanTokenMatches("abc123", undefined), false);
});

// ── sameSearchPage: telling a redirect from our own token fragment ────────────

test("sameSearchPage ignores the scan token fragment the page ends up carrying", () => {
  // Every scan lands on the requested URL *plus* the token withScanToken stamped
  // on, so a plain !== reports every single page as redirected and buries the
  // real ones.
  const requested = "https://www.linkedin.com/jobs/search/?keywords=x&start=0";
  const landed = withScanToken(requested, "46ec7841-bf71-4c23-88c0-97cfc7dc97ff");
  assert.equal(sameSearchPage(landed, requested), true);
});

test("sameSearchPage still reports a genuine redirect", () => {
  const requested = "https://www.linkedin.com/jobs/search/?keywords=x&start=0";
  assert.equal(sameSearchPage("https://www.linkedin.com/authwall", requested), false);
  assert.equal(sameSearchPage("https://www.linkedin.com/checkpoint/challenge", requested), false);
});

test("sameSearchPage treats a different page of the same search as different", () => {
  assert.equal(
    sameSearchPage(
      "https://www.linkedin.com/jobs/search/?keywords=x&start=25",
      "https://www.linkedin.com/jobs/search/?keywords=x&start=0",
    ),
    false,
  );
});

test("sameSearchPage falls back to an exact match on an unparseable URL", () => {
  assert.equal(sameSearchPage("not a url", "not a url"), true);
  assert.equal(sameSearchPage("not a url", "also not a url"), false);
});
