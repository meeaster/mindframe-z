import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { pathExists } from "./fs-util.js";
import { expandHome } from "./path-util.js";

async function isGitWorktree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function isDirty(root: string): Promise<boolean> {
  const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: root });
  return stdout.trim().length > 0;
}

async function isAhead(root: string): Promise<boolean> {
  try {
    const { stdout } = await execa("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: root });
    return Number(stdout.trim()) > 0;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lockPath);
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      // SAFETY: mkdir rejects with an ErrnoException carrying the filesystem error code.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for upstream checkout lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function resolveUpstreamHomeRoot(options: {
  home: string;
  alias: string;
  repo: string;
  path: string;
}): Promise<string> {
  const upstreamRoot = path.resolve(expandHome(options.path, options.home));
  await mkdir(path.dirname(upstreamRoot), { recursive: true });
  const releaseLock = await acquireLock(`${upstreamRoot}.lock`);
  try {
    if (!(await pathExists(upstreamRoot))) {
      await execa("git", ["clone", options.repo, upstreamRoot]);
      return upstreamRoot;
    }
    if (!(await isGitWorktree(upstreamRoot))) return upstreamRoot;

    if (await isDirty(upstreamRoot)) {
      console.warn(`warning\tupstream home ${options.alias} is dirty; skipping git pull`);
      return upstreamRoot;
    }
    if (await isAhead(upstreamRoot)) {
      console.warn(
        `warning\tupstream home ${options.alias} has unpushed commits; skipping git pull`
      );
      return upstreamRoot;
    }

    try {
      await execa("git", ["pull", "--ff-only"], { cwd: upstreamRoot });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      console.warn(
        `warning\tupstream home ${options.alias} could not update; using existing checkout${detail}`
      );
    }
    return upstreamRoot;
  } finally {
    await releaseLock();
  }
}
