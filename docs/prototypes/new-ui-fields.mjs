/**
 * THROWAWAY PROTOTYPE — wayfinder #64, "Where do the eight card fields live on
 * the new surface?"
 *
 * Not production code and not on the build path. It answers one question: can a
 * name-free reader recover all eight fields from the new-surface capture, and
 * which fields are simply not there?
 *
 * Run from the repo root: node docs/prototypes/new-ui-fields.mjs
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

const FIXTURE =
  ".scratch/linkedin-job-watcher/fixtures/new-ui/linkedin-jobs-search-2026-08-11.html";

/** The card root. Structural (`role="button"`) + the one semantic attribute the
 *  new surface still carries. #63: shape first, and the id has exactly one home. */
const CARD = 'div[role="button"][componentkey^="job-card-component-ref-"]';

const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim();

/** LinkedIn duplicates visible text into a screen-reader sibling — on this surface
 *  the *plain* span holds the decorated copy ("Software Engineer (Verified job)")
 *  and the `aria-hidden` one holds the clean visible text. Same scar as classic,
 *  same fix: prefer the aria-hidden copy. */
const clean = (el) => {
  if (!el) return "";
  const hidden = el.querySelector('[aria-hidden="true"]');
  return norm((hidden ?? el).textContent);
};

// ─── field readers ──────────────────────────────────────────────────────────

const jobIdOf = (card) =>
  /job-card-component-ref-(\d+)$/.exec(card.getAttribute("componentkey") ?? "")?.[1] ?? "";

/** Derived, not read — the `/jobs/view/` anchor is gone from the new card (#61). */
const jobUrlOf = (id) => (id ? `https://www.linkedin.com/jobs/view/${id}/` : "");

/** Title source A: the dismiss button's label. Name-free, survives truncation. */
function titleFromDismiss(card) {
  const label = card
    .querySelector('button[aria-label^="Dismiss "][aria-label$=" job"]')
    ?.getAttribute("aria-label");
  return label ? norm(/^Dismiss\s+([\s\S]+?)\s+job$/i.exec(label)?.[1] ?? "") : "";
}

/** The card's paragraphs in document order, separators dropped. On this surface
 *  the lockup is [title, company, location] and everything after is footer. */
const paragraphsOf = (card) =>
  [...card.querySelectorAll("p")].map(clean).filter((t) => t && t !== "·");

/** Title source B: first paragraph. */
const titleFromLockup = (card) => paragraphsOf(card)[0] ?? "";
const companyOf = (card) => paragraphsOf(card)[1] ?? "";
const locationOf = (card) => paragraphsOf(card)[2] ?? "";

/** Everything after the lockup's three. The Reposted / status match is confined
 *  here and never to the whole card — over-blocking is permanent (#30). */
const footerPartsOf = (card) => paragraphsOf(card).slice(3);
const footerTextOf = (card) => footerPartsOf(card).join(" ");

const AGE_RE = /(\d+)\s*(second|minute|hour|day|week|month)s?\s+ago/i;
const postedTextOf = (card) => footerPartsOf(card).find((t) => AGE_RE.test(t)) ?? "";

const isReposted = (card) => /\breposted\b/i.test(footerTextOf(card));

function linkedInStatusOf(card) {
  const text = footerTextOf(card);
  if (/\bpromoted\b/i.test(text)) return "promoted";
  if (/\bapplied\b/i.test(text)) return "applied";
  if (/\bviewed\b/i.test(text)) return "viewed";
  return postedTextOf(card) ? "posted" : null;
}

// ─── run ────────────────────────────────────────────────────────────────────

const { document } = parseHTML(readFileSync(FIXTURE, "utf8"));
const cards = [...document.querySelectorAll(CARD)];

const rows = cards.map((card) => {
  const id = jobIdOf(card);
  return {
    id,
    url: jobUrlOf(id),
    titleA: titleFromDismiss(card),
    titleB: titleFromLockup(card),
    company: companyOf(card),
    location: locationOf(card),
    posted: postedTextOf(card),
    reposted: isReposted(card),
    status: linkedInStatusOf(card),
    footer: footerPartsOf(card),
  };
});

const n = rows.length;
const got = (f) => rows.filter(f).length;

console.log(`cards: ${n}\n`);
console.log("FIELD COVERAGE");
console.log(`  job id          ${got((r) => r.id)}/${n}`);
console.log(`  url (derived)   ${got((r) => r.url)}/${n}`);
console.log(`  title (dismiss) ${got((r) => r.titleA)}/${n}`);
console.log(`  title (lockup)  ${got((r) => r.titleB)}/${n}`);
console.log(`  titles agree    ${got((r) => r.titleA === r.titleB)}/${n}`);
console.log(`  company         ${got((r) => r.company)}/${n}`);
console.log(`  location        ${got((r) => r.location)}/${n}`);
console.log(`  posted phrase   ${got((r) => r.posted)}/${n}`);
console.log(`  reposted=true   ${got((r) => r.reposted)}/${n}`);
console.log(`  status non-null ${got((r) => r.status)}/${n}`);

const statuses = {};
rows.forEach((r) => (statuses[r.status ?? "null"] = (statuses[r.status ?? "null"] ?? 0) + 1));
console.log(`\nSTATUS BREAKDOWN  ${JSON.stringify(statuses)}`);

const disagreements = rows.filter((r) => r.titleA !== r.titleB);
if (disagreements.length) {
  console.log(`\nTITLE DISAGREEMENTS (${disagreements.length})`);
  disagreements.forEach((r) => {
    console.log(`  ${r.id}\n    dismiss: «${r.titleA}»\n    lockup : «${r.titleB}»`);
  });
}

console.log("\nDISTINCT FOOTER PHRASES");
const phrases = {};
rows.forEach((r) =>
  r.footer.forEach((p) => {
    const key = p.replace(/\d+/g, "N");
    phrases[key] = (phrases[key] ?? 0) + 1;
  }),
);
Object.entries(phrases)
  .sort((a, b) => b[1] - a[1])
  .forEach(([p, c]) => console.log(`  ${String(c).padStart(3)}  ${p}`));

console.log("\nLOCATION SHAPES");
const shapes = {};
rows.forEach((r) => {
  const m = /\(([^)]+)\)\s*$/.exec(r.location);
  const k = m ? `… (${m[1]})` : "no suffix";
  shapes[k] = (shapes[k] ?? 0) + 1;
});
Object.entries(shapes).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}  ${k}`));

console.log("\nSAMPLE ROWS");
rows.slice(0, 3).forEach((r) =>
  console.log(
    `  ${r.id} | ${r.titleB.slice(0, 34)} | ${r.company} | ${r.location} | ${r.posted} | ${r.status}`,
  ),
);
