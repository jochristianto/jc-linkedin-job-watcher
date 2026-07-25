# LJW Probe — issue #5 (04)

> **Does a tab you can't see actually load the job list?**
>
> **Answered on 2026-07-24: no.** The same search page rendered **25 of 25**
> postings in a visible tab and **7 of 25** in a hidden one. Chrome gives a tab
> you cannot see no animation frames and heavily throttled timers, and LinkedIn's
> results column needs both — the missing rows were never painted, so no parser
> could have read them. The product now scans in a real, on-screen window tucked
> into the corner of the screen: **[prd.md §18](../prd.md)** records the decision
> and what it costs.
>
> **Spike, not the product.** This folder is the issue #5 measurement rig, kept
> because the question comes back every time someone suggests hiding the scan
> again. It is **not** part of the build: `vite.config.ts` (ticket 01) never lists
> it as an input, so `npm run build` emits only the real extension into `dist/`.
> Load the product from `dist/`; load *this* folder directly only to re-measure.

The smallest possible MV3 extension that answers the load-bearing assumption of
PRD §9: an alarm opens a background tab (`active: false`), injects a script,
scrolls the lazy results column, counts the job cards, `console.log`s the count,
and closes the tab — without the tab ever being looked at.

Nothing from the product's feature set. No storage, no dedupe across runs, no
field scraping, no notifications. Just the mechanism.

## What's here

| File               | Role                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `manifest.json`    | MV3, module service worker, `alarms`/`scripting`/`tabs` + linkedin host |
| `background.js`    | one alarm → open invisible tab → inject → read count → close; logs all  |
| `content-probe.js` | scroll-and-count the results list until settled; `console.log` count    |

The card-identity and settle-polling logic is transcribed from the tested
`src/scan-probe.ts` (`npm test`). `content-probe.js` is a classic injected
script and can't import it — keep the two in sync.

## How to run it (human, logged in)

An agent can't do this part: it needs a real Chrome logged into LinkedIn.

1. Edit `PROBE_URL` at the top of `background.js` — paste one of your logged-in
   job-search URLs (append `&sortBy=DD`, per issue #2).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   `extension/` folder.
3. Open the service-worker console: on the extension card, click
   **service worker**. Everything the probe observes prints there with `[LJW]`.
4. Watch a few cycles (the alarm fires every minute). Each cycle logs the card
   count, whether it settled, and the timing of each leg.

## The questions, and what they answered

The two that changed the product:

- **Q1 — renders at all?** **No, not reliably.** A hidden tab settled at **7 of
  25** cards where a visible one read **25 of 25**. Scrolling does not help: the
  rows are never painted, so there is nothing to scroll to. This is what
  [prd.md §18](../prd.md) is written on.
- **Q8 — missed alarm on relaunch?** **Yes, Chromium fires it immediately.** So
  PRD §9's original unconditional `onStartup` catch-up scan *plus* the replayed
  alarm would have double-run. Replaced by a consumable `pendingCatchUp` flag
  (§17, decision 5).

The rest below stand as written, for anyone re-running the rig. Read them off the
`[LJW]` console log across several cycles:

1. **Renders at all?** Does a cycle log `SETTLED: N distinct cards`, and does
   `N` match what #2 counted by hand? If it logs `NOT SETTLED` / `0`, that's the
   headline finding — **stop and write it down** (the fallback options get
   charted from here).
2. **How long?** The `inject+settle` timing, and the `scroll-samples` count —
   is there a settled DOM or does it only work because we poll?
3. **Scrolling?** Compare the count with scrolling on vs. commenting out the
   `scroller.scrollTop` line — does the invisible tab need it, and can a script
   scroll a tab nobody is looking at?
4. **Backgrounded window** — repeat with the whole Chrome window minimised or
   behind another app (throttled harder than a background tab). Same counts?
5. **Timing** — total ms per cycle. Does the 60–90 s estimate for two watches ×
   two pages hold once you multiply up?
6. **The worker** — does the same worker instance survive a whole cycle, or does
   `+Ns after worker boot` reset (teardown mid-scan)? Observe, don't assume.
7. **Does LinkedIn notice?** — over a handful of consecutive loads, any challenge
   page, redirect, or empty result that smells like rate-limiting.
8. **Missed alarm on relaunch?** Quit Chrome entirely, wait past one minute,
   relaunch. If `onAlarm` fires within ~1 s of the `onStartup` line, Chromium
   fires missed alarms immediately → PRD §9's unconditional catch-up scan would
   double-run and must be rewritten (this confirms issue #3's Chromium-source
   finding).
