// Background service worker (MV3) — ES module entry point.
//
// PREFACTOR (ticket 01): no behaviour yet. This exists so the build pipeline has
// a real service-worker entry to emit and `chrome://extensions` loads the
// unpacked `dist/` with no errors. The scan loop, alarms, keepalive, health and
// notification wiring land in the tickets that follow (PRD §11 build order); the
// pure logic they wrap already lives, tested, in schedule.ts / health.ts /
// lifecycle.ts / push.ts / filter.ts.

import { DEFAULT_SETTINGS } from "./types.ts";

// A trivial reference to the shared defaults keeps the entry wired to §5's single
// source and proves the type-only re-exports compile into the worker bundle.
console.log(
  `[LJW] service worker loaded — default interval ${DEFAULT_SETTINGS.intervalMinutes}m`,
);
