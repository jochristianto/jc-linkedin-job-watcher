import { JobRow } from "@/components/job-row.tsx";
import type { JobView, ListMode } from "@/view-model.ts";

export type JobListProps = {
  jobs: JobView[];
  mode: ListMode;
  /** The at-most-one row whose Block button is mid-question. One id rather than
   *  a set: arming a second button disarms the first, so two rows can never be
   *  asking at once. */
  armedBlockId?: string | null;
  onOpen: (id: string, background: boolean) => void;
  onToggleRead: (id: string) => void;
  onBlock: (id: string) => void;
  onUnapply: (id: string) => void;
};

/**
 * The list. In "new" mode *read* jobs are filtered out — read, not opened: a job
 * you clicked open stays here highlighted so you can go back to it, and only the
 * row's tick removes it. In "all" mode every job stays on screen, read ones
 * rendered grey (PRD §3, and #9's read/unread question).
 *
 * Blocked jobs stay in both modes, greyed. The blocklist governs what *future*
 * scans surface; silently deleting rows you can already see would be a second,
 * unasked-for action.
 */
export function JobList({
  jobs,
  mode,
  armedBlockId = null,
  onOpen,
  onToggleRead,
  onBlock,
  onUnapply,
}: JobListProps) {
  const visible = mode === "new" ? jobs.filter((j) => !j.read) : jobs;
  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          armed={job.id === armedBlockId}
          onOpen={(background) => onOpen(job.id, background)}
          onToggleRead={() => onToggleRead(job.id)}
          onBlock={() => onBlock(job.id)}
          onUnapply={() => onUnapply(job.id)}
        />
      ))}
    </div>
  );
}
