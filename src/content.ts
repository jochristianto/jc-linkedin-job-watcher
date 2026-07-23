// Content script — CLASSIC (non-module) script.
//
// MV3 content scripts declared in the manifest cannot be ES modules, so this
// entry is built as a self-contained IIFE (see vite.content.config.ts): the
// import below is bundled inline, leaving no import/export in the output.
//
// The wrapper does only `parseJobCards(document)` and hands back the result — no
// logic, nothing to unit-test (§14). All of the parsing lives in the pure,
// tested parseJobCards (src/parse.ts). Later scan tickets wire the result back to
// the worker; for now it is logged so the built script can be run from DevTools
// on a logged-in LinkedIn search tab and print the parsed jobs (issue #13).

import { parseJobCards } from "./parse.ts";

const jobs = parseJobCards(document);
console.log(`[LJW] parsed ${jobs.length} job(s)`, jobs);
