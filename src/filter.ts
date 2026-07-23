// Filtering — PRD §3 "Filtering" / §6 "Company blocklist matching" & "Reposted".
//
// This is the reference example for issue #7 (06 — "How does the coding agent know
// it hasn't broken anything?"). It is one of the pure-logic pieces named there:
// company/keyword blocklist matching and the reposted rule. It touches no chrome.*
// API, no DOM and no network, so `node --test` proves it with plain values and no
// browser. Every build ticket's decision logic follows this same shape — see
// prd.md §14 ("How the agent knows it hasn't broken anything").

/** The subset of a Job (PRD §5) the filter decision needs. Structural: a full
 *  `Job` record satisfies it, so `passesFilters(job, rules)` type-checks. */
export type FilterJob = {
  title: string;
  company: string;
  isReposted: boolean;
};

/** The subset of Settings (PRD §5) that governs filtering. `blockedCompanies`
 *  is the *already-normalized* form (PRD §6: normalize on write, not on read). */
export type FilterRules = {
  blockedCompanies: string[]; // normalized (lowercased) company fragments
  blockedTitleKeywords: string[];
  hideReposted: boolean;
};

/**
 * Fold a company name into its match form: lowercased and trimmed. PRD §6 does
 * this once, when the blocklist entry is saved, so a scan never re-lowercases the
 * whole list. Callers normalize both the stored fragments and the job's company
 * with this same function so the two sides compare like-for-like.
 */
export function normalizeCompany(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * True if `company` contains any blocked fragment. Substring match (PRD §6) so a
 * single "acme" entry catches "Acme Corp" and "PT Acme Indonesia" alike.
 * `blockedNormalized` is assumed already lowercased (see {@link normalizeCompany}).
 */
export function isCompanyBlocked(company: string, blockedNormalized: string[]): boolean {
  const c = normalizeCompany(company);
  return blockedNormalized.some((fragment) => c.includes(fragment));
}

/**
 * True if the title contains any blocked keyword, case-insensitively (PRD §3:
 * e.g. "Senior", "Intern"). Same substring approach as the company blocklist.
 */
export function isTitleBlocked(title: string, keywords: string[]): boolean {
  const t = title.toLowerCase();
  return keywords.some((kw) => t.includes(kw.toLowerCase()));
}

/**
 * The surface-it decision: `true` means show/notify this job, `false` means drop
 * it (but the caller still marks it seen — PRD §6 "Seen means evaluated, not
 * shown"). Combines the two blocklists and the reposted rule (PRD §6:
 * `if (hideReposted && isReposted) continue`).
 */
export function passesFilters(job: FilterJob, rules: FilterRules): boolean {
  if (rules.hideReposted && job.isReposted) return false;
  if (isCompanyBlocked(job.company, rules.blockedCompanies)) return false;
  if (isTitleBlocked(job.title, rules.blockedTitleKeywords)) return false;
  return true;
}
