# Prototype — where the eight card fields live on LinkedIn's new surface

Wayfinder ticket: [#64](https://github.com/jochristianto/jc-linkedin-job-watcher/issues/64).
Branch `prototype/new-ui-fields`, throwaway, not merged.

Prototype: [`new-ui-fields.mjs`](./new-ui-fields.mjs) — run from the repo root with
`node docs/prototypes/new-ui-fields.mjs`. It needs the local fixture
`.scratch/linkedin-job-watcher/fixtures/new-ui/linkedin-jobs-search-2026-08-11.html`,
which is gitignored and never committed (captured under #59).

Companion: [`classic-compare.mjs`](./classic-compare.mjs) runs the **shipped** parser
against the classic fixture, so the two surfaces are measured with the same ruler.

---

## Result

A **name-free reader recovers five of the eight fields at 25/25**, in one pass, using
no LinkedIn class name anywhere. Per [#63](https://github.com/jochristianto/jc-linkedin-job-watcher/issues/63)
the reader anchors on shape; the only LinkedIn-chosen token it touches is
`componentkey`, which is the job id's single home.

| Field | New surface | How |
|---|---|---|
| job id | **25/25** | `componentkey="job-card-component-ref-<id>"` on the card root |
| url | **25/25** | **derived** — `https://www.linkedin.com/jobs/view/<id>/` |
| title | **25/25** | two independent sources, agreeing 25/25 (below) |
| company | **25/25** | second paragraph of the lockup |
| location | **25/25** | third paragraph of the lockup |
| posted date | **25/25** as text | relative phrase only — **no `<time>` element exists** |
| `Reposted` | **0/25** | unresolved: absent, or absent *from this sample* |
| LinkedIn status | `Applied` 2/25 | `Promoted` and `Viewed` unresolved, same reason |

## The card

```
div[role="button"][tabindex="0"][componentkey="job-card-component-ref-<id>"]   ← card root
  div[componentkey="job-card-component-ref-<id>"]                              ← duplicate wrapper
    figure[aria-hidden]                                                        ← logo
    p → span                       "Software Engineer (Verified job)"          ← screen-reader copy
      span[aria-hidden="true"]     "Software Engineer"                         ← visible copy
    p                              "JELLYFISH"                                 ← company
    p                              "Greater Tokyo Area (On-site)"              ← location
    button[aria-label="Dismiss Software Engineer job"]
    …footer…
      p "Be an early applicant"  p "·"  p → span[aria-hidden] "1 hour ago"  p "Easy Apply"
```

The id appears **twice per card** — on the interactive root and on an inner wrapper —
so 50 occurrences for 25 postings. Anchor on the `role="button"` root.

**The `aria-hidden` scar holds, and matters more here than on classic.** The plain span
carries the *decorated* copy (`"Software Engineer (Verified job)"`) and the `aria-hidden`
sibling carries the clean visible text. A naive `textContent` reads the decoration into
the title. `fieldText`'s existing "prefer the `aria-hidden` copy" rule is exactly right
and must be carried over.

### Title has two independent sources, and they agree 25/25

1. **Dismiss button** — `button[aria-label^="Dismiss "][aria-label$=" job"]`, parsed with
   `/^Dismiss\s+([\s\S]+?)\s+job$/i`. Survives visual truncation; needs `[\s\S]` rather
   than `.` because titles contain newlines, and tolerates the doubled space seen on one card.
2. **First paragraph** of the lockup, `aria-hidden` copy preferred.

They agreed on all 25, including Japanese titles and one containing `&`. That agreement
is worth more than either source alone: **a disagreement means the card has moved**, which
is a free structural health signal — noted for
[#66](https://github.com/jochristianto/jc-linkedin-job-watcher/issues/66).

### Positional reading, and its limit

Company and location are the 2nd and 3rd paragraphs. This is positional, and positional
reading shifts if a card ever lacks a title or company. It held 25/25 here, but it is the
weakest link in the reader and should be paired with the title cross-check above rather
than trusted alone.

The footer is **not** positionally stable — it holds 1 to 5 phrases in varying order:

```
 25  Be an early applicant
 24  N hours ago
  2  Easy Apply
  2  Applied
  1  Actively reviewing applicants
  1  N connection works here
```

So the footer must be matched **by content**, not by index — which is also what confines
the `Reposted` match away from the title, preserving the #30 scar. Note there is no
description snippet on the new card at all, which removes the original over-block risk.

---

## Classic vs new, same ruler

`classic-compare.mjs` runs the shipped `parseJobCards` over the classic fixture:

| | Classic (25) | New (25) |
|---|---|---|
| cards showing a posted date | 9 | **25** |
| `Viewed` | 16 | 0 |
| `Promoted` | 2 | 0 |
| `Reposted` | 2 | 0 |
| `Applied` | 0 | 2 |
| `<time datetime>` elements | 9 | **0** |
| location carries `(Remote)`/`(Hybrid)`/`(On-site)` | 25/25 | 12/25 |

**Location needs no model change.** Both surfaces bundle the work type into the location
string; the new one merely omits it more often.

## Two findings the ticket did not anticipate

### 1. The exclusive-footer invariant is dead — and the break is in our favour

`src/types.ts:25` documents the slot as exclusive:

> The slot is EXCLUSIVE — the posting date, or `Promoted`, or `Viewed`, or `Applied`,
> never two — so this is the one honest answer to "why is there no date".

On classic that held: 9 dated, 16 viewed, no overlap. **On the new surface it is false.**
Both `Applied` cards carry a date *and* the badge:

```
4451500619  ["Actively reviewing applicants", "Applied", "Be an early applicant", "22 hours ago", "Easy Apply"]
4451131158  ["1 connection works here",       "Applied", "Be an early applicant", "21 hours ago"]
```

This is a **gain**, not a loss. On classic, 16 of 25 postings had no readable date at all
because a badge had displaced it. On the new surface every posting carries its age.

**Decided with the user: keep both.** `linkedInStatus` stops meaning *"why is there no
date"* and becomes *"what else LinkedIn says about this posting"*, alongside a `postedAt`
that is now always populated. Jobs already in storage keep their age and gain no badge
until they are seen again — accepted.

### 2. No `<time datetime>` anywhere — the date resolution loses an arm

Issue #48's four-way rule is *fresh phrase → `<time>` attribute → coarse-phrase midpoint →
nothing*. The middle arm is gone: **0 `<time>` elements in the whole document**, against 9
on classic.

Consequence: a posting older than a day resolves to `"estimated"` precision (the midpoint
of the range the phrase covers) where classic could read the exact day. Sub-day phrases are
unaffected — those always beat the attribute anyway (#43).

**Decided with the user: accept the estimate**, rendered with the existing `~` marker. The
live watch filters to `f_TPR=r86400`, so every posting it sees is sub-day and read to the
minute; the loss only bites on searches not currently run. Rejected: fetching the exact date
from each posting's detail page, which costs a page load per older job on a surface already
calling PerimeterX with `uc=scraping` (#59).

---

## What is still unresolved

**`Reposted`, `Promoted` and `Viewed` returned zero on all 25** — and this prototype cannot
say whether they are gone or merely absent from this sample.

The capture was taken with `f_TPR=r86400&sortBy=R` — **posted in the last 24 hours, newest
first** — which biases against all three. You are unlikely to have already *viewed* a posting
that went up an hour ago. The classic fixture's 16 `Viewed` came from a differently-filtered
search, so the two counts are not comparable evidence.

Against that: **`Applied` rendered twice**, so badges as a category are certainly still drawn
on the new card, and they sit in the footer strip where a content match will find them.

**Settling it needs one more capture** — the same search with the 24-hour filter off — which
is a signed-in observation. Tracked as its own task; #64 stays open behind it, because its bar
is that each of the eight is either demonstrated or named unavailable, and three are neither.

The reader should scan the footer for all three regardless: it already reads that strip, so
the match is free, and if LinkedIn still draws them it simply works.
