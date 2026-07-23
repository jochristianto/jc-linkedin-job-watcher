// Content script — CLASSIC (non-module) script.
//
// MV3 content scripts declared in the manifest cannot be ES modules, so this
// entry is built as a self-contained IIFE (see vite.content.config.ts) with no
// import/export left in the output.
//
// PREFACTOR (ticket 01): no behaviour yet. The real card scraping + page
// classification lands in the scan tickets; the tested pure logic it will mirror
// already lives in src/scan-probe.ts and src/health.ts (classifyPage).

console.log("[LJW] content script loaded");
