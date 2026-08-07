// Content script — CLASSIC (non-module) script, built as a self-contained IIFE
// (see vite.content.config.ts): the imports below are bundled inline, leaving no
// import/export in the output.
//
// It does two things and holds no decisions of its own (PRD §14 — the parsing,
// polling and job shapes all live in pure, tested modules): on a `LJW_SCAN`
// message from the worker it scroll-settles the lazy results list
// (`pollUntilSettled`), parses it (`parseJobCards`), and replies with the jobs.
// That is the read half of the invisible-tab scan (issue #15 / #5). Everything
// here is a thin wrapper over browser APIs, so it is not unit-tested.

import {
  RESULTS_LIST_SELECTOR,
  SLOT_SELECTOR,
  findResultsScroller,
  parseJobCards,
  postingIdsOn,
} from "./parse.ts";
import { fieldReadCounts, NO_FIELD_READS } from "./health.ts";
import { pollUntilSettled, type PollResult, type SettleSample } from "./scan-probe.ts";
import { readScanToken, scanTokenMatches, type ScanRequest, type ScanResponse } from "./scan.ts";
import type { CaptureRequest, CaptureResponse } from "./capture.ts";
import type { Job } from "./types.ts";

/** Poll cadence for walking the lazy list — issue #5's 60–90s cycle budget. The
 *  walk is ~5–10 samples for a 25-result page, so this lands around 5s; the
 *  timeout is the ceiling for a page that never stops loading. */
const POLL_OPTS = { intervalMs: 500, timeoutMs: 30_000, stableSamples: 3 };

/** How far to advance per step, as a fraction of the visible column. Under 1 so
 *  consecutive steps overlap: a full-viewport jump can scroll a row from "not yet
 *  materialised" clean past "materialised" without it ever being read. */
const SCROLL_STEP_RATIO = 0.8;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Advance the results column one step; returns whether it is now at the bottom.
 *  Re-reads `scrollHeight` each call, so a column that grows as LinkedIn appends
 *  a batch correctly reports "not at the end" again. */
function scrollStep(el: Element): boolean {
  const step = Math.max(200, el.clientHeight * SCROLL_STEP_RATIO);
  el.scrollTop += step;
  return el.scrollTop >= el.scrollHeight - el.clientHeight - 2;
}

/**
 * Read the whole results list by walking down it, accumulating postings as they
 * materialise.
 *
 * Measured on the live page, a visible tab fills in 7 → 11 → 17 → 21 → 25 rows
 * over about two seconds of stepped scrolling, and holds at 25 thereafter. So the
 * list is lazy on the way *down* but does not recycle what it has already
 * painted. Two consequences, and the old code got both wrong: scrolling has to
 * actually drive the results column (it scrolled the window, which does nothing
 * here), and the read has to happen *during* the walk rather than once at the
 * end — a single parse only ever sees what has painted by that moment.
 *
 * Merging at every step, keyed by job id, is also the conservative choice if
 * LinkedIn later starts recycling rows: it costs one cheap re-parse per step and
 * removes any dependence on what happens to be in the DOM at the final instant.
 */
async function walkResultsList(): Promise<{
  found: Map<string, Job>;
  seenIds: Set<string>;
  settle: PollResult;
}> {
  const found = new Map<string, Job>();
  const seenIds = new Set<string>();

  const sample = async (): Promise<SettleSample> => {
    // Merge first, scroll second: whatever the previous step materialised is read
    // before this step scrolls it away again.
    for (const job of parseJobCards(document)) {
      if (!found.has(job.id)) found.set(job.id, job);
    }
    // Postings *present* this step, savable or not — the denominator that tells a
    // failure to materialise apart from a failure to parse the fields.
    for (const id of postingIdsOn(document)) seenIds.add(id);
    // Re-resolved every step rather than cached: on the first sample the cards may
    // not exist yet, so there is nothing to walk up from and the fallback would be
    // cached for the rest of the run.
    const scroller = findResultsScroller(document, window);
    const atEnd = scroller ? scrollStep(scroller) : true;
    return {
      count: found.size,
      expected: document.querySelectorAll(SLOT_SELECTOR).length,
      atEnd,
    };
  };

  const settle = await pollUntilSettled({ sample, sleep, now: () => Date.now() }, POLL_OPTS);
  return { found, seenIds, settle };
}

