# PRD: LinkedIn Job Watcher (Chrome Extension)

## 1. The core problem first

LinkedIn actively blocks scraping. Their official API doesn't give you job search access. So the only approach that works reliably is a **Chrome extension** that reads the page while you're logged in — it looks like normal browsing because it is.

A desktop app would need to store your LinkedIn cookies and mimic a browser, which gets your account flagged or banned. Skip that.

---

## 2. What it does

You save one or more LinkedIn job search URLs, each with your filters already applied. On a schedule the extension quietly loads each one in a background tab, reads the job cards across the configured number of pages, compares against what it has seen before, and tells you about anything new.

New jobs surface in two places: a badge count on the extension icon, and a desktop notification. Both lead into the extension's own list view — never straight to LinkedIn. You pick what to open from there.

---

## 3. Features

### Watchlist

- Multiple saved searches, each with its own URL and nickname (e.g. "Indonesia", "Japan")
- Toggle each one on/off individually
- All enabled searches run on the same cycle, one after another

### Scanning

- Configurable interval, default **5 minutes**, with **±1 minute jitter** (§15)
- Configurable page depth, default **1 page** per search — page 2 is mostly stale when sorted by date; the startup / quiet-hours catch-up scan (default 4 pages) recovers anything that drifted deeper during a gap (§15)
- Pagination uses LinkedIn's `&start=` parameter (page 2 = `start=25`, page 3 = `start=50`)
- Pages scraped sequentially with a short randomised pause between, never in parallel
- **Quiet hours**: scanning pauses overnight (default 23:00–07:00 local), configurable; resuming runs a catch-up scan (§15)

### Filtering

- Blocklist of company names (exact or partial match)
- Hide anything marked "Reposted"
- Optional keyword blocklist in job titles (e.g. "Senior", "Intern")

### Notifications

- Desktop notification when a cycle finds new jobs
- One merged notification per cycle, not one per search
- Clicking the notification opens the extension's list view, **not** LinkedIn
- The notification click marks nothing as opened — it only gets you to the list
- Optional Telegram push so results reach your phone when you're away from the machine

### List view

- Shows unopened jobs, newest first: title, company, location, posted time, source watch
- Badge on the extension icon shows unopened count
- Click a job → opens it in a new tab and marks it opened in the same action
- Filter chips to show only one watch's results
- Toggle between "New" and "All"
- "Mark all as read"
- Middle-click / ctrl-click opens in a background tab so you can queue several

### Storage

- Seen job IDs kept locally so you don't get duplicate alerts
- Auto-prune anything older than ~30 days

---

## 4. Architecture

```
manifest.json (MV3)
│
├── background (service worker)
│   ├── chrome.alarms → fires every N minutes
│   ├── checks isScanning lock → skips if a cycle is still running
│   ├── for each enabled watch, sequentially:
│   │     open hidden tab → inject content script → scrape → next page → close
│   ├── merges results across all watches → filters → dedupes
│   ├── fires one notification
│   └── updates badge count
│
├── content script
│   └── reads DOM, extracts job cards, verifies injection token, sends to background
│
├── list view (shared component, mounted twice)
│   ├── popup.html   — toolbar icon click, quick glance
│   └── jobs.html    — notification click, full tab
│
└── options page
    ├── manage watchlist URLs
    ├── manage blocklists
    └── interval + page depth settings
```

