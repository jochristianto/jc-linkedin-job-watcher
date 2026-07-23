import { defineConfig } from "vite";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

// Main build (ticket 01). Emits the background service worker as an ES module and
// the three pages as HTML entries, then copies the MV3 manifest verbatim into
// dist/. The content script is a SEPARATE build (vite.content.config.ts) because
// an MV3 content script must be a classic, non-module script — see package.json's
// `build` script, which runs this first, then the content build.
//
// `extension/` (the issue #5 spike) is deliberately not an input here, so it is
// excluded from the shipped bundle.

const root = process.cwd();

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(root, "src/background.ts"),
        popup: resolve(root, "popup.html"),
        jobs: resolve(root, "jobs.html"),
        options: resolve(root, "options.html"),
      },
      output: {
        // The manifest references "background.js" at a fixed path, so that one
        // entry keeps a stable name; page scripts are hashed under assets/.
        entryFileNames: (chunk) =>
          chunk.name === "background"
            ? "background.js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [
    {
      name: "ljw-copy-manifest",
      closeBundle() {
        copyFileSync(
          resolve(root, "manifest.json"),
          resolve(root, "dist/manifest.json"),
        );
      },
    },
  ],
});
