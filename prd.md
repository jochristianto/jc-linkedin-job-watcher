# PRD: LinkedIn Job Watcher (Chrome Extension)

## 1. The core problem first

LinkedIn actively blocks scraping. Their official API doesn't give you job search access. So the only approach that works reliably is a **Chrome extension** that reads the page while you're logged in — it looks like normal browsing because it is.

A desktop app would need to store your LinkedIn cookies and mimic a browser, which gets your account flagged or banned. Skip that.

---

## 2. What it does

You save one or more LinkedIn job search URLs, each with your filters already applied. On a schedule the extension loads each one into a small window tucked into the corner of the screen, reads the job cards across the configured number of pages, compares against what it has seen before, and tells you about anything new.

New jobs surface in two places: a badge count on the extension icon, and a desktop notification. Both lead into the extension's own list view — never straight to LinkedIn. You pick what to open from there.

> **A window, not a hidden tab.** This section originally said "background tab", and every later section was written on that assumption. It was measured on 2026-07-24 and it does not work: a tab you cannot see gets no animation frames, so LinkedIn's lazy results column never finishes drawing. **§18 supersedes it** — where an earlier section still says "hidden tab" or "background tab", read "the scan window".

---

## 3. Features

### Watchlist

- Multiple saved searches, each with its own URL and nickname (e.g. "Indonesia", "Japan")
- Toggle each one on/off individually
- All enabled searches run on the same cycle, one after another

### Scanning

- A **master on/off switch** in the list header (`Settings.enabled`, default on). Off clears the routine alarm and makes "Scan now" inert — the whole loop stops until it is turned back on. Distinct from a *per-watch* toggle, which silences one search
- **"Only scan when I press Scan now"** (`Settings.manualOnly`, default off). No alarm is ever armed, so nothing is loaded from LinkedIn until the button is pressed — but the watches stay on and a manual round behaves exactly like a scheduled one. It hands the *timing* to the user; the master switch above stops the loop outright (§15, decision 7)
- Configurable interval, default **60 minutes**, with **±30 minutes jitter** — every wake lands somewhere in 30–90 minutes (§15)
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
- Switchable off (`Settings.notifyDesktop`, default on). Off silences the pop-up and nothing else: the badge still moves and Telegram still delivers, because those are how you find out *later* rather than *now*
- Optional Telegram push so results reach your phone when you're away from the machine

### List view