async function readPage(): Promise<ScanResponse> {
  const { found, seenIds, settle } = await walkResultsList();
  const jobs = Array.from(found.values());

  // The classified-outcome signals (§16): where we landed, whether the list
  // container is even present, and the three counts — never a bare "0 cards".
  // The *decision* (empty vs partial vs structure-changed vs logged-out …) is
  // classifyPage's, run in the background against these; this only reads them off.
  return {
    jobs,
    settled: settle.settled,
    finalUrl: window.location.href,
    hasResultsList: document.querySelector(RESULTS_LIST_SELECTOR) !== null,
    cardCount: seenIds.size,
    savedCount: found.size,
    slotCount: settle.expected,
    // Per-field present-counts for the separate field-break axis (issue #52). Read
    // off the parsed postings here so `reduceFieldHealth` in the background stays
    // pure numbers, the way classifyPage already takes only the counts above.
    fieldCounts: fieldReadCounts(jobs),
  };
}

/**
 * Scroll the results list until its cards materialise, then hand back the whole
 * page serialised (issue #49). The scroll is load-bearing, not a nicety: an
 * un-scrolled list paints only a handful of real cards, so a capture taken without
 * walking it first is a capture of nothing — the same reason the scan walks it.
 *
 * It returns the page whatever state it is in. A page with no results list, or one
 * that yielded no cards, is exactly the breakage a capture is meant to diagnose,
 * so it is saved rather than refused; the *decision* about a signed-out redirect
 * (`isLoggedOutUrl`) is the options page's, made against `finalUrl`.
 *
 * `outerHTML` rather than a full `XMLSerializer` walk: it is what the fixture test
 * in `parse.test.ts` reads back, and the doctype is prepended so the saved file
 * opens as a standards-mode document.
 */
async function capturePage(): Promise<CaptureResponse> {
  const { seenIds } = await walkResultsList();
  return {
    html: `<!DOCTYPE html>\n${document.documentElement.outerHTML}`,
    finalUrl: window.location.href,
    hasResultsList: document.querySelector(RESULTS_LIST_SELECTOR) !== null,
    cardCount: seenIds.size,
  };
}

/** The token this page was *loaded* with, captured once at script start.
 *
 *  Read here rather than at message time because `/jobs/search/` is a single-page
 *  app that rewrites its own URL as you interact with it (it keeps `currentJobId`
 *  up to date), and a `history.replaceState` takes the fragment with it. Reading
 *  `location.hash` when the scan message arrives can therefore find the token
 *  already gone, and the read is refused on a page the background itself opened.
 *
 *  The security property is unchanged, and arguably sharper: the token still has
 *  to have been present on the URL this document was navigated to, which a tab the
 *  user opened by hand can never be. */
const PAGE_TOKEN = readScanToken(window.location.hash);

chrome.runtime.onMessage.addListener((message: ScanRequest, _sender, sendResponse) => {
  if (message?.type !== "LJW_SCAN") return undefined;
  // Read nothing until the message's one-time token matches the token the
  // background stamped onto THIS tab's URL (PRD §9). A LinkedIn tab the user
  // opened by hand carries no token, so it is never scraped.
  if (!scanTokenMatches(PAGE_TOKEN, message.token)) return undefined;
  // Answer even if the read throws: an unhandled rejection here would leave the
  // background waiting on a channel that closes empty, which is indistinguishable
  // from a page with no job list on it — and would be diagnosed as the wrong fault.
  void readPage().then(sendResponse, (err) => {
    console.error("[ljw] read failed:", err);
    sendResponse({
      jobs: [],
      settled: false,
      finalUrl: window.location.href,
      hasResultsList: document.querySelector(RESULTS_LIST_SELECTOR) !== null,
      cardCount: 0,
      savedCount: 0,
      slotCount: document.querySelectorAll(SLOT_SELECTOR).length,
      fieldCounts: NO_FIELD_READS,
    });
  });
  return true; // keep the message channel open for the async reply
});

chrome.runtime.onMessage.addListener((message: CaptureRequest, _sender, sendResponse) => {
  if (message?.type !== "LJW_CAPTURE") return undefined;
  // No token gate, deliberately (see CaptureRequest): the gate stops the background
  // scraping a hand-opened tab, but a capture is the user asking to save exactly
  // that tab, from a click on the extension's own Options page. Only extension
  // contexts can send this message, so a web page can never reach here.
  //
  // Answer even if the walk throws, for the same reason readPage does: a channel
  // that closes empty is indistinguishable from an unreachable tab, and the page
  // would report the wrong next step.
  void capturePage().then(sendResponse, (err) => {
    console.error("[ljw] capture failed:", err);
    sendResponse({
      html: "",
      finalUrl: window.location.href,
      hasResultsList: false,
      cardCount: 0,
    });
  });
  return true; // keep the message channel open for the async reply
});
