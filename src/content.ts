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

import { CARD_SELECTOR, parseJobCards } from "./parse.ts";
import { pollUntilSettled } from "./scan-probe.ts";
import type { ScanRequest, ScanResponse } from "./scan.ts";

/** Poll cadence for settling the lazy list — issue #5's 60–90s cycle budget. */
const POLL_OPTS = { intervalMs: 800, timeoutMs: 20_000, stableSamples: 3 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One settle sample: scroll the results column so LinkedIn materialises the next
 *  occludable batch (issue #2, finding 4 — the list is lazy), then count the
 *  distinct cards currently in the DOM. */
async function sample(): Promise<number> {
  window.scrollTo(0, document.body.scrollHeight);
  document.querySelector(CARD_SELECTOR)?.scrollIntoView({ block: "end" });
  return document.querySelectorAll(CARD_SELECTOR).length;
}

async function readPage(): Promise<ScanResponse> {
  const settle = await pollUntilSettled({ sample, sleep, now: () => Date.now() }, POLL_OPTS);
  return { jobs: parseJobCards(document), settled: settle.settled };
}

chrome.runtime.onMessage.addListener((message: ScanRequest, _sender, sendResponse) => {
  if (message?.type !== "LJW_SCAN") return undefined;
  void readPage().then(sendResponse);
  return true; // keep the message channel open for the async reply
});
