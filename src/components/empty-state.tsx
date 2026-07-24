import {
  CircleCheck,
  PowerOff,
  RefreshCw,
  Search,
  Sprout,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { EmptyKind } from "@/view-model.ts";

/** A distinct, actionable message for each empty/degraded situation: no watches,
 *  nothing scanned, nothing new, mid-scan, scan broken. One table so the copy is
 *  a single thing to read and edit. */
const EMPTY_STATES: Record<EmptyKind, { icon: LucideIcon; title: string; body: string }> = {
  "no-watches": {
    icon: Search,
    title: "No searches yet",
    body: "Add a LinkedIn job search in Options to start watching.",
  },
  "no-jobs-yet": {
    icon: Sprout,
    title: "Nothing scanned yet",
    body: "The first scan hasn't finished. New jobs will show up here.",
  },
  "no-new": {
    icon: CircleCheck,
    title: "All caught up",
    body: "No new jobs. Switch to All to see everything found.",
  },
  scanning: {
    icon: RefreshCw,
    title: "Scanning…",
    body: "Checking your searches. This list updates when it's done.",
  },
  "scan-error": {
    icon: TriangleAlert,
    title: "Last scan failed",
    body: "LinkedIn's page may have changed — selectors returned nothing. See Options.",
  },
  paused: {
    icon: PowerOff,
    title: "Paused",
    body: "Watching is off. Flip the switch above on to scan for new jobs again.",
  },
};

/** The empty-state artwork reads as an illustration, not a control you can
 *  press: bigger than a button icon, and faint so it frames the message rather
 *  than competing with it. */
export function EmptyState({ kind }: { kind: EmptyKind }) {
  const { icon: Icon, title, body } = EMPTY_STATES[kind];
  return (
    <div
      data-kind={kind}
      className="m-auto flex max-w-[300px] flex-col items-center gap-1.5 px-6 py-10 text-center"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-7 stroke-[1.5] text-faint",
          kind === "scanning" && "animate-spin [animation-duration:2s]",
          kind === "scan-error" && "text-destructive/70",
        )}
      />
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{body}</div>
    </div>
  );
}
