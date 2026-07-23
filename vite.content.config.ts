import { defineConfig } from "vite";
import { resolve } from "node:path";

// Content-script build (ticket 01). An MV3 content script declared in the
// manifest cannot be an ES module, so it is built in lib mode as an IIFE — a
// self-contained classic script with no import/export in the output. It runs
// AFTER the main build (see package.json `build`), so `emptyOutDir` is false:
// this pass appends dist/content.js beside the main build's output rather than
// wiping it.

const root = process.cwd();

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(root, "src/content.ts"),
      formats: ["iife"],
      name: "LJWContent",
      fileName: () => "content.js",
    },
  },
});
