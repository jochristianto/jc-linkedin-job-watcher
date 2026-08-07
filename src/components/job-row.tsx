import {
  BadgeCheck,
  Ban,
  ExternalLink,
  EyeIcon,
  EyeOffIcon,
  Footprints,
  History,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  companyTone,
  formatAgo,
  metaLine,
  monogram,
  postedAge,
  postedHover,
  shortAge,
  splitLocation,
  type JobView,
  type ViewVariant,
} from "@/view-model.ts";

export type JobRowProps = {
  job: JobView;
  /**
   * Which of the two surfaces this row is in — and the row is genuinely two
   * layouts, not one layout at two sizes.
   *
   * In the tab there is width to spare: the employer monogram leads the row and
   * the actions sit out to the right of the posting, centred against it.
   *
   * In the popup there are 380 pixels for all of it, and those two decorations
   * were costing about 100 of them — enough that nearly every title wrapped to
   * two or three lines and the card grew taller than the job it was describing.
   * So the popup drops the monogram to a bare unread dot and moves the actions
   * to their own line under the posting, where they split it evenly between
   * them. The row is a little taller in the places it was already short, and
   * much shorter in the places it was not.
   */
  variant?: ViewVariant;
  /** This row's Block button pressed once, now reading "Sure?" and waiting for
   *  the press that commits. Transient view state, not job state — `useArmedBlock`
   *  holds which row it is and clears it after {@link BLOCK_CONFIRM_MS}. */
  armed?: boolean;
  /** The clock, injected for the same reason `selectView` takes one: "Found 41m
   *  ago" is a pure function of `job.foundAt` and now, and passing the second in
   *  is what lets a test assert the chip without freezing the system clock. */
  now?: number;
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

/** The tinted pill the work mode gets. Remote and On-site are different jobs and
 *  people filter on the difference by eye, so the three modes are three tones
 *  rather than three more words in a grey line. Inline rather than a class
 *  because the tone is chosen at runtime and `color-mix` is what keeps a 10%
 *  wash readable in both colour schemes. */
function modeStyle(mode: string): CSSProperties {
  const tone = /remote/i.test(mode)
    ? "var(--success)"
    : /hybrid/i.test(mode)
      ? "var(--info)"
      : "var(--foreground)";
  return {
    background: `color-mix(in oklab, ${tone} 10%, var(--card))`,
    color: `color-mix(in oklab, ${tone} 78%, var(--card-foreground))`,
  };
}

/** The employer tile's colours, from the stable per-company tone. Unread rows get
 *  a slightly stronger wash so the tile carries a little of the row's own weight. */
function monoStyle(company: string, unread: boolean): CSSProperties {
  const tone = `var(--chart-${companyTone(company)})`;
  return {
    background: `color-mix(in oklab, ${tone} ${unread ? 18 : 12}%, var(--card))`,
    color: `color-mix(in oklab, ${tone} 80%, var(--card-foreground))`,
    borderColor: `color-mix(in oklab, ${tone} 26%, transparent)`,
  };
}

/** One chip in the meta line: same shape, different fills. */
function Chip({
  children,
  className,
  style,
  title,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={style}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-[7px] py-px whitespace-nowrap",
        className,
      )}
    >
      {children}
    </span>
  );
}

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
 * Triage is the whole job of this list, so the row leads with an employer
 * monogram — blocking is an employer-level decision, and repeat senders should be
 * recognisable before their name is read — and breaks the metadata into scannable
 * chips: work mode, source watch, and the two ages, which are two different facts.
 * "Posted 6h ago" is the posting's own age; "Found 41m ago" is when your watcher
 * picked it up, and only the second says whether the loop is keeping up.
 *
 * Fields fail independently: a missing company, location or posted time simply
 * drops its chip; a missing title falls back to a placeholder so the row is
 * never blank (PRD §12 "each field fails independently").
 *
 * `data-read`/`data-opened`/`data-blocked`/`data-applied` are no longer read by an
 * event delegate — React wires the callbacks directly — but they stay as the handle
 * the tests and QA assert a row's state through.
 */
