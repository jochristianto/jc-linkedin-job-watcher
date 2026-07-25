import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { ChipWatch, ListMode } from "@/view-model.ts";

export type ToolbarProps = {
  watches: ChipWatch[];
  /** null = the leading "All watches" chip is pressed. */
  activeWatchId: string | null;
  mode: ListMode;
  onWatchChange: (id: string | null) => void;
  onModeChange: (mode: ListMode) => void;
};

/**
 * The toolbar row under the header: watch chips on the left, the New⇄All toggle
 * on the right (mockups decision 4).
 *
 * The chips scroll sideways rather than wrap. Wrapping made the toolbar's height
 * a function of how many watches you keep — six of them pushed the list down a
 * whole row in the popup — and the chips are a single ordered choice, which is
 * exactly the thing a horizontal strip reads as. The New⇄All control is pinned
 * outside that strip so it never scrolls out of reach.
 *
 * The chips filter the *list* only — the header badge keeps counting unread
 * across every watch, so switching chips never makes the badge lie. Exactly one
 * chip is pressed at a time, the "All watches" one when nothing is filtered.
 */
export function Toolbar({
  watches,
  activeWatchId,
  mode,
  onWatchChange,
  onModeChange,
}: ToolbarProps) {
  const chips: ChipWatch[] = [{ id: "", name: "All watches" }, ...watches];

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b bg-background px-3 py-1.5 md:px-4">
      {/* No visible scrollbar: a 4px-tall bar under six chips is chrome that
          reads as damage. The strip is short enough that the chips themselves
          are the affordance. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden">
        {chips.map((w) => {
          const pressed = (w.id || null) === activeWatchId;
          return (
            <Button
              key={w.id || "__all__"}
              type="button"
              size="sm"
              variant="ghost"
              data-watch-id={w.id}
              aria-pressed={pressed}
              onClick={() => onWatchChange(w.id || null)}
              className={cn(
                "h-6.5 shrink-0 rounded-full px-2.5 text-[12.5px]",
                pressed
                  ? "border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(16,24,40,0.05)] hover:bg-card"
                  : "border border-transparent font-normal text-muted-foreground",
              )}
            >
              {w.name}
            </Button>
          );
        })}
      </div>

      {/* A segmented control, not two loose buttons: New and All are one choice
          with two positions. `type="single"` keeps exactly one pressed, and the
          empty-string guard is Radix deselecting on a second click of the
          already-active item — which would leave the list in no mode at all. */}
      <ToggleGroup
        type="single"
        size="sm"
        value={mode}
        onValueChange={(v) => v && onModeChange(v as ListMode)}
        className="shrink-0 gap-0.5 rounded-lg border bg-muted p-0.5"
      >
        <ToggleGroupItem
          value="new"
          data-mode="new"
          aria-label="Show new jobs only"
          className="h-6.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-bold data-[state=on]:text-primary data-[state=on]:shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
        >
          New
        </ToggleGroupItem>
        <ToggleGroupItem
          value="all"
          data-mode="all"
          aria-label="Show every job found"
          className="h-6.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-bold data-[state=on]:text-primary data-[state=on]:shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
        >
          All
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
