# How it works

The detail behind [the README](../README.md) — what a scan round actually does,
why the scan window is visible, and what each permission is for. You do not need
any of this to use the extension. It is here because a background tool that
reads a website on your behalf should be inspectable.

---

## One scan round, start to finish

```text
alarm fires
  └─ recover any stale lock, sweep tabs a dead cycle left open
  └─ open ONE scan window (unfocused, tucked into the corner)
  └─ for each enabled watch, in order:
       └─ for each page (1..depth):
            navigate the scan window to the page
            → content script walks the lazy list, parses cards as they render
            → [+ randomised 3–5s pause]
            → a short read retries once, with focus
       [+ randomised 8–12s pause between watches]
  └─ close the scan window
  └─ merge every watch's results → ONE dedupe pass
  └─ save → update badge → one notification → Telegram push
  └─ re-arm the next one-shot alarm
```

Two watches at one page each takes roughly 30–45 seconds; the same at two pages
each, 60–90. All of it fits comfortably inside the shortest gap the jittered
interval can produce.

### One notification per round

Not one per watch, and never one per job. A role that surfaces under two of your
searches notifies once, because deduplication happens on LinkedIn's job ID alone
after every watch has been read.

### Opened state survives re-scans

Re-finding a job you already looked at never re-inflates the badge. The record of
what you have seen is keyed on the job ID and outlives the posting.

### Your own LinkedIn tabs are never touched

Each scan window is stamped with a one-time token. The content script refuses to
read any page that does not carry a matching one, so a LinkedIn tab you happen to
have open is invisible to the extension.

---

## Why the scan window is visible

It used to be a hidden background tab. That was the original design, it was never
verified, and when it finally was — on 24 July 2026 — it turned out not to work.

Chrome gives a tab you cannot see no animation frames and heavily throttled
timers. LinkedIn's results column needs both to fill in rows as you scroll.
Measured on the same page, **a visible tab rendered 25 of 25 postings and a
hidden one 7 of 25.** The missing 18 were never painted, so there was nothing to
read; no amount of scrolling closes that gap.

Since the window has to be seen, it is made as small a thing to see as possible:

- **One window per round**, not per page — a nine-page round interrupts you once
  instead of nine times.
- **Unfocused**, and tucked into the bottom-right corner of whichever screen your
  browser is on.
- **Always closed afterwards**, even if parsing throws.
- **1000 × 720**, which is not arbitrary: below roughly 1024px LinkedIn switches
  the search page to a single-column layout the parser has never been verified
  against, and that width is what the 25-of-25 read was measured at.

**It only takes focus as a last resort.** Chrome also throttles a window it
considers fully covered, so if a page comes back short the extension retries that
one page with the window focused, then hands focus straight back to wherever you
were. That is the only moment a scan takes focus, and it only happens after the
quiet attempt already failed.

**A short read tells you.** If a page yields far fewer postings than it
advertised, the badge turns amber and the list says so — rather than a partial
scan passing as a quiet day.

---

## What happens when it breaks

Silence is indistinguishable from "no new jobs", so every failure has a decided
behaviour and a decided signal.

| What went wrong | What the extension does | How you find out |
| --- | --- | --- |
| **Signed out of LinkedIn** | Pauses scanning — hitting a login wall every round is pointless. Resumes by itself once a round comes back clean | Red badge, banner, one desktop notification |
| **Verification challenge / captcha** | **Halts entirely.** Not backed off — stopped. Loading more pages through a verification wall is exactly what escalates to a restriction | Red badge, banner, one desktop notification. Only **Resume** clears it |
| **LinkedIn changed its page layout** | Warns immediately, and lengthens the interval so it stops hammering | Amber badge and banner |
| **Genuinely no results** | Nothing, until it happens three rounds running — one quiet search is normal | Amber badge and banner after the third |
| **A page failed to load** | Retries that page once, then skips it and carries on with the other watches | Logged only. A flaky network is not a parser problem |
| **Some fields missing on a card** | Saves and shows it anyway, as long as it has an ID, a title and a link. Blank fields simply drop out of the row | Nothing — a per-card blank is normal |
| **Telegram push failing** | Swallowed, always. A push failure can never break a scan or the badge | Soft warning after three consecutive failures |
| **A round died mid-scan** | The next round clears the stuck lock (anything older than 5 minutes) and closes any windows the dead round left open | Nothing — it self-heals |

**Automatic back-off.** After three consecutive rounds that find nothing at all,
the interval doubles on each further empty round, up to a ceiling of 240 minutes.
One round that finds something snaps it straight back to your configured
interval.

**Nothing runs while Chrome is closed.** This is a hard platform limit —
extensions have no background process independent of the browser, and no
extension can work around it. On relaunch, one catch-up round runs at the deeper
catch-up page depth. Quiet hours ending is treated as the same situation, and
gets the same catch-up round.

---

## Permissions, and why

| Permission | Why it is needed |
| --- | --- |
| `storage`, `unlimitedStorage` | Your settings, the IDs of jobs already seen, the job records behind the list |
| `alarms` | The scan cadence. Survives Chrome tearing the background worker down, which a plain timer would not |
| `notifications` | New-job and health alerts |
| `tabs`, `scripting` | Opening and closing the scan window, and messaging the page reader inside it |
| `https://www.linkedin.com/*` | The pages being read |
| `https://api.telegram.org/*` | Telegram push. Only ever contacted if you switch it on |

**No data leaves your browser** except the Telegram message you explicitly
configure. There is no server, no analytics, and no account. Your Telegram token
lives in `chrome.storage.local` alongside your settings and is never committed
anywhere.

---

## Storage, and what gets thrown away

Two records with two different lifetimes:

- **Seen IDs** — a job ID and the moment it was first found. Tiny, and kept
  longer, because its only job is to stop the same posting being announced twice.
  A job filtered out by your blocklist still counts as seen, or every round would
  rediscover and refilter it forever.
- **Job records** — the full title, company, location and state behind each row.
  Kept only while the row is still worth showing.

Once you have opened or read a job and some time has passed, the full record is
dropped and only the seen ID remains. That split is what keeps storage from
growing without limit, and it only ever runs that way round: the memory outlives
the record, never the reverse. A seen ID whose job is still in your list is held
back even once it is older than the seen limit — dropping it first would let a
posting still live on LinkedIn be announced to you a second time, and show you
nothing new when you looked.

The pruning itself ([src/gc.ts](../src/gc.ts)) runs on its own daily alarm, never
on the scan path — writing the seen map re-serialises the whole thing, which is
not work to put in the middle of a round. A clean-up that finds a scan in progress
skips its turn and collects the next day.

Settings → **Retention** → **Delete all job history** does the same job by hand
and without limits: every record and every seen ID, gone. It leaves your settings
alone, and it cannot be undone — with the seen IDs gone, the next round treats
everything still live on LinkedIn as new.

It is unavailable while a round is running, for the same reason the clean-up
skips one, only more so: the round ends by comparing what it found against the
seen IDs, so deleting them underneath it would have it decide everything is new
and write the lot straight back. The delete runs in the background worker and
holds the scan lock while it works, so a round cannot start underneath it either.

---

The full specification, including the reasoning behind every number above, is
[prd.md](../prd.md).
