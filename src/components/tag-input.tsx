import { X } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type TagInputProps = {
  id: string;
  label: string;
  placeholder: string;
  /** What each chip shows. The caller keeps the real values — a blocked company
   *  is a `{display, normalized}` pair, a keyword is a plain string — so this
   *  component never has to know which. */
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
};

/** A list of removable chips over an input that commits on Enter. Used for both
 *  blocklists on the Options page: companies and title keywords. */
export function TagInput({ id, label, placeholder, values, onAdd, onRemove }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commit = (): void => {
    const value = draft.trim();
    if (!value) return;
    onAdd(value);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {values.length > 0 && (
        <div id={`${id}-tags`} className="flex flex-wrap gap-1.5">
          {values.map((value, i) => (
            <Badge
              key={`${value}-${i}`}
              variant="secondary"
              className="gap-1 py-1 pr-1 pl-2 font-normal"
            >
              {value}
              {/* The chip already names what this removes, so the button itself
                  only needs the cross — aria-label carries it for a screen reader. */}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                data-act={`del-${id}`}
                data-idx={i}
                aria-label={`Remove ${value}`}
                onClick={() => onRemove(i)}
                className="size-4 rounded-full hover:bg-foreground/10"
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        id={id}
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          commit();
        }}
        // Committing on blur too, so a value typed and then clicked away from
        // isn't silently dropped by the Save that follows.
        onBlur={commit}
      />
    </div>
  );
}
