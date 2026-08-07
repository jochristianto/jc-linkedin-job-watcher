#!/usr/bin/env node
// Tears down the worktrees and branches a sandcastle run leaves behind.
//
// This is a Node script rather than a package.json one-liner because the shell
// pipeline it replaces could only ever run on macOS/Linux: npm on Windows runs
// scripts through cmd.exe, which has no `awk`, no `while read`, and treats `;` as
// a literal argument rather than a command separator. Node is the one interpreter
// both platforms are guaranteed to have here.
//
// Usage:
//   node .sandcastle/clean.mjs          # remove sandcastle/* worktrees + branches
//   node .sandcastle/clean.mjs --dry-run

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Where sandcastle puts every worktree it creates, and nothing else — it is
// gitignored scratch space (.sandcastle/.gitignore). Anything found here that git
// has no registration for is a leftover, not someone's work.
const WORKTREES_DIR = join(REPO_ROOT, ".sandcastle", "worktrees");

// Only worktrees on a branch under this hierarchy are touched. Sandcastle names
// every branch it creates `sandcastle/issue-<n>` (see main.mts), so this prefix is
// what separates a disposable sandbox from the branch you are actually working on.
const BRANCH_PREFIX = "refs/heads/sandcastle/";

const DRY_RUN = process.argv.includes("--dry-run");

/** Runs git, returning stdout. Throws with git's stderr attached. */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Parses `git worktree list --porcelain` into records.
 *
 * The format is stanzas separated by blank lines, one key-value per line
 * (`worktree <path>`, `HEAD <sha>`, `branch <ref>`), with valueless markers
 * (`bare`, `detached`, `locked`, `prunable`) on their own. Note that git prints
 * Windows paths with forward slashes (`D:/repo/.sandcastle/...`); `resolve()`
 * normalises them so the REPO_ROOT comparison below is not defeated by slash
 * direction alone.
 */
function listWorktrees() {
  const worktrees = [];
  let current = null;

  for (const rawLine of git(["worktree", "list", "--porcelain"]).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");

    if (key === "worktree") {
      current = { path: resolve(value), branch: null, locked: false };
      worktrees.push(current);
    } else if (current && key === "branch") {
      current.branch = value;
    } else if (current && key === "locked") {
      current.locked = true;
    }
  }

  return worktrees;
}

/**
 * Unlinks symlinked/junctioned entries at the top of a worktree before git is
 * allowed to delete it.
 *
 * `git worktree remove` deletes the directory tree, and on Windows that recurses
 * *through* a directory junction instead of removing the link — so a worktree whose
 * node_modules is a junction back to the main checkout takes the main repo's
 * node_modules with it. Sandcastle's own copyToWorktree makes real copies, but
 * anyone who has hand-linked a worktree to skip the 706MB copy has a live
 * foot-gun, and unlinking first costs nothing when there is nothing to unlink.
 *
 * Top level only: that is where the linked-in payloads live (`node_modules`,
 * `.env`), and walking 60k+ files to find nested links would cost more than the
 * removal itself.
 */
function unlinkTopLevelLinks(worktreePath) {
  let entries;
  try {
    entries = readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return; // Directory already gone — prune will reap the registration.
  }

  for (const entry of entries) {
    // Node reports Windows directory junctions as symbolic links, which is what
    // makes this check work on both platforms.
    if (!entry.isSymbolicLink()) continue;

    const link = join(worktreePath, entry.name);
    if (DRY_RUN) {
      console.log(`  would unlink ${entry.name} (symlink/junction)`);
      continue;
    }

    try {
      unlinkSync(link);
    } catch {
      // Windows needs RemoveDirectory for a directory reparse point; Node's
      // unlink handles that itself, but fall back rather than abort the cleanup.
      try {
        rmdirSync(link);
      } catch (error) {
        console.error(`  warning: could not unlink ${entry.name}: ${error.message}`);
      }
    }
    console.log(`  unlinked ${entry.name} (symlink/junction)`);
  }
}

function removeWorktree(worktree) {
  console.log(`${DRY_RUN ? "Would remove" : "Removing"} worktree ${worktree.path}`);
  unlinkTopLevelLinks(worktree.path);
  if (DRY_RUN) return true;

  try {
    // --force twice: the first allows a dirty worktree (a sandbox always is), the
    // second is what git requires to remove a *locked* worktree, which is the state
    // a run killed mid-setup tends to leave behind.
    git(["worktree", "remove", "--force", "--force", worktree.path]);
    return true;
  } catch (error) {
    console.error(`  ${error.message}`);
  }

  // Windows in particular refuses the delete while any file is still open — an
  // orphaned container, a watcher, an editor. Drop the directory ourselves and let
  // prune reconcile git's registration.
  try {
    if (existsSync(worktree.path)) {
      rmSync(worktree.path, { recursive: true, force: true, maxRetries: 3 });
    }
    git(["worktree", "prune"]);
    console.log(`  removed by hand after git declined`);
    return true;
  } catch (error) {
    console.error(`  giving up on ${worktree.path}: ${error.message}`);
    return false;
  }
}

