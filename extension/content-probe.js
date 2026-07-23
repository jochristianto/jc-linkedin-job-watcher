// Injected into the invisible probe tab by background.js (issue #5 / 04).
//
// Job: scroll the lazily-rendered results column, count the DISTINCT job cards,
// keep doing that until the count stops growing (or we time out), then
// console.log the count and hand the result back to the worker.
//
// The identity + settle logic is transcribed verbatim from the tested
// `src/scan-probe.ts` (jobIdOf / extractJobIds / pollUntilSettled) — a classic
// injected script can't import it. Keep the two in sync; the .ts copy is tested.
//
// The trailing async IIFE evaluates to a Promise; chrome.scripting.executeScript
// awaits it and delivers the result to background.js as `result.result`.

(async () => {
  const OPTS = { intervalMs: 800, timeoutMs: 25_000, stableSamples: 3 };

  // ── mirrors src/scan-probe.ts ──────────────────────────────────────────────
  function jobIdOf(el) {
    const direct =
      el.getAttribute("data-job-id") ??
      el.getAttribute("data-occludable-job-id");
    if (direct && /^\d+$/.test(direct)) return direct;
    const href = el.getAttribute("href");
    if (href) {
      const m = href.match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function extractJobIds(cards) {
    const seen = new Set();
    const ids = [];
    for (const c of cards) {
      const id = jobIdOf(c);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }
  // ────────────────────────────────────────────────────────────────────────────

  // The scrollable results column. Selectors drift (issue #2/#12); try a few,
  // and fall back to the whole document so a miss still scrolls *something*.
  function resultsScroller() {
    return (
      document.querySelector(".scaffold-layout__list-container") ||
      document.querySelector(".jobs-search-results-list") ||
      document.scrollingElement ||
      document.documentElement
    );
  }

  function cardElements() {
    let els = Array.from(
      document.querySelectorAll("[data-job-id], li[data-occludable-job-id]"),
    );
    if (els.length === 0) {
      // Alternate/guest DOM: fall back to view-links (extractJobIds dedupes).
      els = Array.from(document.querySelectorAll("a[href*='/jobs/view/']"));
    }
    return els;
  }

  // One sample: nudge the lazy list to render more, then count distinct cards.
  async function sample() {
    const scroller = resultsScroller();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(150); // let occluded rows paint
    return extractJobIds(cardElements()).length;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // mirrors src/scan-probe.ts pollUntilSettled
  const start = Date.now();
  const recent = [];
  let count = 0;
  let samples = 0;
  let settled = false;
  for (;;) {
    count = await sample();
    samples++;
    recent.push(count);
    if (recent.length > OPTS.stableSamples) recent.shift();

    const stable =
      recent.length === OPTS.stableSamples &&
      count > 0 &&
      recent.every((c) => c === count);
    if (stable) {
      settled = true;
      break;
    }
    if (Date.now() - start >= OPTS.timeoutMs) break;
    await sleep(OPTS.intervalMs);
  }

  const result = { count, settled, elapsedMs: Date.now() - start, samples };
  // The ticket's literal ask: one console.log of the card count.
  console.log("[LJW probe] job cards:", count, result);
  return result;
})();
