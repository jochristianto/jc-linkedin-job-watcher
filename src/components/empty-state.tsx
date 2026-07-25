import {
  CircleCheck,
  PowerOff,
  RefreshCw,
  Search,
  Sprout,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EmptyKind } from "@/view-model.ts";

/** A distinct, actionable message for each empty/degraded situation: no watches,
 *  nothing scanned, nothing new, mid-scan, scan broken. One table so the copy is
 *  a single thing to read and edit. */
const EMPTY_STATES: Record<EmptyKind, { icon: LucideIcon; title: string; body: string }> = {
  "no-watches": {
    icon: Search,
    title: "No watches yet",
    body: "A watch is a saved LinkedIn search. Add one in Options and this list fills up on the next scan.",
  },
  "no-jobs-yet": {
    icon: Sprout,
    title: "Nothing scanned yet",
    body: "The first scan hasn't finished. New jobs will show up here.",
  },
  "no-new": {
    icon: CircleCheck,
    title: "You're all caught up",
    body: "Nothing unread in this watch. New matches land here as soon as the next scan finds them.",
  },
  scanning: {
    icon: RefreshCw,
    title: "Scanning your watches…",
    body: "Checking each saved search for postings newer than your last scan.",
  },
  "scan-error": {
    icon: TriangleAlert,
    title: "Last scan failed",
    body: "LinkedIn's page may have changed — selectors returned nothing. See Options.",
  },
  paused: {
    icon: PowerOff,
    title: "Watching is off",
    body: "No scans, no notifications. Your watches and history stay exactly where they are.",
  },
};

/** The one thing to do about this empty state, when there is one. Every message
 *  here is a dead end otherwise — "add a watch in Options" with no way to get to
 *  Options is a sentence, not an exit — so the caller wires the button that ends
 *  the situation the message describes. `scanning` has none: waiting is the
 *  action. */
export type EmptyStateAction = {
  label: string;
  onClick: () => void;
  /** `default` for the one thing that unblocks you, `outline` for a sideways
   *  move like "show all jobs" — that list is not broken, it is just filtered. */
  variant?: "default" | "outline";
};

/** The empty-state artwork reads as an illustration, not a control you can
 *  press: bigger than a button icon, set in a soft tinted tile so it frames the
 *  message rather than competing with it. The error tier is the one that turns
 *  red — everything else here is a normal state of a working extension. */
export function EmptyState({
  kind,
  action,
}: {
  kind: EmptyKind;
  action?: EmptyStateAction;
}) {
  const { icon: Icon, title, body } = EMPTY_STATES[kind];
  const bad = kind === "scan-error";

  return (
    <div
      data-kind={kind}
      className="m-auto flex max-w-[34ch] flex-col items-center gap-2.5 px-5 py-10 text-center"
    >
      <div
        className={cn(
          "flex size-11 items-center justify-center rounded-2xl border",
          bad
            ? "border-destructive/30 bg-destructive/10"
            : "border-primary/20 bg-primary/10",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "size-7 stroke-[1.5]",
            bad ? "text-destructive" : "text-primary",
            kind === "scanning" && "animate-spin [animation-duration:2s]",
          )}
        />
      </div>
      <div className="text-[15px] font-semibold tracking-tight text-foreground">
        {title}
      </div>
      <div className="text-[13px] leading-relaxed text-muted-foreground text-pretty">
        {body}
      </div>
      {action && (
        <Button
          type="button"
          size="sm"
          variant={action.variant ?? "default"}
          data-action="empty-cta"
          onClick={action.onClick}
          className="mt-0.5 h-8"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
