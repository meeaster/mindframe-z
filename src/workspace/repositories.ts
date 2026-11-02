import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { pathExists } from "../core/fs-util.js";
import type { OperationCompletion, OperationOutcome } from "../core/operations.js";
import { expandHome } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";

const SYNC_CONCURRENCY = 8;

export interface RepositoryStatus {
  path: string;
  branch: string;
  changes: string[];
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface DeclaredRepository {
  path: string;
  url: string;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const result = await execa("git", args, { cwd, reject: false });

  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd, reject: false });

  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);

  return result.stdout.trim();
}

export function workspaceRoot(profile: ResolvedProfile, home: string): string {
  return path.resolve(expandHome(profile.manifests.machine.workspace_root, home));
}

// Scratch holds throwaway clones that may be pinned to a commit on purpose, such as evaluation
// baselines, so status and sync never look inside it. Worktrees are disposable branches whose
// pending work status should still show, but sync has nothing to fast-forward there. Services
// are live deployments whose checkouts change only through their own runbooks.
export function statusExclusions(root: string): string[] {
  return [path.join(root, "scratch")];
}

function syncExclusions(root: string, referencesDir: string): string[] {
  return [
    ...statusExclusions(root),
    path.join(root, "worktrees"),
    path.join(root, "services"),
    referencesDir
  ];
}

// Extra folders that name an upstream URL are the workspace's declared repositories: a fresh
// machine clones each one that is missing, and their entries already carry the agent-facing
// description and permissions.
export function declaredRepositories(profile: ResolvedProfile, home: string): DeclaredRepository[] {
  const repositories: DeclaredRepository[] = [];

  for (const folder of profile.extraFolders) {
    if (folder.url)
      repositories.push({ path: path.resolve(expandHome(folder.path, home)), url: folder.url });
  }

  return repositories;
}

// A `.git` entry alone is not enough: a worktree whose main checkout was deleted keeps a `.git`
// file that git rejects.
async function isCheckoutRoot(directory: string): Promise<boolean> {
  if (!(await pathExists(path.join(directory, ".git")))) return false;

  const toplevel = await git(directory, ["rev-parse", "--show-toplevel"]);

  return toplevel !== undefined && (await realpath(toplevel)) === (await realpath(directory));
}

// Walks the workspace for Git checkouts, stopping at each checkout root. Symlinks, dot
// directories, and node_modules are never entered, so scanning stays cheap and cannot loop.
export async function discoverRepositories(
  root: string,
  skip: readonly string[] = []
): Promise<string[]> {
  const repositories: string[] = [];
  const skipped = new Set(skip.map((entry) => path.resolve(entry)));

  async function visit(directory: string): Promise<void> {
    if (skipped.has(directory)) return;

    if (await isCheckoutRoot(directory)) {
      repositories.push(directory);

      if (directory !== root) return;
    }

    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue;

      await visit(path.join(directory, entry.name));
    }
  }

  if (await pathExists(root)) await visit(path.resolve(root));

  return repositories.sort();
}

