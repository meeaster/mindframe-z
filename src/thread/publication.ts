import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa, ExecaError } from "execa";
import { pathExists } from "../core/fs-util.js";
import { writeThreadIndex } from "./index.js";
import { hasRemote, type ResolvedThreadStore } from "./storage.js";
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
  | { kind: "direct"; store: ResolvedThreadStore }
  | {
      kind: "pull-request";
      name: string;
      repositoryRoot: string;
      destinationPath: string;
      base: string;
      autoMerge: boolean;
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

function publicationTarget(store: ResolvedThreadStore): PublicationTarget {
  if (store.publication !== "direct") {
    return {
      kind: "pull-request",
      name: store.name,
      repositoryRoot: store.root,
      destinationPath: store.path,
      base: store.publication.base,
      autoMerge: store.publication.auto_merge
    };
  }
  return { kind: "direct", store };
}

export function assertThreadStoreWritable(store: ResolvedThreadStore): void {
  publicationTarget(store);
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
    if (error instanceof ExecaError && error.exitCode === 1) {
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
  store: ResolvedThreadStore,
  change: ThreadChange,
  push: boolean
): Promise<ThreadPublication> {
  if (await stagedChanges(store.root)) {
    throw new Error(`Thread store has staged changes: ${store.name}`);
  }
  const threadDir = path.join(store.path, change.slug);
  if (change.kind === "write") {
    if (path.resolve(change.sourceDir) !== path.resolve(threadDir)) {
      throw new Error(`Direct thread writes must occur in the authoritative store: ${store.name}`);
    }
    if (!(await pathExists(threadDir))) {
      throw new Error(`Thread does not exist in store ${store.name}: ${change.slug}`);
    }
  } else if (!(await pathExists(threadDir))) {
    return { kind: "unchanged" };
  } else {
    await rm(threadDir, { recursive: true, force: true });
  }
  await writeThreadIndex(store.path);
  const relativeThread = path.relative(store.root, threadDir);
  const relativeIndex = path.relative(store.root, path.join(store.path, "index.md"));
  if (change.kind === "delete") {
    await execa("git", ["add", "-u", "--", relativeThread], { cwd: store.root });
    await execa("git", ["add", "--", relativeIndex], { cwd: store.root });
  } else {
    await execa("git", ["add", "-A", "--", relativeThread, relativeIndex], {
      cwd: store.root
    });
  }
  if (!(await stagedChanges(store.root))) return { kind: "unchanged" };

  await execa("git", ["commit", "-m", change.message], { cwd: store.root });
  const commit = await gitHead(store.root);
  const pushed = push && (await hasRemote(store.root));
  if (pushed) await execa("git", ["push"], { cwd: store.root });
  else if (push) console.warn(`No git remote for ${store.name} — skipping push`);
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

async function requestAutoMerge(cwd: string, url: string): Promise<void> {
  await execa("gh", ["pr", "merge", url, "--auto", "--squash"], { cwd });
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
    throw new Error(`Thread store root is not a Git repository root: ${target.repositoryRoot}`);
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
  let pullRequestUrl: string | undefined;
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
        pullRequestUrl = await createPullRequest(checkout, target.base, branch, change);
        if (target.autoMerge) await requestAutoMerge(checkout, pullRequestUrl);
        result = { kind: "pull-request", branch, commit, url: pullRequestUrl };
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
    if (commit) throw new ThreadPublicationError(branch, commit, pushed, cause, pullRequestUrl);
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
  store: ResolvedThreadStore,
  change: ThreadChange,
  push: boolean
): Promise<ThreadPublication> {
  const target = publicationTarget(store);
  if (target.kind === "direct") return publishDirect(target.store, change, push);
  return publishPullRequest(target, change, push);
}

function publicationLockPath(store: ResolvedThreadStore): string {
  const repositoryRoot = path.resolve(store.root);
  const key = createHash("sha256").update(repositoryRoot).digest("hex");
  return path.join(tmpdir(), "mfz-thread-publication-locks", `${key}.lock`);
}

export async function commitThreadChanges(
  store: ResolvedThreadStore,
  slug: string,
  threadDir: string,
  message: string,
  push: boolean
): Promise<ThreadPublication> {
  return withAdvisoryLock(publicationLockPath(store), `publish thread ${slug}`, () =>
    publishThreadChange(store, { kind: "write", slug, sourceDir: threadDir, message }, push)
  );
}

export async function deleteThreadFromStore(
  store: ResolvedThreadStore,
  slug: string,
  push: boolean
): Promise<ThreadPublication> {
  return withAdvisoryLock(publicationLockPath(store), `delete thread ${slug}`, () =>
    publishThreadChange(
      store,
      { kind: "delete", slug, message: `chore(thread): delete ${slug}` },
      push
    )
  );
}
