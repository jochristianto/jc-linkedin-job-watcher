import { CheckCheck, ExternalLink, MenuIcon, Power, Settings } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AppIcon } from "@/components/app-icon.tsx";
import { SCAN_BUTTON, ScanButton } from "@/components/scan-button.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ScanButtonState, ViewVariant } from "@/view-model.ts";

export type ListHeaderProps = {
  title: string;
  /** Unread across every watch. 0 renders no badge at all. */
  badge: number;
  scanButton: ScanButtonState;
  variant: ViewVariant;
  /** The master on/off switch (§ master). Off pauses the whole loop and hides
   *  "Scan now" — there is nothing to scan until it's back on. */
  enabled: boolean;
  /** A watch chip is filtering the list, so the bulk read only reaches that
   *  watch's jobs (see `markAllRead`). Changes nothing but the words on the
   *  control — "all" over a filtered list would be a promise it doesn't keep,
   *  and this is the one action here that cannot be undone in bulk. */
  filtered: boolean;
  onToggleEnabled: (next: boolean) => void;
  onScan: () => void;
  onMarkAllRead: () => void;
  onOpenTab: () => void;
  onOpenOptions: () => void;
};

/** What the bulk-read control says, in the two lengths the two surfaces have room
 *  for. The words name the scope rather than the watch: a watch name is the user's
 *  to make as long as they like, and either surface would have to cut it short
 *  anyway — "these" is what the chip beside it already answers. */
export function markAllReadLabel(filtered: boolean): { short: string; full: string } {
  return filtered
    ? { short: "Mark these read", full: "Mark these as read" }
    : { short: "Mark all read", full: "Mark all as read" };
}

/** What folds away into the popup's menu. Its own type because {@link HeaderMenu}
 *  takes exactly this set and nothing else — note that neither `onOpenTab` nor
 *  `onScan` is in it: expanding to a full page and scanning right now both stayed
 *  out in the header, beside the menu button. */
type MenuControls = Pick<
  ListHeaderProps,
  "enabled" | "filtered" | "onToggleEnabled" | "onMarkAllRead" | "onOpenOptions"
>;

/** One line of the popup's menu: an icon, a label, and the whole width to be hit
 *  with. Left-aligned rather than centred — it is a list being read down, and
 *  centred labels turn a list into a ransom note. */
function MenuItem({
  icon,
  label,
  id,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  id: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      id={id}
      onClick={onClick}
      className="h-9 w-full justify-start gap-2.5 px-2 text-[13px] font-medium text-foreground"
    >
      {icon}
      {label}
    </Button>
  );
}

/**
 * Everything the popup's header used to spread across a row, as a list you read
 * down instead.
 *
 * Exported and free of the dialog that normally holds it for two reasons. It is
 * what makes the panel testable — a Radix dialog renders nothing at all until it
 * is open, and nothing through `renderToStaticMarkup` even then, since the portal
 * has no DOM to portal into. And it is what lets the mockups show the menu as a
 * second frame beside the closed popup, rather than shipping a picture of the
 * list with its controls simply missing.
 *
 * Labels on every row, which is the point of moving them here: as a row of icons
 * in a 380px header, most of them were a guess until you hovered. There is room
 * for the words in a list, so they get the words.
 *
 * "Scan now" is not among them. It is the one control here you reach for over and
 * over — waiting out the interval is exactly what it exists to skip — and a menu
 * charges a click every time. It sits in the header instead, see {@link ListHeader}.
 */
