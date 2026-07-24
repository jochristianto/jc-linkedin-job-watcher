import { useEffect, useState } from "react";

/** How often the footer's countdown repaints. The default scan interval is five
 *  minutes, so a coarser tick would visibly stall on the seconds. */
export const COUNTDOWN_TICK_MS = 1000;

/**
 * A clock that ticks, so the countdown counts down.
 *
 * The countdown is the one thing on the page that changes without anything
 * happening, so it needs its own clock. Under the old string-rendering mount
 * this had to repaint *only* the footer — a full repaint once a second would
 * have thrown away the user's scroll position and dropped focus mid-click.
 * React reconciles instead of replacing, so the whole view can simply re-render
 * and the scroll box, focus and text selection all survive.
 *
 * The interval dies with the page: the popup is disposable, and an open jobs tab
 * is one timer.
 */
export function useNow(intervalMs: number = COUNTDOWN_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
