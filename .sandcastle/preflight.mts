// Preflight check — runs before .sandcastle/main.mts
//
// Sandcastle's docker provider does a single `docker image inspect` before it
// creates a sandbox, and reports *any* failure of that command as
// "Image '<name>' not found locally". That message is misleading: the same
// error appears when the Docker daemon is asleep (Docker Desktop's Resource
// Saver pauses the VM after a few idle minutes), still booting, or not
// installed at all — cases where the image is present the whole time.
//
// This script removes the ambiguity by checking each precondition itself and
// fixing what it can:
//   1. The `docker` CLI is on PATH.
//   2. The daemon answers `docker info` — starting Docker Desktop and waiting
//      for it if needed.
//   3. The sandbox image exists and was built with this host's UID, building
//      it via `sandcastle docker build-image` when it isn't.
//
// Usage:
//   npx tsx .sandcastle/preflight.mts
// It is wired into `npm run sandcastle` ahead of main.mts.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// How long to wait for the Docker daemon to become responsive. Waking from
// Resource Saver takes a couple of seconds; a cold Docker Desktop start on a
// laptop can take well over a minute.
const DAEMON_TIMEOUT_MS = 180_000;
const DAEMON_POLL_INTERVAL_MS = 2_000;

// Where Docker Desktop lives on macOS. If it isn't there we skip the
// auto-start and just report that the daemon is unreachable.
const DOCKER_DESKTOP_APP = "/Applications/Docker.app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunResult = { code: number; stdout: string; stderr: string };

/** Run a command to completion, capturing output. Never rejects. */
const run = (command: string, args: string[]): Promise<RunResult> =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolvePromise({ code: -1, stdout, stderr: error.message }),
    );
    child.on("close", (code) =>
      resolvePromise({ code: code ?? -1, stdout, stderr }),
    );
  });

/** Run a command with its output streamed to this process's stdio. */
const runInherit = (command: string, args: string[]): Promise<number> =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", () => resolvePromise(-1));
    child.on("close", (code) => resolvePromise(code ?? -1));
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fail = (message: string): never => {
  console.error(`\n[preflight] ${message}\n`);
  process.exit(1);
};

/**
 * Mirror of sandcastle's own defaultImageName() (src/mountUtils.ts) so we check
 * and build exactly the image the docker provider will look for.
 */
const defaultImageName = (repoDir: string): string => {
  const dirName = basename(repoDir.replace(/[\\/]+$/, "")) || "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized || "local"}`;
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const checkDockerCli = async (): Promise<void> => {
  const result = await run("docker", ["--version"]);
  if (result.code !== 0) {
    fail(
      "The `docker` CLI is not available on PATH.\n" +
        "Install Docker Desktop (https://docs.docker.com/desktop/) and try again.",
    );
  }
};

const daemonIsUp = async (): Promise<boolean> => {
  const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return result.code === 0 && result.stdout.trim() !== "";
};

const waitForDaemon = async (): Promise<void> => {
  if (await daemonIsUp()) return;

  // Not reachable yet. On macOS the usual cause is that Docker Desktop is
  // stopped or suspended — `open -a Docker` both launches it and wakes it from
  // Resource Saver, and is a no-op when it is already running.
  if (process.platform === "darwin" && existsSync(DOCKER_DESKTOP_APP)) {
    console.log("[preflight] Docker daemon not responding — starting Docker Desktop...");
    await run("open", ["-a", DOCKER_DESKTOP_APP]);
  } else {
    console.log("[preflight] Docker daemon not responding — waiting for it...");
  }

  const deadline = Date.now() + DAEMON_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    if (await daemonIsUp()) {
      console.log("[preflight] Docker daemon is up.");
      return;
    }
  }

  fail(
    `Docker daemon did not become available within ${DAEMON_TIMEOUT_MS / 1000}s.\n` +
      "Start Docker manually, wait for the whale icon to stop animating, then re-run.",
  );
};

/**
 * Read the image's configured user. Returns null when the image is absent.
 * Retried once: the first docker call after the daemon wakes can still race
 * with the image store finishing its load, which is exactly the transient
 * failure that surfaced as "not found locally".
 */
const readImageUser = async (imageName: string): Promise<string | null> => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await run("docker", [
      "image",
      "inspect",
      imageName,
      "--format",
      "{{.Config.User}}",
    ]);
    if (result.code === 0) return result.stdout.trim();
    if (attempt === 1) await sleep(DAEMON_POLL_INTERVAL_MS);
  }
  return null;
};

const buildImage = async (imageName: string): Promise<void> => {
  console.log(`[preflight] Building image '${imageName}' — this takes a few minutes...`);
  const code = await runInherit("npx", [
    "sandcastle",
    "docker",
    "build-image",
    "--image-name",
    imageName,
  ]);
  if (code !== 0) {
    fail(`Image build failed (exit ${code}). See the docker build output above.`);
  }
};

const ensureImage = async (imageName: string): Promise<void> => {
  const hostUid = process.getuid?.() ?? 1000;
  const imageUser = await readImageUser(imageName);

  if (imageUser === null) {
    console.log(`[preflight] Image '${imageName}' is missing.`);
    await buildImage(imageName);
  } else {
    // Sandcastle refuses to start a sandbox when the image's UID differs from
    // the host UID, because bind-mounted worktree files would be unwritable.
    const imageUid = Number.parseInt(imageUser.split(":")[0] ?? "", 10);
    if (Number.isNaN(imageUid) || imageUid === hostUid) {
      console.log(`[preflight] Image '${imageName}' is ready (uid ${imageUser || "root"}).`);
      return;
    }
    console.log(
      `[preflight] Image '${imageName}' was built with uid ${imageUid}, host uid is ${hostUid} — rebuilding.`,
    );
    await buildImage(imageName);
  }

  const rebuiltUser = await readImageUser(imageName);
  if (rebuiltUser === null) {
    fail(`Image '${imageName}' still not present after a successful build. Check \`docker images\`.`);
  }
  console.log(`[preflight] Image '${imageName}' is ready (uid ${rebuiltUser || "root"}).`);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const repoRoot = resolve(process.cwd());
const imageName = defaultImageName(repoRoot);

await checkDockerCli();
await waitForDaemon();
await ensureImage(imageName);

console.log("[preflight] All checks passed.\n");
