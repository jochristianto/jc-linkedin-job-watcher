// The plain-English explainer at the foot of the Options page.
//
// Every other section names a knob and trusts you to know what it is for. That is
// fine once you have the model — but the model itself lived only in the README,
// which you have to leave the extension to read. So it lives here too: what a
// scan round actually does, in the order it does it, with no jargon and no PRD
// section numbers. The GitHub link at the bottom is the way out to the full
// README, the source, and the issue tracker.
//
// It has been three things now. It started collapsed above the settings, where an
// open essay was something to scroll past; then it moved into a column beside
// them, where it cost the settings a third of the page for text you read once.
// Now it is the last section of the page, in the rail with everything else — the
// place you look things up from rather than the thing in your way — and the
// prose runs in two columns so the whole of it fits one screen. Nothing
// collapses, so there is no state to keep and nothing to re-open.

import { ExternalLink } from "lucide-react";

/** Source, full README, and issues. The one link out of the extension. */
export const REPO_URL = "https://github.com/jochristianto/jc-linkedin-job-watcher";

/** One numbered step of a scan round: the lead is the thing that happens, the
 *  rest is the qualification that stops it being read as more than it is. */
const STEPS: [string, string][] = [
  [
    "Opens each watch in a hidden tab",
    "— one at a time, with a pause in between, using the LinkedIn session you are already signed in to. The tab never takes focus and closes itself.",
  ],
  [
    "Reads the results the way you would,",
    "in your own browser. Nothing is sent to a server and no account details leave this machine.",
  ],
  [
    "Throws away everything already shown,",
    "plus anything caught by your blocked companies and title keywords.",
  ],
  [
    "Whatever is left is new.",
    "The toolbar count goes up, you get one desktop notification for the whole round — not one per job — and a Telegram message if you set that up.",
  ],
  [
    "Hands you the list, not the job.",
    "The notification opens this extension's own list; you choose from there what is worth opening on LinkedIn.",
  ],
];

/** The things that surprise people, answered before they have to ask. */
const NOTES: [string, string][] = [
  [
    "Nothing runs while Chrome is closed.",
    "No extension can. When you open it again the watcher does one deeper catch-up round to fill the gap — same when quiet hours end.",
  ],
  [
    "It slows itself down when things are quiet.",
    "After a few rounds that find nothing the gap stretches towards an hour; one round that finds something puts it straight back.",
  ],
  [
    "Opening a job does not clear it.",
    "It stays in the list marked as visited. Only the tick on a row clears it and brings the count down.",
  ],
  [
    "Your own LinkedIn tabs are never touched.",
    "Only the hidden tab the watcher opens for itself is ever read.",
  ],
  [
    "The switch in the popup header stops everything",
    "until you turn it back on — a full pause, not just quieter.",
  ],
  [
    "Reading LinkedIn this way is against their terms.",
    "Personal single-user use in your own signed-in browser is low-risk in practice, not no-risk — the realistic worst case is your account being restricted.",
  ],
];

/** The heading over each column. Small, upper-case and quiet: it labels a column
 *  rather than starting a new section, which the card title already did. */
function ColumnHeading({ children }: { children: string }) {
  return (
    <span className="text-[10.5px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
      {children}
    </span>
  );
}

function Lead({ lead, rest }: { lead: string; rest: string }) {
  return (
    <p className="m-0 text-[12.5px] leading-relaxed text-pretty text-muted-foreground">
      <b className="font-semibold text-foreground">{lead}</b> {rest}
    </p>
  );
}

export function HowItWorks() {
  return (
    <div id="how-it-works" className="flex flex-wrap gap-x-8 gap-y-5">
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-3">
        <ColumnHeading>Every round</ColumnHeading>
        {STEPS.map(([lead, rest], i) => (
          <div key={lead} className="flex items-start gap-2.5">
            {/* The number carries the order, so the text does not have to. */}
            <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-[11px] font-bold text-primary">
              {i + 1}
            </span>
            <Lead lead={lead} rest={rest} />
          </div>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-3">
        <ColumnHeading>Worth knowing</ColumnHeading>
        {NOTES.map(([lead, rest]) => (
          <div key={lead} className="flex items-start gap-2.5">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-border" />
            <Lead lead={lead} rest={rest} />
          </div>
        ))}
        <a
          id="repo-link"
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 inline-flex w-fit items-center gap-1.5 text-[12.5px] font-semibold text-primary underline underline-offset-4 hover:text-primary/80"
        >
          Source, README and issues on GitHub
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      </div>
    </div>
  );
}
