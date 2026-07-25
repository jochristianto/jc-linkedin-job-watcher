// Re-inline icons/icon-128.png into src/components/app-icon.tsx —
// `npm run build:app-icon`.
//
// The mark is drawn from a data URI (see app-icon.tsx for why), which means one
// copy of the PNG lives in source as base64. This rewrites that copy from the
// file on disk, so redrawing the icon is still a one-command change; the test
// beside the component fails until it has been run.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = join(root, "src/components/app-icon.tsx");

const base64 = readFileSync(join(root, "icons/icon-128.png")).toString("base64");
const source = readFileSync(target, "utf8");

// Anchored on the whole declaration rather than the bare string, so a stray
// data URI elsewhere in the file could never be the thing that gets rewritten.
const DECLARATION = /^(export const APP_ICON_DATA_URL = ")[^"]*(";)$/m;
if (!DECLARATION.test(source)) {
  throw new Error(`no APP_ICON_DATA_URL declaration found in ${target}`);
}

const next = source.replace(
  DECLARATION,
  `$1data:image/png;base64,${base64}$2`,
);
writeFileSync(target, next);

console.log(
  next === source
    ? "  src/components/app-icon.tsx already matches icons/icon-128.png"
    : `  wrote src/components/app-icon.tsx  (${(base64.length / 1024).toFixed(1)} kB of base64)`,
);
