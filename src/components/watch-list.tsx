// The saved LinkedIn searches — the Watches section of the Options page.
//
// A watch is a search URL with your filters already baked into it, and the row
// has to make three things obvious: whether it is running, what it actually
// searches for, and where to change it. The first is a switch rather than a
// checkbox — it pauses a search rather than selecting it, and a switch is what
// says so. The second is `watchUrlChips`, which reads the query string back as
// plain words, because a 200-character LinkedIn URL tells a human nothing. The
// third is two icon buttons, quiet until you look for them.
//
// Adding and editing share one form. There is only ever one open — opening it on
// a second row closes the first — so the section never grows two sets of fields
// arguing about which one you are filling in. When it is closed, its place is
// held by a dashed button, which is the only way an empty list has anything to
// click at all.

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { parseWatchInput } from "@/options-form.ts";
import { watchUrlChips } from "@/settings-view.ts";
import type { Watch } from "@/types.ts";

export type WatchListProps = {
  watches: Watch[];
  onChange: (watches: Watch[]) => void;
};

/** What the open form is doing: adding a new watch, or editing the one with this
 *  id. `null` is the resting state — no form, just the dashed button. */
type FormState = { mode: "add" } | { mode: "edit"; id: string } | null;

const HINT =
  "Set the filters up on LinkedIn first, then paste the address bar here — they travel with the URL.";

export function WatchList({ watches, onChange }: WatchListProps) {
  const [form, setForm] = useState<FormState>(null);
  const [draft, setDraft] = useState({ name: "", url: "" });
  const [error, setError] = useState("");

  const close = (): void => {
    setForm(null);
    setDraft({ name: "", url: "" });
    setError("");
  };

  const openAdd = (): void => {
    setForm({ mode: "add" });
    setDraft({ name: "", url: "" });
    setError("");
  };

  const openEdit = (w: Watch): void => {
    setForm({ mode: "edit", id: w.id });
    setDraft({ name: w.name, url: w.url });
    setError("");
  };

  /** Validate once, then either patch the row being edited or append a new one.
   *  Nothing is written on a bad URL — the form stays open with the reason under
   *  it, so a mistyped address never costs the rest of what was typed. */
  const submit = (): void => {
    const parsed = parseWatchInput(draft.name, draft.url);
    if (!parsed.ok) {
      setError(parsed.errors.name ?? parsed.errors.url ?? "Invalid search.");
      return;
    }
    const { name, url } = parsed.value;
    if (form?.mode === "edit") {
      onChange(watches.map((w) => (w.id === form.id ? { ...w, name, url } : w)));
    } else {
      onChange([...watches, { id: crypto.randomUUID(), name, url, enabled: true }]);
    }
    close();
  };

  return (
    <div className="flex flex-col gap-2">
      <div id="watch-list" className="flex flex-col gap-2">
        {watches.map((w) => (
          <div
            key={w.id}
            data-watch-id={w.id}
            className={cn(
              "flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-[background-color,opacity]",
              w.enabled ? "bg-card" : "bg-muted/55 opacity-70",
            )}
          >
            <div className="pt-1">
              <Switch
                checked={w.enabled}
                data-act="toggle"
                aria-label={`${w.enabled ? "Pause" : "Resume"} ${w.name}`}
                onCheckedChange={(checked) =>
                  onChange(watches.map((x) => (x.id === w.id ? { ...x, enabled: checked } : x)))
                }
              />
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-semibold tracking-tight">{w.name}</span>
                {/* Said out loud as well as shown by the switch: a greyed row at
                    the bottom of a list of six is easy to read as "the last one"
                    rather than as "this one is off". */}
                {!w.enabled && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10.5px] font-medium">
                    Paused
                  </Badge>
                )}
              </div>

              {/* The URL, said in words. Derived, never stored — see `watchUrlChips`. */}
              <div className="flex flex-wrap items-center gap-1">
                {watchUrlChips(w.url).map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border bg-muted/60 px-2 py-px text-[11.5px] font-medium whitespace-nowrap"
                  >
                    {chip}
                  </span>
                ))}
              </div>

              {/* The URL itself opens the search on LinkedIn in a new tab — the
                  quickest way to check a saved search still returns what you
                  expect, and `target="_blank"` because this page has unsaved
                  edits in it. Truncated to one line; the title carries the rest. */}
              <a
                href={w.url}
                target="_blank"
                rel="noreferrer"
                data-act="open-url"
                title={w.url}
                className="block truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {w.url}
              </a>
            </div>

            <div className="flex shrink-0 items-center">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                data-act="edit"
                title="Edit nickname or URL"
                aria-label={`Edit ${w.name}`}
                onClick={() => openEdit(w)}
              >
                <Pencil className="size-3.5 text-muted-foreground" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                data-act="remove"
                title={`Remove ${w.name}`}
                aria-label={`Remove ${w.name}`}
                onClick={() => {
                  // Removing the row the form is open on would leave the form
                  // editing a watch that no longer exists.
                  if (form?.mode === "edit" && form.id === w.id) close();
                  onChange(watches.filter((x) => x.id !== w.id));
                }}
                className="hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {form ? (
        <div
          id="watch-form"
          className="flex animate-in flex-col gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-3 duration-150 fade-in-0 slide-in-from-top-1"
        >
          <span className="text-[12.5px] font-semibold">
            {form.mode === "edit" ? "Edit watch" : "New watch"}
          </span>
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <div className="flex flex-col gap-1.5 sm:w-44">
              <Label htmlFor="watch-name" className="text-[11.5px] text-muted-foreground">
                Nickname
              </Label>
              <Input
                id="watch-name"
                className="edit-name"
                value={draft.name}
                placeholder="e.g. SE @ Osaka"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="watch-url" className="text-[11.5px] text-muted-foreground">
                Search URL
              </Label>
              <Input
                id="watch-url"
                className="edit-url"
                value={draft.url}
                placeholder="https://www.linkedin.com/jobs/search/?…"
                onChange={(e) => {
                  setDraft({ ...draft, url: e.target.value });
                  setError("");
                }}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* The hint and the error share one line: they answer the same
                question, and only one of them is ever the current answer. */}
            <p
              data-err={error ? "watch-form" : undefined}
              className={cn(
                "min-w-0 flex-1 basis-50 text-[11.5px] leading-snug",
                error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {error || HINT}
            </p>
            <div className="flex shrink-0 gap-1.5">
              <Button type="button" size="sm" variant="ghost" data-act="cancel-edit" onClick={close}>
                Cancel
              </Button>
              <Button type="button" size="sm" data-act="save-edit" onClick={submit}>
                {form.mode === "edit" ? "Save watch" : "Add watch"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          id="add-search"
          onClick={openAdd}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-foreground/20 py-2.5 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:border-primary/45 hover:bg-primary/5 hover:text-primary"
        >
          <Plus className="size-3.5" />
          Add a watch
        </button>
      )}
    </div>
  );
}