- Shows unread jobs, newest first: title, company, location, posted time, source watch
- The **posting age is live**, recomputed from the stored date each time the row draws (issue #51), so a job found three weeks ago stops insisting it was posted two weeks ago. The ladder reads `12m` / `6h` / `yesterday` / `5d` / `3w` / `2mo` / `1y`, rounded half-up so a tie errs *older* (24 days is `3w`, 25 is `4w`) and using `mo` for months so a three-month-old posting never reads `3m` (`m` is minutes). Below a day it is an elapsed duration; at a day and above a calendar difference, because the stored date is only day-precise up there and "yesterday" is a calendar word. Hover gives the date in words; an **estimated** date wears a `~` and says so on hover. A record saved before the date was stored keeps showing its frozen phrase, unchanged, and ages out within 30 days
- Where LinkedIn withheld the date — because the posting has already been opened *anywhere*, including directly on LinkedIn outside this extension — the row carries a **`Seen on LinkedIn`** chip instead of a date. That is distinct from `Opened` (you opened it *from this list*): the two co-occur, and the informative case is `Seen on LinkedIn` without `Opened` — a posting looked at on LinkedIn and forgotten. The chip sits in the meta line with the other chips, not beside the title with `Blocked`: it is a fact about the posting, not a verdict on it
- A card LinkedIn marked **`Reposted`** — the employer re-listed the role, often because nobody took the first listing — carries an amber **`Reposted`** chip (issue #53). It sits immediately after the posting-age slot (after `Posted … ago`, or after `Seen on LinkedIn` where there is no date) and ahead of `Found …`: the date and the repost are both facts about the posting's own history, while `Found …` is a fact about the watcher. Amber, not grey, so a possibly-stale row is findable while skimming; the full word on both surfaces, the popup wrapping the line rather than abbreviating. It is a chip, not a badge beside the title, for the same reason `Seen on LinkedIn` is — a detail of the posting, not a verdict on it. `Job.isReposted` has existed since the beginning and only ever fed the hide filter; this surfaces it. With **Hide reposted** on the row never renders, so the chip and the filter never both appear. Read as `=== true`: a record written before the flag existed has it absent, which means "no marker seen", not "reposted"
- Badge on the extension icon counts the jobs you have not looked at yet
- Click a job → opens it in a new tab, clears the row's unread dot and takes it off the badge, and tags the row "Opened". Looking is not dismissing, though: the row itself **stays in the list**, so a job you clicked into is still there when you come back to it
- Each row has its own "mark as read" button — the only action that greys a row and drops it out of "New". It toggles, so a mis-click is one press back, and un-ticking a row you had opened puts its dot back
- Each row has its own "block this company" button, so a bad company can be blocklisted from where you see it rather than from Options. Already-listed jobs from that company stay on screen, greyed and tagged, and stop counting towards the badge; it's future scans that stop surfacing it. It toggles too
- Filter chips to show only one watch's results
- Toggle between "New" and "All"
- "Mark all as read", over the list as you have it filtered rather than over everything stored: with a watch chip on it clears that watch and leaves the others as unread as they were, and reads "Mark these as read" so the words match what it will do. Nothing un-reads in bulk, so it must not reach jobs you cannot see — a job hidden by "Hide jobs marked Reposted" is left alone for the same reason. The badge keeps counting every watch, so a scoped read leaves a number behind on purpose
- Middle-click / ctrl-click opens in a background tab so you can queue several
- Opening a posting queues **"Did you apply for this job?"** on that job's own card, answerable when you come back from LinkedIn. Yes takes an optional note and pushes an `[Applied]` message; No records nothing (§19)
- A status bar reading the armed alarm itself: scanning, a live countdown, quiet hours, manual-only, or paused

### Storage

- Seen job IDs kept locally so you don't get duplicate alerts
- Auto-prune anything older than ~30 days

---

## 4. Architecture

```text
manifest.json (MV3)
│
├── background (service worker)
│   ├── chrome.alarms → fires every N minutes
│   ├── checks isScanning lock → skips if a cycle is still running
│   ├── opens ONE scan window for the whole cycle (unfocused, corner, §18)
│   ├── for each enabled watch, sequentially:
│   │     navigate the window → inject content script → scrape → next page
│   ├── closes the scan window
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

**Stack:** TypeScript + **plain Vite, no extension plugin** (`@crxjs/vite-plugin` is maintained but its content-script handling — this project's most load-bearing surface — is its weakest; issue #4 / ticket 03). Chrome API typings come from **`@types/chrome`**, not `chrome-types` (the latter types `storage.get` as `any`; same ticket). Pure logic is unit-tested with Node's test runner via `tsx` (`npm test`), which needs no browser (§14). Permissions (§10) stand unchanged.

---

## 5. Data shape

```ts
type Job = {
  id: string; // LinkedIn's job ID from the URL
  title: string;
  company: string;
  location: string;
  isReposted: boolean;
  // LinkedIn's own posting date, kept as a real date rather than the frozen phrase
  // it was true at scan time (issue #48). `postedAt` is resolved four ways per card
  // — fresh phrase to the minute, `<time datetime>` attribute to the day, coarse
  // phrase to a midpoint estimate, or nothing — and `postedPrecision` says which;
  // only `"estimated"` shows a `~`. `linkedInStatus` reads the exclusive footer
  // slot, the one honest answer to why a card has no date. All three are optional
  // in a backup file: records and files written before this shipped carry none,
  // and an absent `postedAt` reads as "never captured" — the same state a `Viewed`
  // card is stored in. `postedText` stays required — it has always been written.
  postedAt: number | null;
  postedPrecision: "exact" | "day" | "estimated" | null;
  postedText: string; // "2 hours ago" — the words LinkedIn rendered, unchanged
  linkedInStatus: "posted" | "promoted" | "viewed" | "applied" | null;
  url: string;
  foundAt: number;
  watchId: string; // which saved search surfaced it
  opened: boolean; // you clicked through — clears the dot and the badge count, keeps the row
  openedAt: number | null;
  read: boolean; // you dismissed it — greys the row, drops it out of "New"
  readAt: number | null;
  // Applying is a third state again, and the only one that means you *acted* on
  // the posting. All three are optional: records written before this shipped
  // carry none of them, and an absent `applied` reads as "never applied", so no
  // migration is needed. Answering "No" writes nothing at all (§19).
  applied?: boolean;
  appliedAt?: number | null;
  applyNotes?: string; // what was typed alongside a Yes; "" when left empty
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
  enabled: boolean; // default true — the master switch (§3). Off stops the loop AND "Scan now"
  manualOnly: boolean; // default false — no alarm is armed; "Scan now" is the only trigger (§15.7)
  watches: Watch[];
  blockedCompanies: BlockedCompany[];
  blockedTitleKeywords: string[];
  hideReposted: boolean;
  intervalMinutes: number; // default 60
  jitterMinutes: number; // default 30 — ±this, randomised onto each interval (§15)
  pagesPerScan: number; // default 1 — routine depth (§15); page 2 is mostly stale
  catchUpPages: number; // default 4, used on startup and quiet-hours resume (§9/§15)
  quietHours: QuietHours;
  notifyDesktop: boolean; // default true — the desktop pop-up only; badge and push are unaffected
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
  // Default 240. The ceiling has to sit above `intervalMinutes` or the rule is
  // inert: a 60-minute base clamped to a 60-minute maximum can never double.
  maxIntervalMinutes: number;
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

`seen` is deliberately separate from `jobs`. During a scan the only question is "have I seen this ID before" — loading full job objects to answer that is wasteful, and it's the operation running on every card of every scan.

### Two different lifetimes

| Key    | Holds          | Purpose               | Size                                     |
| ------ | -------------- | --------------------- | ---------------------------------------- |
| `seen` | ID → timestamp | Prevents re-notifying | ~10 chars per entry; 10k entries ≈ 300KB |
| `jobs` | Full records   | Feeds the list view   | Only for jobs still worth displaying     |

Once a job has been opened or read and some time has passed, drop its full record but keep the `seen` entry. You don't need the title and company of something clicked three weeks ago — only the memory not to alert on it again. This split is what keeps storage from growing unbounded.

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

  // Full records: shorter life once you've dealt with the job — opened or read
  const keptJobs: Record<string, Job> = {};
  for (const [id, job] of Object.entries(jobs)) {
    const handled = job.opened || job.read;
    const limit = (handled ? r.openedJobDays : r.unopenedJobDays) * DAY;
    if (now - job.foundAt < limit) keptJobs[id] = job;
  }

  // Seen IDs: the long-lived record — and never shorter-lived than the job
  // record it belongs to (see "The lifetimes cross", below)
  let keptSeen = Object.entries(seen).filter(
    ([id, ts]) => now - ts < r.seenDays * DAY || id in keptJobs,
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
| `openedJobDays`   | 7       | You've already opened or read it; the full record is dead weight.                                                          |
| `unopenedJobDays` | 30      | Long gone from LinkedIn by then regardless.                                                                                |
| `seenHardCap`     | 50,000  | Trims to 40,000 when breached. Pure safety net.                                                                            |

All four are configurable from the options page.

### The lifetimes cross

`seenDays` (15) is shorter than `unopenedJobDays` (30), so for a fortnight an unopened record outlives the memory of it. §6 states the split one way round — "drop its full record but keep the `seen` entry" — and the filter above, taken literally, allows the reverse: the id expiring while the record it belongs to is still stored.

A posting still live on LinkedIn in that window then comes back as new. It notifies and it pushes — and it shows *nothing*, because `mergeJobs` keeps the record already held rather than replacing it. An alert with nothing behind it is worse than no alert.

So **a surviving job record holds its own seen id back** (`|| id in keptJobs`). It is the one addition to §7's algorithm, it only ever keeps more, and the hard cap still applies afterwards. The defaults are untouched: the invariant is what the two lifetimes always meant, rather than a new number.

### The alarm it runs on

A **periodic** alarm (`ljw-gc`, 1440 minutes), not the re-armed one-shot the scan cadence uses. The scan alarm is re-armed each cycle because jitter, back-off and the quiet-hours jump have to be recomputed every time; a daily prune decides none of those, so there is nothing for a re-arm to do that a period doesn't.

Created on install and on browser startup, but only **if it does not already exist**. A periodic alarm outlives the service worker, and re-creating one that is already ticking restarts its period — on a browser that is restarted daily, that is a collector that never runs. The first run is a minute after creation rather than a day: pruning isn't worth putting in front of the first scan, but a full day's delay would mean an install that only ever runs an hour at a time never collects at all.

**A run that finds a scan in progress skips its turn.** A cycle reads `seen` and writes it back at its end, immediately either side of its dedupe; a prune landing between those two is either overwritten by the cycle — harmless, tomorrow collects again — or overwrites the ids the cycle just recorded, which would re-announce every job it had just found. The window is short, but a daily run will eventually find it, and skipping costs a day. This is the operational half of "never on the scan path".

The lock is read through `recoverStaleLock`, the same reading the two scan paths take, never off the raw `isScanning` flag. A worker torn down mid-cycle leaves that flag true indefinitely, and a collector that trusted it would then skip *every* day — silently, and worst of all with the master switch off, where no scan tick ever comes along to clear the lock. The recovery is read-only here: releasing the lock and sweeping the tabs the dead cycle orphaned belongs to the scan paths.

**A key nothing aged out of is not written.** Per the caveat below, writing re-serialises the whole map; a run with nothing to prune should cost three reads, not two full rewrites of storage, every day, forever.

**The master switch does not gate it.** Switching scanning off stops the extension *doing* things; it does not freeze the clock, and a job found six weeks ago is equally stale whether or not anything has scanned since.

### Delete all job history

The same thing on demand and without limits, in the options page's Retention section: empty `jobs` and `seen` outright.

**Settings are not part of it.** Starting the collection over and un-configuring the extension are two different things to want, and one button for both would make it impossible to do either on its own. There is no factory reset; deleting `jobs`, `seen` and nothing else is the whole feature.

`ui.pendingApplyId` goes with the jobs. It names the job whose "Did you apply for this job?" is still unanswered (§ the apply question), and a question about a record that no longer exists can only hang there. The rest of the view state — chip, mode — is about the page rather than the data, so it survives.

**Not while a cycle is running**, for the reason the daily collector skips one — only more so. A cycle dedupes against `seen` at its end, so emptying it mid-round makes every job that round found new again: it would write the records straight back and announce them, which is the exact opposite of what the button was pressed for.

Guarding that with a check in the page is not enough, because a round can start between the check and the write. **The delete therefore runs in the worker, holding the scan lock** — the lock is what serialises access to `seen` and `jobs`, a cycle is simply its longest-running holder, and only the worker can take it. It is taken with `holdLock`, not `beginScan`: a delete is not the deep round a pending catch-up flag was set for, and consuming that flag would quietly downgrade the next round.

The page keeps a check of its own, but only as a *hint* — the button greys out with a line saying why. That hint is derived against a ticking clock rather than stored as a flag: a worker torn down mid-cycle writes nothing further, so a lock read once as "scanning" would disable the control for as long as the page stayed open. Re-judging it through `recoverStaleLock` each tick is what lets a stuck lock age out of the way.

**It names the quantity before it asks.** "Delete all data?" asks you to confirm a number you have not been told, so the section carries the live count and the dialog repeats it. The consequence is spelled out too: with the seen ids gone, the next round finds everything still live on LinkedIn and announces it as new. That is the cost of the button, and it is the one thing about it nobody predicts.

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

### Message format

Two messages, one shape. Every job is a linked title followed by labelled lines, so a posting reads the same whether it arrived as new or as one you told the extension you applied to. The title is always the link — on a phone the message *is* the way back to the posting.

New jobs:

```text
[New Job Posts]

1. {jobTitle}
Company: {companyName}
Location: {location}

2. {jobTitle}
Company: {companyName}
Location: {location}
```

Applied (the answer to "Did you apply for this job?"):

```text
[Applied]

{jobTitle}
Company: {companyName}
Location: {location}
Notes: {notes}
```

A batch is **split at 10 jobs per message**, not truncated: 100 new jobs arrive as ten messages, numbered 1–100 straight through, so ten messages read as one list continued rather than ten lists that each begin at 1. Messages go out one after another with a ~1s gap, since a bot posting to the same chat is throttled at roughly a message a second and a 429 would drop the tail of the batch silently.

Each line degrades on its own (§12): an unparsed company drops the `Company:` line rather than printing an empty label, an empty note drops `Notes:`, a job with no url keeps its title as plain text, and a job with no title falls back to "Untitled role" so the link is never invisible anchor text.

### Send function

```ts
async function sendPush(jobs: Job[], cfg: PushConfig): Promise<boolean> {
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId || jobs.length === 0) {
    return false;
  }

  let allSent = true;
  for (const [i, text] of buildPushMessages(jobs).entries()) {
    if (i > 0) await sleep(1000); // pace a split batch
    // POST { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }
    // to https://api.telegram.org/bot<token>/sendMessage; res.ok decides.
    // A refusal does not abandon the messages after it, but does fail the batch.
    if (!(await postMessage(text, cfg))) allSent = false;
  }
  return allSent; // never throws — push failure must not break the scan
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
| 4096-char message cap      | 10 jobs per message covers it with room to spare; a longer batch is split across messages rather than truncated.                                                                                             |
| Push failure               | Caught and swallowed. Offline phone or Telegram outage must not stop the scan or the badge update.                                                                                                           |
| Token is a real credential | Anyone holding it can post as your bot. Lives in `chrome.storage.local`, readable by anything with access to the Chrome profile. Fine for a personal tool — don't commit it; revoke via BotFather if leaked. |
| Rate limits                | ~30 messages/second overall, but ~1/second to one chat — hence the gap between the messages of a split batch. Irrelevant for a routine cycle's single message.                                               |

### Options page: "Send test message"

Silent push failure is the most likely thing to go wrong — a wrong chat ID produces no error you'd notice for days. A test button that reports success or failure inline removes that whole class of problem.

### A third message: the field-break alarm (issue #54)

Push carried new jobs only — never health. The field-break guard (§16.4) lights a badge and a popup banner, but those *already existed and already failed*: the extension went quiet twice and it was weeks before anyone noticed the amber badge that was there the whole time. So the guard's finding also goes out over Telegram, the one channel that persists in a chat the user reads rather than firing once into an empty room.

```text
⚠️ LinkedIn's job list changed

Company names stopped reading — 0 of the 25 jobs on the last scan had one.

Everything else still works. Jobs are still being found and sent to you.

To get it fixed, save a copy of your job-search page while you're logged in. The extension's Options page has a button for it.
```

Four jobs, in order (`buildFieldBreakPush`, proved against this copy): **name the field** ("LinkedIn changed" is not actionable); **give the count** (`0 of N`, so whoever fixes it has the number); **say whether jobs are still arriving** — a dead `location` is cosmetic but a dead `title`/`url` means no job is saved at all, so the third line flips to "New jobs can't be read while this is broken"; and **name the one action that helps** — the Options capture button (§ Diagnostics / issue #49), which is why #54 is blocked on it, a message naming a button that does not exist being worse than none.

**Cadence — once a day while broken.** Scans run every ~5 minutes, so this is the difference between ~288 pushes a day and one. The user's call, chosen over "once per break" and a weekly nudge: a fix can take a fortnight, and a daily alert about something already known is how a guard earns an uninstall — but the badge and banner stay lit continuously regardless, so the daily push is a nudge on top of a standing signal, not the only trace. State is one `lastPushedAt` (`'fieldBreakPush'` key) that spaces the send; `reduceFieldPush` is the pure gate (injected `lastPushedAt`, literal `now`). Recovery is immediate — the first scan that reads the field again clears the state and stops the pushes, so a *later* break pushes again rather than staying suppressed. A push that fails is swallowed exactly like §8's others, and with Telegram unconfigured the guard still lights the badge and banner and nothing throws. (Bounding the cadence — daily for a fortnight, weekly after — is offered to a later ticket if it bites, not built unasked.)

---

## 9. Key flows

### Scan cycle

```text
Alarm fires
  → if isScanning, skip this tick and return
  → recover any stale lock, sweep tabs a dead cycle orphaned (§16.6/§17.2)
  → set isScanning = true
  → open ONE scan window for the whole cycle (unfocused, corner, §18)
  → for each enabled watch, sequentially:
        for page 1..pagesPerScan:
            navigate the scan window to url + &start=(page-1)*25
            inject content script with a one-time token
            scrape, send back
            pause ~3-5s
            a short read retries that page once, with focus (§18)
        pause ~10s between watches
  → close the scan window
  → merge all results
  → apply blocklists and reposted filter
  → drop anything already in the seen set
  → persist new jobs, update badge
  → if new jobs > 0, fire one notification (unless notifyDesktop is off)
  → set isScanning = false
```

Two watches at two pages each takes roughly 60–90 seconds, comfortably inside even the shortest gap the jittered interval can produce (30 minutes, §15).

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
3. **Single-watch scan loop** — alarm, scan window (§18), one page, close.
4. **List view** — popup with badge count, highlight-on-click, and per-row mark-as-read / block-company. Build it as a shared component from the start.
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

Two pages every 5 minutes would be **576 page loads a day per watchlist entry** — over 1,100 for two searches. That was the number most likely to draw attention, so the shipped defaults cut it: **one page** per scan, an **hourly interval** rather than a 5-minute one, **quiet hours** overnight, and **±30 minutes jitter**. See §15 for the full working; the short version is 24 loads/day/watch clock-round, ~16 with the default 8-hour quiet window — a rounding error next to the original.

Page 2 is mostly stale. When sorted by date, new postings land on page 1; an hour of postings for a normal search does not fill 25 cards, and the catch-up scan (§9, §15) covers the gap case where it does. Raise `pagesPerScan` only if you find you're actually missing things.

### Terms of Service

This is against LinkedIn's ToS. Personal single-user use in your own logged-in browser is low-risk in practice, but the risk isn't zero — account restriction is the realistic worst case.

### The scan surface, and MV3

The original plan here was a background tab. §18 records why that had to become a visible window, and what it costs: a scan is now something the user can see happen, which is the price of reading a page LinkedIn only renders when it is on screen.

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
| Garbage collection — two lifetimes + hard cap, what a run removed, and delete-all (§7) | 08 | **Done** — `src/gc.ts` + `src/gc.test.ts`. §7 lifted verbatim into `collectGarbage(state, now)`; `removedCounts` decides whether the daily run writes at all, `clearHistory` decides what "delete all job history" empties |
| Scheduling — jitter, quiet hours, in-cycle pauses, back-off (§15) | 03/10 | **Reference example** — `src/schedule.ts` + `src/schedule.test.ts` |
| Failure diagnosis & surfacing — page classification, health reducer, stale-lock, push-fail, partial-parse (§16) | 08 | **Reference example** — `src/health.ts` + `src/health.test.ts` |
| Worker lifecycle — keepalive constant, catch-up flag, orphan-tab tracking, stale-lock recovery, taking the lock for something that is not a scan (§17/§7) | 10 | **Reference example** — `src/lifecycle.ts` + `src/lifecycle.test.ts` |
| Card parser — DOM → `Job` | 01 | Fixture-driven, see below |
| What the list view shows — badge count, which empty state, which banner, the scan status, the applied record (§19) | 09/UI | **Done** — `src/view.ts` + `src/view-model.ts`, with their tests. `selectView` returns it all as data; the components only map it to JSX |
| What the settings page derives — dirty sections, watch-URL chips, the header summary, the load estimate and its tier | UI | **Done** — `src/settings-view.ts` + `src/settings-view.test.ts`, above `options-form.ts`'s validation and storage round-trip |
| What importing a backup would change, how merge and replace differ, and which screen the wizard is on (§20) | UI | **Done** — `src/import-plan.ts` + `src/import-plan.test.ts`, above `backup.ts`'s file shape and validation. `planImport` is called by both the preview and the write |
| Notification text and when one is due | 06 | **Done** — `src/notify.ts` + `src/notify.test.ts` |

That is the line. Anything that is *only* an orchestration of `chrome.*` calls (opening tabs, firing alarms, setting the badge) is **not** unit-tested — see "the untestable remainder".

### The parser is testable — with fixtures, no network, no login

The card parser reads a `Document` and returns `Job[]`. Give it a `Document` parsed from **saved HTML** and it needs no browser and no LinkedIn session. Split it so the pure part takes a `Document` (or an `Element`), not the live page:

```ts
// pure — testable
export function parseJobCards(doc: Document): Job[] { ... }
// thin content-script wrapper — not unit-tested
parseJobCards(document);
```

`parseJobCards` reads only the `Document` — including the `<time datetime>` attribute and the age phrase — and never a clock (issue #48). Reading an attribute is not reading a clock: the parser resolves the attribute to a `postedAt` at day precision and reads the footer's exclusive state into `linkedInStatus`, but the phrase cases (fresh-to-the-minute and coarse-estimate) need `foundAt`, which the pure `stampJobs` supplies later. So both halves stay provable against literal inputs, and no `Date.now()` is ever injected into the reader.

- **Fixtures live in** `.scratch/linkedin-job-watcher/fixtures/page-1/` and `.../page-2/` — **gitignored** (a saved logged-in page carries profile chrome; it must never be committed, per `.gitignore` and issue #2).
- **A test loads a fixture with `node:fs` + a DOM parser** (`linkedom` or `jsdom`, dev-dependency only) and asserts the parsed IDs/fields. Because fixtures are gitignored, the parser test **skips cleanly (`test.skip`) when its fixture file is absent** so CI/other machines stay green; it runs wherever the human has captured the page.
- **Refreshing when LinkedIn changes:** re-capture the two pages into the same folders (issue #2 checklist), re-run `npm test`, update selectors until green. The failing parser test is the signal that LinkedIn moved the DOM (PRD §12).

### Test runner

**Node's own test runner, driven by `tsx`** — `tsx --test`, wired as `npm test`. Vitest was the Vite-toolchain default, but the pure logic has no bundler dependency, so the zero-config Node runner is fewer moving parts (issue #4's bias), and that reasoning still holds: this is `node:test` with `node:assert`, not a second framework.

*Amended.* This originally read `node --test --experimental-strip-types`, and that was true until the UI moved to React. Node's type stripping does not compile JSX and does not resolve the `@/` path alias, which between them cover every `*.test.tsx` and most of what they import. `tsx` handles both and changes nothing about how the tests are written. If the parser fixtures later need a heavier DOM setup, revisit — until then, don't add a second runner.

**`chrome.*` in tests:** the tested code contains **no `chrome.*`** — that is the whole point of the pure/side-effect split (below). So there is nothing to fake. `chrome.*` lives only in thin wrappers that the tests don't import. Do **not** stub `chrome` globally; if a function needs a stub, that function is on the wrong side of the line — refactor the pure part out.

### The untestable remainder — a human checklist at checkpoints

The scan window opening in the corner, alarms firing on schedule, desktop notifications appearing, the badge count, notification-click focusing the tab, the startup catch-up scan: these need a human to look. They run **at checkpoints, not after every ticket** (most tickets touch only pure logic or one wrapper). The three checkpoints:

1. **After ticket 03 (single-watch scan loop):** load unpacked; confirm the alarm fires, the scan window opens in the corner and closes itself, and one page's jobs land in `chrome.storage.local`.
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

Eight decisions, eight answers:

1. **Interval — 60 minutes.** *Revised down from 5.* A recruiter posting is still on page 1 hours later (§13), so the freshness a 5-minute beat bought was mostly theoretical: you find out about a job in the hour rather than in the minute, and you were never going to apply inside five minutes anyway. What it cost was real — 288 loads a day per watch is a volume no human browsing session resembles, and the thing this extension must not do is get the account flagged (§12). An hour is the cadence a person checking between meetings actually has. Configurable for anyone who wants it tighter, but the shipped number now errs towards not being noticed.
2. **Page depth — default 1, not 2.** Page 2 is mostly stale when sorted by date (§12); the gap it guards against — a burst pushing a posting past page 1 between checks — is exactly what the catch-up scan (`catchUpPages`, default 4) recovers on startup and quiet-hours resume. So routine scans go shallow and the rare deep scan happens only when a real gap preceded it. One page halves the request volume for free.
3. **Jitter — ±30 minutes, half the interval.** *Revised up from ±1.* A fixed heartbeat is the cheapest thing there is to recognise, and ±1 minute on a 5-minute beat still described a near-perfect metronome. At 60 ± 30 every wake lands somewhere in **30–90 minutes** and consecutive gaps are never the same length, so there is no period to lock onto — the interval stops being a fingerprint and starts looking like someone opening a tab when they think of it. Freshness is unaffected in the direction that matters: the worst case is a 90-minute gap on a posting that stays on page 1 for hours. It forces the **alarm shape**: a re-armed one-shot (`chrome.alarms.create(name, { when })` at the end of each cycle), because `chrome.alarms` can't jitter a periodic alarm and clamps periods under a minute (issue #3). `jitteredDelayMs()` is clamped to a 1-minute floor so a large jitter can never produce a sub-minute or negative delay.
4. **Quiet hours — yes, clock-based, default on.** Scanning pauses in a user-set local window, default 23:00–07:00. It's stored as minutes-of-day and may wrap midnight (`isWithinQuietHours` handles the wrap). At the boundary: when the next fire would land inside the window, the alarm is pushed to the window's end instead, and that first wake runs a **catch-up scan** at `catchUpPages` depth — a quiet gap is the same problem as a closed-Chrome gap (§9). Recruiters post in business hours, so the overnight gap costs almost nothing and cuts ~8h of loads.
5. **In-cycle pauses — keep, but randomise.** 3–5s between pages and ~8–12s between watches (PRD §9), drawn uniformly per pause via `randomPauseMs()` rather than a fixed value, same reasoning as the interval jitter.
6. **The stopping rule — back off *and* tell the user.** The back-off signal is `emptyScansBeforeBackoff` (default 3) consecutive scans returning **zero cards across every watch** — the signature of a broken parser or a soft block (§12). On trip, the extension doubles its own interval each further empty scan up to `maxIntervalMinutes` (default 240 — the ceiling has to sit above the base interval or the rule is inert, which is why raising the interval to 60 raised this too) *and* surfaces a "reading may be broken" warning (`shouldWarnStalled`). It recovers instantly: one non-empty scan resets the counter and the interval snaps back to base. It does both — self-throttle so it stops hammering, and tell the human so a genuine DOM break gets fixed rather than silently backed-off forever.
7. **A way out of the schedule entirely — `manualOnly`.** Every decision above tunes *when* the extension decides to scan, and there is a user for whom the honest answer is "never, unless I say so": someone who wants the watchlist, the dedupe and the Telegram push, but does not want their browser touching LinkedIn while they are not looking. With `manualOnly` on, no alarm is ever armed — `nextScanDelayMs` is not consulted, because there is no next scan — and **"Scan now" is the only thing that loads a page.** Everything downstream is unchanged: watches stay enabled, a manual round updates the list, the badge, the notification and the push exactly as a scheduled one would, and the back-off counter still ticks. Three things follow from "no alarm":
   - The status bar has no countdown to report, so it says *Manual only — press Scan now* rather than counting down to nothing.
   - `chrome.alarms.getAll()` returning an empty list is **correct**, not a fault — worth stating because it is the first thing anyone debugging a silent extension checks.
   - The load estimate (§12) cannot be a daily figure without predicting how often a human presses a button. It reports the **per-press** cost instead.

   Interval, jitter and quiet hours are *kept*, not cleared — greyed out on the page and back in service the moment the switch goes off. It is deliberately **not** the same control as `enabled` (§3): that one stops the loop *including* the manual button, and is the switch for "I am not job-hunting this month". This one is "I will decide when."

8. **Shipped defaults** (all configurable per §5):

| Setting | Default | Why |
| --- | --- | --- |
| `enabled` | true | The master switch; off stops the loop and the manual button both (§3) |
| `manualOnly` | false | Scheduled rounds are the point; the escape hatch is opt-in (decision 7) |
| `intervalMinutes` | 60 | Hourly is as fresh as the postings are; 5 min was volume for nothing (decision 1) |
| `jitterMinutes` | 30 | Every wake lands in 30–90 min, so there is no period to recognise (decision 3) |
| `pagesPerScan` | 1 | Page 2 mostly stale; catch-up covers the gap (decision 2) |
| `catchUpPages` | 4 | One deep scan on startup / quiet-hours resume (decisions 2, 4) |
| `quietHours` | on, 23:00–07:00 | Cuts ~8h of loads at near-zero freshness cost (decision 4) |
| `notifyDesktop` | true | A find is worth interrupting for; silencing it is one switch away (§3) |
| `pacing.pagePauseMs` | [3000, 5000] | Randomised page pause (decision 5) |
| `pacing.watchPauseMs` | [8000, 12000] | Randomised watch pause (decision 5) |
| `backoff.emptyScansBeforeBackoff` | 3 | Trip the stopping rule after 3 empty scans (decision 6) |
| `backoff.maxIntervalMinutes` | 240 | Ceiling for the doubling interval; must exceed the base (decision 6) |

**Resulting volume.** One page an hour is 24 loads/day/watch clock-round; the default 8-hour quiet window drops that to ~16 — against PRD §12's original 576, before the user touches a single setting. Two watches sit near 32/day rather than 1,100+, which is the volume of a person who checks their saved searches now and then.

---

## 16. What happens when it breaks, and how do you find out?

Resolves issue #9 / ticket 08. The PRD describes the happy path in detail and §12 says "log loudly," but for a tool that runs unattended in the background, **silence is indistinguishable from "no new jobs."** The failure mode this section exists to prevent is the extension quietly stopping for weeks. Each failure below gets a decided *behaviour* and a decided *signal*. The pure logic lives in `src/health.ts` (a §14 reference example); `background.ts` and the content script are the thin wrappers that feed it signals and act on the returned `HealthState`.

The unifying idea: the content script never reports a bare "0 cards." It reports a **classified page outcome** (`classifyPage`), and the cycle's outcomes collapse to the single worst one (`aggregateOutcome`) which a pure reducer (`reduceScanHealth`) folds into a persisted `HealthState`. One source of truth drives the badge, the popup banner, and notifications.

### The eight failures

1. **Logged out.** The content script checks where the tab actually landed. LinkedIn redirects a signed-out session to `/authwall` or `/login`, so a final URL matching those → outcome `logged-out` (not "0 cards"). **Behaviour:** scanning **pauses** — hitting a login wall every round is pointless and a poor signal. It resumes automatically on the next scan that comes back `ok` (i.e. once the user signs in). **Signal:** red badge, popup banner "Signed out of LinkedIn — scanning paused," and **one** desktop notification on the transition in.

2. **A challenge or captcha.** A final URL under `/checkpoint/` or containing `/challenge` → outcome `challenge`, which **outranks every other outcome** in the aggregate. This is the signal that matters most for account safety. **Behaviour:** scanning **halts entirely** — not backed-off, *stopped* — and stays halted until the user clears the challenge on LinkedIn and manually resumes. Continuing to load tabs through a verification wall is exactly what escalates to a restriction (§12). **Signal:** red badge, banner "LinkedIn asked for verification — scanning stopped," and one hard desktop notification (once, on transition).

3. **Zero cards parsed — "no results" vs "LinkedIn changed the page."** Told apart by **whether the results-list container is present at all**, not by the card count. Container present, zero cards → `empty` (a genuine "no results for this search," benign). Container **absent** → `structure-changed` (the selectors are dead — LinkedIn moved the DOM). **Behaviour:** `structure-changed` warns **immediately** (a missing list is unambiguous); `empty` only warns after `emptyScansBeforeBackoff` (default 3) consecutive empties, since one quiet search is normal. Both feed the §15 back-off counter, so a broken parser also lengthens the interval instead of hammering. **Signal:** amber badge + banner "Reading may be broken." No desktop notification — soft failures use the passive channels to avoid notification fatigue.

   **One named cause of a missing list — the new results surface (issue #50 / #47).** LinkedIn runs two job-search surfaces at once: the classic `/jobs/search/` this plan is built and tested against, and a newer `/jobs/search-results/` with build-hashed class names and no readable card-level date. When a missing results list is paired with a final URL that is *not* on `/jobs/search/`, the outcome is `search-moved` rather than the generic `structure-changed`, and the banner says so: "LinkedIn moved your search to its new results page, which this extension cannot read yet." Same amber severity and back-off behaviour — this only sharpens the message from a shrug into something actionable. The URL check sits *after* the challenge and logged-out checks in `classifyPage`, so it can never outrank an account-safety signal (a redirect to `/authwall` or `/checkpoint/` still classifies as logged-out / challenge). This is the trigger recorded on #47: if this outcome ever fires, supporting the new surface reopens as its own effort — no second selector set is added here.

4. **Partial parse.** Each field fails independently (§12). A job with a valid `id`, `title` and `url` is **saved and shown** even if `company`/`location` came back blank — the list view already drops blank meta parts (`renderJobRow`, mockups/render.ts). Only the three load-bearing fields are required (`isSavableJob`): id for dedupe, url to open, title to show; a card missing any of them is dropped.

   **Field-break guard — notice when a field stops reading (issue #52).** A soft drift signal on its **own axis**, decided by its own pure reducer (`reduceFieldHealth`) and persisted in its own key (`'fieldHealth'`), exactly as `reducePushHealth`/`pushHealth` sit beside scan health — **not** a new `PageOutcome` arm. Folding it into that worst-first enum would force a ranking and let a `structure-changed` on one watch mask a field break on another; a page can be `ok` on every §16.3 count and still have a dead selector.

   - **What is guarded:** the four always-present fields — `title`, `company`, `location`, `url` (0 blank across 50 measured postings) — plus one **invariant** that stands in for the one field that *cannot* be counted. The posting **date** is legitimately absent from a third to two-thirds of a healthy page (LinkedIn withholds it on opened postings, showing a `Viewed` badge instead), so a guard on the raw date count would have fired on both healthy captures. The invariant instead: **every posting carries a `<time>` date *or* a footer state label, never neither** (50/50, no exceptions). Read straight off `linkedInStatus` (§5): `posted` = a date was read, `viewed`/`promoted`/`applied` = a label, `null` = neither — so an unobserved `Promoted` card counts rather than trips a false alarm. **Reposted is deliberately excluded** — no reposted card has ever been captured, so there is no baseline for "normal."
   - **The threshold is a cliff, not a slope:** fires only when a guarded field is present on **zero** of the scan's postings, never a ratio. A class rename hits every card in one deploy, so a real break is `0 of N`, not `18 of 25`; `COMPLETE_READ_RATIO` (0.9) guards a different question — did we read the whole list — and is deliberately **not** reused. A **sample floor** of 5 postings (a judgement call, not from the captures) means `0 of 1` never trips the alarm; below it the scan is not judged and the prior state is carried unchanged.
   - **Behaviour:** amber badge + a popup banner naming the field(s) and the count, **plus a once-a-day Telegram alarm** (issue #54, §8). No desktop notification (like the other soft failures). The badge and banner from #52 already existed and already failed to be noticed — the extension went quiet twice and it was weeks before anyone saw the amber badge sitting there — so #54 adds the one channel that persists in a chat the user actually reads. The strict `0-of-N` threshold is what pays for a channel that loud: a false positive is close to impossible, which is the only reason a daily alarm is defensible. The state persists across scans and clears on the first scan that reads every field again.

   A field blank on **every** card in a scan used to be only a console log; this guard turns that observation into a persisted, surfaced state (`fieldHealth`), on its own axis so it can be acted on rather than lost in the noise.

5. **Tab fails to load** (timeout, network down, 5xx). Outcome `load-failed`. **Behaviour:** **retry that one page once** (blips are transient), then **skip** it and continue the cycle — a transient failure on one watch must not abort the others. Crucially, `load-failed` **does not** count toward the empty-scan back-off: it's an infra failure, not a parser signal, so a flaky network doesn't masquerade as "LinkedIn changed the page." **Signal:** none in v1 beyond a logged event (repeated total-network-outage warning is deferred — if LinkedIn is fully unreachable the user has bigger cues).

6. **Stuck scan lock.** PRD §9 clears a stale lock on startup, but the MV3 worker can be torn down mid-cycle on *any* tick (§12), leaving `isScanning` stuck true and every future alarm skipping forever. **Decision: the stale-lock check runs on every alarm tick**, not just startup (`isLockStale`). **Threshold: 5 minutes** (`staleLockMs`, default 300 000) — comfortably above the 60–90s a real cycle takes (§9), and `isScanning` with a null `startedAt` is treated as stale (corrupt). A stale lock is cleared and the scan proceeds.

7. **Push failure.** §8 swallows every push failure so it can never break the scan — that stays. But a wrong chat id fails silently for days (§8). **Decision: track *consecutive* push failures** (`reducePushHealth`); after `pushFailWarnThreshold` (default 3) in a row with push enabled, surface a **soft** warning in the popup/options ("Telegram push has been failing — run Send test message"). One good send resets it. Never a desktop notification, never a scan break. The §8 "Send test message" button stays the primary check; this is the passive backstop given #6's lesson that silent-forever is the real danger.

8. **Where failures are recorded and surfaced.** One persisted `HealthState` (`'health'` key) is the single source of truth, so every surface agrees:

| Mechanism | Drives | v1? |
| --- | --- | --- |
| **Badge colour** | `severity`: default (ok) / amber (warn) / red (error); a field break (§16.4) bumps an otherwise-ok badge to amber | **v1** |
| **Popup banner** | `message` — one line describing the problem and the fix; a field break stacks its own amber banner | **v1** |
| **Desktop notification** | **Hard** failures only (`challenge`, `logged-out`), once on transition | **v1** |
| **Options error log** | A rolling list of the last N failure events with timestamps | **Deferred** — badge + banner + notification cover "find out"; a full log UI is post-v1 |

The split: hard failures (challenge, logged out) get an active push — a desktop notification — because they stop scanning and need the user now. Soft failures (parser drift, repeated empties, push failing) use only the passive badge + banner, so the tool doesn't cry wolf every quiet afternoon. The options error log is the one deferred piece; the three v1 channels already answer "how do you find out it broke."

### Structural consequence

Per §14, the decision logic is pure and tested (`src/health.ts` + `src/health.test.ts`): `classifyPage`, `aggregateOutcome`, `reduceScanHealth`, `isSavableJob`, `fieldReadCounts`/`aggregateFieldCounts`/`reduceFieldHealth` (the field-break axis, §16.4), `reduceFieldPush` (its once-a-day Telegram cadence, §8/issue #54), `reducePushHealth`, `isLockStale`. The message that alarm carries is `buildFieldBreakPush` in `src/push.ts`, proved against its copy. The content script reads the live DOM/URL into a `PageSignals` — including the per-field present-counts and the date-or-label count — and `background.ts` persists the `HealthState`/`fieldHealth`/`fieldBreakPush`, sets the badge, and fires notifications — none of that is unit-tested, all of the decisions are.

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

---

## 18. The scan window: why the page has to be on screen

Every section above §12 was written assuming a background tab — `tabs.create({ active: false })`, invisible, out of the way. That was issue #5's question 4 and it was left open, which meant the whole design rested on an assumption nobody had checked.

It was checked on **2026-07-24**, and it is false.

### The measurement

Chrome gives a tab you cannot see **no animation frames and heavily throttled timers**. LinkedIn's results column fills in lazily as the viewport moves, so it needs both. Measured on the same search page, in the same profile, minutes apart:

| Surface | Postings rendered |
| --- | --- |
| Visible tab | **25 of 25** |
| Hidden tab (`active: false`) | **7 of 25** |

Scrolling does not close the gap. The missing 18 rows were never painted, so there was nothing in the DOM to read — a parser fix could not have helped, because the parser was reading everything that existed. A hidden scan would have silently reported roughly a quarter of the postings and looked exactly like a quiet day.

### The decision

**The scan window is genuinely on screen, and that is not negotiable.** Given that, the job becomes making it the smallest thing to see that still renders:

1. **One window per *cycle*, not per page.** A nine-page cycle interrupts the user once instead of nine times. `openScanSession` / `closeScanSession` bracket the whole run; the per-page work only navigates the window that already exists.
2. **A `popup`-type window, `focused: false`,** placed at the bottom-right of whichever screen the user's browser is on (derived from the last-focused window's bounds, so it needs no `system.display` permission).
3. **Always closed in a `finally`,** even if parsing throws. A scan window that outlives its scan is the worst failure this design can produce, because it is the one the user has to clean up by hand.
4. **1000 × 720, and the width is load-bearing.** Below roughly 1024px LinkedIn switches `/jobs/search/` to a single-column layout the selectors have never been verified against, and 1000px is the width the 25-of-25 read was measured at. **The height is the dial to turn** for a less obtrusive window — the lazy-scroll walk simply takes a step or two more. The width should only move behind another measurement.
5. **Focus is borrowed only as a last resort.** Chrome also throttles a window it considers fully covered, so a page that comes back short is retried **once, with the window focused**, and focus is handed straight back to the window the user was in (captured before the retry, restored in a `finally`). This is the only point at which a scan takes focus, and it never happens on a first attempt.

### What it costs, stated plainly

A scan is now visible. There is no version of this that reads LinkedIn's results reliably and stays invisible, so the honest framing is that the extension trades invisibility for correctness — and then spends its effort on frequency instead. That is why §15's defaults matter more after this section than before it: the cheapest way to be seen less is to scan less. Manual-only (§15, decision 7) exists partly for exactly this reason.

### Structural consequence

Per §14 this is all wrapper code — `openScanSession`, `scanPageIn` and `closeScanSession` in `background.ts` are `chrome.windows.*` orchestration and are not unit-tested. What *is* pure and tested is everything they feed: `classifyPage` decides whether a short read is a retry case, `scan-probe.ts` owns the settle-polling and card-identity logic, and `parse.ts` reads the DOM the window produced. The window's own dimensions are named constants with the measurement written next to them, because the next person to shrink it needs to know which number was measured and which was chosen.

---

## 19. "Did you apply for this job?"

The list view tracks two things a job can be: *looked at* (`opened`) and *dealt with* (`read`). Neither says whether you actually applied — which is the only outcome the whole extension exists to produce, and the one thing it had no record of. A job you applied to and a job you glanced at and closed looked identical a week later.

### When the question is asked

**On opening a posting, on that job's own card.** Clicking a row opens LinkedIn in a new tab, marks the job opened, and queues the question against that job id. The card carries it when you come back.

Two details that look small and are not:

- **It is written to storage, not held in component state.** Opening a tab takes focus, and a popup that loses focus is destroyed. A question held in memory would never be asked at all.
- **It is asked on the card, never above the list.** A prompt at the top of the list is about "a job"; a prompt on the card is about *that* job, which is the only version that survives a list with four unanswered questions in it.

The question is **never asked twice** about the same job, and never asked about one already answered Yes. It does not re-open on its own — being re-asked on every popup reopen would make the popup unusable — but clicking the row queues it again.

### The two answers are not symmetrical

**No writes nothing.** Not `applied: false` — nothing. You might apply tomorrow, and a stored "no" is a fact with a shelf life. Three other actions mean the same thing and share the same path: the note step's Cancel, and either way of ticking the job read. That last one matters for safety: the tick can never write an applied record you did not ask for.

**Yes is two steps.** The answer, then a note box — quick-note chips as a head start, an auto-growing textarea, `Cmd/Ctrl + Enter` to save, `Esc` to cancel. Only **Save** records anything; cancelling at the note step takes the Yes back with it and lands exactly where No does. The note is optional, the answer is not.

Saving writes `applied`, `appliedAt` (first answer wins — it records when you applied, not when you last confirmed it) and `applyNotes` (overwritten, because a second answer is you correcting the note), then pushes the `[Applied]` Telegram message from §8.

### Undo takes the note with it

Tapping the **Applied** tag deletes all three fields rather than setting `applied: false`, so the job returns to the exact shape it had before it was ever answered — nothing left over to distinguish "I un-applied this" from "never applied", and the question becomes askable again. That does discard the note, which is the price of a one-tap undo, and the reason the control's accessible name spells the consequence out.

> **Known rough edge.** "Undo, and forget the note" is harsh for the only affordance a logged application has. The designed replacement — a *manage applied* strip with `Edit note` / `Not applied` — is specced in [docs/ui-redesign-followups.md](docs/ui-redesign-followups.md) and needs no storage change.

### Structural consequence

Per §14: `markJobApplied` and `clearJobApplied` are pure functions over the jobs map in `view.ts`, tested there; `buildAppliedMessage` is pure in `push.ts`. The components own only the two-step interaction, and the pending question id lives in the `ui` storage key beside the active chip and mode.

---

## 20. Importing a backup: the difference, then the choice

An import used to be a blind overwrite. The file was validated, the scan lock taken, and `settings`, `seen` and `jobs` written wholesale — anything in this browser but not in the file was gone. The only thing you were told beforehand was what the **file** held ("4 watches, 12 blocked companies, 128 jobs…"), never what you were about to lose.

The old rule behind that — *replace, don't merge* — was argued on one point that is still correct: **a merge can never be used to remove the entry you took the backup to get rid of.** So Replace survives, unchanged. What changed is that neither mode happens sight-unseen.

### Two modes, chosen on the first screen

**Merge** adds what the file has and keeps what is here. **Replace** makes this browser match the file exactly. Replace is not a legacy mode kept for compatibility; it is the only one that can remove anything, and it is the one with no undo.

The wizard between them shows only the screens with something to say — a file that changes nothing is two screens, not five — because a wizard that makes you press Next past three empty screens teaches you to press Next without reading, which is the habit this whole feature exists to break. "1 watch already here" is context standing beside an addition, not a reason for a screen.

Replace skips only the settings screen (there is nothing to tick when every value comes from the file). It keeps the list and history screens **even when all they hold is removals** — especially then, because the removals are the thing the old one-shot dialog never told anyone, and showing them is Replace's whole justification for surviving.

### The merge rules, and why each one goes the way it does

**A merge only ever adds.** Every list is a union, every timestamp collapses to the earlier one, and every "have you dealt with this" flag survives if either side has it set. That makes the merge *monotone*, which is what lets the wizard show a preview computed a minute ago: a round finishing in the meantime can only make the real result contain more.

- **Watches** match on id and then on **what the URL searches for**, with the local watch kept verbatim. Watch ids are `crypto.randomUUID()`, generated where the watch was typed, so two browsers configured with the same LinkedIn search never share one — matching on id alone would duplicate every watch on every merge, which is the failure that makes a merge feature worse than no merge feature. The honest consequence is worth stating rather than hiding: **a merge cannot rename or re-enable a watch. That is what Replace is for.** When a file's watch is dropped in favour of a local one under a different id, the file's jobs are re-pointed at the surviving id — otherwise they arrive carrying a `watchId` nothing matches, which `selectView` degrades to a blank chip and which reads as "the import lost my jobs".
- **Blocklists** union on the matching form, keeping the local spelling. A file's company entries are re-derived with `makeBlockedCompany` rather than trusted: §6 normalizes on *write* and an import is a write, and since the merge *matches* on `normalized`, deriving it is how it earns the right to compare on it.
- **Jobs** resolve to whichever record is **further along**. If either side says opened, dismissed or applied, that sticks; timestamps take the earlier value, following §19's "first answer wins". Descriptive fields keep the local record's — swapping a title under a row the user is reading is churn with no benefit — with one exception: `postedAt` and `postedPrecision` move **together** to whichever side is more precise, because that pair is the one place there is an objective better, and taking the date from one side and the confidence from the other would be a lie.
- **Notes are the one rule that does not pick a winner.** Two different notes against the same job are joined, this browser's first. A note is the only irreplaceable free text in the system; everything else a merge discards can be re-scanned, re-derived or re-typed in seconds. §19 already flags "undo takes the note with it" as its harsh edge, and losing one *silently*, inside an import that advertised itself as additive, would be strictly worse. Segments are de-duplicated, so re-importing the same file does not double a note.
- **Seen ids** union taking the **earlier** `firstSeenAt`. `dedupe.ts` keeps the existing stamp instead, and that is not a contradiction: there, a scan can only ever propose `now`, so existing already *is* earlier. Across two independent histories that guarantee is gone, and earlier is right three times over — the field is called `firstSeenAt`; `collectGarbage` prunes at `firstSeenAt + seenDays`, so the later stamp would quietly renew a memory past its schedule; and the minimum makes the merge commutative.

### Single-value settings are asked about, not decided

Everything that is not a list gets a row — grouped, so it reads in plain words (quiet hours is one decision, not three numbers) and only when the two sides actually differ, which in practice is two or three rows. Both values are on screen at once, which is why the control is a two-item toggle rather than a checkbox: a checkbox has room for one label, and the point of the screen is to show you both.

**Absent reads as "mine"**, the same absent-means-the-safe-thing idiom `manualOnly`, `notifyDesktop` and `applied` already use, so pressing through the wizard without touching anything produces a purely additive merge. The master switch is a normal row rather than a carve-out: the wizard's promise is that nothing is written that you did not see, and a silent carve-out breaks that promise in the direction you cannot notice.

The Telegram bot token and chat id are never a row and never merged. The merged settings go through the existing `restoredSettings`, so §backup rule 1 — the two credentials never come from a file, and the ones in this browser are what an import keeps — is still enforced in exactly one function.

### The page ships decisions, never a result

The `LJW_IMPORT` message carries the validated file, the mode and the ticked rows. It does **not** carry the merged maps the page just previewed, and the worker re-reads all three keys under the scan lock and re-plans against them.

This is not theoretical. A wizard takes minutes, and `settings` is written from outside the options page while it is open — the popup's master switch and a job row's Block button both write it. A merge computed on the page against a snapshot taken when the file was chosen would silently drop whatever landed in between.

There is deliberately **no** compare-and-retry refusal. The merge is monotone, so a recomputed result can only contain more; refusing would make the user redo the wizard to protect against nothing. The consequence to accept is that the counts shown can be smaller than the counts written — so the response carries the **recomputed** counts and the status line reports what happened rather than what was promised. (Replace does wipe a mid-wizard round's jobs. That is what it advertises.)

### Structural consequence

Per §14, a new pure module: `src/import-plan.ts` + `src/import-plan.test.ts`. `backup.ts` answers "what is in the file, and is it valid?"; this one answers "what would applying it do, and what do I get asked?" — the same seam `options-form.ts` → `settings-view.ts` already cuts.

`planImport(file, target, mode, choices)` is the **single entry point, called from both sides**: the options page previews with it and the worker writes with it. A preview computed by different code than the write is a preview that can lie; with one function the only thing that can drift is the *input*, and re-reading that under the lock is exactly what the worker does. Which screens exist, what each line says and what the confirm sentence reads are decided there too, so `src/components/import-preview.tsx` is props-only and holds no step state — the `selectView` pattern applied to a wizard.
