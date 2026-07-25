import { cn } from "@/lib/utils";

/**
 * The extension's own icon — icons/icon-128.png — inlined as a data URI.
 *
 * Inlined rather than referenced by path because the same component renders in
 * three places that disagree about what a path means: the extension pages
 * (icons/ sits beside them in dist/), the generated mockups (opened straight
 * from `file://`, two directories away), and the node suite (no DOM at all). A
 * data URI is the one form all three read identically, and at 4 kB it costs
 * less than the branching would.
 *
 * 128px is the size the manifest already ships, so the mark stays crisp at the
 * 22–26px it is drawn at on a 3x display. `app-icon.test.ts` re-reads the PNG
 * and fails if this string ever drifts from the file on disk — regenerate with:
 *
 *   npm run build:app-icon
 */
export const APP_ICON_DATA_URL = "data:image/png;base64,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";

/**
 * The app mark: the same briefcase Chrome puts in the toolbar and on every
 * desktop notification, so a page's header and the thing you clicked to get
 * there are visibly one product. It used to be a generic eye glyph in a tinted
 * tile, which matched nothing the user had already seen.
 *
 * The artwork carries its own rounded background, so it is drawn bare — no tile
 * behind it, and no corner radius laid over the one already painted in.
 */
export function AppIcon({ className }: { className?: string }) {
  return (
    <img
      src={APP_ICON_DATA_URL}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0", className)}
    />
  );
}
