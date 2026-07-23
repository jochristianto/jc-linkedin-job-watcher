// Background service worker for the issue #5 (04) spike.
//
// One alarm, one background tab (active: false), one injected script, one
// console.log of the card count. Everything it observes is printed to THIS
// worker's console (chrome://extensions → "LJW Probe" → "service worker") with
// an [LJW] prefix. Read the answers to the ticket's questions off that log.
//
// This is a throwaway measurement rig, not the product. It deliberately does no
// scraping of fields, no storage, no dedupe across runs — just: did an unseen
// tab render the list, how long did it take, and did the worker survive it.

// ── EDIT ME ────────────────────────────────────────────────────────────────
// Paste a *logged-in* LinkedIn job-search URL (issue #2 recommends appending
// &sortBy=DD so page 1 stays dense with new postings). Keep it to one watch,
// one page — the point is the mechanism, not coverage.
const PROBE_URL =
  "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&sortBy=DD";

// A short period so you can watch several cycles quickly (question #7: does
// LinkedIn notice over a handful of consecutive loads). The product uses 5 min.
const PROBE_ALARM = "ljw-probe";
const PROBE_PERIOD_MINUTES = 1;
// ─────────────────────────────────────────────────────────────────────────────

const bootAt = Date.now();
function log(...args) {
  const t = ((Date.now() - bootAt) / 1000).toFixed(1);
  console.log(`[LJW +${t}s]`, ...args);
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(PROBE_ALARM);
  if (!existing) {
    await chrome.alarms.create(PROBE_ALARM, {
      periodInMinutes: PROBE_PERIOD_MINUTES,
    });
    log("created alarm", PROBE_ALARM, `every ${PROBE_PERIOD_MINUTES} min`);
  } else {
    const dueIn = (existing.scheduledTime - Date.now()) / 1000;
    log("alarm already exists; next fire in", dueIn.toFixed(1), "s");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  log("onInstalled — worker started fresh");
  ensureAlarm();
});

// Question #8: does a missed alarm fire immediately on relaunch? Quit Chrome
// entirely, wait past the period, relaunch, and watch: if onAlarm below fires
// within ~1s of this line, Chromium fired the missed alarm immediately and
// PRD §9's unconditional onStartup catch-up scan would double-run.
chrome.runtime.onStartup.addListener(async () => {
  log("onStartup — Chrome (re)launched");
  const alarm = await chrome.alarms.get(PROBE_ALARM);
  if (alarm) {
    const overdueBy = (Date.now() - alarm.scheduledTime) / 1000;
    log(
      "at startup the probe alarm was",
      overdueBy > 0 ? `${overdueBy.toFixed(1)}s OVERDUE` : "not yet due",
      "(watch for an immediate onAlarm below → missed alarms fire on relaunch)",
    );
  }
  await ensureAlarm();
});

let probeRunning = false;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PROBE_ALARM) return;
  const sinceBoot = ((Date.now() - bootAt) / 1000).toFixed(1);
  log(`onAlarm fired (${sinceBoot}s after worker boot)`);
  if (probeRunning) {
    log("previous probe still running — skipping this tick (scan-lock)");
    return;
  }
  probeRunning = true;
  runProbe()
    .catch((err) => log("probe threw:", err?.message ?? err))
    .finally(() => {
      probeRunning = false;
    });
});

// One end-to-end probe: open an invisible tab, wait for the list to settle,
// read the count, close the tab. Times every leg (question #5).
async function runProbe() {
  const t0 = Date.now();
  log("opening background tab (active: false):", PROBE_URL);
  const tab = await chrome.tabs.create({ url: PROBE_URL, active: false });
  const tabCreated = Date.now();

  try {
    // Give the SPA a beat to boot before we start scroll-and-count polling.
    await sleep(1500);

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-probe.js"],
    });
    const probe = result?.result;
    const done = Date.now();

    if (!probe) {
      log("INJECTION RETURNED NOTHING — content-probe.js did not run");
    } else if (!probe.settled) {
      log(
        `NOT SETTLED after ${probe.elapsedMs}ms — count stalled at ${probe.count}` +
          " (question #1/#4: an invisible tab may not render — write this down)",
      );
    } else {
      log(
        `SETTLED: ${probe.count} distinct cards in ${probe.elapsedMs}ms` +
          ` (${probe.samples} scroll-samples). Compare against #2's hand count.`,
      );
    }
    log(
      "timing — tab open:",
      tabCreated - t0,
      "ms; inject+settle:",
      done - tabCreated,
      "ms; total:",
      done - t0,
      "ms",
    );
  } finally {
    if (tab.id != null) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      log("closed probe tab");
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
