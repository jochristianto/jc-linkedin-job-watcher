# LinkedIn Job Watcher

A personal Chrome extension (MV3) that watches your saved LinkedIn job searches on a background alarm and tells you about **genuinely new** postings — a badge count, one merged desktop notification per scan, and optionally a Telegram message on your phone.

It reads the page while you're logged in, in your own browser, in a small window that opens for a few seconds and closes itself. Notifications lead into the extension's **own** list view, never straight to LinkedIn — you pick what to open from there.

> **Heads up:** scraping is against LinkedIn's ToS. Personal single-user use in your own logged-in browser is low-risk in practice, but the risk isn't zero — account restriction is the realistic worst case. Keep the scan depth low (the shipped defaults already do).

---

## Requirements

| | |
|---|---|
| **Node.js** | `v24.18.0` (see [.nvmrc](.nvmrc)) — needs ≥ 22.6 for `--experimental-strip-types` |
| **Chrome** | Any current Chrome/Chromium with Manifest V3 |
| **LinkedIn** | You must be **signed in** to LinkedIn in the same Chrome profile |

---

## Install (5 minutes)

### 1. Build the extension

```bash
nvm use            # optional, picks up .nvmrc
npm install
npm run build
```

**No `.env` is required to build** — or to install, run, or receive notifications. The build reads no environment variables at all. (A `.env` is used by exactly one optional dev script; see [Testing the push from the terminal](#testing-the-push-from-the-terminal-env).)

This produces a loadable, unpacked extension in `dist/`:

```text
dist/
├── manifest.json
├── background.js      # MV3 service worker (the scan loop)
├── content.js         # page reader, injected into linkedin.com
├── popup.html         # toolbar popup — the list view
├── jobs.html          # same list view, full tab
├── options.html       # settings
├── assets/
└── icons/
```

### 2. Load it into Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the **`dist/`** folder — not the repo root

Pin the extension to your toolbar so you can see the badge.

> Load `dist/`, never the repo root. The [extension/](extension/) folder is an unrelated spike (issue #5) and is deliberately excluded from the build.

### 3. Add your first search

1. On LinkedIn, run a job search with all your filters applied.
2. **Sort by "Most recent"** — this matters. The defaults scan only page 1, which assumes newest-first ordering. Sorting by date puts `sortBy=DD` in the URL.
3. Copy the full URL from the address bar.
4. Right-click the extension icon → **Options** (or click the gear in the popup).
5. Under **Searches**, give it a nickname (e.g. "Indonesia") and paste the URL → **Add**.
6. Click **Save settings** at the bottom. *Nothing is stored until you save.*

The first scan fires on the next alarm tick — or immediately, if you open the popup and click **Scan now**. Any URL that works in your browser works here — the query string (keywords, filters, `sortBy=DD`) is preserved verbatim; only `&start=` is rewritten for pagination.

---

## Daily use

**Badge on the toolbar icon** — how many jobs you haven't dealt with yet. Opening a job doesn't change it; marking it read does.

| Badge | Meaning |
|---|---|
| Slate number | Unread count (`99+` past 99) |
| Amber | Soft warning — layout may have changed, or scans have gone stale |
| Red `!` | Hard failure — signed out of LinkedIn, or a verification challenge |

**Click the icon** → the popup list (380px, opens on **New**).
**Click a notification** → the same list as a full tab (720px, opens on **All**). An already-open jobs tab is focused rather than duplicated.

In both views:

- **Click a job** → opens the posting in a new tab and **highlights the row**, which stays in the list. Nothing disappears because you looked at it. Cmd/Ctrl/middle-click opens it in the background.
- **The tick on a row** → marks that one job read: the row greys out, drops out of **New**, and the badge falls by one. This is the only thing that clears a job. Press it again (it flips to an undo arrow) to bring the job back.
- **Block on a row** → adds that job's company to your blocklist, without a trip to Options. Future scans stop surfacing it. Jobs from that company already in your list stay on screen, greyed and tagged **Blocked**, and stop counting towards the badge. It asks first: the button reads **Sure?** after one press and only blocks on the second — click anywhere else, or wait five seconds, and the question goes away. The button then reads **Unblock**, which takes just the one press.
- **Scan now** runs a cycle immediately, ignoring the interval and quiet hours. It flips to *Scanning…* (greyed out, with the status bar below it saying the same) **the moment you press it** — not when the background gets round to answering, which can take a second or two if Chrome had put the extension to sleep. The list repaints on its own when the cycle finishes. After a manual scan the next automatic one is a full interval away, not stacked minutes behind. When a verification challenge has halted scanning, the same button turns red and reads **Resume** — that is how you clear the halt.
- **The status bar** along the bottom says what the loop is doing: *Scanning for new jobs…* with a spinning icon while a cycle is running, otherwise a live countdown to the next one (*Next scan in 4m 12s*). Inside quiet hours it says so, which is why that number is hours rather than minutes. It reads the armed alarm itself, so it can't drift from the real schedule — and with no search enabled there is nothing to scan, so the bar disappears entirely.
- **Watch chips** filter the list to one search. The badge still counts across all of them.
- **New ⇄ All** toggles between unread-only and everything.
- **Mark all as read** clears the badge and empties New in one action.
- **Open as a full page** (the arrow icon, popup only) moves the list you're looking at into a 720px tab — the popup is a small panel that closes the moment you click anything outside it, which is the wrong place to read a long list. Your chip and mode come with you, and an already-open jobs tab is focused rather than duplicated.
- Your last chip + mode are remembered, so reopening the popup lands you where you left off.

A row therefore has three looks: plain (untouched), highlighted with a blue bar (you opened it), and greyed (you read it, or blocked its company).

---

## Options reference

### How this works
A collapsed explainer at the top of the page: what a scan round actually does, in plain English, plus the things worth knowing before you trust a background scraper (nothing runs while Chrome is closed, it slows itself down when nothing turns up, the ToS caveat). Click the row to open it; it links back here for the rest.

### Searches
Add, edit, remove, and individually enable/disable saved searches. Enabled searches all run on the same cycle, strictly one after another — never in parallel.

### Filters
- **Blocked companies** — matched case-insensitively; normalised once when saved. The **Block** button on any job row adds and removes entries here too
- **Blocked title keywords** — e.g. "Intern", "Senior"
- **Hide reposted** — drop anything LinkedIn marks as "Reposted"

Filtered jobs are still recorded as seen, so they never resurface later.

### Scanning

| Setting | Default | What it does |
|---|---|---|
| Interval | `5` min | Base time between scans |
| Jitter | `±1` min | Randomised onto each interval so traffic isn't a fixed heartbeat |
| Pages per scan | `1` | Routine depth. Page 2 is mostly stale when sorted by date |
| Catch-up pages | `4` | Deeper scan after a browser restart or when quiet hours end |
| Quiet hours | `23:00–07:00` | Scanning pauses overnight; resuming triggers a catch-up scan |

At the defaults that's roughly **192 page loads a day per search**. Raise the depth only if you find you're actually missing things.

There's also automatic back-off: after **3** consecutive empty scans, the interval stretches out toward a 60-minute ceiling; one scan that finds something resets it.

### Telegram push
Optional, and *additive* to the desktop notification — never a replacement. See below.

### Retention
How long records are kept: seen IDs `15` days, jobs you've opened or read `7` days, untouched jobs `30` days, seen hard cap `50,000`. **Not yet enforced** — see [Known limitations](#known-limitations).

> **Save settings** writes your changes. **Reset** reverts the form to the last-saved values — it is not a factory reset.

---

## Telegram push (optional)

Get new jobs on your phone.

1. **Create a bot** — message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow the prompts. It hands you a token like `123456:ABC-DEF…`.
2. **Get your chat id** — message your new bot once (say anything), then open:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
   Read `result[0].message.chat.id` out of the JSON.
3. In **Options → Telegram push**, tick **Send new jobs to Telegram**, paste both values, and click **Send test message**. Success or failure is reported inline.
4. **Check it on your phone**, not just desktop Telegram — confirm the links are tappable and the layout reads well.
5. Click **Save settings**.

Credentials live only in this browser's extension storage. They are never committed.

Push failures can never break a scan — `sendPush` swallows them. Three consecutive failures raise a soft warning on the options page and in the list view.

### Testing the push from the terminal (`.env`)

Optional, and only useful while developing. `npm run send-test-message` sends a real Telegram message using the **exact** production format from [src/push.ts](src/push.ts), so you can check how it looks on your phone without waiting for a scan or even loading the extension.

It needs the same two credentials. Set them up once:

```bash
cp .env.example .env
```

Then open `.env` and fill in the two values from steps 1–2 above:

```ini
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

Now run it as often as you like:

```bash
npm run send-test-message
```

**`.env` is gitignored** — it never gets committed. It's also entirely optional; the script loads it via `--env-file-if-exists`, so with no `.env` at all it runs fine and you can pass the values inline instead:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=987654321 npm run send-test-message
```

By default that `.env` feeds **only** this terminal script. The running extension reads what you saved in **Options → Telegram push** — a separate copy. If you'd rather not enter the credentials twice, see below.

### Pre-filling Options from `.env` (`npm run build:dev`)

The Options page runs inside Chrome and can't read a file on your disk, so the only way to get `.env` values into it is for the **build to paste them into the code**. That leaves your token in `dist/` as plain text — fine locally, not fine for anything you share. So it's a separate command:

```bash
npm run build       # normal — dist/ contains NO credentials
npm run build:dev   # dev only — bakes .env into dist/ as Options defaults
```

`build:dev` prints a warning every time, so a dev build is never mistaken for a clean one:

```text
⚠  DEV BUILD — your Telegram credentials from .env are embedded in dist/ as plain text.
   Do not share, zip or publish this dist/. Run `npm run build` for a clean one.
```

Reload the extension and the two Telegram fields arrive filled in, with a notice in the card. **Press Save settings** — the prefill populates the form, it doesn't write to storage on its own.

Rules it follows:

- **A saved credential always wins.** The prefill only fills fields you've left blank, so rebuilding can never overwrite a token you typed by hand.
- **Nothing is saved automatically.** You still press Save; a build-time value never silently becomes stored state.
- **`npm run build` is unconditionally clean.** It doesn't check whether `.env` exists — production mode always compiles the constant to `null`, so the default build has no path to a leak.

> You do **not** need any of this. `.env` and `build:dev` are optional convenience for Telegram only. You never need them to build, install, or run the extension, or to get desktop notifications — `notifications` is a Chrome permission, not a credential.
>
> Also worth knowing: you'd normally type the token into Options **once, ever**. Those settings live in `chrome.storage.local` and survive rebuilds, extension reloads and Chrome restarts — only a full **Remove** clears them.

---

## How scanning works

```text
alarm fires
  └─ recover any stale lock, sweep orphaned tabs
  └─ open ONE scan window (unfocused, tucked in the corner)
  └─ for each enabled watch, in order:
       └─ for each page (1..depth):
            navigate the scan window to the page
            → content script walks the lazy list, parses cards as they render
            → [+ randomised 3–5s pause]
            → a partial read retries once, with focus
       [+ randomised 8–12s pause between watches]
  └─ close the scan window
  └─ merge every watch's results → ONE dedupe pass
  └─ save → update badge → one notification → Telegram push
  └─ re-arm the next one-shot alarm
```

A few things worth knowing:

- **One notification per cycle**, not per watch. A role surfacing under two searches notifies once.
- **Opened state survives re-scans** — reopening a search never re-inflates the badge.
- **Your own LinkedIn tabs are never scraped.** Each scan window is stamped with a one-time token; the content script refuses to read any page that doesn't carry a matching one.
- **The scan window is visible, and that is deliberate.** It used to be a hidden tab, which was never verified and turns out not to work: Chrome gives a tab you can't see no animation frames and throttled timers, so LinkedIn's results column never finishes drawing. Measured on the same page, a visible tab rendered 25 of 25 postings and a hidden one 7 of 25 — the missing postings were never on screen to be read. Since it has to be seen, it's made as small a thing to see as possible: one unfocused window per *scan* rather than per page, tucked into the corner of whichever screen your browser is on, and always closed afterwards even if parsing throws.
- **It only takes focus as a last resort.** Chrome also throttles a window it considers fully covered, so if a scan comes back short it retries that page once with the window focused, then hands focus straight back to where you were.
- **A short read tells you.** If a page yields far fewer postings than it advertised, the badge turns amber and the popup says so, rather than a partial scan passing as a quiet day.
- **Nothing runs while Chrome is closed.** This is a hard platform limit — extensions have no background process independent of the browser. On relaunch, a catch-up-depth scan runs exactly once.

### Permissions, and why

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Settings, seen IDs, job records |
| `alarms` | The scan cadence — survives service-worker teardown |
| `notifications` | New-job and health alerts |
| `tabs`, `scripting` | Open/close the scan window and message it |
| `https://www.linkedin.com/*` | The pages being read |
| `https://api.telegram.org/*` | Telegram push (only used if you enable it) |

No data leaves your browser except the Telegram message you explicitly configure.

---

## Troubleshooting

**Badge shows a red `!`**
Open the popup — a one-line banner says which it is:

- *"Signed out of LinkedIn — scanning paused."* Sign back in; scanning resumes automatically on the next tick.
- *"LinkedIn asked for verification — scanning stopped."* Open LinkedIn and clear the challenge, then click **Resume** in the popup header — nothing else clears this state, because a halted extension never runs the successful scan that would clear it on its own. If the challenge is still there, the next cycle simply halts again.

**Badge is amber**
Either the parser found no results list (LinkedIn may have changed its layout — check `chrome://extensions` → *service worker* → Console for a `[ljw]` selector-drift warning), or scans have gone stale.

**Nothing ever gets scanned**
Click **Scan now** in the popup first — it bypasses the interval and quiet hours, so it tells you straight away whether the problem is the schedule or the scan itself. If that finds nothing either, check, in order: at least one search is **enabled**; you're signed in to LinkedIn in this profile; and the alarm exists — `chrome://extensions` → *service worker* → Console → `await chrome.alarms.getAll()`.

Note the default quiet hours are **23:00–07:00**, so an extension installed late at night genuinely won't scan until morning. That's the schedule working, not a fault.

**Watching a scan happen**
`chrome://extensions` → **service worker** under this extension opens the background DevTools. All scan logging lands there.

**`npm run build` fails with `Cannot find module '@rollup/rollup-darwin-arm64'`**
A known npm bug with optional platform dependencies. Fix with:

```bash
rm -rf node_modules package-lock.json && npm install
# or, without touching the lockfile:
npm install @rollup/rollup-darwin-arm64 --no-save
```

**After changing code:** re-run `npm run build`, then hit **Reload** (⟳) on the extension card in `chrome://extensions`.

---

## Known limitations

These are real gaps in the current build, not misconfiguration:

1. **Retention is not enforced yet.** The garbage-collection logic exists and is tested ([src/gc.ts](src/gc.ts)), but nothing calls it in production — there's no daily GC alarm wired into the service worker. The Retention settings are saved but currently have no effect, so `seen` and `jobs` grow without bound. `unlimitedStorage` means this won't break anything soon.

---

## Development

```bash
npm install
npm test          # 300 unit tests, node's test runner via tsx, no browser needed
npm run typecheck # tsc --noEmit
npm run build     # → dist/, never contains credentials
npm run build:dev # → dist/ with .env baked in as Options defaults (local only)
npm run build:mockups # regenerate mockups/*.html from the real components
```

No environment setup is needed for any of the above. The one optional extra is `cp .env.example .env`, which enables `npm run send-test-message` and `npm run build:dev` — see [Pre-filling Options from `.env`](#pre-filling-options-from-env-npm-run-builddev).

The architecture rule (PRD §14): **every decision lives in a pure, tested module; the `chrome.*` wrappers hold no logic and are not unit-tested.**

| | |
|---|---|
| **Pure & tested** | [parse.ts](src/parse.ts) · [filter.ts](src/filter.ts) · [dedupe.ts](src/dedupe.ts) · [schedule.ts](src/schedule.ts) · [health.ts](src/health.ts) · [lifecycle.ts](src/lifecycle.ts) · [scan.ts](src/scan.ts) · [view.ts](src/view.ts) · [view-model.ts](src/view-model.ts) · [gc.ts](src/gc.ts) · [options-form.ts](src/options-form.ts) · [push.ts](src/push.ts) |
| **Side-effect wrappers** | [background.ts](src/background.ts) · [content.ts](src/content.ts) · [storage.ts](src/storage.ts) · [jobs-tab.ts](src/jobs-tab.ts) · [components/](src/components/) · [hooks/](src/hooks/) |

Two Vite builds run in sequence: [vite.config.ts](vite.config.ts) emits the service worker + three HTML pages, then [vite.content.config.ts](vite.content.config.ts) appends `content.js` as an IIFE — an MV3 content script can't be an ES module.

### UI stack

**React 19 + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com).** The pages mount
React components; the registry components live unmodified in
[src/components/ui/](src/components/ui/) so `npx shadcn add` can be re-run over
them, and app styling goes in the components that use them.

The §14 rule holds across the change: `selectView` in [view.ts](src/view.ts)
decides *everything* the list view shows — badge count, which empty state, which
banners, the scan status — as plain data, and the components only map that to
JSX. That is why the suite stayed at ~300 tests without needing a DOM: component
tests render to a string with `react-dom/server`, and the assembly logic is
asserted on values.

Two notes for anyone editing the styles:

- Tailwind is configured **in CSS** ([src/tokens.css](src/tokens.css)), not a JS
  config — there is no `tailwind.config.js` to look for. The palette is this
  project's own (warm grey page, LinkedIn blue) in OKLCH, under shadcn's
  semantic names. `--primary` is the brand blue; `--accent` is shadcn's *subtle
  tint* role, not the brand.
- Dark mode still follows the OS with **zero JS**. shadcn ships `dark:` as a
  `.dark` class variant that needs a toggle, so `@custom-variant dark` re-binds
  it to `prefers-color-scheme`.

The cost of the stack, stated plainly: the popup's JS went from ~13 kB to
~320 kB (~100 kB gzipped). What it buys is one consistent, accessible component
set — focus rings, keyboard behaviour and ARIA come from Radix rather than from
remembering to add them.

The full specification is [prd.md](prd.md); UI mockups live in
[mockups/](mockups/) and are **generated** from the real components by
`npm run build:mockups`.