export function JobRow({
  job,
  variant = "tab",
  armed = false,
  now = Date.now(),
  onOpen,
  onToggleRead,
  onBlock,
  onUnapply,
  footer,
}: JobRowProps) {
  // The popup's layout: no monogram, actions on their own line below. See the
  // `variant` prop for why the two surfaces do not share one row.
  const stacked = variant === "popup";
  // Only the title needs a fallback — it's the one field always rendered. The
  // rest (company, location, posted time) are dropped by metaLine when blank.
  const title = job.title.trim() || "Untitled role";
  const meta = metaLine([job.company, job.location]);

  const { mode } = splitLocation(job.location);
  const found = formatAgo(now - job.foundAt);
  const mono = monogram(job.company);

  // The posting's own age, four cases (issue #51), in priority order:
  //  - A stored `postedAt` → a *live* rung recomputed every render, so a job
  //    found three weeks ago stops insisting it was posted two weeks ago; the
  //    date in words on hover, and a `~` when the date is only estimated.
  //  - `linkedInStatus: "viewed"` → no date at all (LinkedIn withheld it), a
  //    `Seen on LinkedIn` chip instead. A viewed card carries no `postedAt` by
  //    construction, so the age and the chip are mutually exclusive.
  //  - No date but a frozen `postedText` → the legacy phrase, exactly as before:
  //    records saved before #48 have no `postedAt` and age out within 30 days.
  //  - Nothing → nothing.
  const seen = job.linkedInStatus === "viewed";
  const postedAt = job.postedAt;
  const hasDate = postedAt != null;
  const age = postedAt != null ? postedAge(postedAt, now) : "";
  // Only "estimated" earns the tilde; "exact" and "day" are both true at the
  // resolution the row shows them, so marking them apart would be noise.
  const ageTilde = job.postedPrecision === "estimated" ? "~" : "";
  const ageHover =
    postedAt != null ? postedHover(postedAt, job.postedPrecision) : undefined;
  const frozen = !hasDate && !seen ? shortAge(job.postedText) : "";

  // Read and blocked both grey the row, so the row says which one it is.
  const dimmed = job.read || job.blocked;
  // The dot means "you have not looked at this one", so clicking through to the
  // posting clears it exactly as the tick does — and it is the same rule the
  // badge counts by (`unreadCount`), so the dots on screen always add up to the
  // number in the header. The row itself stays on the New list either way; what
  // separates "clicked" from "ticked" from there is the "Opened" chip below and
  // the grey wash, which only the tick applies. Blocked rows never carry a dot —
  // greyed out of the badge count, so a dot would be claiming a job that isn't.
  const unread = !job.read && !job.opened && !job.blocked;

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

  const actions = (
    <RowActions
      job={job}
      stacked={stacked}
      armed={armed}
      appliedLabel={appliedLabel}
      blockLabel={blockLabel}
      blockText={blockText}
      readLabel={readLabel}
      company={company}
      onToggleRead={onToggleRead}
      onBlock={onBlock}
      onUnapply={onUnapply}
    />
  );

  return (
    <div
      data-job-id={job.id}
      data-read={job.read}
      data-opened={job.opened}
      data-blocked={job.blocked}
      data-applied={job.applied}
      // Which of the two layouts this row is in, for the same reason the four
      // above are here: it is the handle the tests and QA read the row through.
      data-actions={stacked ? "below" : "inline"}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-[10px] border bg-card",
        "shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-[opacity,background-color] duration-200",
        "has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50",
        // Read is the row filed away: it keeps its place in All, tinted back
        // towards the page so the unread ones are the white cards. Blocked is
        // filed away too, and takes the same tint — deliberately a background
        // rather than the opacity the whole card used to carry, because fading
        // the card faded its buttons with it and Unblock, the one way back from
        // a mis-click, ended up looking disabled. The greying that says "this
        // one is out" belongs on the text (`dimmed`), not on the controls.
        dimmed && "bg-[color-mix(in_oklab,var(--muted)_55%,var(--card))]",
      )}
    >
      <div
        className={cn(
          "flex items-start px-3 py-2.5",
          stacked ? "gap-2" : "gap-2.5",
        )}
      >
        {/* The unread marker. In the tab it rides the corner of the employer
            tile; in the popup the tile is gone and the dot keeps a narrow column
            of its own, so read and unread titles still start on the same
            vertical line instead of shuffling sideways as rows are ticked. */}
        {stacked ? (
          <span
            aria-hidden="true"
            className="flex w-2 shrink-0 justify-center pt-2"
          >
            {unread && <span className="size-2 rounded-full bg-unread" />}
          </span>
        ) : (
          <span aria-hidden="true" className="relative shrink-0 pt-px">
            <span
              style={monoStyle(job.company, unread)}
              className="flex size-7.5 items-center justify-center rounded-[9px] border text-[13px] leading-none font-bold tracking-tight"
            >
              {mono}
            </span>
            {unread && (
              <span className="absolute -top-0.5 -right-0.75 size-2.5 rounded-full border-2 border-card bg-unread" />
            )}
          </span>
        )}

        <a
          href={job.url}
          title="Open on LinkedIn"
          className="flex min-w-0 flex-1 flex-col gap-0.5 outline-none"
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
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={cn(
                "text-sm leading-snug tracking-tight hover:underline hover:underline-offset-2",
                unread ? "font-semibold" : "font-medium",
                dimmed ? "text-foreground/60" : "text-foreground",
              )}
            >
              {title}
            </span>
            {job.blocked && (
              <Badge
                variant="secondary"
                className="h-4.5 px-1.5 text-[10px] font-normal"
              >
                Blocked
              </Badge>
            )}
          </span>

          {meta && (
            <span
              className={cn(
                "truncate text-[13px] leading-snug",
                dimmed ? "text-foreground/55" : "text-foreground",
              )}
            >
              {meta}
            </span>
          )}

          {/* The chips. Each one is dropped when the field behind it is missing,
              so a half-parsed card loses a chip rather than the whole line. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {mode && (
              <Chip style={modeStyle(mode)} className="font-semibold">
                {mode}
              </Chip>
            )}
            {job.watchName && (
              <Chip className="border bg-card">{job.watchName}</Chip>
            )}
            {hasDate ? (
              <span className="whitespace-nowrap" title={ageHover}>
                Posted {ageTilde}
                {age}
              </span>
            ) : (
              frozen && (
                <span className="whitespace-nowrap">Posted {frozen} ago</span>
              )
            )}
            <span
              title="When your watcher picked it up"
              className="inline-flex items-center gap-1 whitespace-nowrap text-[color-mix(in_oklab,var(--primary)_78%,var(--muted-foreground))]"
            >
              <History className="size-3 shrink-0" aria-hidden="true" />
              Found {found} ago
            </span>
            {job.opened && !job.applied && (
              <Chip className="bg-muted">
                <ExternalLink
                  className="size-2.5 shrink-0"
                  aria-hidden="true"
                />
                Opened
              </Chip>
            )}
            {/* LinkedIn withheld the date because the posting was opened
                *somewhere* — including directly on LinkedIn, outside this
                extension. That is the only signal we have ever had about
                browsing that happened without us, and it was thrown away until
                now. It sits with the other chips as a fact about the posting,
                not beside the title with `Blocked`, which is a verdict on it.
                It reads next to `Opened` on a row that earns both: "I opened
                this from here" plus "LinkedIn agrees". */}
            {seen && (
              <Chip
                className="bg-muted"
                title="LinkedIn withheld the posting date because this job has already been opened — anywhere, including on LinkedIn itself"
              >
                <Footprints className="size-2.5 shrink-0" aria-hidden="true" />
                Seen on LinkedIn
              </Chip>
            )}
          </span>

          {/* The note that rode along with the Yes. The whole reason it is stored
              is being able to read it back off the list weeks later, and until
              now nothing ever showed it. */}
          {job.applied && job.notes && (
            <span className="mt-1 block rounded-lg bg-muted px-2 py-1.5 text-xs leading-relaxed text-foreground">
              <span className="mr-1.5 font-semibold text-muted-foreground">
                Note
              </span>
              {job.notes}
            </span>
          )}
        </a>

        {/* Beside the posting in the tab. In the popup this renders empty and the
            same buttons appear on their own line below — see `actions`. */}
        {!stacked && actions}
      </div>

      {/* The popup's action line, full width under the posting and fenced off
          from it by a rule.
          Without the rule the buttons sat directly against the chips, and "Found
          4h ago · Opened" — grey, small, the same size as the labels beside it —
          read as the start of the same line rather than as the end of the
          posting. The border and the padding either side of it are what say the
          card has two halves: what the job is, then what you can do about it. */}
      {stacked && <div className="flex border-t mx-3 py-3">{actions}</div>}

      {/* Pinned inside the card, under the posting: "Did you apply for this job?"
          on the one row it is about. */}
      {footer}
    </div>
  );
}

