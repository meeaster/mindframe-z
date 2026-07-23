import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { pathExists } from "./fs-util.js";
import { expandHome } from "./path-util.js";

function isLocalRepoSpec(repo: string): boolean {
  return (
    repo.startsWith("/") || repo.startsWith("./") || repo.startsWith("../") || repo.startsWith("~/")
  );
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for upstream clone lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function resolveUpstreamHomeRoot(options: {
  home: string;
  alias: string;
  repo: string;
}): Promise<string> {
  if (isLocalRepoSpec(options.repo)) return path.resolve(expandHome(options.repo, options.home));

  const cloneRoot = path.join(options.home, ".mindframe-z", "homes", options.alias);
  await mkdir(path.dirname(cloneRoot), { recursive: true });
  const releaseLock = await acquireLock(`${cloneRoot}.lock`);
  try {
    if (!(await pathExists(cloneRoot))) {
      await execa("git", ["clone", options.repo, cloneRoot]);
      return cloneRoot;
    }

    if (await isDirty(cloneRoot)) {
      console.warn(`warning\tupstream home ${options.alias} is dirty; skipping git pull`);
      return cloneRoot;
    }
    if (await isAhead(cloneRoot)) {
      console.warn(
        `warning\tupstream home ${options.alias} has unpushed commits; skipping git pull`
      );
      return cloneRoot;
    }

    try {
      await execa("git", ["pull", "--ff-only"], { cwd: cloneRoot });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      console.warn(
        `warning\tupstream home ${options.alias} could not update; using existing clone${detail}`
      );
    }
    return cloneRoot;
  } finally {
    await releaseLock();
  }
}
