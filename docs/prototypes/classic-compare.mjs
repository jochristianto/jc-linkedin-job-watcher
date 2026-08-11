/**
 * THROWAWAY PROTOTYPE — wayfinder #64. Runs the SHIPPED parser against the
 * classic fixture, so the classic and new surfaces are measured with the same
 * ruler. Run from the repo root:
 *
 *   node --experimental-strip-types docs/prototypes/classic-compare.mjs
 */
import fs from "node:fs";
import { parseHTML } from "linkedom";
const { parseJobCards } = await import("../../src/parse.ts");
const html = fs.readFileSync(".scratch/linkedin-job-watcher/fixtures/page-1/linkedin-jobs-page-1.html", "utf8");
const jobs = parseJobCards(parseHTML(html).document);
console.log("classic jobs parsed:", jobs.length);
const locShapes = {};
jobs.forEach(j => { const m=/\(([^)]+)\)\s*$/.exec(j.location); const k=m?`… (${m[1]})`:"no suffix"; locShapes[k]=(locShapes[k]??0)+1; });
console.log("location shapes:", locShapes);
const st = {}; jobs.forEach(j => st[j.linkedInStatus??"null"]=(st[j.linkedInStatus??"null"]??0)+1);
console.log("status breakdown:", st);
console.log("reposted:", jobs.filter(j=>j.isReposted).length);
console.log("with postedText:", jobs.filter(j=>j.postedText).length);
console.log("\nsample:");
jobs.slice(0,4).forEach(j=>console.log(`  ${j.id} | ${j.title.slice(0,30)} | ${j.company} | ${j.location} | «${j.postedText}» | ${j.linkedInStatus} | rep=${j.isReposted}`));
