// The one thing that can go wrong with an inlined asset: the file on disk moves
// on and the copy in source does not. Nothing else here needs testing — the
// component is an <img> with a class on it — but this does, because a stale mark
// is invisible in review and only shows up as the *old* icon in a shipped build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { APP_ICON_DATA_URL } from "./app-icon.tsx";

const root = resolve(import.meta.dirname, "../..");

test("APP_ICON_DATA_URL is the current icons/icon-128.png", () => {
  const png = readFileSync(join(root, "icons/icon-128.png")).toString("base64");
  assert.equal(
    APP_ICON_DATA_URL,
    `data:image/png;base64,${png}`,
    "the inlined app mark is out of date — run `npm run build:app-icon`",
  );
});
