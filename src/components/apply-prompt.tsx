import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { applyPromptStep, metaLine, type ApplyAnswer } from "@/view-model.ts";

/** The little the prompt needs in order to say *which* job it is asking about.
 *  The url is deliberately absent: the message's link is read from storage by the
 *  worker that sends it, so the prompt never has to carry it around. */
export type ApplyPromptJob = { id: string; title: string; company: string };

/**
 * Where this prompt is standing.
 *
 * `"row"` is the normal one: pinned inside the card of the job it is asking
 * about, the way LinkedIn's own "Did you finish applying?" sits in the posting.
 * `"list"` is the fallback for when that row is not on screen — the question
 * outlives a chip switch and a New⇄All switch, so it has to be askable with no
 * row to sit in (see `pendingApplyJob` in list-view).
 */
export type ApplyPromptPlacement = "row" | "list";

export type ApplyPromptProps = {
  job: ApplyPromptJob;
  placement?: ApplyPromptPlacement;
  /** Yes with the typed note, or No with nothing. What each *means* is the
   *  caller's: only Yes is recorded and pushed (see `markJobApplied`). */
  onAnswer: (applied: boolean, notes: string) => void;
  /** The note step's "Cancel" — the question goes away unanswered and nothing is
   *  written, even if Yes had been clicked. */
  onDismiss: () => void;
};

/**
 * The four things people actually write in this box, as one tap each.
 *
 * The note is optional and the box is empty on arrival, which in practice means
 * most answers carry no note at all — and a Yes with no note is a record you
 * cannot do anything with in three months. These are the common cases pre-typed,
 * so the useful version costs one click rather than a sentence. Appended with the
 * same " · " the meta line uses, so two chips read as one note and not two.
 */
const QUICK_NOTES = ["Referral", "Recruiter reply", "Cold apply", "Take-home sent"] as const;

/**
 * The tinted strip both steps share.
 *
 * Deliberately NOT a dialog, and not an overlay. The question is a small one
 * about something you did a minute ago, and a modal answers it by taking the
 * whole list hostage until you do — you cannot look at the row it is asking
 * about, or at anything else, without dismissing it first. Sitting in the layout
 * instead, it asks while the list stays readable and usable, and the answer is
 * still one click away. It is a wash of the brand colour rather than a health
 * tier because it is not a warning; nothing has gone wrong.
 *
 * In a row it names no job: the title is one line above it, inside the same card,
 * and repeating it there would be the same sentence twice. Standing alone in the
 * list it has to name one — a question that arrives minutes later, in a popup you
 * reopened, is about nothing in particular without it.
 */
