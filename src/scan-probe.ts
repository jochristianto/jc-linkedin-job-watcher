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

/** Injected effects for {@link pollUntilSettled}, faked in tests. */
export interface PollDeps {
  /** Scroll the results column and return the current distinct-card count. */
  sample: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  /** Elapsed-time clock in ms; must advance as `sleep` is awaited. */
  now: () => number;
}

/** What the probe learned about one page load. */
export interface PollResult {
  /** The last count observed. */
  count: number;
  /** True if the count stabilised (non-zero) before the timeout. */
  settled: boolean;
  elapsedMs: number;
  /** How many times `sample()` was called. */
  samples: number;
}

/**
 * Scroll-and-count until the distinct-card count holds steady for
 * `stableSamples` consecutive reads (settled) or `timeoutMs` elapses. An
 * all-zero run that times out is the "invisible tab renders nothing" answer to
 * question #1 — settled comes back false and the caller stops and writes it down.
 */
export async function pollUntilSettled(
  deps: PollDeps,
  opts: PollOptions,
): Promise<PollResult> {
  const start = deps.now();
  const recent: number[] = [];
  let count = 0;
  let samples = 0;

  for (;;) {
    count = await deps.sample();
    samples++;

    recent.push(count);
    if (recent.length > opts.stableSamples) recent.shift();

    const stable =
      recent.length === opts.stableSamples &&
      count > 0 &&
      recent.every((c) => c === count);
    if (stable) {
      return { count, settled: true, elapsedMs: deps.now() - start, samples };
    }

    if (deps.now() - start >= opts.timeoutMs) {
      return { count, settled: false, elapsedMs: deps.now() - start, samples };
    }

    await deps.sleep(opts.intervalMs);
  }
}
