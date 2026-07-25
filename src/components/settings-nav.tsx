// The rail down the left of the Options page: where you are, what else there is,
// and which sections you have edited but not saved.
//
// The settings run to six panels and several screens. Before this the only way to
// know how far down "Retention" was, was to scroll until you found it — and the
// only way to find an unsaved edit after wandering off was to remember making it.
// The rail answers both: it names every section from the top of the page, follows
// the scroll so the current one is always marked, and carries an amber dot on any
// section holding something the Save button has not yet written.
//
// It holds still while the settings scroll past it. The page keeps its single
// scrollbar at the edge of the window — the rail is sticky rather than a column
// of its own scroll box — and the offset it sticks at is the scroll area's own
// top padding, so it is already stuck at the first pixel of scroll. With the
// `top-0` this used to carry it would instead slide up by that padding and only
// then catch, which read as a jolt and left it welded to the header afterwards.
//
// It is hidden below `lg`: this page only ever opens as a full browser tab, and
// at that width the 190px column would take a third of the space the settings
// themselves need. Nothing is lost when it goes — the header badge still counts
// the unsaved edits, and the sections are titled.

import { cn } from "@/lib/utils";
import { SECTION_LABELS, SETTINGS_SECTIONS, type SettingsSection } from "@/settings-view.ts";

export type SettingsNavProps = {
  /** The section currently under the top of the scroll area. */
  active: SettingsSection;
  /** Sections holding at least one unsaved edit — one amber dot each. */
  dirty: Set<SettingsSection>;
  onSelect: (section: SettingsSection) => void;
};

export function SettingsNav({ active, dirty, onSelect }: SettingsNavProps) {
  return (
    <nav
      id="settings-nav"
      aria-label="Settings sections"
      className="sticky top-4 hidden w-48 shrink-0 flex-col gap-0.5 md:top-6 lg:flex"
    >
      <span className="px-2.5 pt-0.5 pb-1.5 text-[10.5px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
        On this page
      </span>
      {SETTINGS_SECTIONS.map((section) => {
        const isActive = section === active;
        return (
          <button
            key={section}
            type="button"
            data-section={section}
            aria-current={isActive ? "true" : undefined}
            onClick={() => onSelect(section)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
              isActive
                ? "bg-card font-semibold text-foreground shadow-sm"
                : "font-medium text-muted-foreground hover:bg-card/60 hover:text-foreground",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{SECTION_LABELS[section]}</span>
            {dirty.has(section) && (
              <span
                title="Unsaved changes in this section"
                className="size-1.5 shrink-0 rounded-full bg-warn"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
