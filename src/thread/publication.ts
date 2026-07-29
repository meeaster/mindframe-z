import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { pathExists } from "../core/fs-util.js";
import { writeThreadIndex } from "./index.js";
import { hasRemote, type ResolvedThreadDestination } from "./storage.js";
import { withAdvisoryLock } from "./lock.js";

export type ThreadPublication =
  | { kind: "unchanged" }
  | { kind: "direct"; commit: string; pushed: boolean }
  | { kind: "local-branch"; branch: string; commit: string }
  | { kind: "pull-request"; branch: string; commit: string; url: string };

type ThreadChange =
  | { kind: "write"; slug: string; sourceDir: string; message: string }
  | { kind: "delete"; slug: string; message: string };

type PublicationTarget =
  | { kind: "disabled"; name: string }
  | { kind: "direct"; destination: ResolvedThreadDestination }
  | {
      kind: "pull-request";
      name: string;
      repositoryRoot: string;
      destinationPath: string;
      base: string;
    };

export class ThreadPublicationError extends Error {
  readonly branch: string;
  readonly commit: string;
  readonly pushed: boolean;
  readonly url: string | undefined;

  constructor(branch: string, commit: string, pushed: boolean, cause: unknown, url?: string) {
    super(
      `Thread publication failed after commit ${commit} on ${branch}${pushed ? " (remote branch pushed)" : ""}${url ? `; pull request ${url}` : ""}`,
      { cause }
    );
    this.name = "ThreadPublicationError";
    this.branch = branch;
    this.commit = commit;
    this.pushed = pushed;
    this.url = url;
  }
}

function publicationTarget(destination: ResolvedThreadDestination): PublicationTarget {
  if (destination.pull_request) {
    if (!destination.root) {
      throw new Error(
        `Pull-request thread destination has no repository root: ${destination.name}`
      );
    }
    return {
      kind: "pull-request",
      name: destination.name,
      repositoryRoot: destination.root,
      destinationPath: destination.path,
      base: destination.pull_request.base
    };
  }
  if (destination.read_only) return { kind: "disabled", name: destination.name };
  return { kind: "direct", destination };
}

export function assertThreadDestinationWritable(destination: ResolvedThreadDestination): void {
  const target = publicationTarget(destination);
  if (target.kind === "disabled")
    throw new Error(`Thread destination is read-only: ${target.name}`);
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

async function stagedChanges(cwd: string): Promise<boolean> {
  try {
    await execa("git", ["diff", "--cached", "--quiet"], { cwd });
    return false;
  } catch (error) {
    if (typeof error === "object" && error && "exitCode" in error && error.exitCode === 1) {
      return true;
    }
    throw error;
  }
}

async function materializeThreadChange(
  destinationRoot: string,
  relativeTarget: string,
  change: ThreadChange
): Promise<boolean> {
  const target = path.join(destinationRoot, relativeTarget);
  if (change.kind === "delete" && !(await pathExists(target))) return false;
  await rm(target, { recursive: true, force: true });
  if (change.kind === "write") {
    await cp(change.sourceDir, target, { recursive: true, force: true });
  }
  const threadRoot = path.dirname(target);
  await writeThreadIndex(threadRoot);
  const relativeIndex = path.relative(destinationRoot, path.join(threadRoot, "index.md"));
  await execa("git", ["add", "-A", "--", relativeTarget, relativeIndex], {
    cwd: destinationRoot
  });
  return true;
}

async function publishDirect(
  destination: ResolvedThreadDestination,
  change: ThreadChange,
  push: boolean
): Promise<ThreadPublication> {
  if (await stagedChanges(destination.path)) {
    throw new Error(`Thread destination has staged changes: ${destination.name}`);
  }
  if (!(await materializeThreadChange(destination.path, change.slug, change))) {
    return { kind: "unchanged" };
  }
  if (!(await stagedChanges(destination.path))) return { kind: "unchanged" };

  await execa("git", ["commit", "-m", change.message], { cwd: destination.path });
  const commit = await gitHead(destination.path);
  const pushed = push && (await hasRemote(destination.path));
  if (pushed) await execa("git", ["push"], { cwd: destination.path });
  else if (push) console.warn(`No git remote for ${destination.name} — skipping push`);
  return { kind: "direct", commit, pushed };
}

function publicationBranch(slug: string): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\..+$/, "Z");
  return `automation/thread-${slug}-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function existingPullRequestUrl(cwd: string, branch: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
      cwd
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function createPullRequest(
  cwd: string,
  base: string,
  branch: string,
  change: ThreadChange
): Promise<string> {
  try {
    const { stdout } = await execa(
      "gh",
      [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        branch,
        "--title",
        change.message,
        "--body",
        `Updates the durable thread \`${change.slug}\` through the configured review workflow.`
      ],
      { cwd }
    );
    if (!stdout.trim()) throw new Error("gh pr create returned no pull request URL");
    return stdout.trim();
  } catch (error) {
    const existing = await existingPullRequestUrl(cwd, branch);
    if (existing) return existing;
    throw error;
  }
}

async function retainRecoveryBranch(
  repositoryRoot: string,
  branch: string,
  commit: string
): Promise<void> {
  await execa("git", ["branch", branch, commit], { cwd: repositoryRoot });
}