export function HeaderMenu({
  enabled,
  filtered,
  onToggleEnabled,
  onMarkAllRead,
  onOpenOptions,
}: MenuControls) {
  return (
    <div data-slot="header-menu" className="flex flex-col gap-0.5">
      {/* The master switch keeps the top of the list and a rule under it, the
          same fencing it had in the header: it is the one control here that
          stops the whole extension, and the rest are things you do to the list.
          It is also the one that does not close the menu — you flip it and read
          what the row now says, rather than reopening to check. */}
      <div className="flex items-center gap-2.5 px-2 py-2">
        <Power
          className={cn(
            "size-4 shrink-0",
            enabled ? "text-primary" : "text-muted-foreground",
          )}
          aria-hidden="true"
        />
        {/* The label wraps the words and stops there, rather than the whole row
            with the switch inside it: a `<label>` containing the control it
            points at is exactly the shape that double-fires a toggle, and this
            one turns the extension off. Clicking the words still works — that is
            what `htmlFor` is for. */}
        <label
          htmlFor="master-switch"
          className="flex min-w-0 flex-1 cursor-pointer flex-col"
        >
          <span className="text-[13px] font-medium">
            {enabled ? "Watching for jobs" : "Paused"}
          </span>
          <span className="text-[11.5px] text-muted-foreground">
            {enabled ? "Scans run on their schedule" : "No scans until you resume"}
          </span>
        </label>
        <Switch
          size="sm"
          id="master-switch"
          checked={enabled}
          onCheckedChange={onToggleEnabled}
          aria-label={enabled ? "Watching for jobs — turn off" : "Paused — turn on"}
        />
      </div>

      <div className="my-1 border-t" />

      {/* A list has the room for the long form, so the menu takes it — and when a
          chip is on, the row says it will only clear that chip's jobs. */}
      <MenuItem
        id="mark-all-read"
        icon={<CheckCheck className="size-4 shrink-0" aria-hidden="true" />}
        label={markAllReadLabel(filtered).full}
        onClick={onMarkAllRead}
      />

      {/* "Open as a full page" and "Scan now" are deliberately not here — both
          stayed out in the header beside the menu button. A one-click escape
          from a 380px panel belongs there, and behind a menu it would cost two
          clicks to stop using the surface you are complaining about. */}
      <MenuItem
        id="open-options"
        icon={<Settings className="size-4 shrink-0" aria-hidden="true" />}
        label="Options"
        onClick={onOpenOptions}
      />
    </div>
  );
}

/** The hamburger, and the menu behind it.
 *
 *  Collapsing three controls into one costs a click on every one of them, and buys
 *  back the header's second line — at 380px the title and the cluster could not
 *  share a row, so the controls wrapped underneath and the popup opened ~34px
 *  shorter on jobs. It also buys the labels (see {@link HeaderMenu}).
 *
 *  What it must not cost is knowing the loop is off: the switch used to say so
 *  from the header, and a menu says nothing while it is shut. So the trigger
 *  carries a dot when paused — the same marker the rows use for "this one needs
 *  you" — and the footer still spells "Paused" out in words. */
