// Options page entry — PRD §11 step 7. Thin wrapper (§14): imports the
// stylesheet and mounts the settings form. Every decision it makes lives tested
// in options-form.ts.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./tokens.css";
import { OptionsPage } from "@/components/options-page.tsx";

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <OptionsPage />
    </StrictMode>,
  );
}
