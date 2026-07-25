import type { ReactNode } from "react";

import { JobRow } from "@/components/job-row.tsx";
import { visibleJobs, type JobView, type ListMode, type ViewVariant } from "@/view-model.ts";

export type JobListProps = {
  jobs: JobView[];
  mode: ListMode;
  /** Which surface these rows are in. Handed straight to `JobRow`, which lays
   *  itself out differently in the popup's 380px than in the tab. */
  variant?: ViewVariant;
  /** The at-most-one row whose Block button is mid-question. One id rather than
   *  a set: arming a second button disarms the first, so two rows can never be
   *  asking at once. */
  armedBlockId?: string | null;
  /** The at-most-one row carrying the apply question in its card, and what to put
   *  there. Both or neither: an id with nothing to render pins an empty strip,
   *  and a strip with no id has no row to belong to. Whether the row is even on
   *  screen is the caller's to check (`visibleJobs`) — from in here a job filtered
   *  out by the mode and a job that never existed look the same. */
  applyPromptJobId?: string | null;
  applyPrompt?: ReactNode;
  /** The clock, handed down to every row so the whole list agrees on what "Found
   *  41m ago" means. One value rather than a `Date.now()` per row: rows rendered
   *  in the same paint should not disagree by a minute at the boundary. */
  now?: number;
  onOpen: (id: string, background: boolean) => void;
  onToggleRead: (id: string) => void;
  onBlock: (id: string) => void;
  onUnapply: (id: string) => void;
};

/**
 * The list. Which rows a mode shows is `visibleJobs`, tested with plain values —
 * in "new" mode *read* jobs are filtered out (read, not opened: a job you clicked
 * open stays here highlighted so you can go back to it, and only the row's tick
 * removes it), in "all" mode every job stays on screen, read ones rendered grey
 * (PRD §3, and #9's read/unread question).
 */
export function JobList({
  jobs,
  mode,
  variant = "tab",
  armedBlockId = null,
  applyPromptJobId = null,
  applyPrompt = null,
  now = Date.now(),
  onOpen,
  onToggleRead,
  onBlock,
  onUnapply,
}: JobListProps) {
  return (
    <div className="flex flex-col gap-2">
      {visibleJobs(jobs, mode).map((job) => (
        <JobRow
          key={job.id}
          job={job}
          variant={variant}
          now={now}
          armed={job.id === armedBlockId}
          footer={job.id === applyPromptJobId ? applyPrompt : null}
          onOpen={(background) => onOpen(job.id, background)}
          onToggleRead={() => onToggleRead(job.id)}
          onBlock={() => onBlock(job.id)}
          onUnapply={() => onUnapply(job.id)}
        />
      ))}
    </div>
  );
}
