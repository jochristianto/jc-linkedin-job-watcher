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
