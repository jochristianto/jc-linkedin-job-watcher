# Contributing

This is a personal tool, built mostly by a coding agent against a written spec.
Patches are welcome; so is forking it and never speaking to me again. Read
[LICENSE.md](LICENSE.md) first — you may share and modify this freely, but you
may not publish it as an extension or sell it.

---

## Getting set up

```bash
nvm use        # optional, picks up .nvmrc → Node v24.18.0
npm install
npm test       # 507 unit tests, no browser needed
npm run build  # → dist/
```

Then load `dist/` as an unpacked extension — see the [install steps](README.md#install-5-minutes).

| Command | What it does |
| --- | --- |
| `npm test` | The whole suite via `tsx --test`. No bundler, no browser, no LinkedIn session |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | → `dist/`. **Never** contains credentials |
| `npm run build:dev` | → `dist/` with `.env` baked in as Options defaults. Local only |
| `npm run build:mockups` | Regenerates `mockups/*.html` from the real components |
| `npm run send-test-message` | Sends one real Telegram message in the production format |

**No environment setup is required for any of it.** The build reads no
environment variables. The only optional extra is `cp .env.example .env`, which
unlocks the two Telegram dev helpers described [below](#telegram-dev-helpers-env).

**After changing code:** re-run `npm run build`, then press **Reload** (⟳) on the
extension card in `chrome://extensions`.

---

## The one architectural rule

From [prd.md §14](prd.md):

> **Every decision lives in a pure, tested module. The `chrome.*` wrappers hold
> no logic and are not unit-tested.**

This is not a preference. The extension runs unattended in a background service
worker, so an agent with no way to check its own work would report success on
code that never ran. Keeping decisions in pure functions is what makes them
checkable by `npm test` without a browser.

| | |
| --- | --- |
| **Pure & tested** | [parse.ts](src/parse.ts) · [filter.ts](src/filter.ts) · [dedupe.ts](src/dedupe.ts) · [schedule.ts](src/schedule.ts) · [health.ts](src/health.ts) · [lifecycle.ts](src/lifecycle.ts) · [scan.ts](src/scan.ts) · [view.ts](src/view.ts) · [view-model.ts](src/view-model.ts) · [gc.ts](src/gc.ts) · [options-form.ts](src/options-form.ts) · [settings-view.ts](src/settings-view.ts) · [push.ts](src/push.ts) · [notify.ts](src/notify.ts) |
| **Side-effect wrappers** | [background.ts](src/background.ts) · [content.ts](src/content.ts) · [storage.ts](src/storage.ts) · [jobs-tab.ts](src/jobs-tab.ts) · [components/](src/components/) · [hooks/](src/hooks/) |

In practice: if a function needs a `chrome.*` stub to be tested, it is on the
wrong side of the line — pull the decision out instead of stubbing. Injected
dependencies are the escape hatch where one is genuinely needed
(`sendPush(jobs, cfg, fetchImpl = fetch)`).

`selectView` in [view.ts](src/view.ts) is the reference example. It decides
*everything* the list view shows — the badge count, which empty state, which
banners, the scan status — as plain data. The components only map that to JSX,
which is why the suite needs no DOM: component tests render to a string with
`react-dom/server`, and the assembly logic is asserted on values.

The same split now covers the Options page:
[options-form.ts](src/options-form.ts) owns validation and the storage
round-trip, [settings-view.ts](src/settings-view.ts) owns everything the
redesigned page *derives* — which section holds an unsaved edit, the chips read
back out of a watch's URL, the one-line header summary, and the daily page-load
estimate with its Gentle / Heavy / Risky tier.

### The parser test skips on purpose

[parse.test.ts](src/parse.test.ts) needs saved LinkedIn HTML, and a page saved
from a logged-in session carries profile chrome that must never be committed.
Fixtures live in `.scratch/linkedin-job-watcher/fixtures/` and are gitignored, so
the test calls `test.skip` when the file is absent — that is the one skipped test
in a green run, not a failure. Capture the pages yourself and it runs.

When LinkedIn moves its DOM, that test is the alarm. Re-capture, re-run, fix
selectors until green.

---

## How the build is put together

Two Vite builds run in sequence:

1. [vite.config.ts](vite.config.ts) emits the service worker plus the three HTML
   pages (`popup.html`, `jobs.html`, `options.html`).
2. [vite.content.config.ts](vite.content.config.ts) appends `content.js` as an
   IIFE — an MV3 content script cannot be an ES module.

[extension/](extension/) is **not** an input to either. It is the issue #5
measurement spike and is deliberately excluded; see
[extension/README.md](extension/README.md).

---

## UI stack

**React 19 + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com).** The registry
components live unmodified in [src/components/ui/](src/components/ui/) so
`npx shadcn add` can be re-run over them; app-specific styling goes in the
components that *use* them.

Two things that will trip you up:

- **Tailwind is configured in CSS**, in [src/tokens.css](src/tokens.css) — there
  is no `tailwind.config.js` to go looking for. The palette is this project's own
  (warm grey page, LinkedIn blue) expressed in OKLCH under shadcn's semantic
  names. `--primary` is the brand blue; `--accent` is shadcn's *subtle tint*
  role, not the brand.
- **Dark mode follows the OS with zero JS.** shadcn ships `dark:` as a `.dark`
  class variant that needs a toggle, so `@custom-variant dark` re-binds it to
  `prefers-color-scheme` and no class is ever set.

The cost of the stack, stated plainly: the popup's JS went from ~13 kB to
~320 kB (~100 kB gzipped). What it buys is one consistent, accessible component
set — focus rings, keyboard behaviour and ARIA come from Radix rather than from
remembering to add them.

### Conventions with tests behind them

- **No bare glyphs or emoji in the UI.** Icons are [Lucide](https://lucide.dev)
  SVG via `lucide-react`, stroked in `currentColor` and `aria-hidden`, with the
  label on the control around them. Characters like `✓ ↺ ⊘ ⚙ ✕` render at a
  different weight on every platform and emoji arrive pre-coloured, ignoring the
  theme. Guarded by tests in
  [components.test.tsx](src/components/components.test.tsx) and
  [mockups.test.ts](mockups/mockups.test.ts) — including `⌘`, which tofu-boxes
  off macOS, so shortcuts are spelled out as "Cmd/Ctrl + Enter".
- **Two actions never share an icon.** Also asserted.
- **Comments explain why, not what.** The existing ones are long and argue their
  case; match that rather than the density you would use elsewhere.

---

## Mockups

[mockups/](mockups/) holds `file://`-openable snapshots of every state worth
seeing. They are **generated** — `npm run build:mockups` renders the production
components with fake data and inlines the production stylesheet. Never hand-edit
them; regenerate. `npm test` checks that the generated pages still cover every
state.

`options.html` is the one exception: it is a live form over `chrome.storage` and
cannot be rendered headlessly, so it shows only the banners a healthy page never
displays. Load the unpacked extension to see the real page.

---

## Telegram dev helpers (`.env`)

Both are optional and exist only to save you typing a token into the Options page
while developing. Neither is needed to build, install, or run the extension.

```bash
cp .env.example .env
```

```ini
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

`.env` is gitignored. Get the two values from the
[Telegram setup steps](README.md#telegram-push-optional).

### `npm run send-test-message`

Sends a real Telegram message using the **exact** production format from
[src/push.ts](src/push.ts), so you can check how it reads on a phone without
waiting for a scan or even loading the extension. It loads `.env` via
`--env-file-if-exists`, so you can also pass the values inline:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=987654321 npm run send-test-message
```

### `npm run build:dev`

The Options page runs inside Chrome and cannot read a file on your disk, so the
only way to get `.env` values into it is for the build to paste them into the
code. That leaves your token in `dist/` as plain text — fine locally, not fine
for anything you share. Hence a separate command, which prints a warning every
time:

```text
⚠  DEV BUILD — your Telegram credentials from .env are embedded in dist/ as plain text.
   Do not share, zip or publish this dist/. Run `npm run build` for a clean one.
```

Three rules it follows:

- **A saved credential always wins.** The prefill only fills fields you left
  blank, so rebuilding cannot overwrite a token you typed by hand.
- **Nothing is saved automatically.** You still press **Save settings**; a
  build-time value never silently becomes stored state.
- **`npm run build` is unconditionally clean.** It does not check whether `.env`
  exists — production mode always compiles the constant to `null`, so the default
  build has no path to a leak.

---

## Where the documentation lives

| File | What it is for |
| --- | --- |
| [README.md](README.md) | The user's manual. Install, daily use, settings, troubleshooting. Nothing a non-developer would skip |
| [docs/how-it-works.md](docs/how-it-works.md) | What a scan round actually does, why the scan window is visible, permissions |
| [prd.md](prd.md) | The full specification, and the argument behind every decision. The source of truth when code and README disagree |
| [docs/ui-redesign-followups.md](docs/ui-redesign-followups.md) | What the UI redesign shipped, what it deferred, and how the rest would work |
| [mockups/README.md](mockups/README.md) | The eight UI decisions, and how the generated mockups stay honest |
| [extension/README.md](extension/README.md) | The issue #5 spike that proved a hidden tab does not work. Historical |
| [LICENSE.md](LICENSE.md) | Personal use, no store publication, no sale. The account risk is the user's |

**Keep them true.** A change that alters shipped behaviour is not finished until
the prose says the same thing:

- New or changed default → `prd.md` §5 / §15 **and** the settings table in
  `README.md`.
- New setting → `README.md`'s Options reference, plus `settings-view.ts`'s
  `SECTION_OF_FIELD` (typed exhaustively, so it will not compile otherwise).
- Visible UI change → `npm run build:mockups`, and check whether
  `docs/images/preview-*.png` still shows the truth.

The screenshots in `docs/images/` are captured by hand from the running
extension, not generated. They go stale silently — the only defence is looking.
