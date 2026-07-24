import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { parseWatchInput } from "@/options-form.ts";
import type { Watch } from "@/types.ts";

export type WatchListProps = {
  watches: Watch[];
  onChange: (watches: Watch[]) => void;
};

/** The saved LinkedIn searches: enable/disable, edit in place, remove. Editing
 *  swaps the row for two inputs rather than opening a dialog — there are two
 *  fields, and a modal for two fields is a modal too many. */
export function WatchList({ watches, onChange }: WatchListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string>("");

  const update = (id: string, patch: Partial<Watch>): void =>
    onChange(watches.map((w) => (w.id === id ? { ...w, ...patch } : w)));

  return (
    <div id="watch-list" className="flex flex-col gap-2">
      {watches.map((w) =>
        w.id === editingId ? (
          <WatchEditRow
            key={w.id}
            watch={w}
            error={editError}
            onCancel={() => {
              setEditingId(null);
              setEditError("");
            }}
            onSave={(name, url) => {
              const parsed = parseWatchInput(name, url);
              if (!parsed.ok) {
                setEditError(parsed.errors.name ?? parsed.errors.url ?? "Invalid search.");
                return;
              }
              update(w.id, { name: parsed.value.name, url: parsed.value.url });
              setEditingId(null);
              setEditError("");
            }}
          />
        ) : (
          <div
            key={w.id}
            data-watch-id={w.id}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <Checkbox
              checked={w.enabled}
              data-act="toggle"
              aria-label={`${w.enabled ? "Disable" : "Enable"} ${w.name}`}
              onCheckedChange={(checked) => update(w.id, { enabled: checked === true })}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{w.name}</div>
              {/* The URL opens the search on LinkedIn in a new tab — the quickest
                  way to check that a saved search still returns what you expect.
                  `block truncate` keeps the row one line however long the URL is;
                  the title attribute is how you read the rest of it. */}
              <a
                href={w.url}
                target="_blank"
                rel="noreferrer"
                data-act="open-url"
                title={w.url}
                className="block truncate text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {w.url}
              </a>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-act="edit"
              onClick={() => {
                setEditingId(w.id);
                setEditError("");
              }}
            >
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-act="remove"
              onClick={() => onChange(watches.filter((x) => x.id !== w.id))}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Remove
            </Button>
          </div>
        ),
      )}
    </div>
  );
}

function WatchEditRow({
  watch,
  error,
  onSave,
  onCancel,
}: {
  watch: Watch;
  error: string;
  onSave: (name: string, url: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(watch.name);
  const [url, setUrl] = useState(watch.url);
  return (
    <div
      data-watch-id={watch.id}
      className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Input
          className="edit-name"
          value={name}
          aria-label="Nickname"
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          className="edit-url"
          value={url}
          aria-label="Search URL"
          onChange={(e) => setUrl(e.target.value)}
        />
        {error && (
          <p data-err="watch-edit" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="button" size="sm" data-act="save-edit" onClick={() => onSave(name, url)}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" data-act="cancel-edit" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
