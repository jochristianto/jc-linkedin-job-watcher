import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { applyPromptState, metaLine, type ApplyAnswer } from "@/view-model.ts";

/** The little the prompt needs in order to say *which* job it is asking about.
 *  The url is deliberately absent: the message's link is read from storage by the
 *  worker that sends it, so the dialog never has to carry it around. */
export type ApplyPromptJob = { id: string; title: string; company: string };

export type ApplyPromptProps = {
  job: ApplyPromptJob;
  /** Yes with the typed note, or No with nothing. What each *means* is the
   *  caller's: only Yes is recorded and pushed (see `markJobApplied`). */
  onAnswer: (applied: boolean, notes: string) => void;
  /** Escape, the backdrop, or "Not now" — the question goes away unanswered and
   *  nothing is written. */
  onDismiss: () => void;
};

/**
 * "Did you apply for this job?" — the question that follows opening a posting.
 *
 * It appears when you come back to the list, not while you are reading the job:
 * clicking a row opens LinkedIn in a focused tab, and a popup that loses focus is
 * destroyed, so the question is queued in storage (`UiState.pendingApplyId`) and
 * asked by whichever surface you open next. That is also the only moment the
 * answer can be known — before you have seen the posting there is nothing to
 * answer.
 *
 * Deliberately NOT a Radix Dialog. A Radix dialog renders through a portal, which
 * `renderToStaticMarkup` produces nothing for — and every other component here is
 * proved by rendering it to a string. A plain fixed overlay costs the focus trap
 * and gains a testable component, so the Escape key and the backdrop click are
 * wired by hand below.
 *
 * The notes box is dead until the answer is Yes, and the commit button is dead
 * until the question is answered at all; both rules live in `applyPromptState`,
 * tested with plain values.
 */
export function ApplyPrompt({ job, onAnswer, onDismiss }: ApplyPromptProps) {
  const [answer, setAnswer] = useState<ApplyAnswer>(null);
  const [notes, setNotes] = useState("");
  const { notesEnabled, submitEnabled, submitLabel } = applyPromptState(answer);

  // Escape closes it from wherever focus happens to be. Ours to wire, since this
  // is not a Radix Dialog (see above).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  // Picking Yes puts the cursor straight in the box that just came alive, so the
  // note can be typed without a second click hunting for it.
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (notesEnabled) notesRef.current?.focus();
  }, [notesEnabled]);

  // The row's own fallback, for the same reason: a prompt with no heading under
  // the question would be asking about nothing in particular.
  const title = job.title.trim() || "Untitled role";

  return (
    <div
      data-slot="apply-prompt"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      // A click on the backdrop dismisses; one inside the card must not. The
      // target check rather than a stopPropagation on the card, so the card stays
      // an ordinary element with no event handling of its own.
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-prompt-title"
        data-job-id={job.id}
        className="flex w-full max-w-[340px] flex-col gap-3 rounded-lg border bg-card p-4 shadow-lg"
      >
        <div className="flex flex-col gap-1">
          <h2 id="apply-prompt-title" className="text-sm font-semibold text-foreground">
            Did you apply for this job?
          </h2>
          {/* Which job — a question that arrives minutes later, in a popup you
              reopened, is meaningless without it. */}
          <p className="text-xs text-muted-foreground">{metaLine([title, job.company])}</p>
        </div>

        {/* One choice with two positions, the same segmented control the New⇄All
            toggle uses. The empty-string guard is Radix deselecting on a second
            click of the active item, which puts the question back to unanswered —
            fine here, unlike the list mode, so it is mapped to `null` rather than
            swallowed. */}
        <ToggleGroup
          type="single"
          size="sm"
          value={answer ?? ""}
          onValueChange={(v) => setAnswer((v || null) as ApplyAnswer)}
          className="w-full rounded-md border bg-muted/50 p-0.5"
        >
          <ToggleGroupItem
            value="yes"
            data-answer="yes"
            className="h-8 flex-1 rounded-sm text-xs data-[state=on]:bg-card data-[state=on]:shadow-sm"
          >
            Yes
          </ToggleGroupItem>
          <ToggleGroupItem
            value="no"
            data-answer="no"
            className="h-8 flex-1 rounded-sm text-xs data-[state=on]:bg-card data-[state=on]:shadow-sm"
          >
            No
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="apply-notes" className="text-xs text-muted-foreground">
            Notes (optional)
          </Label>
          <Textarea
            id="apply-notes"
            ref={notesRef}
            rows={3}
            value={notes}
            disabled={!notesEnabled}
            // The placeholder carries the rule the disabled box cannot say for
            // itself: it is Yes that opens it, not a bug.
            placeholder={
              notesEnabled
                ? "Referral, cover letter, who you spoke to…"
                : "Answer Yes to add a note"
            }
            onChange={(e) => setNotes(e.target.value)}
            className="resize-none text-xs md:text-xs"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-action="apply-dismiss"
            onClick={onDismiss}
            className="text-muted-foreground"
          >
            Not now
          </Button>
          <Button
            type="button"
            size="sm"
            data-action="apply-submit"
            disabled={!submitEnabled}
            onClick={() => onAnswer(answer === "yes", notes)}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
