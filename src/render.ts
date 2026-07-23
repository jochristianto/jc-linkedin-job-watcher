// Shared list-view component for the LinkedIn Job Watcher (PRD §4).
//
// The PRD calls the list view "a shared component, mounted twice" — in
// popup.html (toolbar click, ~400px) and jobs.html (notification click, full
// tab). Issue #4 settled the build stack: plain Vite, no framework, plain
// TypeScript. So this component is plain functions that produce markup — no
// React/Preact/Svelte, nothing to cold-start. The page mounts it with a single
// `container.innerHTML = renderList(jobs, mode)` and delegates clicks off the
// container. The popup and the tab render the *same* markup; they diverge only
// through CSS driven by a `.view-popup` / `.view-tab` class on the root.
//
// These functions are pure (string in, string out) so the shape of every row
// and empty state is unit-testable without a DOM or chrome.* — which is exactly
// what the static mockups embed and what production reuses.

export type JobView = {
  id: string;
  title: string;
  company: string;
  location: string;
  postedText: string;
  watchName: string;
  url: string;
  opened: boolean;
};

export type ListMode = "new" | "all";

export type EmptyKind =
  | "no-watches"
  | "no-jobs-yet"
  | "no-new"
  | "scanning"
  | "scan-error";

/** Escape scraped text before embedding it in markup. LinkedIn titles contain
 * `&` and `<` often enough to break the row otherwise (mirrors push.ts). */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Join the present parts with " · ", dropping any that are missing so a blank
 * company or location never leaves a dangling separator (see #9). */
export function metaLine(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" · ");
}

/**
 * One job row. Fields fail independently: a missing company, location or
 * posted time is simply omitted; a missing title falls back to a placeholder
 * so the row is never blank (PRD §12 "each field fails independently").
 */
export function renderJobRow(job: JobView): string {
  // Only the title needs a fallback — it's the one field always rendered. The
  // rest (company, location, posted time) are dropped by metaLine when blank.
  const title = job.title.trim() ? esc(job.title) : "Untitled role";
  const meta = metaLine([esc(job.company), esc(job.location)]);
  const foot = metaLine([esc(job.postedText), esc(job.watchName)]);

  return `
    <a class="job" href="${esc(job.url)}" data-job-id="${esc(job.id)}" data-read="${job.opened}">
      <span class="job-dot" aria-hidden="true"></span>
      <span class="job-body">
        <span class="job-title">${title}</span>
        ${meta ? `<span class="job-meta">${meta}</span>` : ""}
        ${foot ? `<span class="job-foot">${foot}</span>` : ""}
      </span>
    </a>`.trim();
}

/**
 * The list. In "new" mode opened jobs are filtered out (the popup's default —
 * a quick glance at what's unread). In "all" mode every job stays on screen,
 * opened ones rendered read (PRD §3, and #9's read/unread question).
 */
export function renderList(jobs: JobView[], mode: ListMode): string {
  const visible = mode === "new" ? jobs.filter((j) => !j.opened) : jobs;
  return visible.map(renderJobRow).join("\n");
}

const EMPTY_STATES: Record<EmptyKind, { icon: string; title: string; body: string }> = {
  "no-watches": {
    icon: "🔍",
    title: "No searches yet",
    body: "Add a LinkedIn job search in Options to start watching.",
  },
  "no-jobs-yet": {
    icon: "🌱",
    title: "Nothing scanned yet",
    body: "The first scan hasn't finished. New jobs will show up here.",
  },
  "no-new": {
    icon: "✅",
    title: "All caught up",
    body: "No new jobs. Switch to All to see everything found.",
  },
  scanning: {
    icon: "🔄",
    title: "Scanning…",
    body: "Checking your searches. This list updates when it's done.",
  },
  "scan-error": {
    icon: "⚠️",
    title: "Last scan failed",
    body: "LinkedIn's page may have changed — selectors returned nothing. See Options.",
  },
};

/** A distinct, actionable message for each empty/degraded situation (PRD §5 of
 * the issue): no watches, nothing scanned, nothing new, mid-scan, scan broken. */
export function renderEmptyState(kind: EmptyKind): string {
  const s = EMPTY_STATES[kind];
  return `
    <div class="empty" data-kind="${kind}">
      <div class="empty-icon" aria-hidden="true">${s.icon}</div>
      <div class="empty-title">${s.title}</div>
      <div class="empty-body">${s.body}</div>
    </div>`.trim();
}
