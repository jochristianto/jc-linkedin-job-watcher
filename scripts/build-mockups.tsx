// Regenerate mockups/*.html from the real components — `npm run build:mockups`.
//
// The mockups used to be hand-authored HTML that mirrored what render.ts
// emitted, with a note admitting it was "not the compiled component". That was
// affordable when the component *was* a string template; against React + Tailwind
// it would be a guaranteed lie, since the classes come out of the components and
// the CSS out of the compiler.
//
// So they are generated now: the same components production mounts, rendered to
// static HTML with fake data, over the real compiled stylesheet inlined into a
// <style> block. The important property survives — a committed file you can open
// straight from `file://` with no build step and no extension — and the drift
// cannot.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyState } from "../src/components/empty-state.tsx";
import { HealthBanner } from "../src/components/health-banner.tsx";
import { HowItWorks } from "../src/components/how-it-works.tsx";
import { JobList } from "../src/components/job-list.tsx";
import { HeaderMenu, ListHeader } from "../src/components/list-header.tsx";
import { SettingsNav } from "../src/components/settings-nav.tsx";
import { WatchList } from "../src/components/watch-list.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../src/components/ui/card";
import { ScanStatusBar } from "../src/components/scan-status.tsx";
import { Toolbar } from "../src/components/toolbar.tsx";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type {
  EmptyKind,
  JobView,
  ListMode,
  ScanStatus,
  ViewVariant,
} from "../src/view-model.ts";
import type { Watch } from "../src/types.ts";

const root = resolve(import.meta.dirname, "..");
const noop = () => {};

// ── The compiled stylesheet ─────────────────────────────────────────────────
// Tailwind v4 finds its own sources by scanning out from the input CSS file, so
// this picks up every class in src/components/ with no config to keep in step.