**Stack:** TypeScript + **plain Vite, no extension plugin** (`@crxjs/vite-plugin` is maintained but its content-script handling — this project's most load-bearing surface — is its weakest; issue #4 / ticket 03). Chrome API typings come from **`@types/chrome`**, not `chrome-types` (the latter types `storage.get` as `any`; same ticket). Pure logic is unit-tested with `node --test --experimental-strip-types`, which needs no bundler (§14). Permissions (§10) stand unchanged.

---

## 5. Data shape

```ts
type Job = {
  id: string; // LinkedIn's job ID from the URL
  title: string;
  company: string;
  location: string;
  isReposted: boolean;
  postedText: string; // "2 hours ago"
  url: string;
  foundAt: number;
  watchId: string; // which saved search surfaced it
  opened: boolean;
  openedAt: number | null;
};

type Watch = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
};

type BlockedCompany = {
  display: string; // "Acme Corp" — what the options UI shows
  normalized: string; // "acme corp" — what matching uses
};

type Settings = {
  watches: Watch[];
  blockedCompanies: BlockedCompany[];
  blockedTitleKeywords: string[];
  hideReposted: boolean;
  intervalMinutes: number; // default 5
  jitterMinutes: number; // default 1 — ±this, randomised onto each interval (§15)
  pagesPerScan: number; // default 1 — routine depth (§15); page 2 is mostly stale
  catchUpPages: number; // default 4, used on startup and quiet-hours resume (§9/§15)
  quietHours: QuietHours;
  pacing: PacingConfig;
  backoff: BackoffConfig;
  retention: RetentionConfig;
  push: PushConfig;
  staleLockMs: number; // default 300_000 (5 min) — lock older than this is stale (§16)
  pushFailWarnThreshold: number; // default 3 — consecutive push failures before warning (§16)
};

type QuietHours = {
  enabled: boolean; // default true
  startMinute: number; // local minutes-of-day, default 1380 (23:00)
  endMinute: number; // local minutes-of-day, default 420 (07:00)
};

type PacingConfig = {
  pagePauseMs: [number, number]; // default [3000, 5000] — pause between pages (§9)
  watchPauseMs: [number, number]; // default [8000, 12000] — pause between watches
};

type BackoffConfig = {
  emptyScansBeforeBackoff: number; // default 3 — consecutive all-empty scans (§15)
  maxIntervalMinutes: number; // default 60 — ceiling the doubling interval hits
};

type PushConfig = {
  enabled: boolean;
  botToken: string;
  chatId: string;
};

type RetentionConfig = {
  seenDays: number; // default 15
  openedJobDays: number; // default 7
  unopenedJobDays: number; // default 30
  seenHardCap: number; // default 50_000
};

type ScanState = {
  isScanning: boolean;
  startedAt: number | null;
  openTabIds: number[]; // tabs the live cycle has open, for orphan cleanup (§17.2)
  pendingCatchUp: boolean; // next scan runs at catchUpPages depth (§17.5)
};

// Health / failure state — persisted so the popup, badge and notifications all
// read one source of truth (§16). Produced by the pure reducer in src/health.ts.
type HealthState = {
  mode: "active" | "paused" | "halted"; // paused = logged out, halted = challenge
  severity: "ok" | "warn" | "error"; // badge colour: default / amber / red
  consecutiveEmptyScans: number; // shared with the §15 back-off counter
  consecutivePushFailures: number; // §16.7 — silent-per-call, warns after a run
  message: string | null; // popup banner text, null when healthy
};
```

**Dedupe on the job ID alone**, not on `watchId + id`. A remote role can appear in both the Indonesia and Japan searches — keying on the pair would notify you twice for the same posting.

**Never key on title + company.** The same employer can post a genuinely new opening with an identical title. LinkedIn's job ID is the only reliable identity.

---

## 6. Storage

### Which API

`chrome.storage.local`, not `sync`.

`sync` caps at ~100KB total and 8KB per item, with write rate limits — you'd blow past that within weeks. `local` gives 10MB by default, unlimited with the `unlimitedStorage` permission. Add it; costs nothing.

### Layout

Separate top-level keys, so a write to one doesn't rewrite everything else:

```ts
'settings'    → Settings
'seen'        → Record<string, number>   // jobId → firstSeenAt (ms)
'jobs'        → Record<string, Job>      // jobId → full record
'scanState'   → ScanState
'health'      → HealthState              // last failure/health snapshot (§16)
```

`seen` is deliberately separate from `jobs`. During a scan the only question is "have I seen this ID before" — loading full job objects to answer that is wasteful, and it's the operation running every 5 minutes.

### Two different lifetimes

| Key    | Holds          | Purpose               | Size                                     |
| ------ | -------------- | --------------------- | ---------------------------------------- |
| `seen` | ID → timestamp | Prevents re-notifying | ~10 chars per entry; 10k entries ≈ 300KB |
| `jobs` | Full records   | Feeds the list view   | Only for jobs still worth displaying     |

Once a job has been opened and some time has passed, drop its full record but keep the `seen` entry. You don't need the title and company of something clicked three weeks ago — only the memory not to alert on it again. This split is what keeps storage from growing unbounded.

### Seen means evaluated, not shown

A job filtered out by a company blocklist or the reposted rule **still gets added to `seen`**. Otherwise every scan rediscovers it, refilters it, and repeats that work forever.

### Company blocklist matching

Normalize on write, not on read — otherwise you lowercase the entire list on every scan. Match with `includes()` against a lowercased company name, so "acme" catches both "Acme Corp" and "PT Acme Indonesia".

### Reposted

Not a separate bucket. It's a boolean on the job, and the decision happens at scan time:

```ts
if (settings.hideReposted && job.isReposted) continue; // but still mark seen
```

---

## 7. Garbage collection

Runs on its own daily alarm, never on the scan path.

```ts
const DAY = 86_400_000;

async function collectGarbage() {
  const now = Date.now();
  const { seen, jobs, settings } = await chrome.storage.local.get([
    "seen",
    "jobs",
    "settings",
  ]);
  const r = settings.retention;

  // Full records: shorter life once opened
  const keptJobs: Record<string, Job> = {};
  for (const [id, job] of Object.entries(jobs)) {
    const limit = (job.opened ? r.openedJobDays : r.unopenedJobDays) * DAY;
    if (now - job.foundAt < limit) keptJobs[id] = job;
  }

  // Seen IDs: the long-lived record
  let keptSeen = Object.entries(seen).filter(
    ([, ts]) => now - ts < r.seenDays * DAY,
  );

  // Backstop against a date bug silently defeating the age check
  if (keptSeen.length > r.seenHardCap) {
    keptSeen.sort((a, b) => b[1] - a[1]);
    keptSeen = keptSeen.slice(0, Math.floor(r.seenHardCap * 0.8));
  }

  await chrome.storage.local.set({
    seen: Object.fromEntries(keptSeen),
    jobs: keptJobs,
  });
}
```

### Retention defaults

| Setting           | Default | Reasoning                                                                                                                  |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `seenDays`        | 15      | A posting down for two weeks won't resurface in search results. If it somehow did, it'd be a genuinely new posting anyway. |
| `openedJobDays`   | 7       | You've already clicked it; the full record is dead weight.                                                                 |
| `unopenedJobDays` | 30      | Long gone from LinkedIn by then regardless.                                                                                |
| `seenHardCap`     | 50,000  | Trims to 40,000 when breached. Pure safety net.                                                                            |

All four are configurable from the options page.

### One caveat

`chrome.storage.local` has no partial updates — writing `seen` serializes and writes the whole object. At 10,000 entries that's fine, and it's exactly why GC runs on its own daily alarm rather than pruning inline during scans.

If it ever does get slow, IndexedDB is the upgrade path since it supports real key-range deletes. Not worth starting there — considerably more code for a problem you likely won't hit.

---

## 8. Push to phone (Telegram)

Desktop notifications only reach you at the machine. Push is a bolt-on at the end of the scan cycle — one HTTPS call after the new-jobs list is built — so you also get results when you're away.

**This does not cover Chrome being closed.** Nothing does; extensions have no background process independent of the browser. See §13 for how the gap is handled.

### Why Telegram

The Bot API is a plain HTTPS POST to `api.telegram.org`. No SDK, no OAuth flow, no server of your own. Nothing else comes close on effort.

### One-time setup (no code)

1. Message `@BotFather` on Telegram, send `/newbot`, follow the prompts → you get a bot token.
2. Send any message to your new bot.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` → find `"chat":{"id":...}`.

Token and chat ID go in the options page. Never hardcoded.

### Manifest change

```json
"host_permissions": [
  "https://www.linkedin.com/*",
  "https://api.telegram.org/*"
]
```

### Send function

```ts
async function sendPush(jobs: Job[], cfg: PushConfig): Promise<boolean> {
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId || jobs.length === 0) {
    return false;
  }

  const lines = jobs
    .slice(0, 10)
    .map(
      (j) =>
        `<a href="${j.url}">${escapeHtml(j.title)}</a>\n` +
        `${escapeHtml(j.company)} · ${escapeHtml(j.location)}`,
    );
  if (jobs.length > 10) lines.push(`<i>+${jobs.length - 10} more</i>`);

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text:
            `<b>${jobs.length} new job${jobs.length > 1 ? "s" : ""}</b>\n\n` +
            lines.join("\n\n"),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    return res.ok;
  } catch {
    return false; // never let push failure break the scan
  }
}
```

`escapeHtml` is required, not optional — job titles contain `&` and `<` often enough to break the message.

### Where it hooks in

```ts
if (newJobs.length > 0) {
  await persistJobs(newJobs);
  await updateBadge();
  fireDesktopNotification(newJobs);
  await sendPush(newJobs, settings.push); // additive, not a replacement
}
```

Desktop notification and push both fire. They serve different moments — one for when you're at the machine, one for when you're not.

### Constraints and failure modes

| Issue                      | Handling                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4096-char message cap      | `slice(0, 10)` covers it. Chunk with a delay between if you'd rather send everything.                                                                                                                        |
| Push failure               | Caught and swallowed. Offline phone or Telegram outage must not stop the scan or the badge update.                                                                                                           |
| Token is a real credential | Anyone holding it can post as your bot. Lives in `chrome.storage.local`, readable by anything with access to the Chrome profile. Fine for a personal tool — don't commit it; revoke via BotFather if leaked. |
| Rate limits                | ~30 messages/second allowed. Irrelevant at one message per 5 minutes.                                                                                                                                        |

### Options page: "Send test message"

Silent push failure is the most likely thing to go wrong — a wrong chat ID produces no error you'd notice for days. A test button that reports success or failure inline removes that whole class of problem.

---

## 9. Key flows

### Scan cycle

```
Alarm fires
  → if isScanning, skip this tick and return
  → set isScanning = true
  → for each enabled watch, sequentially:
        for page 1..pagesPerScan:
            open background tab at url + &start=(page-1)*25
            inject content script with a one-time token
            scrape, send back, close tab
            pause ~3-5s
        pause ~10s between watches
  → merge all results
  → apply blocklists and reposted filter
  → drop anything already in the seen set
  → persist new jobs, update badge
  → if new jobs > 0, fire one notification
  → set isScanning = false
