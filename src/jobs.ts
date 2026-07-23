// Jobs page entry — the SAME list view mounted as a full tab (PRD §4), where
// notification clicks land.
//
// Thin wrapper (§14): same mount as the popup, differing only by the
// `.view-tab` root class and defaulting to "All" — you arrived to browse
// everything found, opened rows included. The markup is identical to the popup.

import "./tokens.css";
import { mountListView } from "./mount.ts";

const root = document.getElementById("app");
if (root) mountListView(root, "all", "LinkedIn Job Watcher");