function compileCss(): string {
  const dir = mkdtempSync(join(tmpdir(), "ljw-mockups-"));
  try {
    const out = join(dir, "mockups.css");
    execFileSync(
      "npx",
      [
        "@tailwindcss/cli",
        "-i",
        join(root, "src/tokens.css"),
        "-o",
        out,
        "--minify",
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
    );
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Fake data ───────────────────────────────────────────────────────────────

/** A frozen clock, so "Found 41m ago" is the same string on every build and the
 *  generated files only change when a component does. */
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);
const minsAgo = (m: number) => NOW - m * 60_000;

function job(over: Partial<JobView> = {}): JobView {
  return {
    id: "3901",
    title: "Senior Software Engineer",
    company: "Acme Corp",
    location: "Jakarta, Indonesia (Hybrid)",
    postedText: "2 hours ago",
    watchName: "Indonesia",
    url: "https://www.linkedin.com/jobs/view/3901/",
    foundAt: minsAgo(41),
    opened: false,
    read: false,
    blocked: false,
    applied: false,
    notes: "",
    ...over,
  };
}

const WATCHES = [
  { id: "w1", name: "Indonesia" },
  { id: "w2", name: "Japan" },
];

/** The popup's list: unread rows, one already opened, one whose location never
 *  parsed (the field-missing case), one blocked company still on screen. */
const POPUP_JOBS: JobView[] = [
  job({
    id: "1",
    title: "Senior Backend Engineer (Go)",
    company: "Tokopedia",
    postedText: "12 minutes ago",
    foundAt: minsAgo(4),
  }),
  job({
    id: "2",
    title: "Staff Engineer, Platform",
    company: "GoTo Financial",
    location: "Jakarta (On-site)",
    postedText: "1 hour ago",
    foundAt: minsAgo(23),
    opened: true,
  }),
  // Location never parsed — the meta line must not leave a dangling separator.
  job({
    id: "3",
    title: "Principal Engineer",
    company: "Momo Financial",
    location: "",
    postedText: "3 hours ago",
    foundAt: minsAgo(58),
  }),
  job({
    id: "4",
    title: "Engineering Manager",
    company: "Blocked Recruiters Ltd",
    location: "Remote",
    postedText: "5 hours ago",
    foundAt: minsAgo(94),
    blocked: true,
  }),
];

/** The tab's list: everything the popup shows plus the states only "All" mode
 *  reaches — a read row still on screen, and a Block button mid-question. */
const TAB_JOBS: JobView[] = [
  ...POPUP_JOBS,
  job({
    id: "5",
    title: "Distinguished Engineer",
    company: "Grab",
    location: "Singapore (Hybrid)",
    postedText: "yesterday",
    foundAt: minsAgo(1_100),
    watchName: "Japan",
    read: true,
  }),
  job({
    id: "6",
    title: "Head of Engineering",
    company: "Sea Group",
    location: "Singapore (Remote)",
    postedText: "yesterday",
    foundAt: minsAgo(1_240),
    watchName: "Japan",
  }),
  // The applied record, with the note it was logged against — the one row that
  // shows the list doubling as a record of what you sent.
  job({
    id: "7",
    title: "Director of Engineering",
    company: "PT Acme Indonesia",
    location: "Jakarta, Indonesia (On-site)",
    postedText: "1 day ago",
    foundAt: minsAgo(1_380),
    opened: true,
    applied: true,
    notes: "Referral · Cover letter v3, asked about the platform team",
  }),
];

/** Three saved searches for the Options mockup: two running, one paused, and
 *  between them enough URL parameters to show every chip `watchUrlChips` reads —
 *  place, recency, job type and workplace. */
const MOCK_WATCHES: Watch[] = [
  {
    id: "w1",
    name: "SE @ Japan",
    enabled: true,
    url: "https://www.linkedin.com/jobs/search/?f_TPR=r86400&geoId=101355337&keywords=Software%20Engineer&origin=JOB_SEARCH_PAGE",
  },
  {
    id: "w2",
    name: "SE @ Indonesia",
    enabled: true,
    url: "https://www.linkedin.com/jobs/search/?f_JT=F&f_TPR=r86400&geoId=102478259&keywords=Software%20Engineer&origin=JOB_SEARCH_PAGE",
  },
  {
    id: "w3",
    name: "SE @ Singapore",
    enabled: false,
    url: "https://www.linkedin.com/jobs/search/?f_TPR=r86400&f_WT=2&geoId=102454443&keywords=Software%20Engineer&origin=JOB_SEARCH_PAGE",
  },
];

// ── Page shells ─────────────────────────────────────────────────────────────

function page(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <!-- GENERATED by \`npm run build:mockups\` — do not edit by hand.
         Rendered from the real components in src/components/, over the real
         compiled Tailwind stylesheet. Light and dark both ship; dark follows the
         OS through prefers-color-scheme, with no JS. -->
    <style>
${css}
    </style>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

/** The list view, assembled exactly as `<ListView>` assembles it — minus the
 *  storage reads, with the state passed in instead. */
function listView(opts: {
  variant: ViewVariant;
  title: string;
  badge: number;
  jobs: JobView[];
  mode: ListMode;
  activeWatchId: string | null;
  status: ScanStatus;
  armedBlockId?: string | null;
  banner?: { message: string; severity: "warn" | "error" };
}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <div
        data-variant={opts.variant}
        className={
          opts.variant === "popup"
            ? "flex h-150 min-h-120 w-95 flex-col overflow-hidden bg-background"
            : "flex h-screen flex-col overflow-hidden bg-background"
        }
      >
        <ListHeader
          title={opts.title}
          badge={opts.badge}
          scanButton={opts.status.kind === "scanning" ? "scanning" : "idle"}
          variant={opts.variant}
          enabled={opts.status.kind !== "disabled"}
          // Derived from the chip exactly as <ListView> derives it, so a mockup
          // showing a filtered list also shows the narrowed bulk-read wording.
          filtered={opts.activeWatchId !== null}
          onToggleEnabled={noop}
          onScan={noop}
          onMarkAllRead={noop}
          onOpenTab={noop}
          onOpenOptions={noop}
        />
        <Toolbar
          watches={WATCHES}
          activeWatchId={opts.activeWatchId}
          mode={opts.mode}
          onWatchChange={noop}
          onModeChange={noop}
        />
        {opts.banner && (
          <HealthBanner
            message={opts.banner.message}
            severity={opts.banner.severity}
          />
        )}
        <div className="flex-1 overflow-y-auto bg-[color-mix(in_oklab,var(--muted)_45%,var(--background))]">
          <div className="mx-auto w-full max-w-220 p-2.5 md:p-3.5">
            <JobList
              jobs={opts.jobs}
              mode={opts.mode}
              variant={opts.variant}
              now={NOW}
              armedBlockId={opts.armedBlockId ?? null}
              onOpen={noop}
              onToggleRead={noop}
              onBlock={noop}
              onUnapply={noop}
            />
            <div className="px-1 pt-3.5 pb-1 text-center text-xs text-muted-foreground">
              {opts.jobs.length} shown · opened jobs are cleared after 7 days
            </div>
          </div>
        </div>
        <ScanStatusBar
          status={opts.status}
          unread={opts.badge}
          watchCount={WATCHES.length}
        />
      </div>
    </TooltipProvider>,
  );
}

/**
 * The popup's header menu, as the dialog panel it opens into.
 *
 * Its own frame rather than part of the popup frame, because a Radix dialog
 * cannot be rendered here at all: it draws nothing until it is open, and its
 * portal has no DOM to portal into under `renderToStaticMarkup`. Rendering
 * `HeaderMenu` directly is what keeps these three controls visible in the
 * mockups — the alternative is a picture of the popup with its whole right-hand
 * side reduced to one anonymous button.
 */
function headerMenuFrame(): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <div className="flex flex-col gap-2 p-4">
        <p className="font-mono text-xs text-muted-foreground">
          popup header menu — behind the one header button
        </p>
        <div className="flex w-87 flex-col gap-4 rounded-lg border bg-background p-4 shadow-lg">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold">Job Watcher</h2>
            <p className="text-xs text-muted-foreground">
              Everything this popup can do.
            </p>
          </div>
          <HeaderMenu
            enabled={true}
            filtered={false}
            onToggleEnabled={noop}
            onMarkAllRead={noop}
            onOpenOptions={noop}
          />
        </div>
      </div>
    </TooltipProvider>,
  );
}

const EMPTY_KINDS: EmptyKind[] = [
  "no-watches",
  "no-jobs-yet",
  "no-new",
  "scanning",
  "scan-error",
];

/** All five empty/degraded states side by side, each in a popup-width frame so
 *  they are seen at the size they actually appear. */
function statesShowcase(): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-8">
        <h1 className="text-lg font-semibold">Empty &amp; degraded states</h1>
        <div className="flex flex-wrap gap-5">
          {EMPTY_KINDS.map((kind) => (
            <figure key={kind} className="flex flex-col gap-2">
              <figcaption className="font-mono text-xs text-muted-foreground">
                {kind}
              </figcaption>
              <div className="flex h-[280px] w-[360px] flex-col rounded-lg border bg-background">
                <EmptyState kind={kind} />
              </div>
            </figure>
          ))}
        </div>
      </div>
    </TooltipProvider>,
  );
}

// ── Write them ──────────────────────────────────────────────────────────────

const css = compileCss();

const files: Record<string, string> = {
  "popup.html": page(
    "Popup — LinkedIn Job Watcher",
    css,
    // The popup as it opens, and beside it the menu its one header button leads
    // to. Two frames because the second cannot be rendered inside the first —
    // see `headerMenuFrame`.
    `<div class="flex flex-wrap items-start gap-2">${listView({
      variant: "popup",
      title: "New jobs",
      badge: 3,
      jobs: POPUP_JOBS,
      mode: "new",
      activeWatchId: null,
      status: { kind: "waiting", remainingMs: 252_000, quiet: false },
    })}${headerMenuFrame()}</div>`,
  ),
  "jobs.html": page(
    "Jobs tab — LinkedIn Job Watcher",
    css,
    listView({
      variant: "tab",
      title: "LinkedIn Job Watcher",
      badge: 4,
      jobs: TAB_JOBS,
      mode: "all",
      activeWatchId: null,
      // The state you cannot discover by looking at a resting row.
      armedBlockId: "6",
      status: { kind: "scanning" },
    }),
  ),
  "states.html": page("States — LinkedIn Job Watcher", css, statesShowcase()),
  "options.html": page(
    "Options — LinkedIn Job Watcher",
    css,
    // The Options *form* reads chrome.storage on mount, so the page as a whole
    // cannot be rendered headlessly the way the list view can. Three parts of it
    // can, because they take everything they show as props: the rail, the watch
    // rows — the most-changed piece of the redesign, and the one whose URL chips
    // are worth being able to look at — and the how-it-works explainer. They are
    // laid out here the way the real page lays them out, on the same surface
    // colour. Below them, the banner pair: the two things on that page a
    // screenshot would otherwise never show.
    renderToStaticMarkup(
      <div className="bg-[color-mix(in_oklab,var(--muted)_45%,var(--background))] p-6">
        <div className="mx-auto flex w-full max-w-275 flex-wrap items-start gap-4">
          <SettingsNav
            active="watches"
            dirty={new Set(["scanning"] as const)}
            onSelect={noop}
          />

          <main className="flex min-w-0 flex-1 basis-115 flex-col gap-3.5">
            <Card className="gap-4 py-5">
              <CardHeader className="gap-1.5 px-5">
                <CardTitle className="flex flex-wrap items-center gap-2 text-[15px] tracking-tight">
                  Watches
                </CardTitle>
                <CardDescription className="text-[12.5px] leading-relaxed text-pretty">
                  A watch is a saved LinkedIn search with your filters already
                  applied. Every watch runs on the same cycle — switch one off
                  to pause it without losing the URL.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                <WatchList watches={MOCK_WATCHES} onChange={noop} />
              </CardContent>
            </Card>

            <Card className="gap-4 py-5">
              <CardHeader className="gap-1.5 px-5">
                <CardTitle className="text-[15px] tracking-tight">
                  How this works
                </CardTitle>
                <CardDescription className="text-[12.5px] leading-relaxed text-pretty">
                  It re-runs your saved searches in the background and tells you
                  when something genuinely new turns up — so you can stop
                  refreshing the tab yourself.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                <HowItWorks />
              </CardContent>
            </Card>

            <p className="text-sm text-muted-foreground">
              The rest of the form is live over <code>chrome.storage</code>, so
              it is not rendered here — load the unpacked extension and open
              Options to see it. Its two transient banners are below, since
              neither shows on a healthy first open.
            </p>
            <HealthBanner
              message="Telegram push has been failing — run Send test message"
              severity="warn"
              className="rounded-md border"
            />
            <HealthBanner
              message="Signed out of LinkedIn — scanning paused."
              severity="error"
              className="rounded-md border"
            />
          </main>
        </div>
      </div>,
    ),
  ),
};

for (const [name, html] of Object.entries(files)) {
  const path = join(root, "mockups", name);
  writeFileSync(path, html);
  console.log(
    `  wrote mockups/${name}  (${(html.length / 1024).toFixed(0)} kB)`,
  );
}
