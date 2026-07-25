import { RefreshCw } from "lucide-react";

/**
 * A one-line card above the list while a cycle runs and the list already has
 * something in it.
 *
 * The footer says "Scanning for new jobs…" too, but the footer is where you look
 * to find out *when* the loop runs, not to notice that it is running now. This
 * sits where the new rows will land, so a list that looks unchanged for the next
 * fifteen seconds is visibly mid-scan rather than visibly stale. On an empty list
 * it is redundant — {@link ScanSkeletons} occupies that space instead.
 */
export function ScanningBar() {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-[10px] border bg-card px-2.5 py-2">
      <RefreshCw className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
      <span className="text-[12.5px] text-muted-foreground">Scanning your watches…</span>
    </div>
  );
}

/** Three bar widths per card, deliberately uneven: rows of identical grey bars
 *  read as a loading *graphic*, whereas ragged ones read as text about to
 *  arrive — which is what is actually coming. */
const SKELETONS = [
  ["62%", "44%", "30%"],
  ["48%", "56%", "26%"],
  ["70%", "38%", "34%"],
] as const;

/**
 * The first scan, with nothing yet to show: the shape of the rows that are
 * coming rather than a spinner in an empty box.
 *
 * Only for the genuinely-empty case. Once there are rows, replacing them with
 * skeletons would throw away a list you were reading in order to announce a scan
 * that may add nothing to it.
 *
 * `aria-hidden` throughout: there is no information here, and a screen reader
 * announcing nine blank boxes is worse than silence. The scanning status is
 * announced once by the footer's live region.
 */
export function ScanSkeletons() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {SKELETONS.map((widths, i) => (
        <div
          key={i}
          className="animate-pulse rounded-[10px] border bg-card p-3"
        >
          <div className="h-2.5 rounded bg-muted" style={{ width: widths[0] }} />
          <div className="mt-2.5 h-2 rounded bg-muted" style={{ width: widths[1] }} />
          <div className="mt-2 h-2 rounded bg-muted" style={{ width: widths[2] }} />
        </div>
      ))}
    </div>
  );
}
