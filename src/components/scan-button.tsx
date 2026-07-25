import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ScanButtonState } from "@/view-model.ts";

const SCAN_BUTTON: Record<ScanButtonState, { label: string; title: string }> = {
  idle: { label: "Scan now", title: "Scan every enabled search right now" },
  scanning: { label: "Scanning…", title: "A scan is already running" },
  // Short on purpose: the header is only 380px wide in the popup, and the health
  // banner directly below already says "…clear it, then resume" (§16.8).
  halted: { label: "Resume", title: "Clear the halt and scan right now" },
};

/**
 * The manual scan control in the header — a scan right now rather than waiting
 * out the interval and quiet hours (PRD §9/§15).
 *
 * Disabled *only* while a cycle is in flight. It stays live in every failure
 * state, including `halted`, because otherwise the service-worker console is the
 * user's only way to trigger a scan.
 */
export function ScanButton({
  state,
  onScan,
  compact = false,
  className,
}: {
  state: ScanButtonState;
  onScan: () => void;
  compact?: boolean;
  /** Layout imposed by wherever it is standing — the popup's menu stretches it
   *  to a full-width row. Applied last, so a caller that has to override the
   *  resting look can; `halted` is the one state worth leaving alone, since a
   *  filled button is how it asks to be pressed. */
  className?: string;
}) {
  const { label, title } = SCAN_BUTTON[state];
  const scanning = state === "scanning";
  return (
    <Button
      type="button"
      size="sm"
      variant={state === "halted" ? "default" : "ghost"}
      id="scan-now"
      data-scan-state={state}
      title={title}
      disabled={scanning}
      onClick={onScan}
      className={cn(
        "h-7 gap-1.5 px-2 text-xs",
        state === "idle" && "text-muted-foreground",
        className,
      )}
    >
      <RefreshCw
        className={cn("size-3.5", scanning && "animate-spin")}
        aria-hidden="true"
      />
      {!compact && label}
    </Button>
  );
}