```

Two watches at two pages each takes roughly 60–90 seconds, comfortably inside a 5-minute window.

### Notification click

```ts
chrome.notifications.onClicked.addListener(async (id) => {
  const url = chrome.runtime.getURL("jobs.html");
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id!, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  chrome.notifications.clear(id);
});
```

Reusing the tab matters — otherwise a busy morning leaves you with six identical tabs.

> **Note:** `chrome.action.openPopup()` can't reliably be triggered from a notification click. That's why the notification opens a full-page tab instead of the popup. The list component is shared between the two, so this costs nothing.

### Job click

```ts
async function handleJobClick(job: Job, background = false) {
  await markOpened(job.id); // write first
  await updateBadge();
  chrome.tabs.create({ url: job.url, active: !background });
}
```

Write to storage **before** opening the tab. If the tab opens first and the popup closes, the write can get cut off mid-flight.

### Browser startup

`chrome.alarms` survive a browser restart. **A missed alarm fires immediately on relaunch** (confirmed against Chromium in #5 — the original PRD guess that it doesn't was wrong), which is exactly why the startup handler must *not* also run an inline catch-up scan: that would double-run. Instead it arms a catch-up flag and lets the alarm do the one scan (§17, decision 5).

```ts
chrome.runtime.onStartup.addListener(async () => {
  const state = await loadScanState();
  const { tabIdsToClose, state: swept } = recoverStaleLock(state, Date.now(), settings.staleLockMs);
  await Promise.all(tabIdsToClose.map((id) => chrome.tabs.remove(id).catch(() => {})));
  await saveScanState(requestCatchUp(swept)); // next scan runs at catchUpPages depth
  await ensureAlarmExists(); // re-arm the one-shot if it didn't survive
  // No inline scan — the alarm (replayed-missed or freshly armed) runs it once (§17.5).
});
```

`recoverStaleLock()` is essential and now runs on **every** alarm tick, not only startup (§16.6/§17): if Chrome was killed mid-scan, `isScanning` stays `true` and every future alarm skips forever. It clears any lock older than `staleLockMs` (~5 min) *and* closes the tabs the dead cycle orphaned (§17.2), and preserves the pending catch-up so the deep scan is never dropped.

The gap itself costs less than it appears. Dedupe is by job ID, not by "what changed since last check," so a restart scan reports everything unfamiliar regardless of when it appeared. You find out later, not never. What you can lose is anything pushed past your page depth during the gap — hence `catchUpPages` (default 4), used once on startup before reverting to the normal depth. **Quiet-hours resume is the same case** and reuses the same catch-up scan (§15): waking after an 8-hour quiet window is indistinguishable from waking after an 8-hour close.

> **Note on the alarm shape (§15, decision 3):** the interval is a **re-armed one-shot** alarm, not a periodic one — the cycle computes the next delay (interval ± jitter, or a jump to the end of quiet hours) and calls `chrome.alarms.create(name, { when })` at the end of each run. `chrome.alarms` can't express per-fire jitter on a periodic alarm and clamps periods below one minute (issue #3), so one-shot re-arming is what makes jitter and quiet hours possible. `ensureAlarmExists()` re-arms it if it didn't survive a restart.

### Injection guard

When a scan opens its own tab, it passes a one-time token to the injected script. The content script verifies the token before reading anything. This keeps it from acting on a LinkedIn tab you happen to have open yourself.

---

## 10. Permissions

```json
{
  "permissions": [
    "storage",
    "unlimitedStorage",
    "alarms",
    "notifications",
    "scripting",
    "tabs"
  ],
  "host_permissions": [
    "https://www.linkedin.com/*",
    "https://api.telegram.org/*"
  ]
}
```

---

## 11. Build order

1. **Scrape once, manually** — a content script that reads job cards from a LinkedIn search page you already have open. Prove the selectors work before anything else.
2. **Storage + dedupe** — save seen IDs, detect what's new.
3. **Single-watch scan loop** — alarm, background tab, one page, close.
4. **List view** — popup with badge count and mark-as-opened on click. Build it as a shared component from the start.
5. **Multi-watch + pagination** — sequential cycle, scan lock, injection token.
6. **Notifications** — merged per cycle, opening `jobs.html`.
7. **Options UI** — watchlist, blocklists, interval, page depth, retention.
8. **Garbage collection** — daily alarm, the two-lifetime prune, hard cap.
9. **Telegram push** — send function, options fields, test button.
10. **Startup handling** — keepalive around the cycle, stale-lock recovery + orphan-tab sweep on every tick, alarm recreate, catch-up *flag* (not an inline scan) so the replayed missed alarm doesn't double-run (§17).
11. **Polish** — filter chips, mark-all-read.

---

## 12. Risks you should know about

### Selectors will break

LinkedIn changes their DOM regularly, sometimes monthly. Write the scraper so each field fails independently, and log loudly when a selector returns nothing. Budget for ongoing maintenance.

### Request volume

Two pages every 5 minutes would be **576 page loads a day per watchlist entry** — over 1,100 for two searches. That was the number most likely to draw attention, so the shipped defaults cut it: **one page** per scan, **quiet hours** overnight, **±1 minute jitter**. See §15 for the full working; the short version is 288 loads/day/watch clock-round, ~192 with the default 8-hour quiet window — roughly a third of the original.

Page 2 is mostly stale. When sorted by date, new postings land on page 1; page 2 only helps if a burst pushed something down between checks, which at a 5-minute interval is uncommon — and the catch-up scan (§9, §15) covers the gap case where it isn't. Raise `pagesPerScan` only if you find you're actually missing things.

### Terms of Service

This is against LinkedIn's ToS. Personal single-user use in your own logged-in browser is low-risk in practice, but the risk isn't zero — account restriction is the realistic worst case.

### Background tabs and MV3

Manifest V3 service workers get killed after ~30 seconds idle (there is no longer a maximum *lifetime* — idleness, not age, is what kills them; issue #3). Use `chrome.alarms` to wake them rather than a bare `setInterval`, which will not survive a teardown. A scan cycle spanning 60–90 seconds keeps itself alive with a 25s keepalive ping — the Chrome-sanctioned pattern — and treats `isScanning` with a timestamp so a stale lock expires rather than blocking forever. §17 settles the full policy: **keepalive, not restartability** (a lost cycle costs one skipped scan; dedupe makes the re-scan lossless), orphaned tabs are swept on stale-lock recovery, and no per-page cursor is persisted.

---

## 13. Chrome closed: what is and is not covered

Nothing runs while Chrome is closed. No service worker, no alarms, no scanning. This is a hard platform limit — extensions have no background process independent of the browser, and no amount of extension code changes it.

What the design does instead:

| Scenario                              | Covered?                                             |
| ------------------------------------- | ---------------------------------------------------- |
| Away from the machine, Chrome running | **Yes** — Telegram push (§8)                         |
| Chrome minimized / in background      | **Yes** — alarms fire normally                       |
| Chrome fully closed                   | **No** — gap, then catch-up scan on next launch (§9) |

The gap is smaller in practice than it looks. Recruiters post during business hours, and an 11pm posting is still on page 1 at 8am. The startup catch-up scan at `catchUpPages` depth recovers anything that drifted deeper overnight.

### If you genuinely need coverage while Chrome is closed

That stops being an extension. Options, in ascending order of effort and risk:

1. **Don't close Chrome.** Set it to launch at login; run it minimized. Zero code, and the honest answer for most personal setups.
2. **Server-side scraping.** A VPS running headless Chrome with your session cookie. Works, but it's the setup most likely to get your account flagged — a datacenter IP on a fixed schedule looks exactly like what it is — and it means storing a live LinkedIn session on a server.

Option 2 is not recommended for this use case. The combination of Telegram push and keeping Chrome running gets you nearly all of the benefit with none of the account risk.

---

## 14. How the agent knows it hasn't broken anything

The extension is built mostly unattended by a coding agent. An agent with no way to check its own work will report success on code that never ran. This section fixes the checking mechanism and constrains how every build ticket below is written. (Resolves issue #7 / ticket 06.)

### The line: what is tested automatically

Every piece of **pure logic** — a function of its inputs, no `chrome.*`, no DOM, no network — is unit-tested and MUST pass before a ticket is called done. Concretely:

| Pure logic | Ticket | Reference / status |
| --- | --- | --- |
| Telegram HTML escaping + message build + `sendPush` (injectable `fetch`) | 09 | **Done** — `src/push.ts` + `src/push.test.ts` |
| Company + keyword blocklist matching, the reposted rule | 07 | **Reference example** — `src/filter.ts` + `src/filter.test.ts` |
| Dedupe against the seen set (dedupe on job ID alone, §5) | 02 | Same shape as `filter.ts` |
| Garbage collection — two lifetimes + hard cap (§7) | 08 | §7 is already pure; lift it verbatim into a `collectGarbage(state, now)` that takes `{seen, jobs, retention, now}` and returns `{seen, jobs}` |
| Scheduling — jitter, quiet hours, in-cycle pauses, back-off (§15) | 03/10 | **Reference example** — `src/schedule.ts` + `src/schedule.test.ts` |
| Failure diagnosis & surfacing — page classification, health reducer, stale-lock, push-fail, partial-parse (§16) | 08 | **Reference example** — `src/health.ts` + `src/health.test.ts` |
| Worker lifecycle — keepalive constant, catch-up flag, orphan-tab tracking, stale-lock recovery (§17) | 10 | **Reference example** — `src/lifecycle.ts` + `src/lifecycle.test.ts` |
| Card parser — DOM → `Job` | 01 | Fixture-driven, see below |

That is the line. Anything that is *only* an orchestration of `chrome.*` calls (opening tabs, firing alarms, setting the badge) is **not** unit-tested — see "the untestable remainder".

### The parser is testable — with fixtures, no network, no login

The card parser reads a `Document` and returns `Job[]`. Give it a `Document` parsed from **saved HTML** and it needs no browser and no LinkedIn session. Split it so the pure part takes a `Document` (or an `Element`), not the live page:

```ts
// pure — testable
export function parseJobCards(doc: Document): Job[] { ... }
// thin content-script wrapper — not unit-tested
parseJobCards(document);
```

- **Fixtures live in** `.scratch/linkedin-job-watcher/fixtures/page-1/` and `.../page-2/` — **gitignored** (a saved logged-in page carries profile chrome; it must never be committed, per `.gitignore` and issue #2).
- **A test loads a fixture with `node:fs` + a DOM parser** (`linkedom` or `jsdom`, dev-dependency only) and asserts the parsed IDs/fields. Because fixtures are gitignored, the parser test **skips cleanly (`test.skip`) when its fixture file is absent** so CI/other machines stay green; it runs wherever the human has captured the page.
- **Refreshing when LinkedIn changes:** re-capture the two pages into the same folders (issue #2 checklist), re-run `npm test`, update selectors until green. The failing parser test is the signal that LinkedIn moved the DOM (PRD §12).

### Test runner

**`node --test` with type-stripping** (`node --test --experimental-strip-types`), already wired as `npm test`. Vitest was the Vite-toolchain default, but the pure logic has no bundler dependency, so the zero-config Node runner is fewer moving parts (issue #4's bias). If the parser fixtures later need a heavier DOM setup, revisit — until then, don't add a second runner.

**`chrome.*` in tests:** the tested code contains **no `chrome.*`** — that is the whole point of the pure/side-effect split (below). So there is nothing to fake. `chrome.*` lives only in thin wrappers that the tests don't import. Do **not** stub `chrome` globally; if a function needs a stub, that function is on the wrong side of the line — refactor the pure part out.

### The untestable remainder — a human checklist at checkpoints

Background tabs opening, alarms firing on schedule, desktop notifications appearing, the badge count, notification-click focusing the tab, the startup catch-up scan: these need a human to look. They run **at checkpoints, not after every ticket** (most tickets touch only pure logic or one wrapper). The three checkpoints:

1. **After ticket 03 (single-watch scan loop):** load unpacked; confirm the alarm fires, a hidden tab opens and closes, and one page's jobs land in `chrome.storage.local`.
2. **After ticket 06 (notifications):** confirm a cycle with new jobs shows exactly one merged desktop notification, and clicking it opens `jobs.html` (reusing an existing tab, not spawning duplicates).
3. **After ticket 10 (startup handling):** quit Chrome mid-scan, relaunch; confirm the stale lock clears, any tabs the dead cycle left open are closed, the alarm is recreated, and **exactly one** catch-up scan runs (not two — §17.5).

Plus a Telegram phone check (ticket 09, `npm run send-test-message`). Each checkpoint ticket carries its exact steps in its "Done criteria".

### Done-criteria format — every build ticket carries both

Every build ticket MUST state, explicitly:

- **The command that must pass** — almost always `npm run typecheck && npm test`, plus any new test files the ticket adds.
- **The observable outcome** — for pure-logic tickets this is "the new tests pass"; for the checkpoint tickets above it is the human-check steps (what to click, what to see).

Both, not either. A ticket with only a passing command but no observable outcome can go green on code that never ran in Chrome; a ticket with only a human check can't be re-verified by the next agent that touches it.

### Structural consequence — the pure/side-effect split is mandated, not optional

Because the logic must be testable without Chrome, **the separation of pure functions from `chrome.*` calls is a PRD requirement, not left to the builder.** The rule:

- Pure decision logic goes in its own module (`filter.ts`, `dedupe.ts`, `gc.ts`, `parse.ts`) with **no `chrome.*` import** and an accompanying `*.test.ts`.
- `chrome.*` (and `fetch`, and the live `document`) lives in thin wrappers/entry points (`background.ts`, the content script) that call the pure modules. Dependencies that a test needs to control are **injected** (see `sendPush(jobs, cfg, fetchImpl = fetch)` in `src/push.ts`).
- `src/filter.ts` is the worked reference for this shape.

---

## 15. Cadence, depth, and going quiet

Resolves issue #8 / ticket 07. PRD §12 set the defaults at 576 page loads a day per watch and then hedged. This section turns that hedge into shipped numbers, informed by #5's cycle timing (two watches × two pages ≈ 60–90s, §9). The pure logic lives in `src/schedule.ts` (a §14 reference example); `chrome.alarms` and the scan loop are the thin wrappers that call it.

Seven decisions, seven answers:

1. **Interval — keep 5 minutes.** A recruiter posting is still on page 1 hours later (§13), so 10 or 15 minutes loses little in freshness; 5 stays as a comfortable default that a burst won't outrun, and it's configurable for anyone who wants to relax it. The volume worry is answered by page depth and quiet hours, not by slowing the beat.
2. **Page depth — default 1, not 2.** Page 2 is mostly stale when sorted by date (§12); the gap it guards against — a burst pushing a posting past page 1 between checks — is exactly what the catch-up scan (`catchUpPages`, default 4) recovers on startup and quiet-hours resume. So routine scans go shallow and the rare deep scan happens only when a real gap preceded it. One page halves the request volume for free.
3. **Jitter — ±1 minute, real but modest.** A fixed 5-minute heartbeat is a weak signal, not nothing; ±1 minute of jitter costs one line and removes a clean periodicity for no downside. It forces the **alarm shape**: a re-armed one-shot (`chrome.alarms.create(name, { when })` at the end of each cycle), because `chrome.alarms` can't jitter a periodic alarm and clamps periods under a minute (issue #3). `jitteredDelayMs()` is clamped to a 1-minute floor so a large jitter can never produce a sub-minute or negative delay.
4. **Quiet hours — yes, clock-based, default on.** Scanning pauses in a user-set local window, default 23:00–07:00. It's stored as minutes-of-day and may wrap midnight (`isWithinQuietHours` handles the wrap). At the boundary: when the next fire would land inside the window, the alarm is pushed to the window's end instead, and that first wake runs a **catch-up scan** at `catchUpPages` depth — a quiet gap is the same problem as a closed-Chrome gap (§9). Recruiters post in business hours, so the overnight gap costs almost nothing and cuts ~8h of loads.
5. **In-cycle pauses — keep, but randomise.** 3–5s between pages and ~8–12s between watches (PRD §9), drawn uniformly per pause via `randomPauseMs()` rather than a fixed value, same reasoning as the interval jitter.
6. **The stopping rule — back off *and* tell the user.** The back-off signal is `emptyScansBeforeBackoff` (default 3) consecutive scans returning **zero cards across every watch** — the signature of a broken parser or a soft block (§12). On trip, the extension doubles its own interval each further empty scan up to `maxIntervalMinutes` (default 60) *and* surfaces a "reading may be broken" warning (`shouldWarnStalled`). It recovers instantly: one non-empty scan resets the counter and the interval snaps back to base. It does both — self-throttle so it stops hammering, and tell the human so a genuine DOM break gets fixed rather than silently backed-off forever.
7. **Shipped defaults** (all configurable per §5):

| Setting | Default | Why |
| --- | --- | --- |
| `intervalMinutes` | 5 | Fresh enough; a burst won't outrun it (decision 1) |
| `jitterMinutes` | 1 | Breaks a clean 5-minute periodicity for one line (decision 3) |
| `pagesPerScan` | 1 | Page 2 mostly stale; catch-up covers the gap (decision 2) |
| `catchUpPages` | 4 | One deep scan on startup / quiet-hours resume (decisions 2, 4) |
| `quietHours` | on, 23:00–07:00 | Cuts ~8h of loads at near-zero freshness cost (decision 4) |
| `pacing.pagePauseMs` | [3000, 5000] | Randomised page pause (decision 5) |
| `pacing.watchPauseMs` | [8000, 12000] | Randomised watch pause (decision 5) |
| `backoff.emptyScansBeforeBackoff` | 3 | Trip the stopping rule after 3 empty scans (decision 6) |
| `backoff.maxIntervalMinutes` | 60 | Ceiling for the doubling interval (decision 6) |

**Resulting volume.** One page every 5 minutes is 288 loads/day/watch clock-round; the default 8-hour quiet window drops that to ~192 — roughly a third of PRD §12's original 576, before the user touches a single setting. Two watches sit near 384/day rather than 1,100+.

---

## 16. What happens when it breaks, and how do you find out?

Resolves issue #9 / ticket 08. The PRD describes the happy path in detail and §12 says "log loudly," but for a tool that runs unattended every few minutes, **silence is indistinguishable from "no new jobs."** The failure mode this section exists to prevent is the extension quietly stopping for weeks. Each failure below gets a decided *behaviour* and a decided *signal*. The pure logic lives in `src/health.ts` (a §14 reference example); `background.ts` and the content script are the thin wrappers that feed it signals and act on the returned `HealthState`.

The unifying idea: the content script never reports a bare "0 cards." It reports a **classified page outcome** (`classifyPage`), and the cycle's outcomes collapse to the single worst one (`aggregateOutcome`) which a pure reducer (`reduceScanHealth`) folds into a persisted `HealthState`. One source of truth drives the badge, the popup banner, and notifications.

### The eight failures

1. **Logged out.** The content script checks where the tab actually landed. LinkedIn redirects a signed-out session to `/authwall` or `/login`, so a final URL matching those → outcome `logged-out` (not "0 cards"). **Behaviour:** scanning **pauses** — hitting a login wall every 5 minutes is pointless and a poor signal. It resumes automatically on the next scan that comes back `ok` (i.e. once the user signs in). **Signal:** red badge, popup banner "Signed out of LinkedIn — scanning paused," and **one** desktop notification on the transition in.

2. **A challenge or captcha.** A final URL under `/checkpoint/` or containing `/challenge` → outcome `challenge`, which **outranks every other outcome** in the aggregate. This is the signal that matters most for account safety. **Behaviour:** scanning **halts entirely** — not backed-off, *stopped* — and stays halted until the user clears the challenge on LinkedIn and manually resumes. Continuing to load tabs through a verification wall is exactly what escalates to a restriction (§12). **Signal:** red badge, banner "LinkedIn asked for verification — scanning stopped," and one hard desktop notification (once, on transition).

3. **Zero cards parsed — "no results" vs "LinkedIn changed the page."** Told apart by **whether the results-list container is present at all**, not by the card count. Container present, zero cards → `empty` (a genuine "no results for this search," benign). Container **absent** → `structure-changed` (the selectors are dead — LinkedIn moved the DOM). **Behaviour:** `structure-changed` warns **immediately** (a missing list is unambiguous); `empty` only warns after `emptyScansBeforeBackoff` (default 3) consecutive empties, since one quiet search is normal. Both feed the §15 back-off counter, so a broken parser also lengthens the interval instead of hammering. **Signal:** amber badge + banner "Reading may be broken." No desktop notification — soft failures use the passive channels to avoid notification fatigue.

4. **Partial parse.** Each field fails independently (§12). A job with a valid `id`, `title` and `url` is **saved and shown** even if `company`/`location` came back blank — the list view already drops blank meta parts (`renderJobRow`, mockups/render.ts). Only the three load-bearing fields are required (`isSavableJob`): id for dedupe, url to open, title to show; a card missing any of them is dropped. A field blank on **every** card in a scan (`fieldMissingAcrossAll`) is a soft selector-drift signal worth recording — a per-job blank is not.

5. **Tab fails to load** (timeout, network down, 5xx). Outcome `load-failed`. **Behaviour:** **retry that one page once** (blips are transient), then **skip** it and continue the cycle — a transient failure on one watch must not abort the others. Crucially, `load-failed` **does not** count toward the empty-scan back-off: it's an infra failure, not a parser signal, so a flaky network doesn't masquerade as "LinkedIn changed the page." **Signal:** none in v1 beyond a logged event (repeated total-network-outage warning is deferred — if LinkedIn is fully unreachable the user has bigger cues).

6. **Stuck scan lock.** PRD §9 clears a stale lock on startup, but the MV3 worker can be torn down mid-cycle on *any* tick (§12), leaving `isScanning` stuck true and every future alarm skipping forever. **Decision: the stale-lock check runs on every alarm tick**, not just startup (`isLockStale`). **Threshold: 5 minutes** (`staleLockMs`, default 300 000) — comfortably above the 60–90s a real cycle takes (§9), and `isScanning` with a null `startedAt` is treated as stale (corrupt). A stale lock is cleared and the scan proceeds.

7. **Push failure.** §8 swallows every push failure so it can never break the scan — that stays. But a wrong chat id fails silently for days (§8). **Decision: track *consecutive* push failures** (`reducePushHealth`); after `pushFailWarnThreshold` (default 3) in a row with push enabled, surface a **soft** warning in the popup/options ("Telegram push has been failing — run Send test message"). One good send resets it. Never a desktop notification, never a scan break. The §8 "Send test message" button stays the primary check; this is the passive backstop given #6's lesson that silent-forever is the real danger.

8. **Where failures are recorded and surfaced.** One persisted `HealthState` (`'health'` key) is the single source of truth, so every surface agrees:

| Mechanism | Drives | v1? |
| --- | --- | --- |
| **Badge colour** | `severity`: default (ok) / amber (warn) / red (error) | **v1** |
| **Popup banner** | `message` — one line describing the problem and the fix | **v1** |
| **Desktop notification** | **Hard** failures only (`challenge`, `logged-out`), once on transition | **v1** |
| **Options error log** | A rolling list of the last N failure events with timestamps | **Deferred** — badge + banner + notification cover "find out"; a full log UI is post-v1 |

The split: hard failures (challenge, logged out) get an active push — a desktop notification — because they stop scanning and need the user now. Soft failures (parser drift, repeated empties, push failing) use only the passive badge + banner, so the tool doesn't cry wolf every quiet afternoon. The options error log is the one deferred piece; the three v1 channels already answer "how do you find out it broke."

### Structural consequence

Per §14, the decision logic is pure and tested (`src/health.ts` + `src/health.test.ts`): `classifyPage`, `aggregateOutcome`, `reduceScanHealth`, `isSavableJob`, `fieldMissingAcrossAll`, `reducePushHealth`, `isLockStale`. The content script reads the live DOM/URL into a `PageSignals`; `background.ts` persists the `HealthState`, sets the badge, and fires notifications — none of that is unit-tested, all of the decisions are.

---

## 17. How a scan cycle stays alive, and picks up where it left off

Resolves issue #11 / ticket 10. Issue #3 turned the fog into facts: the MV3
worker dies after ~30s of not touching an extension API (no maximum lifetime any
more), nothing in memory survives a teardown, Chrome sanctions a specific
keepalive pattern, and the dead air in a cycle is the wait for LinkedIn to render
(`tabs.create` resolves before the page loads). The facts are known; what to *do*
about them is what this section decides. Real cycle timing from #5 anchors it: two
watches × two pages ≈ 60–90s (§9), and page 1 settles in a few seconds after the
tab opens. The pure logic lives in `src/lifecycle.ts` (a §14 reference example);
`background.ts` is the thin wrapper that runs the keepalive, opens/closes tabs,
and persists the state.

Five decisions, five answers:

1. **Keepalive alone — not restartability.** A cycle survives its own dead air
   with the Chrome-sanctioned pattern: `const k = setInterval(() =>
   chrome.runtime.getPlatformInfo(), KEEPALIVE_PING_MS)` around the whole cycle,
   cleared in a `finally`. `KEEPALIVE_PING_MS` is **25 000** — comfortably under
   the ~30s teardown, so the 60–90s cycle never goes idle long enough to be
   killed. Restartability — persisting a cursor so an interrupted cycle resumes
   mid-flight — is real work for almost no gain: the keepalive makes a *normal*
   cycle survive intact, and the residual risk (a crash, an OOM, Chrome quitting)
   costs exactly **one skipped scan**, with the next alarm only minutes away.
   Dedupe is by job id (§5), so a re-scan reports everything unfamiliar regardless
   of when it appeared — a lost cycle loses nothing permanently, only briefly.
   The one thing worth catching up is depth, and decision 5 handles that far more
   cheaply than a cursor.

2. **Orphaned tabs — the cycle records them; a stale-lock sweep closes them.** The
   visible failure is a user finding six stray LinkedIn tabs after the worker died
   mid-cycle. In the happy path each tab is closed in a per-page `finally` the
   instant its page is scraped (as the #5 probe does), and `untrackTab` drops it
   from the record. What's left tracked when the worker dies is the orphan set:
   `beginScan` starts each cycle with an empty `openTabIds`, `trackTab` appends the
   id the moment `tabs.create` resolves (idempotent, so a persist-then-open race
   can't duplicate it), and `recoverStaleLock` returns whatever is still tracked
   for the wrapper to force-close before the next scan. **Who closes them:** the
   next alarm tick (or startup) that recovers the stale lock. **When:** before the
   replacement cycle opens its own tabs, so strays never accumulate past one cycle.

3. **The scan lock — settled in §16.6, reused here.** #9 already decided it and
   this ticket only cross-references: staleness is `isLockStale` (imported into
   `lifecycle.ts`, not re-implemented), the threshold is `staleLockMs` (default
   **300 000** / 5 min, well above a real 60–90s cycle), `isScanning` with a null
   `startedAt` is treated as stale/corrupt, and the check runs on **every alarm
   tick**, not just startup — because the worker can be torn down on any tick, not
   only across a browser restart. `recoverStaleLock` is the one call that composes
   that check with decision 2's tab sweep.

4. **Progress worth persisting — none, beyond cleanup and depth.** Follows from
   decision 1. There is no per-watch or per-page cursor: an abandoned cycle is
   re-scanned from the top, not resumed. The only state that crosses a teardown is
   the scan lock (decision 3) and the orphan-tab list (decision 2) — enough to
   *clean up* after a dead cycle, deliberately not enough to *resume* one. This is
   why `ScanState` grows two fields (`openTabIds`, `pendingCatchUp`, §5) and not a
   cursor.

5. **The startup catch-up — a consumable flag, replacing §9's unconditional
   scan.** #5 confirmed Chromium fires a missed alarm immediately on relaunch, so
   PRD §9's original unconditional `onStartup` scan *plus* that auto-fire would be
   a double-run. The fix: `onStartup` no longer scans inline. It clears any stale
   lock, sweeps orphan tabs, `ensureAlarmExists()`, and calls `requestCatchUp` to
   set `pendingCatchUp = true`. The next scan to begin — whether the replayed
   missed alarm or a freshly armed one — reads the flag via `beginScan`, runs at
   `catchUpPages` depth, and clears it in the same step. It fires **exactly once**:
   the scan lock serialises cycles, so a second concurrent fire sees `isScanning`
   and skips before it can consume the flag. The same `requestCatchUp` is reused on
   a quiet-hours resume (`willResumeFromQuiet`, §15) — a quiet gap and a
   closed-Chrome gap are the same problem (§9). If a stale-lock sweep happens to
   run on that first startup tick, the flag survives it (`recoverStaleLock`
   preserves `pendingCatchUp`), so the catch-up is never dropped.

### The revised startup handler

```ts
chrome.runtime.onStartup.addListener(async () => {
  const state = await loadScanState();
  const { tabIdsToClose, state: swept } = recoverStaleLock(state, Date.now(), settings.staleLockMs);
  await Promise.all(tabIdsToClose.map((id) => chrome.tabs.remove(id).catch(() => {})));
  await saveScanState(requestCatchUp(swept)); // next scan runs at catchUpPages depth
  await ensureAlarmExists(); // re-arm the one-shot if it didn't survive the restart
  // No inline scan: the alarm (replayed-missed or freshly armed) runs it once.
});
```

### Shipped constants

| Constant | Default | Why |
| --- | --- | --- |
| `KEEPALIVE_PING_MS` | 25 000 | Under the ~30s idle teardown; keeps a 60–90s cycle alive (decision 1) |
| `staleLockMs` | 300 000 | §16.6 — a lock older than 5 min is a dead cycle (decisions 2, 3) |
| `catchUpPages` | 4 | §15 — the one deep scan the catch-up flag triggers (decision 5) |

### Structural consequence

Per §14, the decision logic is pure and tested (`src/lifecycle.ts` +
`src/lifecycle.test.ts`): `requestCatchUp`, `beginScan`, `endScan`, `trackTab`,
`untrackTab`, `recoverStaleLock`, and the `KEEPALIVE_PING_MS` constant, reusing
`isLockStale` from `health.ts` so staleness is decided in exactly one place.
`background.ts` runs the `setInterval` keepalive, calls `chrome.tabs.create` /
`.remove`, and persists the returned `ScanLifecycleState` — none of that is
unit-tested, all of the decisions are. This is the last of the three
worker-lifecycle checkpoints (§14): quit Chrome mid-scan, relaunch, and confirm
the stale lock clears, the strays close, and exactly one catch-up scan runs.
