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

- Configurable interval, default **5 minutes**
- Configurable page depth, default **2 pages** per search
- Pagination uses LinkedIn's `&start=` parameter (page 2 = `start=25`, page 3 = `start=50`)
- Pages scraped sequentially with a short pause between, never in parallel

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

**Stack:** TypeScript + Vite (via `@crxjs/vite-plugin`), plus `chrome-types` for the Chrome API typings.

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
  pagesPerScan: number; // default 2
  catchUpPages: number; // default 4, used once on browser startup
  retention: RetentionConfig;
  push: PushConfig;
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

`chrome.alarms` survive a browser restart, but **a missed alarm does not fire retroactively**. If Chrome was closed for 9 hours, nothing ran, and the alarm resumes on its normal schedule — possibly not for another 5 minutes.

```ts
chrome.runtime.onStartup.addListener(async () => {
  await clearStaleLock(); // isScanning may be stuck true from an interrupted cycle
  await ensureAlarmExists(); // recreate if it didn't survive
  await runScanCycle({ pages: settings.catchUpPages }); // don't wait for the next tick
});
```

`clearStaleLock()` is essential. If Chrome was killed mid-scan, `isScanning` stays `true` and every future alarm skips forever. Check `startedAt` — anything older than ~5 minutes is stale.

The gap itself costs less than it appears. Dedupe is by job ID, not by "what changed since last check," so a restart scan reports everything unfamiliar regardless of when it appeared. You find out later, not never. What you can lose is anything pushed past your page depth during the gap — hence `catchUpPages` (default 4), used once on startup before reverting to the normal depth.

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
10. **Startup handling** — stale lock clear, alarm recreate, catch-up scan.
11. **Polish** — filter chips, mark-all-read.

---

## 12. Risks you should know about

### Selectors will break

LinkedIn changes their DOM regularly, sometimes monthly. Write the scraper so each field fails independently, and log loudly when a selector returns nothing. Budget for ongoing maintenance.

### Request volume

Two pages every 5 minutes is **576 page loads a day per watchlist entry**. Two saved searches puts you over 1,100. This is the number most likely to draw attention.

Also worth knowing: page 2 is mostly stale. When sorted by date, new postings land on page 1. Page 2 only helps if a burst pushed something down between checks, which at a 5-minute interval is uncommon.

Build it configurable as specified, but consider defaulting `pagesPerScan` to 1 and raising it only if you find you're actually missing things. Randomized jitter of ±1 minute on the interval, and pausing overnight, both help.

### Terms of Service

This is against LinkedIn's ToS. Personal single-user use in your own logged-in browser is low-risk in practice, but the risk isn't zero — account restriction is the realistic worst case.

### Background tabs and MV3

Manifest V3 service workers get killed after ~30 seconds idle. Use `chrome.alarms` to wake them rather than `setInterval`, which will not survive. A scan cycle spanning 60–90 seconds needs to be resilient to the worker being torn down mid-cycle — persist progress to storage as you go, and treat `isScanning` with a timestamp so a stale lock can expire rather than blocking forever.

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
