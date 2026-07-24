import { CheckCheck, ExternalLink, Settings } from "lucide-react";

import { ScanButton } from "@/components/scan-button.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScanButtonState, ViewVariant } from "@/view-model.ts";

export type ListHeaderProps = {
  title: string;
  /** Unread across every watch. 0 renders no badge at all. */
  badge: number;
  scanButton: ScanButtonState;
  variant: ViewVariant;
  onScan: () => void;
  onMarkAllRead: () => void;
  onOpenTab: () => void;
  onOpenOptions: () => void;
};

/** The header: title + unread badge on the left, the four controls on the right.
 *
 *  "Open as a full page" is popup-only — the popup is a 380px panel that closes
 *  the moment you click outside it, so a long list wants a real tab, while in
 *  the tab there is nothing to expand into. This used to be emitted in both and
 *  hidden by a `.view-tab` CSS rule, because the markup was one shared string;
 *  a component can simply not render it. */
export function ListHeader({
  title,
  badge,
  scanButton,
  variant,
  onScan,
  onMarkAllRead,
  onOpenTab,
  onOpenOptions,
}: ListHeaderProps) {
  // The popup is 380px and the four controls plus a title do not fit in it. The
  // title is the thing you can least afford to lose — "New j…" tells you nothing —
  // so "Mark all read" drops its label there and keeps it in the roomier tab.
  const compact = variant === "popup";

  return (
    <header className="flex items-center gap-1.5 border-b bg-card px-3 py-2">
      <span className="truncate text-sm font-semibold">{title}</span>
      {badge > 0 && (
        <Badge className="h-[18px] min-w-[18px] shrink-0 justify-center rounded-full px-1 tabular-nums">
          {badge}
        </Badge>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <ScanButton state={scanButton} onScan={onScan} />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size={compact ? "icon" : "sm"}
              variant="ghost"
              id="mark-all-read"
              title="Mark all as read"
              aria-label="Mark all as read"
              onClick={onMarkAllRead}
              className={
                compact
                  ? "size-7 text-muted-foreground"
                  : "h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              }
            >
              <CheckCheck className={compact ? "size-4" : "size-3.5"} aria-hidden="true" />
              {!compact && "Mark all read"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Mark all as read</TooltipContent>
        </Tooltip>

        {variant === "popup" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                id="open-tab"
                aria-label="Open as a full page"
                onClick={onOpenTab}
                className="size-7 text-muted-foreground"
              >
                <ExternalLink className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open as a full page</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              id="open-options"
              aria-label="Options"
              onClick={onOpenOptions}
              className="size-7 text-muted-foreground"
            >
              <Settings className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Options</TooltipContent>
        </Tooltip>
      </span>
    </header>
  );
}
