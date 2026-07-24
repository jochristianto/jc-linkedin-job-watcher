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

/**
 * The footer status bar: what the scan loop is doing, and how long until it does
 * it again. It answers the question the rest of the view can't — a list that
 * hasn't changed in ten minutes looks identical whether the loop is healthy,
 * asleep for quiet hours, or dead.
 *
 * Renders nothing at all for `off`: with no enabled search there is no scan to
 * promise, and a bar saying so would be a bar saying nothing.
 *
 * `role="status"` is set ONLY while scanning: that text lands once and is worth
 * announcing, whereas a live region wrapped around a ticking countdown would
 * read the whole sentence out loud every second.
 */
export function ScanStatusBar({ status }: { status: ScanStatus }) {
  if (status.kind === "off") return null;
  const { icon: Icon, text } = statusFace(status);
  const scanning = status.kind === "scanning";
  return (
    <div
      data-kind={status.kind}
      {...(scanning ? { role: "status" } : {})}
      className={cn(
        "flex items-center gap-1.5 border-t bg-card/60 px-3 py-1.5 text-[11px] text-muted-foreground",
        status.kind === "halted" && "text-destructive",
      )}
    >
      <Icon
        className={cn("size-3 shrink-0", scanning && "animate-spin")}
        aria-hidden="true"
      />
      <span className="truncate">{text}</span>
    </div>
  );
}