/**
 * Directories under .sandcastle/worktrees/ that git has no worktree registration
 * for.
 *
 * A run killed during sandbox setup leaves the directory on disk with its `.git`
 * pointer file never written, so `git worktree list` does not report it and
 * `git worktree prune` will not reap it — the previous shell version of this script
 * iterated git's list alone and therefore reported "nothing to do" while several
 * hundred megabytes of half-copied node_modules stayed behind. Those leftovers are
 * not inert: `cp -R src dest` copies *into* an existing `dest`, so the next run
 * nests a fresh node_modules underneath the stale one instead of resuming it.
 */
function orphanedWorktreeDirs(registeredPaths) {
  if (!existsSync(WORKTREES_DIR)) return [];

  return readdirSync(WORKTREES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(WORKTREES_DIR, entry.name))
    .filter((path) => !registeredPaths.has(resolve(path)));
}

function removeOrphan(path) {
  console.log(`${DRY_RUN ? "Would delete" : "Deleting"} orphaned directory ${path}`);
  unlinkTopLevelLinks(path);
  if (DRY_RUN) return true;

  try {
    // maxRetries covers the transient Windows sharing violations that an antivirus
    // scanner or a lingering handle produces partway through 60k+ files.
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch (error) {
    console.error(`  giving up on ${path}: ${error.message}`);
    return false;
  }
}

function deleteBranches() {
  // A bare hierarchy name matches every ref beneath it, so this lists
  // `sandcastle/issue-12`, `sandcastle/issue-15`, and so on.
  const branches = git([
    "for-each-ref",
    "--format=%(refname:short)",
    BRANCH_PREFIX.replace(/\/$/, ""),
  ])
    .split(/\r?\n/)
    .filter((branch) => branch !== "");

  let failed = 0;
  for (const branch of branches) {
    if (DRY_RUN) {
      console.log(`Would delete branch ${branch}`);
      continue;
    }
    try {
      git(["branch", "-D", branch]);
      console.log(`Deleted branch ${branch}`);
    } catch (error) {
      // Most likely still claimed by a worktree we could not remove above.
      console.error(`  ${error.message}`);
      failed += 1;
    }
  }

  if (branches.length === 0) console.log("No sandcastle/* branches to delete.");
  return failed;
}

// ---------------------------------------------------------------------------

try {
  // Clears registrations whose directory a previous cleanup (or an interrupted
  // run) already deleted, so the listing below reflects what is really on disk.
  git(["worktree", "prune"]);

  const worktrees = listWorktrees();
  const targets = worktrees.filter(
    (worktree) =>
      worktree.branch?.startsWith(BRANCH_PREFIX) &&
      // Belt-and-braces: never delete the checkout this script is running from,
      // whatever branch it happens to be on.
      worktree.path !== resolve(REPO_ROOT),
  );

  if (targets.length === 0) {
    console.log("No registered sandcastle/* worktrees to remove.");
  }

  let failed = targets.filter((worktree) => !removeWorktree(worktree)).length;

  // Every path git still claims, including the main checkout and any worktree on a
  // non-sandcastle branch — those must survive even if they live under
  // .sandcastle/worktrees/.
  const stillRegistered = new Set(
    listWorktrees()
      .map((worktree) => worktree.path)
      .concat(resolve(REPO_ROOT)),
  );

  const orphans = orphanedWorktreeDirs(stillRegistered);
  if (orphans.length === 0) {
    console.log("No orphaned worktree directories.");
  }
  failed += orphans.filter((path) => !removeOrphan(path)).length;

  failed += deleteBranches();

  if (failed > 0) {
    console.error(
      `\nsandcastle:clean finished with ${failed} failure(s). Stop anything still holding ` +
        `those files (check \`docker ps\` for orphaned sandcastle-* containers) and re-run.`,
    );
    process.exit(1);
  }

  console.log(DRY_RUN ? "\nDry run complete." : "\nClean.");
} catch (error) {
  console.error(`sandcastle:clean: ${error.message}`);
  process.exit(1);
}