export async function repositoryStatus(repository: string): Promise<RepositoryStatus> {
  const branch =
    (await git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ??
    `detached at ${(await git(repository, ["rev-parse", "--short", "HEAD"])) ?? "unborn HEAD"}`;

  const porcelain = await gitOrThrow(repository, ["status", "--short", "--untracked-files=all"]);
  const changes = porcelain === "" ? [] : porcelain.split("\n");

  const upstream = await git(repository, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}"
  ]);

  const status: RepositoryStatus = { path: repository, branch, changes, ahead: 0, behind: 0 };

  if (upstream) {
    const counts = await gitOrThrow(repository, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${upstream}`
    ]);

    const [ahead = "0", behind = "0"] = counts.split(/\s+/);
    status.upstream = upstream;
    status.ahead = Number(ahead);
    status.behind = Number(behind);
  }

  return status;
}

async function remotes(repository: string): Promise<string[]> {
  return ((await git(repository, ["remote"])) ?? "").split("\n").filter(Boolean);
}

async function remoteDefaultBranch(
  repository: string,
  remote: string
): Promise<string | undefined> {
  const output = await git(repository, ["ls-remote", "--symref", remote, "HEAD"]);
  const match = output?.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m);

  return match?.[1];
}

function repositoryOutcome(
  target: string,
  status: OperationOutcome["status"],
  detail?: string
): OperationOutcome {
  const outcome: OperationOutcome = {
    category: "repository",
    action: "reconcile",
    status,
    target,
    significance: "meaningful"
  };

  if (detail !== undefined) outcome.detail = detail;

  return outcome;
}

// Fast-forwards a checkout to its remote default branch. Anything that would need a merge,
// a branch switch, or a guess about the remote is left alone and reported as skipped.
export async function fastForwardRepository(repository: string): Promise<OperationOutcome> {
  const names = await remotes(repository);

  // Local-only checkouts, such as scratch experiments, have nothing to update from.
  if (names.length === 0) {
    return { ...repositoryOutcome(repository, "unchanged", "no remote"), significance: "internal" };
  }

  const remote = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined;

  if (!remote) return repositoryOutcome(repository, "skipped", "no unambiguous default remote");

  const defaultBranch = await remoteDefaultBranch(repository, remote);

  if (!defaultBranch) {
    return repositoryOutcome(repository, "skipped", `could not read ${remote}'s default branch`);
  }

  const fetched = await execa("git", ["fetch", "--prune", remote], {
    cwd: repository,
    reject: false
  });

  if (fetched.exitCode !== 0) {
    return repositoryOutcome(repository, "failed", `fetch failed: ${fetched.stderr.trim()}`);
  }

  const branch = await git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (branch !== defaultBranch) {
    return repositoryOutcome(
      repository,
      "skipped",
      branch ? `on ${branch}, not ${defaultBranch}` : "HEAD is detached or unborn"
    );
  }

  const before = await gitOrThrow(repository, ["rev-parse", "--short", "HEAD"]);

  const merged = await execa("git", ["merge", "--ff-only", `${remote}/${defaultBranch}`], {
    cwd: repository,
    reject: false
  });

  if (merged.exitCode !== 0) {
    return repositoryOutcome(repository, "skipped", "cannot fast-forward cleanly");
  }

  const after = await gitOrThrow(repository, ["rev-parse", "--short", "HEAD"]);

  if (before === after) return repositoryOutcome(repository, "unchanged");

  return { ...repositoryOutcome(repository, "updated"), changes: ["revision"], before, after };
}

export async function cloneRepository(repository: DeclaredRepository): Promise<OperationOutcome> {
  await mkdir(path.dirname(repository.path), { recursive: true });

  const cloned = await execa("git", ["clone", repository.url, repository.path], { reject: false });

  if (cloned.exitCode !== 0) {
    return repositoryOutcome(
      repository.path,
      "failed",
      `clone of ${repository.url} failed: ${cloned.stderr.trim()}`
    );
  }

  return repositoryOutcome(repository.path, "created", `cloned ${repository.url}`);
}

async function inBatches<T>(
  items: readonly T[],
  run: (item: T) => Promise<OperationOutcome>,
  onComplete: OperationCompletion
): Promise<void> {
  const queue = [...items];

  async function worker(): Promise<void> {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      onComplete(await run(item));
    }
  }

  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, items.length) }, worker));
}

// Clones declared repositories that are missing, then fast-forwards the checkouts found in the
// workspace. Reference checkouts are left to `mfz refs sync`, which owns their lifecycle.
export async function syncWorkspace(
  profile: ResolvedProfile,
  home: string,
  onComplete: OperationCompletion
): Promise<void> {
  const missing: DeclaredRepository[] = [];

  for (const repository of declaredRepositories(profile, home)) {
    const existing = await lstat(repository.path).catch(() => undefined);

    if (!existing) missing.push(repository);
  }

  await inBatches(missing, cloneRepository, onComplete);

  const cloned = new Set(missing.map((repository) => repository.path));

  const root = workspaceRoot(profile, home);
  const found = await discoverRepositories(root, syncExclusions(root, profile.referencesDir));

  await inBatches(
    found.filter((repository) => !cloned.has(repository)),
    fastForwardRepository,
    onComplete
  );
}
