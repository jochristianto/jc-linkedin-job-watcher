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
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {chips.map((w) => {
          const pressed = (w.id || null) === activeWatchId;
          return (
            <Button
              key={w.id || "__all__"}
              type="button"
              size="sm"
              variant={pressed ? "secondary" : "ghost"}
              data-watch-id={w.id}
              aria-pressed={pressed}
              onClick={() => onWatchChange(w.id || null)}
              className={cn(
                "h-6 rounded-full px-2.5 text-xs font-normal",
                pressed
                  ? "border border-border bg-secondary text-secondary-foreground"
                  : "text-muted-foreground",
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
        className="shrink-0 rounded-md border bg-muted/50 p-0.5"
      >
        <ToggleGroupItem
          value="new"
          data-mode="new"
          aria-label="Show new jobs only"
          className="h-6 rounded-sm px-2.5 text-xs data-[state=on]:bg-card data-[state=on]:shadow-sm"
        >
          New
        </ToggleGroupItem>
        <ToggleGroupItem
          value="all"
          data-mode="all"
          aria-label="Show every job found"
          className="h-6 rounded-sm px-2.5 text-xs data-[state=on]:bg-card data-[state=on]:shadow-sm"
        >
          All
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
