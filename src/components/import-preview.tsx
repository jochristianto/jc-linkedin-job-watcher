// The import wizard's body — every screen between choosing a backup file and
// something being written.
//
// Props-only and fully controlled: no storage, no `chrome.*`, no internal step
// state, no `useEffect`. Which screens exist, which is next, what each line says
// and what the confirm sentence reads are all decided in `import-plan.ts`, so this
// component only maps that data to JSX — the same split `selectView` gives the
// list view, applied to a wizard. Which is also why the whole thing is renderable
// from a test with `react-dom/server` and by the mockup builder.
//
// The wizard exists because the old import was a single dialog that told you what
// was in the *file* and then overwrote everything with it. What it never told you
// was what you were about to lose.

import { useState } from "react";
import { ChevronDown, GitMerge, Replace } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { backupCounts, backupPhrase, type BackupFile } from "@/backup.ts";
import {
  GROUP_LABELS,
  confirmLabel,
  confirmSentence,
  stepAfter,
  stepBefore,
  stepTitle,
  type DiffGroup,
  type DiffLine,
  type ImportDiff,
  type ImportMode,
  type ImportStep,
  type SettingChoiceKey,
  type SettingChoices,
  type SettingSide,
} from "@/import-plan.ts";

/** The style each kind of line is read in. Only a removal is coloured — it is the
 *  one that costs you something, and colouring the others as well would leave
 *  nothing standing out. */
const LINE_TONE: Record<DiffLine["kind"], string> = {
  added: "text-foreground",
  same: "text-muted-foreground",
  advanced: "text-foreground",
  removed: "text-destructive",
};

/**
 * One count, and the names behind it.
 *
 * `defaultOpen` rather than a controlled `open`: which lines you have expanded is
 * about reading, not about the import, so it does not belong in the page's state —
 * and a prop is what lets a test and the mockup render the open state without
 * clicking anything.
 *
 * A line with no names (seen ids have none — an id is not something to read) is
 * rendered as plain text rather than as a button that opens onto nothing.
 */
