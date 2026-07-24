import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { applyPromptStep, metaLine, type ApplyAnswer } from "@/view-model.ts";

/** The little the prompt needs in order to say *which* job it is asking about.
 *  The url is deliberately absent: the message's link is read from storage by the
 *  worker that sends it, so the dialog never has to carry it around. */
export type ApplyPromptJob = { id: string; title: string; company: string };

export type ApplyPromptProps = {
  job: ApplyPromptJob;
  /** Yes with the typed note, or No with nothing. What each *means* is the
   *  caller's: only Yes is recorded and pushed (see `markJobApplied`). */
  onAnswer: (applied: boolean, notes: string) => void;
  /** Escape, the backdrop, or "Cancel" — the question goes away unanswered and
   *  nothing is written, even if Yes had been clicked. */
  onDismiss: () => void;
};

/**
 * The backdrop and card both dialogs share, and the two ways out that belong to
 * the overlay rather than to either question: Escape, and a click outside.
 *
 * Deliberately NOT a Radix Dialog. A Radix dialog renders through a portal, which
 * `renderToStaticMarkup` produces nothing for — and every other component here is
 * proved by rendering it to a string. A plain fixed overlay costs the focus trap
 * and gains a testable component, so the two are wired by hand below.
 */
function ApplyDialog({
  job,
  heading,
  onDismiss,
  children,
}: {
  job: ApplyPromptJob;
  heading: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  // Escape closes it from wherever focus happens to be. Ours to wire, since this
  // is not a Radix Dialog (see above).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  // The row's own fallback, for the same reason: a card with no heading under the
  // question would be asking about nothing in particular.
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
            {heading}
          </h2>
          {/* Which job — a question that arrives minutes later, in a popup you
              reopened, is meaningless without it. And it is repeated on the second
              dialog: by then you have answered one question already. */}
          <p className="text-xs text-muted-foreground">{metaLine([title, job.company])}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The first dialog: the question itself, and the two answers as two buttons.
 *
 * Two plain buttons rather than a segmented control, because this is not a
 * setting being toggled — it is a question being answered, once, and each button
 * is an act with a consequence. No answers and closes on the click; Yes hands
 * over to the second dialog.
 *
 * There is no third "not now" alongside them: it would say exactly what No
 * already says, since No records nothing either. Sitting in the dialog's footer
 * where a cancel would be, No *is* the way out.
 */
export function ApplyQuestion({
  job,
  onYes,
  onNo,
  onDismiss,
}: {
  job: ApplyPromptJob;
  onYes: () => void;
  onNo: () => void;
  onDismiss: () => void;
}) {
  return (
    <ApplyDialog job={job} heading="Did you apply for this job?" onDismiss={onDismiss}>
      {/* Right-aligned and No first: the ordinary dialog footer, with the answer
          that does something last, under the thumb. */}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="outline" data-answer="no" onClick={onNo}>
          No
        </Button>
        <Button type="button" size="sm" data-answer="yes" onClick={onYes}>
          Yes
        </Button>
      </div>
    </ApplyDialog>
  );
}

/**
 * The second dialog, and Yes is the only way to it: the note that rides along
 * with the application.
 *
 * Only Submit records anything. Cancel — like Escape and the backdrop — takes the
 * Yes back with it: the job is not marked applied and no message goes out, which
 * is the way out of a Yes that was a misclick.
 */
export function ApplyNote({
  job,
  onSave,
  onDismiss,
}: {
  job: ApplyPromptJob;
  onSave: (notes: string) => void;
  onDismiss: () => void;
}) {
  const [notes, setNotes] = useState("");

  // Landing here is already the decision to write something, so the cursor is in
  // the box on arrival — no second click hunting for it.
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    notesRef.current?.focus();
  }, []);

  return (
    <ApplyDialog job={job} heading="Add a note?" onDismiss={onDismiss}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="apply-notes" className="text-xs text-muted-foreground">
          Notes (optional)
        </Label>
        <Textarea
          id="apply-notes"
          ref={notesRef}
          rows={3}
          value={notes}
          placeholder="Referral, cover letter, who you spoke to…"
          onChange={(e) => setNotes(e.target.value)}
          className="resize-none text-xs md:text-xs"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        {/* Out of here without the Yes: nothing is marked, nothing is sent. */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-action="apply-dismiss"
          onClick={onDismiss}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" data-action="apply-submit" onClick={() => onSave(notes)}>
          Submit
        </Button>
      </div>
    </ApplyDialog>
  );
}

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
 * Asked as two dialogs, because the two answers cost different things. No is the
 * common one and is done in a single click: it answers, records nothing and
 * closes — which is also why it is the only way out the first dialog needs. Yes
 * is the one worth a second screen, so it — and only it — opens the note. Which
 * dialog belongs to which answer is `applyPromptStep`'s, tested with plain values.
 */
export function ApplyPrompt({ job, onAnswer, onDismiss }: ApplyPromptProps) {
  const [answer, setAnswer] = useState<ApplyAnswer>(null);

  return applyPromptStep(answer) === "ask" ? (
    <ApplyQuestion
      job={job}
      onYes={() => setAnswer("yes")}
      onNo={() => onAnswer(false, "")}
      onDismiss={onDismiss}
    />
  ) : (
    <ApplyNote job={job} onSave={(notes) => onAnswer(true, notes)} onDismiss={onDismiss} />
  );
}
