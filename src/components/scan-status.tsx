import { Clock, Moon, PowerOff, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCountdown, type ScanStatus } from "@/view-model.ts";

/** The icon and sentence for each status. Split out from the markup so the copy
 *  is one table to read, the same way SCAN_BUTTON and EMPTY_STATES are. */
function statusFace(status: ScanStatus): { icon: LucideIcon; text: string } {
  switch (status.kind) {
    case "scanning":
      return { icon: RefreshCw, text: "Scanning for new jobs…" };
    case "waiting":
      return status.quiet
        ? { icon: Moon, text: `Quiet hours · next scan in ${formatCountdown(status.remainingMs)}` }
        : { icon: Clock, text: `Next scan in ${formatCountdown(status.remainingMs)}` };
    case "due":
      return { icon: Clock, text: "Next scan due any moment" };
    case "halted":
      return { icon: TriangleAlert, text: "Scanning stopped — press Resume" };
    case "unscheduled":
      return { icon: Clock, text: "No scan scheduled — press Scan now" };
    case "off":
      return { icon: Clock, text: "" };
    case "disabled":
      return { icon: PowerOff, text: "Paused — turn on to scan" };
  }
}

export type ScanStatusBarProps = {
  status: ScanStatus;
  /** Unread across every watch — the same number the header badge shows. */
  unread?: number;
  /** How many watches are configured. */
  watchCount?: number;
};

/** `1 watch` / `4 watches`, because "1 watches" in a status bar reads as a bug. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The footer status bar: what the scan loop is doing, how long until it does it
 * again, and — on the right — the standing count the header badge also carries.
 *
 * It answers the question the rest of the view can't: a list that hasn't changed
 * in ten minutes looks identical whether the loop is healthy, asleep for quiet
 * hours, or dead. The counts opposite are the other half of that: with a watch
 * chip filtering the list, the number of rows on screen is not the number of jobs
 * waiting for you, and this is where the real total stays visible.
 *
 * Renders nothing at all for `off`: with no enabled search there is no scan to
 * promise, and a bar saying so would be a bar saying nothing.
 *
 * `role="status"` is set ONLY while scanning: that text lands once and is worth
 * announcing, whereas a live region wrapped around a ticking countdown would
 * read the whole sentence out loud every second.
 */
export function ScanStatusBar({ status, unread, watchCount }: ScanStatusBarProps) {
  if (status.kind === "off") return null;
  const { icon: Icon, text } = statusFace(status);
  const scanning = status.kind === "scanning";

  // Paused is a state, not a tally: counting down jobs "new" under a switch the
  // user deliberately turned off invites the reading that scanning is continuing.
  const counts =
    status.kind === "disabled"
      ? "Paused"
      : unread === undefined || watchCount === undefined
        ? null
        : `${unread} new · ${plural(watchCount, "watch", "watches")}`;

  return (
    <div
      data-kind={status.kind}
      {...(scanning ? { role: "status" } : {})}
      className={cn(
        "flex shrink-0 items-center gap-2.5 border-t bg-background px-3 py-2 text-xs text-muted-foreground md:px-4",
        status.kind === "halted" && "text-destructive",
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn("size-3.5 shrink-0", scanning && "animate-spin")}
          aria-hidden="true"
        />
        <span className="truncate">{text}</span>
      </span>
      {counts && (
        <span className="ml-auto shrink-0 tabular-nums">{counts}</span>
      )}
    </div>
  );
}
