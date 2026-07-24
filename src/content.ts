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
import { pollUntilSettled, type SettleSample } from "./scan-probe.ts";
import { readScanToken, scanTokenMatches, type ScanRequest, type ScanResponse } from "./scan.ts";
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
async function readPage(): Promise<ScanResponse> {
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

  // The classified-outcome signals (§16): where we landed, whether the list
  // container is even present, and the three counts — never a bare "0 cards".
  // The *decision* (empty vs partial vs structure-changed vs logged-out …) is
  // classifyPage's, run in the background against these; this only reads them off.
  return {
    jobs: Array.from(found.values()),
    settled: settle.settled,
    finalUrl: window.location.href,
    hasResultsList: document.querySelector(RESULTS_LIST_SELECTOR) !== null,
    cardCount: seenIds.size,
    savedCount: found.size,
    slotCount: settle.expected,
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
    });
  });
  return true; // keep the message channel open for the async reply
});