async function cleanupWorktree(
  repositoryRoot: string,
  workspace: string,
  checkoutAdded: boolean
): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (checkoutAdded) {
    try {
      await execa("git", ["worktree", "remove", "--force", path.join(workspace, "checkout")], {
        cwd: repositoryRoot
      });
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(workspace, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  try {
    await execa("git", ["worktree", "prune"], { cwd: repositoryRoot });
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

async function publishPullRequest(
  target: Extract<PublicationTarget, { kind: "pull-request" }>,
  change: ThreadChange,
  push: boolean
): Promise<ThreadPublication> {
  const { stdout: topLevel } = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: target.repositoryRoot
  });
  if (path.resolve(topLevel.trim()) !== target.repositoryRoot) {
    throw new Error(
      `Thread destination root is not a Git repository root: ${target.repositoryRoot}`
    );
  }
  await execa("git", ["remote", "get-url", "origin"], { cwd: target.repositoryRoot });
  await execa("git", ["fetch", "origin", target.base], { cwd: target.repositoryRoot });

  const workspace = await mkdtemp(path.join(tmpdir(), "mfz-thread-publish-"));
  const checkout = path.join(workspace, "checkout");
  const branch = publicationBranch(change.slug);
  const relativeTarget = path.join(
    path.relative(target.repositoryRoot, target.destinationPath),
    change.slug
  );
  let checkoutAdded = false;
  let commit: string | undefined;
  let pushed = false;
  let result: ThreadPublication | undefined;
  let workflowError: unknown;
  const recoveryFailures: unknown[] = [];

  try {
    await execa(
      "git",
      ["worktree", "add", "--quiet", "--detach", checkout, `origin/${target.base}`],
      {
        cwd: target.repositoryRoot
      }
    );
    checkoutAdded = true;
    const materialized = await materializeThreadChange(checkout, relativeTarget, change);
    if (!materialized || !(await stagedChanges(checkout))) {
      result = { kind: "unchanged" };
    } else {
      await execa("git", ["commit", "-m", change.message], { cwd: checkout });
      commit = await gitHead(checkout);
      if (!push) {
        await retainRecoveryBranch(target.repositoryRoot, branch, commit);
        result = { kind: "local-branch", branch, commit };
      } else {
        await execa("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: checkout });
        pushed = true;
        const url = await createPullRequest(checkout, target.base, branch, change);
        result = { kind: "pull-request", branch, commit, url };
      }
    }
  } catch (error) {
    workflowError = error;
    if (commit) {
      try {
        await retainRecoveryBranch(target.repositoryRoot, branch, commit);
      } catch (recoveryError) {
        recoveryFailures.push(recoveryError);
      }
    }
  }

  const cleanupFailures = await cleanupWorktree(target.repositoryRoot, workspace, checkoutAdded);
  const secondaryFailures = [...recoveryFailures, ...cleanupFailures];
  if (workflowError !== undefined) {
    if (!commit && secondaryFailures.length === 0) throw workflowError;
    const cause = new AggregateError(
      [workflowError, ...secondaryFailures],
      `Thread publication failed for ${change.slug}`
    );
    if (commit) throw new ThreadPublicationError(branch, commit, pushed, cause);
    throw cause;
  }
  if (secondaryFailures.length > 0) {
    const cause = new AggregateError(
      secondaryFailures,
      `Thread publication cleanup failed for ${change.slug}`
    );
    if (result?.kind === "pull-request") {
      throw new ThreadPublicationError(result.branch, result.commit, true, cause, result.url);
    }
    if (result?.kind === "local-branch") {
      throw new ThreadPublicationError(result.branch, result.commit, false, cause);
    }
    throw cause;
  }
  if (!result) throw new Error(`Thread publication produced no result: ${change.slug}`);
  return result;
}

async function publishThreadChange(
  destination: ResolvedThreadDestination,
  change: ThreadChange,
  push: boolean
): Promise<ThreadPublication> {
  const target = publicationTarget(destination);
  if (target.kind === "disabled")
    throw new Error(`Thread destination is read-only: ${target.name}`);
  if (target.kind === "direct") return publishDirect(target.destination, change, push);
  return publishPullRequest(target, change, push);
}

function publicationLockPath(destination: ResolvedThreadDestination): string {
  const repositoryRoot = path.resolve(
    destination.pull_request && destination.root ? destination.root : destination.path
  );
  const key = createHash("sha256").update(repositoryRoot).digest("hex");
  return path.join(tmpdir(), "mfz-thread-publication-locks", `${key}.lock`);
}

export async function commitThreadChanges(
  destination: ResolvedThreadDestination,
  slug: string,
  threadDir: string,
  message: string,
  push: boolean
): Promise<ThreadPublication> {
  return withAdvisoryLock(publicationLockPath(destination), `publish thread ${slug}`, () =>
    publishThreadChange(destination, { kind: "write", slug, sourceDir: threadDir, message }, push)
  );
}

export async function deleteThreadFromDestination(
  destination: ResolvedThreadDestination,
  slug: string,
  push: boolean
): Promise<ThreadPublication> {
  return withAdvisoryLock(publicationLockPath(destination), `delete thread ${slug}`, () =>
    publishThreadChange(
      destination,
      { kind: "delete", slug, message: `chore(thread): delete ${slug}` },
      push
    )
  );
}
