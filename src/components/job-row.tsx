import { BadgeCheck, Ban, Check, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { metaLine, type JobView } from "@/view-model.ts";

export type JobRowProps = {
  job: JobView;
  /** This row's Block button pressed once, now reading "Sure?" and waiting for
   *  the press that commits. Transient view state, not job state — `useArmedBlock`
   *  holds which row it is and clears it after {@link BLOCK_CONFIRM_MS}. */
  armed?: boolean;
  /** A plain left click on the posting. `background` is a middle-click or a
   *  modifier click, which the browser has already opened in its own tab — the
   *  handler only records that it was opened. */
  onOpen: (background: boolean) => void;
  onToggleRead: () => void;
  onBlock: () => void;
  /** The "Applied" tag, tapped: throw the record away and let the question be asked
   *  again. Only ever reachable on a row that carries one. */
  onUnapply: () => void;
  /** A strip pinned to the bottom of this row's card, inside its border — today
   *  only "Did you apply for this job?", on the one row it is about. Passed in
   *  rather than built here: the row knows nothing about the question, and the
   *  answer is `ListView`'s to handle. */
  footer?: ReactNode;
};

/**
 * One job row: the posting itself as a link, plus the row actions — the tick, the
 * Block button, and, on a job you answered "Yes" to, the Applied tag that undoes it.
 *
 * The row is a `<div>` wrapping an `<a>`, not one big `<a>`, because buttons
 * cannot legally live inside an anchor. The anchor still covers the whole
 * title/meta block, so clicking the row opens the posting exactly as before —
 * and keeping a real `href` is what lets a middle-click or ⌘-click do the
 * browser's own background-tab thing (PRD §3) instead of us reimplementing it.
 *
 * The card is a column: the posting on top and an optional `footer` under it,
 * both inside the one border. That is what lets the apply question be asked
 * *on the job it is about* rather than floating somewhere above the list.
 *
 * Fields fail independently: a missing company, location or posted time is
 * simply omitted; a missing title falls back to a placeholder so the row is
 * never blank (PRD §12 "each field fails independently").
 *
 * `data-read`/`data-opened`/`data-blocked`/`data-applied` are no longer read by an
 * event delegate — React wires the callbacks directly — but they stay as the handle
 * the tests and QA assert a row's state through.
 */
export function JobRow({
  job,
  armed = false,
  onOpen,
  onToggleRead,
  onBlock,
  onUnapply,
  footer,
}: JobRowProps) {
  // Only the title needs a fallback — it's the one field always rendered. The
  // rest (company, location, posted time) are dropped by metaLine when blank.
  const title = job.title.trim() || "Untitled role";
  const meta = metaLine([job.company, job.location]);
  const foot = metaLine([job.postedText, job.watchName]);

  // Read and blocked both grey the row, so the row says which one it is.
  const dimmed = job.read || job.blocked;

  // Every action on the row is undoable from the row it was pressed on. That matters
  // most for Block: the only other way back is hunting the company down in Options.
  const readLabel = job.read ? "Mark as unread" : "Mark as read";

  // The one exception to that, and the reason the label spells it out: undoing an
  // applied record takes the note with it, and only answering the question again
  // brings a note back. One tap all the same — a confirm on every correction would
  // cost more than the note does.
  const appliedLabel = "Applied — undo, and forget the note";

  // A card with no company parsed has nothing to block, so it gets no button
  // rather than one that would blocklist the empty string (§12 again).
  const company = job.company.trim();
  const blockLabel = job.blocked ? `Unblock ${company}` : `Block ${company}`;
  // Armed = pressed once, waiting for the second press that commits. Only the
  // blocking direction ever arms — unblocking just puts jobs back, so there is
  // nothing to be sure about.
  const blockText = armed ? "Sure?" : job.blocked ? "Unblock" : "Block";

  return (
    <div
      data-job-id={job.id}
      data-read={job.read}
      data-opened={job.opened}
      data-blocked={job.blocked}
      data-applied={job.applied}
      className={cn(
        "group relative flex flex-col overflow-hidden",
        "has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50",
      )}
    >
      {/* The posting itself. The hover tint and the fading live on this line
          rather than on the card, so a footer pinned below stays at full strength
          — the question it asks is not part of the row's read/blocked state. It
          carries the card's rounding too: with a footer under it the tint has to
          round off above it, not run square into it. */}
      <div
        className={cn(
          "flex items-start gap-2 px-2.5 py-2 transition-colors rounded-lg border bg-card hover:bg-accent/40",
          // Opened is not a dismissal — the row stays put so you can come back to
          // it (PRD §9) — but clicking through marks it visited: no dot, no
          // highlight, just faded so the ones you haven't touched stand out.
          job.opened && !dimmed && "opacity-80",
          dimmed && "opacity-55",
        )}
      >
        <a
          href={job.url}
          className="flex min-w-0 flex-1 items-start gap-2 outline-none"
          onClick={(e) => {
            const background =
              e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey;
            // A plain click is ours to handle: let the browser follow the href and
            // it opens a second tab alongside the one we open. A modifier click is
            // deliberately left alone — that background tab is the browser's job.
            if (!background) e.preventDefault();
            onOpen(background);
          }}
          onAuxClick={(e) => {
            if (e.button === 1) onOpen(true);
          }}
        >
          {/* The unread dot. Opened rows drop it too — a click through counts as
              seen, even though the row stays until you tick it. Blocked rows never
              carry one either: greyed out of the badge count, so a dot would be
              claiming a job that isn't. */}
          <span
            aria-hidden="true"
            className={cn(
              "mt-1.5 size-2 shrink-0 rounded-full",
              !job.read && !job.opened && !job.blocked
                ? "bg-unread"
                : "bg-transparent",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] leading-snug font-medium text-foreground">
              {title}
            </span>
            {meta && (
              <span className="truncate text-xs text-muted-foreground">
                {meta}
              </span>
            )}
            {(foot || job.blocked) && (
              <span className="flex items-center gap-1.5 text-[11px] text-faint">
                {foot}
                {job.blocked && (
                  <Badge
                    variant="secondary"
                    className="h-4 px-1.5 text-[10px] font-normal"
                  >
                    Blocked
                  </Badge>
                )}
              </span>
            )}
          </span>
        </a>

        {/* Applied, then Block, then the tick out at the edge where a one-tap
            dismiss belongs. The Applied tag lives here rather than in the meta
            line with the Blocked one because it is tappable, and interactive
            content inside the row's `<a>` is both invalid and unclickable. */}
        <span className="flex shrink-0 items-center gap-1">
          {job.applied && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-action="unapply"
              aria-pressed={true}
              // The visible word is only "Applied", so the accessible name is what has
              // to say that pressing it takes the record — and the note — away again.
              title={appliedLabel}
              aria-label={appliedLabel}
              onClick={onUnapply}
              className="h-7 gap-1 px-2 text-xs text-ok hover:bg-ok/10 hover:text-ok"
            >
              <BadgeCheck className="size-3.5" aria-hidden="true" />
              Applied
            </Button>
          )}
          {company && (
            <Button
              type="button"
              size="sm"
              variant={armed ? "destructive" : "ghost"}
              data-action="block"
              data-armed={armed}
              aria-pressed={job.blocked}
              // The visible label is only "Block"/"Sure?", so the accessible name
              // is what has to carry *which company* is about to disappear.
              title={
                armed ? `${blockLabel} — press again to confirm` : blockLabel
              }
              aria-label={
                armed ? `${blockLabel} — press again to confirm` : blockLabel
              }
              onClick={onBlock}
              className={cn(
                "h-7 gap-1 px-2 text-xs",
                // Red at rest so it reads as the one destructive thing on the row,
                // solid red once armed so the second press is unmistakable.
                !armed &&
                  !job.blocked &&
                  "text-destructive hover:bg-destructive/10 hover:text-destructive",
                job.blocked && "text-muted-foreground",
              )}
            >
              <Ban className="size-3.5" aria-hidden="true" />
              {blockText}
            </Button>
          )}
          {/* A native `title` rather than a shadcn Tooltip, deliberately: a Radix
              tooltip is a context subscription and a portal *per row*, and this
              button exists once per job. The header's two icon-only buttons render
              once a page and do get the real thing. */}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-action="read"
            aria-pressed={job.read}
            aria-label={readLabel}
            title={readLabel}
            onClick={onToggleRead}
            className="size-7 text-muted-foreground hover:text-foreground"
          >
            {job.read ? (
              <RotateCcw className="size-4" aria-hidden="true" />
            ) : (
              <Check className="size-4" aria-hidden="true" />
            )}
          </Button>
        </span>
      </div>

      {/* Pinned inside the card, under the posting: "Did you apply for this job?"
          on the one row it is about. */}
      {footer}
    </div>
  );
}
