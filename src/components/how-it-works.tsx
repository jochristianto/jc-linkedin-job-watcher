// The plain-English explainer at the top of the Options page.
//
// Every other card on that page names a knob and trusts you to know what it is
// for. That is fine once you have the model — but the model itself lived only in
// the README, which you have to leave the extension to read. So it lives here
// too: what a scan round actually does, in the order it does it, with no jargon
// and no PRD section numbers. The GitHub link at the bottom is the way out to
// the full README, the source, and the issue tracker.
//
// It is a `<details>`, open by default. It used to sit above the settings and
// start collapsed, where an open essay was something to scroll past; now it sits
// in its own column beside them, so showing it costs the settings no room and
// hiding it would only leave that column blank. Native disclosure still means no
// React state, no storage key to remember, and the keyboard and screen-reader
// behaviour is the browser's rather than ours — the same reasoning that keeps
// dark mode on `prefers-color-scheme` with no JS. `open` is the initial state
// only: React writes it once, so collapsing it survives every re-render of the
// form next door.

import { ChevronRight, ExternalLink } from "lucide-react";

/** Source, full README, and issues. The one link out of the extension. */
export const REPO_URL = "https://github.com/jochristianto/jc-linkedin-job-watcher";

export function HowItWorks() {
  return (
    <details
      open
      id="how-it-works"
      className="group rounded-xl border bg-card text-card-foreground shadow-sm"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-4 font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        How this works
      </summary>

      <div className="flex flex-col gap-5 border-t px-6 py-5 text-sm text-muted-foreground">
        <p>
          It re-runs your saved LinkedIn searches in the background and tells you when something
          genuinely new turns up — so you can stop refreshing the tab yourself.
        </p>

        <section className="flex flex-col gap-2">
          <h3 className="font-medium text-foreground">Every round, it:</h3>
          <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-faint">
            <li>
              <b className="font-medium text-foreground">Opens each of your searches in a hidden
              tab</b> — one at a time, with a pause in between, using the LinkedIn session you are
              already signed in to. The tab never takes focus and closes itself.
            </li>
            <li>
              <b className="font-medium text-foreground">Reads the results the way you would</b>,
              in your own browser. Nothing is sent to a server and no account details leave your
              machine.
            </li>
            <li>
              <b className="font-medium text-foreground">Throws away everything it has already
              shown you</b>, plus anything caught by your blocked companies and title keywords.
            </li>
            <li>
              <b className="font-medium text-foreground">Whatever is left is new.</b> The number on
              the toolbar icon goes up, you get one desktop notification for the whole round — not
              one per job — and a Telegram message too, if you set that up.
            </li>
            <li>
              <b className="font-medium text-foreground">Hands you the list, not the job.</b>{" "}
              Clicking a notification opens this extension's own list; you choose from there what
              is worth opening on LinkedIn.
            </li>
          </ol>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="font-medium text-foreground">Worth knowing</h3>
          <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-faint">
            <li>
              <b className="font-medium text-foreground">Nothing runs while Chrome is closed.</b>{" "}
              No extension can. When you open Chrome again it does one deeper catch-up round to
              fill the gap — same when quiet hours end.
            </li>
            <li>
              <b className="font-medium text-foreground">It slows itself down when things are
              quiet.</b> After a few rounds that find nothing, the gap stretches out towards an
              hour; one round that finds something puts it straight back to normal.
            </li>
            <li>
              <b className="font-medium text-foreground">Opening a job does not clear it.</b> It
              stays in the list, marked as visited. Only the tick on a row clears it and brings the
              count down.
            </li>
            <li>
              <b className="font-medium text-foreground">Your own LinkedIn tabs are never
              touched.</b> Only the hidden tab it opens for itself is ever read.
            </li>
            <li>
              <b className="font-medium text-foreground">The switch in the popup header stops
              everything</b> until you turn it back on — a full pause, not just quieter.
            </li>
            <li>
              <b className="font-medium text-foreground">Reading LinkedIn this way is against
              their terms.</b> Personal single-user use in your own signed-in browser is low-risk
              in practice, but not no-risk — the realistic worst case is your account being
              restricted. The shipped settings keep it to one page every few minutes; raise the
              depth only if you find you are actually missing things.
            </li>
          </ul>
        </section>

        <p className="border-t pt-4">
          <a
            id="repo-link"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-foreground underline underline-offset-4 hover:text-primary"
          >
            Source code, full README and issues on GitHub
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </p>
      </div>
    </details>
  );
}
