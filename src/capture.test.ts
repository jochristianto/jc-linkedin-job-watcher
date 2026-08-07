import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureFilename,
  captureMessage,
  isLoggedOutUrl,
  pickCaptureTab,
  type TabLike,
} from "./capture.ts";

// "Save a copy of your job-search page" (issue #49) — the pure half (§14): which
// tab to capture, what the file is called, and the sentence each outcome shows.
// No chrome.*, no DOM, no clock read (the caller passes `capturedAt`), so
// `node --test` proves every rule with plain values. The scroll/serialise/download
// wiring lives untested in the content script and the options page.

const SEARCH = "https://www.linkedin.com/jobs/search/?keywords=engineer&geoId=101355337";
const FEED = "https://www.linkedin.com/feed/";
const AUTHWALL = "https://www.linkedin.com/authwall?trk=jobs";
const OTHER = "https://example.com/jobs/search/";

// ── pickCaptureTab ───────────────────────────────────────────────────────────

test("picks the LinkedIn job-search tab, returning its id", () => {
  const tabs: TabLike[] = [
    { id: 1, url: FEED },
    { id: 2, url: SEARCH },
    { id: 3, url: OTHER },
  ];
  assert.deepEqual(pickCaptureTab(tabs), { ok: true, tabId: 2 });
});

test("a /jobs/search/ tab is matched with or without a trailing slash, and search-results is not", () => {
  assert.equal(pickCaptureTab([{ id: 7, url: "https://www.linkedin.com/jobs/search" }]).ok, true);
  assert.equal(pickCaptureTab([{ id: 7, url: "https://www.linkedin.com/jobs/search/" }]).ok, true);
  // The new results surface is out of scope (#47) — it is not the classic page.
  assert.deepEqual(pickCaptureTab([{ id: 7, url: "https://www.linkedin.com/jobs/search-results/" }]), {
    ok: false,
    reason: "not-search-page",
  });
});

test("no LinkedIn tab open at all is its own reason", () => {
  assert.deepEqual(pickCaptureTab([{ id: 1, url: FEED }, { id: 2, url: "https://www.linkedin.com/jobs/" }]), {
    ok: false,
    reason: "not-search-page",
  });
  assert.deepEqual(pickCaptureTab([{ id: 1, url: OTHER }]), {
    ok: false,
    reason: "no-linkedin-tab",
  });
  assert.deepEqual(pickCaptureTab([]), { ok: false, reason: "no-linkedin-tab" });
});

test("a LinkedIn tab sitting on an authwall reads as logged-out, not merely off the search page", () => {
  assert.deepEqual(pickCaptureTab([{ id: 4, url: AUTHWALL }]), {
    ok: false,
    reason: "logged-out",
  });
});

test("a real search tab wins even when a login tab is also open", () => {
  assert.deepEqual(
    pickCaptureTab([
      { id: 4, url: AUTHWALL },
      { id: 5, url: SEARCH },
    ]),
    { ok: true, tabId: 5 },
  );
});

test("a search-URL tab with no id cannot be captured, so it is not the search tab", () => {
  assert.deepEqual(pickCaptureTab([{ url: SEARCH }]), {
    ok: false,
    reason: "not-search-page",
  });
});

// ── isLoggedOutUrl ───────────────────────────────────────────────────────────

test("isLoggedOutUrl catches the pages LinkedIn bounces a signed-out session to", () => {
  assert.equal(isLoggedOutUrl(AUTHWALL), true);
  assert.equal(isLoggedOutUrl("https://www.linkedin.com/login"), true);
  assert.equal(isLoggedOutUrl("https://www.linkedin.com/checkpoint/challenge"), true);
  assert.equal(isLoggedOutUrl(SEARCH), false);
  assert.equal(isLoggedOutUrl(undefined), false);
});

// ── captureFilename ──────────────────────────────────────────────────────────

test("the file is an .html named for the day it was captured", () => {
  const at = Date.UTC(2026, 7, 7); // 2026-08-07
  assert.equal(captureFilename(at), "linkedin-jobs-search-2026-08-07.html");
});

// ── captureMessage ───────────────────────────────────────────────────────────

test("every outcome says what happened or what to do next, and none is silent", () => {
  const saved = captureMessage({ kind: "saved", cardCount: 25 });
  assert.equal(saved.kind, "ok");
  assert.match(saved.message, /25/);

  const savedNone = captureMessage({ kind: "saved", cardCount: 0 });
  assert.equal(savedNone.kind, "ok");

  for (const kind of ["no-linkedin-tab", "not-search-page", "logged-out", "unreachable", "failed"] as const) {
    const status = captureMessage({ kind });
    assert.equal(status.kind, "err", `${kind} is an error`);
    assert.notEqual(status.message.trim(), "", `${kind} has a message`);
  }
});
