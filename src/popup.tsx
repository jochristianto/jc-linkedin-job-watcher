// Popup page entry — the shared list view mounted as the toolbar popup (PRD §4).
//
// Thin wrapper (§14): imports the stylesheet, then mounts the shared component
// in its popup variant. The popup defaults to "New" — a quick glance at what's
// unread. Everything it renders lives tested in view.ts.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./tokens.css";
import { ListView } from "@/components/list-view.tsx";

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ListView variant="popup" defaultMode="new" title="New jobs" />
    </StrictMode>,
  );
}
