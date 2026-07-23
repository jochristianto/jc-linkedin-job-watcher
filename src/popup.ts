// Popup page entry — the shared list view mounted as the toolbar popup (PRD §4).
//
// Thin wrapper (§14): it imports the token stylesheet, then hands the pre-classed
// `.view-popup` root to the shared mount. The popup defaults to "New" — a quick
// glance at what's unread. Everything it renders lives tested in view.ts.

import "./tokens.css";
import { mountListView } from "./mount.ts";

const root = document.getElementById("app");
if (root) mountListView(root, "new", "New jobs");
