import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompany,
  isCompanyBlocked,
  isHiddenAsReposted,
  isTitleBlocked,
  passesFilters,
  type FilterRules,
  type FilterJob,
} from "./filter.ts";

// A worked reference for issue #7 (06): the "filtering" pure logic (PRD §3/§6).
// No chrome.*, no DOM, no network — driven entirely by plain values, so `node
// --test` can prove it without a browser. Every build ticket's pure logic copies
// this shape (see prd.md §14).

function job(overrides: Partial<FilterJob> = {}): FilterJob {
  return {
    title: "Staff Engineer",
    company: "Acme Corp",
    isReposted: false,
    ...overrides,
  };
}

function rules(overrides: Partial<FilterRules> = {}): FilterRules {
  return {
    blockedCompanies: [],
    blockedTitleKeywords: [],
    hideReposted: false,
    ...overrides,
  };
}

test("normalizeCompany lowercases and trims so matching is done once, on write", () => {
  assert.equal(normalizeCompany("  Acme Corp  "), "acme corp");
  assert.equal(normalizeCompany("PT ACME Indonesia"), "pt acme indonesia");
});

test("isCompanyBlocked matches on substring so one entry catches its variants", () => {
  // PRD §6: "acme" catches both "Acme Corp" and "PT Acme Indonesia".
  const blocked = ["acme"];
  assert.equal(isCompanyBlocked("Acme Corp", blocked), true);
  assert.equal(isCompanyBlocked("PT Acme Indonesia", blocked), true);
  assert.equal(isCompanyBlocked("Globex", blocked), false);
});

test("isCompanyBlocked is case-insensitive against an already-normalized list", () => {
  assert.equal(isCompanyBlocked("ACME CORP", ["acme"]), true);
});

test("isCompanyBlocked with an empty blocklist blocks nothing", () => {
  assert.equal(isCompanyBlocked("Acme Corp", []), false);
});

test("isTitleBlocked matches a keyword case-insensitively anywhere in the title", () => {
  assert.equal(isTitleBlocked("Senior Engineer", ["senior"]), true);
  assert.equal(isTitleBlocked("SENIOR ENGINEER", ["senior"]), true);
  assert.equal(isTitleBlocked("Staff Engineer", ["senior", "intern"]), false);
});

test("passesFilters keeps a job that trips no rule", () => {
  assert.equal(passesFilters(job(), rules()), true);
});

test("passesFilters drops a blocked company", () => {
  assert.equal(
    passesFilters(job({ company: "Acme Corp" }), rules({ blockedCompanies: ["acme"] })),
    false,
  );
});

test("passesFilters drops a blocked title keyword", () => {
  assert.equal(
    passesFilters(job({ title: "Intern, Backend" }), rules({ blockedTitleKeywords: ["intern"] })),
    false,
  );
});

test("isHiddenAsReposted needs both the flag and the setting, and treats an absent flag as no", () => {
  assert.equal(isHiddenAsReposted({ isReposted: true }, true), true);
  assert.equal(isHiddenAsReposted({ isReposted: true }, false), false);
  assert.equal(isHiddenAsReposted({ isReposted: false }, true), false);
  // A record written before the flag existed: nothing ever said it was a repost,
  // so it stays visible rather than being hidden on a missing field.
  assert.equal(isHiddenAsReposted({}, true), false);
});

test("passesFilters drops a reposted job only when hideReposted is on", () => {
  assert.equal(passesFilters(job({ isReposted: true }), rules({ hideReposted: false })), true);
  assert.equal(passesFilters(job({ isReposted: true }), rules({ hideReposted: true })), false);
  assert.equal(passesFilters(job({ isReposted: false }), rules({ hideReposted: true })), true);
});