function Line({ line, defaultOpen = false }: { line: DiffLine; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = LINE_TONE[line.kind];

  if (line.names.length === 0) {
    return (
      <p data-line={line.kind} className={cn("py-1 text-xs", tone)}>
        {line.label}
      </p>
    );
  }

  return (
    <div data-line={line.kind}>
      {/* `<details>` would be less code and ships a platform disclosure triangle,
          which is exactly the bare glyph the icon rule exists to keep out — it
          renders at a different weight on every OS and ignores the theme. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-xs hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          tone,
        )}
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
        {line.label}
      </button>
      {open && (
        <ul className="mb-1 ml-5 list-disc space-y-0.5 pl-3 text-xs text-muted-foreground">
          {line.names.map((name) => (
            <li key={name} className="wrap-break-word">
              {name}
            </li>
          ))}
          {line.overflow > 0 && (
            <li className="list-none pl-0 italic">
              and {line.overflow.toLocaleString("en-US")} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function Group({ group, defaultOpen = false }: { group: DiffGroup; defaultOpen?: boolean }) {
  return (
    <section data-group={group.title} className="py-1">
      <h4 className="text-[13px] font-semibold">{group.title}</h4>
      {group.lines.map((line) => (
        <Line key={line.kind} line={line} defaultOpen={defaultOpen} />
      ))}
    </section>
  );
}

/** One of the two mode cards on the first screen. A card rather than a radio row:
 *  the choice is between two paragraphs, not between two words. */
function ModeCard({
  mode,
  active,
  title,
  blurb,
  icon,
  onPick,
}: {
  mode: ImportMode;
  active: boolean;
  title: string;
  blurb: string;
  icon: React.ReactNode;
  onPick: (mode: ImportMode) => void;
}) {
  return (
    <button
      type="button"
      data-mode={mode}
      aria-pressed={active}
      onClick={() => onPick(mode)}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-left transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        active ? "border-primary bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className={cn("mt-0.5 shrink-0", active ? "text-primary" : "text-muted-foreground")}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground text-pretty">
          {blurb}
        </span>
      </span>
    </button>
  );
}

/** One settings row: both values on screen at once, which is why this is a
 *  two-item toggle rather than a checkbox — a checkbox has room for one label,
 *  and the whole point of the screen is to show you both. */
function ChoiceRow({
  choice,
  side,
  onChoose,
}: {
  choice: { key: SettingChoiceKey; label: string; mine: string; file: string };
  side: SettingSide;
  onChoose: (key: SettingChoiceKey, side: SettingSide) => void;
}) {
  return (
    <div data-choice={choice.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
      <p className="min-w-0 flex-1 basis-40 text-xs font-medium">{choice.label}</p>
      <ToggleGroup
        type="single"
        size="sm"
        value={side}
        onValueChange={(v) => v && onChoose(choice.key, v as SettingSide)}
        className="shrink-0 gap-0.5 rounded-lg border bg-muted p-0.5"
      >
        <ToggleGroupItem
          value="mine"
          data-side="mine"
          aria-label={`Keep mine: ${choice.mine}`}
          className="h-6.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-bold data-[state=on]:text-primary data-[state=on]:shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
        >
          Mine · {choice.mine}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="file"
          data-side="file"
          aria-label={`Take the file's: ${choice.file}`}
          className="h-6.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-bold data-[state=on]:text-primary data-[state=on]:shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
        >
          File · {choice.file}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export type ImportPreviewProps = {
  /** The validated file, for the provenance line on the first screen. */
  backup: BackupFile;
  diff: ImportDiff;
  steps: ImportStep[];
  step: ImportStep;
  mode: ImportMode;
  choices: SettingChoices;
  /** A round started while the wizard was open. The worker would refuse the write,
   *  so the confirm button says so instead of letting the click bounce off it. */
  scanning: boolean;
  /** Render the first line of each group already open. Test and mockup only —
   *  nothing in the page passes it. */
  expandDetail?: boolean;
  onMode: (mode: ImportMode) => void;
  onChoose: (key: SettingChoiceKey, side: SettingSide) => void;
  onStep: (step: ImportStep) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * The wizard, one screen at a time.
 *
 * `steps` is passed in rather than derived here for the same reason `selectView`
 * exists: which screens this file needs is a decision, it depends on what the diff
 * holds, and a decision made inside a component is a decision `npm test` cannot
 * reach.
 */
export function ImportPreview({
  backup,
  diff,
  steps,
  step,
  mode,
  choices,
  scanning,
  expandDetail = false,
  onMode,
  onChoose,
  onStep,
  onConfirm,
  onCancel,
}: ImportPreviewProps) {
  const back = stepBefore(steps, step);
  const next = stepAfter(steps, step);
  const position = steps.indexOf(step) + 1;

  return (
    <div data-step={step} className="flex min-h-0 flex-col gap-3">
      {/* `pr-7` keeps the step badge clear of `DialogContent`'s own close button,
          which is absolutely positioned at `top-3 right-3` and so knows nothing
          about what is laid out underneath it. Only this row is inset — the
          scrolling half and the footer below both want the full width. */}
      <div className="flex items-center justify-between gap-3 pr-7">
        <h3 className="text-sm font-semibold">{stepTitle(step, mode)}</h3>
        <Badge variant="secondary" className="shrink-0 text-[11px] font-medium">
          Step {position} of {steps.length}
        </Badge>
      </div>

      {/* The scrolling half. A file with two thousand new jobs must not push the
          Back and Import buttons off the bottom of the dialog. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === "mode" && (
          <div className="flex flex-col gap-2.5">
            <p className="text-xs leading-snug text-muted-foreground text-pretty">
              Exported {new Date(backup.exportedAt).toLocaleString()} by version{" "}
              {backup.extensionVersion}, holding {backupPhrase(backupCounts(backup))}.
            </p>
            <ModeCard
              mode="merge"
              active={mode === "merge"}
              title="Merge it in"
              blurb="Add what the file has and keep what you have. Nothing here is removed, and a job you have already opened or applied to stays that way."
              icon={<GitMerge className="size-4.5" aria-hidden="true" />}
              onPick={onMode}
            />
            <ModeCard
              mode="replace"
              active={mode === "replace"}
              title="Replace everything"
              blurb="Make this browser match the file exactly. Anything not in the file goes — which is the only way a backup can be used to remove something. There is no undo."
              icon={<Replace className="size-4.5" aria-hidden="true" />}
              onPick={onMode}
            />
          </div>
        )}

        {step === "settings" && (
          <div className="flex flex-col">
            <p className="mb-1.5 text-xs leading-snug text-muted-foreground text-pretty">
              Only the settings you and the file disagree about. Everything is set to
              yours — tick a row over to take the file's value instead. Your watches,
              blocked companies and blocked keywords are not here: those merge on their
              own, because keeping both sides needs no decision.
            </p>
            {[...new Set(diff.settings.map((c) => c.group))].map((groupKey) => (
              <div key={groupKey} data-settings-group={groupKey}>
                <Separator className="my-2" />
                <h4 className="text-[13px] font-semibold">{GROUP_LABELS[groupKey]}</h4>
                {diff.settings
                  .filter((c) => c.group === groupKey)
                  .map((choice) => (
                    <ChoiceRow
                      key={choice.key}
                      choice={choice}
                      side={choices[choice.key] ?? "mine"}
                      onChoose={onChoose}
                    />
                  ))}
              </div>
            ))}
          </div>
        )}

        {step === "lists" &&
          diff.lists.map((group) => (
            <Group key={group.title} group={group} defaultOpen={expandDetail} />
          ))}

        {step === "history" &&
          diff.history.map((group) => (
            <Group key={group.title} group={group} defaultOpen={expandDetail} />
          ))}

        {step === "confirm" && (
          <p
            className={cn(
              "text-xs leading-relaxed text-pretty",
              mode === "replace" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {confirmSentence(diff)}
          </p>
        )}
      </div>

      {scanning && step === "confirm" && (
        <p id="import-blocked" className="text-xs text-destructive">
          A round started while you were reading. Wait for it to finish — it is
          rewriting the same job history this would.
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" id="import-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          {back !== null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              id="import-back"
              onClick={() => onStep(back)}
            >
              Back
            </Button>
          )}
          {next === null ? (
            <Button
              type="button"
              size="sm"
              id="import-confirm"
              disabled={scanning}
              aria-describedby={scanning ? "import-blocked" : undefined}
              onClick={onConfirm}
              className={cn(mode === "replace" && buttonVariants({ variant: "destructive" }))}
            >
              {confirmLabel(mode)}
            </Button>
          ) : (
            <Button type="button" size="sm" id="import-next" onClick={() => onStep(next)}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