function ApplyBanner({
  job,
  heading,
  placement,
  tone = "ask",
  children,
}: {
  job: ApplyPromptJob;
  heading: string;
  placement: ApplyPromptPlacement;
  /** The note step tints a shade further into the brand colour than the question
   *  does: it is the step you are being asked to *do* something in, not just
   *  answer, and the two need to look like two. */
  tone?: "ask" | "note";
  children: ReactNode;
}) {
  const inRow = placement === "row";
  // The row's own fallback, for the same reason it has one: a strip that names a
  // blank title would be asking about nothing.
  const title = job.title.trim() || "Untitled role";

  return (
    <section
      data-slot="apply-prompt"
      data-placement={placement}
      aria-labelledby="apply-prompt-title"
      data-job-id={job.id}
      // Wraps rather than shrinks: at 380px the popup can run out of room for the
      // question and the answers side by side, and when it does the answers drop
      // to their own line instead of squeezing the words being answered.
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5",
        // Flush with the card's edges and separated by a rule, not inset: the
        // strip is the bottom of the posting's own card, so a floating block
        // tucked inside it would read as a second, unrelated thing.
        inRow ? "border-t" : "border-y",
        tone === "ask"
          ? "bg-[color-mix(in_oklab,var(--primary)_7%,var(--card))]"
          : "border-primary/20 bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))]",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <h2
          id="apply-prompt-title"
          className="text-[13px] font-semibold text-foreground"
        >
          {heading}
        </h2>
        {!inRow && (
          <p className="truncate text-xs text-muted-foreground">
            {metaLine([title, job.company])}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * The first step: the question itself, and the two answers as two buttons.
 *
 * Two plain buttons rather than a segmented control, because this is not a
 * setting being toggled — it is a question being answered, once, and each button
 * is an act with a consequence. No answers and closes the strip; Yes hands over
 * to the second step.
 *
 * There is no third "not now" alongside them: it would say exactly what No
 * already says, since No records nothing either. No *is* the way out, which is
 * also why the strip needs no close button of its own.
 */
export function ApplyQuestion({
  job,
  placement = "row",
  onYes,
  onNo,
}: {
  job: ApplyPromptJob;
  placement?: ApplyPromptPlacement;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <ApplyBanner
      job={job}
      placement={placement}
      heading="Did you apply for this job?"
    >
      {/* Yes is the answer that does something and it is the filled one; No is the
          outline beside it. Sized to sit inside a row without out-weighing the
          posting above them, but still padded past the two words they hold: a
          pair of targets that short, next to each other, is a pair that gets
          misclicked. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          data-answer="yes"
          onClick={onYes}
          className="h-8 px-4 text-[13px]"
        >
          Yes
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-answer="no"
          onClick={onNo}
          className="h-8 bg-card px-4 text-[13px]"
        >
          No
        </Button>
      </div>
    </ApplyBanner>
  );
}

/**
 * The second step, and Yes is the only way to it: the note that rides along with
 * the application.
 *
 * Only Save records anything. Cancel takes the Yes back with it: the job is not
 * marked applied and no message goes out, which is the way out of a Yes that was
 * a misclick.
 *
 * The box grows with what is typed rather than scrolling inside three fixed rows.
 * A note is one to four lines and you are writing it to read it back later, so
 * hiding the first line the moment you reach the fourth is the one behaviour this
 * field must not have.
 */
export function ApplyNote({
  job,
  placement = "row",
  onSave,
  onDismiss,
}: {
  job: ApplyPromptJob;
  placement?: ApplyPromptPlacement;
  onSave: (notes: string) => void;
  onDismiss: () => void;
}) {
  const [notes, setNotes] = useState("");
  const notesRef = useRef<HTMLTextAreaElement>(null);

  /** Re-fit the box to its content. Height is cleared first because `scrollHeight`
   *  of an already-tall box never shrinks back on its own — without the reset,
   *  deleting a line leaves the gap behind. */
  const grow = useCallback(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Landing here is already the decision to write something, so the cursor is in
  // the box on arrival — no second click hunting for it.
  useEffect(() => {
    notesRef.current?.focus();
  }, []);

  /** A quick-note chip, appended to whatever is already typed. Focus goes back to
   *  the box afterwards: the chips are a head start on a note, not a replacement
   *  for one, and leaving focus on the chip makes the next keystroke go nowhere. */
  const addQuick = (label: string) => {
    setNotes((cur) => (cur.trim() ? `${cur.trim()} · ${label}` : label));
    requestAnimationFrame(() => {
      notesRef.current?.focus();
      grow();
    });
  };

  return (
    <ApplyBanner job={job} placement={placement} heading="Add a note?" tone="note">
      {/* A full-width row of its own under the job, not beside it: the box is the
          thing being filled in, and half a strip is not enough of it to type in. */}
      <div className="flex w-full basis-full flex-col gap-1.5">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_NOTES.map((label) => (
            <button
              key={label}
              type="button"
              data-action="apply-quick-note"
              onClick={() => addQuick(label)}
              className="cursor-pointer rounded-full border border-dashed border-foreground/20 px-2.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              + {label}
            </button>
          ))}
        </div>

        <Label htmlFor="apply-notes" className="sr-only">
          Notes (optional)
        </Label>
        <Textarea
          id="apply-notes"
          ref={notesRef}
          rows={3}
          value={notes}
          placeholder="Referral, recruiter, cover-letter version…"
          onChange={(e) => {
            setNotes(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            // The box swallows Enter, so the keyboard needs its own way to commit —
            // and Esc has to back out without recording, exactly as Cancel does.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onSave(notes);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onDismiss();
            }
          }}
          className="min-h-18.5 resize-none overflow-hidden bg-card text-[13px] md:text-[13px]"
        />

        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
            Cmd/Ctrl + Enter saves · Esc cancels
          </span>
          {/* Out of here without the Yes: nothing is marked, nothing is sent. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-action="apply-dismiss"
            onClick={onDismiss}
            className="h-8 px-3 text-[12.5px] text-muted-foreground"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-action="apply-submit"
            onClick={() => onSave(notes)}
            className="h-8 px-4 text-[12.5px]"
          >
            Save
          </Button>
        </div>
      </div>
    </ApplyBanner>
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
 * Asked in two steps, because the two answers cost different things. No is the
 * common one and is done in a single click: it answers, records nothing and
 * closes — which is also why it is the only way out the first step needs. Yes is
 * the one worth a second screen, so it — and only it — opens the note. Which step
 * belongs to which answer is `applyPromptStep`'s, tested with plain values.
 */
export function ApplyPrompt({
  job,
  placement = "row",
  onAnswer,
  onDismiss,
}: ApplyPromptProps) {
  const [answer, setAnswer] = useState<ApplyAnswer>(null);

  return applyPromptStep(answer) === "ask" ? (
    <ApplyQuestion
      job={job}
      placement={placement}
      onYes={() => setAnswer("yes")}
      onNo={() => onAnswer(false, "")}
    />
  ) : (
    <ApplyNote
      job={job}
      placement={placement}
      onSave={(notes) => onAnswer(true, notes)}
      onDismiss={onDismiss}
    />
  );
}