function HeaderMenuButton(props: MenuControls) {
  const [open, setOpen] = useState(false);

  /** Every menu action closes the menu behind it: they all change the list, and
   *  the point of pressing one is to look at what changed. The master switch is
   *  the exception and is wired straight through — see {@link HeaderMenu}. */
  const close = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  const label = props.enabled ? "Menu" : "Menu — watching is paused";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              id="header-menu"
              aria-label={label}
              className="relative size-8 text-muted-foreground"
            >
              <MenuIcon className="size-4" aria-hidden="true" />
              {!props.enabled && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-muted-foreground"
                />
              )}
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>

      <DialogContent>
        {/* Radix wires `aria-describedby` to the description itself, and warns
            when a dialog has none — so both are real elements, not decoration. */}
        <div className="flex flex-col gap-0.5">
          <DialogTitle>Job Watcher</DialogTitle>
          <DialogDescription>Everything this popup can do.</DialogDescription>
        </div>
        <HeaderMenu
          {...props}
          onMarkAllRead={close(props.onMarkAllRead)}
          onOpenOptions={close(props.onOpenOptions)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The header: the app mark, its name and the unread count on the left, the
 *  controls on the right.
 *
 *  The two surfaces answer "the controls" differently. The tab has the width, so
 *  it lays them out in a row and labels the one that earns a label. The popup has
 *  380px and does not, so they fold into a hamburger and a dialog — see
 *  {@link HeaderMenuButton} for what that trade buys and what it costs.
 *
 *  Three things stay out of that fold. "Open as a full page" keeps its place beside
 *  the hamburger: it is the way out of the cramped surface, and putting the exit
 *  inside the thing you are escaping is a click too many. And it is popup-only to
 *  begin with — the tab already is the full page, so there is nothing to expand
 *  into. "Scan now" keeps its place for the opposite reason: it is the control you
 *  press most, the whole point of it is not waiting, and a menu is a wait. It goes
 *  icon-only here — the row it joins is icons, and the label survives as the
 *  tooltip and the accessible name.
 *
 *  Which leaves the master switch, "Mark all as read" and "Options" behind the
 *  hamburger — three things you do once and then get on with reading. */
export function ListHeader({
  title,
  badge,
  scanButton,
  variant,
  enabled,
  filtered,
  onToggleEnabled,
  onScan,
  onMarkAllRead,
  onOpenTab,
  onOpenOptions,
}: ListHeaderProps) {
  const menuControls: MenuControls = {
    enabled,
    filtered,
    onToggleEnabled,
    onMarkAllRead,
    onOpenOptions,
  };
  const markRead = markAllReadLabel(filtered);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-background px-3 py-2 md:px-4">
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
        {/* The app mark — the extension's own icon, as shipped to the toolbar. */}
        <AppIcon className="size-5.5" />
        <span className="truncate text-[14.5px] font-semibold tracking-tight">
          {title}
        </span>
        {badge > 0 && (
          <span className="flex h-5 min-w-5.5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11.5px] font-bold text-primary-foreground tabular-nums">
            {badge}
          </span>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {variant === "popup" ? (
          <>
            {/* Nothing to scan while paused, so the manual trigger goes away
                with the loop — the switch inside the menu is the way back on. */}
            {enabled && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ScanButton
                    state={scanButton}
                    onScan={onScan}
                    compact
                    className="size-8 px-0"
                  />
                </TooltipTrigger>
                <TooltipContent>{SCAN_BUTTON[scanButton].title}</TooltipContent>
              </Tooltip>
            )}

            {/* The way out of a 380px panel, kept where one click reaches it. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  id="open-tab"
                  aria-label="Open as a full page"
                  onClick={onOpenTab}
                  className="size-8 text-muted-foreground"
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open as a full page</TooltipContent>
            </Tooltip>

            <HeaderMenuButton {...menuControls} />
          </>
        ) : (
          <>
            {/* The master switch is fenced off behind a rule: it is the one
                control here that stops the whole extension, and the two next to
                it are both things you do to the list. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="mr-0.5 flex items-center gap-1.5 border-r pr-2">
                  <Power
                    className={cn(
                      "size-3.5",
                      enabled ? "text-primary" : "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <Switch
                    size="sm"
                    id="master-switch"
                    checked={enabled}
                    onCheckedChange={onToggleEnabled}
                    aria-label={
                      enabled ? "Watching for jobs — turn off" : "Paused — turn on"
                    }
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {enabled
                  ? "Watching — click to pause"
                  : "Paused — click to resume"}
              </TooltipContent>
            </Tooltip>

            {/* Nothing to scan while paused, so the manual trigger goes away
                with it. */}
            {enabled && <ScanButton state={scanButton} onScan={onScan} />}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  id="mark-all-read"
                  title={markRead.full}
                  aria-label={markRead.full}
                  onClick={onMarkAllRead}
                  className="h-8 gap-1.5 px-2 text-[13px] font-medium text-muted-foreground"
                >
                  <CheckCheck className="size-3.5" aria-hidden="true" />
                  {/* The row is tight even in the tab, so the visible words drop
                      the "as"; the full sentence stays as the name and tooltip. */}
                  {markRead.short}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{markRead.full}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  id="open-options"
                  aria-label="Options"
                  onClick={onOpenOptions}
                  className="size-8 text-muted-foreground"
                >
                  <Settings className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Options</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </header>
  );
}