/** The row's three controls, built once and placed by {@link JobRow} in one of
 *  two spots. Applied, then Block, then the tick out at the edge where a one-tap
 *  dismiss belongs. The Applied tag lives out here rather than in the meta line
 *  with the Blocked one because it is tappable, and interactive content inside
 *  the row's `<a>` is both invalid and unclickable.
 *
 *  The two placements want opposite things from the same buttons.
 *
 *  On their own line in the popup they are the whole line, so they take it: every
 *  button `flex-1` off a zero basis, which makes the usual pair an even 50:50 (and
 *  thirds on a row that also carries Applied). Half a card's width each is a
 *  target you hit without aiming — the thing a 380px window most needs — and two
 *  equal halves read as one control rather than as buttons trailing off the edge.
 *
 *  Beside the posting in the tab they are a margin, not a line, so they stay at
 *  their natural size and the tick loses its label: the row is already three or
 *  four lines of text and "Mark as read" spelled out next to it is a fifth
 *  competing for the same eye. The word survives as the tooltip and the
 *  accessible name, which is where it is wanted — on hover, and read aloud. */
function RowActions({
  job,
  stacked,
  armed,
  appliedLabel,
  blockLabel,
  blockText,
  readLabel,
  company,
  onToggleRead,
  onBlock,
  onUnapply,
}: {
  job: JobView;
  /** The popup's own line under the posting, rather than the tab's cluster
   *  beside it. See {@link JobRowProps.variant}. */
  stacked: boolean;
  armed: boolean;
  appliedLabel: string;
  blockLabel: string;
  blockText: string;
  readLabel: string;
  company: string;
  onToggleRead: () => void;
  onBlock: () => void;
  onUnapply: () => void;
}) {
  return (
    <span
      className={cn(
        "flex items-center",
        stacked
          ? "w-full gap-3"
          : // Centred against the posting rather than pinned to its first line:
            // the card is as tall as its chips and its note, and buttons hanging
            // off the top of that read as belonging to the title alone.
            "shrink-0 gap-3 self-center",
      )}
    >
      {job.applied && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-action="unapply"
          aria-pressed={true}
          // The visible word is only "Applied", so the accessible name is what has
          // to say that pressing it takes the record — and the note — away again.
          title={appliedLabel}
          aria-label={appliedLabel}
          onClick={onUnapply}
          className={cn(
            "h-8 gap-1 px-2 text-xs font-medium text-success hover:bg-success/10 hover:text-success",
            stacked && "flex-1",
          )}
        >
          <BadgeCheck className="size-3.5" aria-hidden="true" />
          Applied
        </Button>
      )}
      {company && (
        <Button
          type="button"
          size="sm"
          variant={armed ? "destructive" : "outline"}
          data-action="block"
          data-armed={armed}
          aria-pressed={job.blocked}
          // The visible label is only "Block"/"Sure?", so the accessible name
          // is what has to carry *which company* is about to disappear.
          title={armed ? `${blockLabel} — press again to confirm` : blockLabel}
          aria-label={
            armed ? `${blockLabel} — press again to confirm` : blockLabel
          }
          onClick={onBlock}
          className={cn(
            "h-8 gap-2 px-2 text-xs font-medium",
            stacked && "flex-1",
            // Red at rest so it reads as the one destructive thing on the row,
            // solid red once armed so the second press is unmistakable.
            !armed &&
              !job.blocked &&
              "text-destructive hover:bg-destructive/10 hover:text-destructive",
            // Unblock is not destructive, so it loses the red — but it keeps the
            // full-strength foreground, because it is the only way back off a
            // block and a grey label on a grey card reads as "nothing to press".
            job.blocked && "text-foreground hover:bg-muted",
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
        // Icon-only in the tab, so the button is square rather than a `sm` with
        // one lopsided side of padding where the word used to be.
        size={stacked ? "sm" : "icon-sm"}
        variant="default"
        data-action="read"
        aria-pressed={job.read}
        aria-label={readLabel}
        title={readLabel}
        onClick={onToggleRead}
        className={cn(
          stacked && "h-8 flex-1 gap-1.5 px-2 text-xs font-medium",
          // job.read
          //   ? "text-primary"
          //   : "text-muted-foreground hover:text-foreground",
        )}
      >
        {job.read ? (
          <EyeIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <EyeOffIcon className="size-3.5" aria-hidden="true" />
        )}
        {/* The label rides along only where there is a line to hold it. In the
            tab `aria-label` and `title` still carry it. */}
        {stacked && readLabel}
      </Button>
    </span>
  );
}
