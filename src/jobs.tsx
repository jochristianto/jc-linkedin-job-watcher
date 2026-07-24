// Jobs page entry — the SAME list view mounted as a full tab (PRD §4), where
// notification clicks land.
//
// Thin wrapper (§14): same component as the popup, differing only by the variant
// and defaulting to "All" — you arrived to browse everything found, opened rows
// included.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./tokens.css";
import { ListView } from "@/components/list-view.tsx";

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ListView variant="tab" defaultMode="all" title="LinkedIn Job Watcher" />
    </StrictMode>,
  );
}
