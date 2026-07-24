// Scan probe — the load-bearing logic behind issue #5 (04):
// "Does a tab you can't see actually load the job list?"
//
// The spike extension in `extension/` opens a background tab (`active: false`),
// injects `content-probe.js`, scrolls the lazy results column, and counts job
// cards. Two pieces of that are pure and worth getting right regardless of what
// the browser measurement turns out to be, so they live here with tests:
//
//   1. job-card identity  — which element is which posting, and how many
//      *distinct* postings a page holds (question #1: does the count match what
//      #2 found by hand; question #4: are page-1 and page-2 IDs actually
//      different).
//   2. settle-polling      — how the probe decides the lazily-rendered list has
//      finished materialising (question #2: is there a load event or must it
//      poll; question #3: does it need scrolling first).
//
// `content-probe.js` is a classic injected script and cannot import this module,
// so it transcribes `jobIdOf`/`extractJobIds` verbatim — keep the two in sync;
// this is the copy that has the tests.

/** A minimal structural view of a job-card element: just its attributes. */
export interface CardLike {
  getAttribute(name: string): string | null;
}

/**
 * Recover LinkedIn's numeric job id from a card, in the order issue #2 found
 * reliable on the authenticated `/jobs/search/` DOM: `data-job-id` on the card,
 * then `data-occludable-job-id` on the enclosing `<li>`, then the
 * `/jobs/view/<id>/` href. Returns null when none yields a numeric id, so a
 * promoted/ghost slot neither counts nor crashes the scan (PRD §12).
 */
export function jobIdOf(card: CardLike): string | null {
  const direct =
    card.getAttribute("data-job-id") ??
    card.getAttribute("data-occludable-job-id");
  if (direct && /^\d+$/.test(direct)) return direct;

  const href = card.getAttribute("href");
  if (href) {
    const m = href.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * The distinct job ids on a page, in document order. Dedupes on the id alone —
 * not `watchId + id` — so a role that appears twice on one page is one job
 * (PRD §5). This is the count the probe reports and compares against #2.
 */
export function extractJobIds(cards: CardLike[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const card of cards) {
    const id = jobIdOf(card);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Tunables for {@link pollUntilSettled}. */
export interface PollOptions {
  /** Wait between samples (a sample = scroll the list, then count). */
  intervalMs: number;
  /** Give up after this much elapsed time and report whatever count we have. */
  timeoutMs: number;
  /** How many consecutive equal, non-zero counts mean "the list has settled". */
  stableSamples: number;
}

/** One reading taken partway through the walk down the results column. */
export interface SettleSample {
  /** Distinct postings **accumulated so far** across the whole walk — not the
   *  number currently in the DOM. LinkedIn de-materialises rows scrolled well
   *  past, so an instantaneous count goes *down* as you scroll and can never
   *  reach the full list; the caller keeps a running set and reports its size,
   *  which makes this monotonic and "it stopped growing" meaningful. */
  count: number;
  /** Posting slots the page itself declares (see `SLOT_SELECTOR`), or 0 when the
   *  page uses no slot markup. Carried through as the denominator the caller
   *  checks its own read against; it never gates settling, so a page that
   *  declares more slots than it can ever render cannot hang the walk. */
  expected: number;
  /** The scroll container has no further room to scroll — the walk has reached
   *  the bottom of the list. */
  atEnd: boolean;
}

/** Injected effects for {@link pollUntilSettled}, faked in tests. */
export interface PollDeps {
  /** Advance the walk one step: scroll the results column on, merge whatever is
   *  now materialised into the running set, and report {@link SettleSample}. */
  sample: () => Promise<SettleSample>;
  sleep: (ms: number) => Promise<void>;
  /** Elapsed-time clock in ms; must advance as `sleep` is awaited. */
  now: () => number;
}

/** What the probe learned about one page load. */
export interface PollResult {
  /** The last accumulated count observed. */
  count: number;
  /** The last slot count the page declared (0 = it declares none). */
  expected: number;
  /** True if the walk reached the bottom AND the accumulated count stopped
   *  growing, before the timeout. False means the read is incomplete — the
   *  caller must treat whatever it got as partial, not as the whole list. */
  settled: boolean;
  elapsedMs: number;
  /** How many times `sample()` was called. */
  samples: number;
}

/**
 * Walk the lazy results column until it is exhausted: keep sampling until the
 * accumulated posting count has held steady for `stableSamples` consecutive
 * reads **and** the scroll container has reached its end — or `timeoutMs`
 * elapses.
 *
 * Both conditions are needed, and each one alone is a real bug we have shipped:
 * stability alone settles on the handful of cards LinkedIn paints before any
 * scrolling has happened (the count is trivially "stable" because nothing is
 * driving it), and reaching the end alone settles before the last batch has
 * painted. Requiring both means "we walked the whole list and it stopped
 * yielding new postings".
 *
 * `expected` never gates the loop — only `atEnd` and stability do — so a page
 * that declares 25 slots but can only ever render 24 times out at worst rather
 * than spinning forever.
 */
export async function pollUntilSettled(
  deps: PollDeps,
  opts: PollOptions,
): Promise<PollResult> {
  const start = deps.now();
  const recent: number[] = [];
  let count = 0;
  let expected = 0;
  let samples = 0;

  for (;;) {
    const s = await deps.sample();
    count = s.count;
    expected = s.expected;
    samples++;

    recent.push(count);
    if (recent.length > opts.stableSamples) recent.shift();

    const stable =
      recent.length === opts.stableSamples &&
      count > 0 &&
      recent.every((c) => c === count);
    if (stable && s.atEnd) {
      return { count, expected, settled: true, elapsedMs: deps.now() - start, samples };
    }

    if (deps.now() - start >= opts.timeoutMs) {
      return { count, expected, settled: false, elapsedMs: deps.now() - start, samples };
    }

    await deps.sleep(opts.intervalMs);
  }
}
