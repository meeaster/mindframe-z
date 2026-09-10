import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execa, ExecaError } from "execa";
import { writeJsonFileAtomic } from "../core/fs-util.js";
import { z } from "zod";
import { eachUpstream, type ReferenceEntry } from "../core/manifests.js";
import {
  expandHome,
  extraFoldersIndexPath,
  referenceStatePath,
  referenceIndexPath,
  type RuntimePaths
} from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  planFileOutcome,
  planRemovePathOutcome,
  removePathOutcome,
  writeFileOutcome,
  type WriteFileOptions
} from "../core/file-operations.js";
import {
  collectOperations,
  type OperationCompletion,
  type OperationCollector,
  type OperationOutcome,
  type OperationStartNotification
} from "../core/operations.js";

interface GitResult {
  stdout: string;
}

type RunGit = (
  file: string,
  args: readonly string[],
  options: { stdio: "pipe" }
) => Promise<GitResult>;
type GitError = ExecaError<{ stdio: "pipe" }>;

export interface ReferenceSyncOptions {
  onStart?: OperationStartNotification;
  onComplete?: OperationCompletion;
}

export class ReferenceReconciliationError extends Error {
  readonly outcomes: readonly OperationOutcome[];

  constructor(message: string, outcomes: readonly OperationOutcome[], cause: unknown) {
    super(message, { cause });
    this.name = "ReferenceReconciliationError";
    this.outcomes = [...outcomes];
  }
}

class ReferenceBlockedError extends Error {}

const referenceStateSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), z.array(z.string()))
});
type ReferenceState = z.infer<typeof referenceStateSchema>;

async function runGitCommand(
  file: string,
  args: readonly string[],
  options: { stdio: "pipe" }
): Promise<GitResult> {
  const result = await execa(file, args, options);
  return { stdout: result.stdout };
}

export function referencePath(profile: ResolvedProfile, reference: ReferenceEntry): string {
  return path.join(profile.referencesDir, reference.name);
}

export function referenceIndexContent(profile: ResolvedProfile): string {
  const lines = [
    "# Enabled References",
    "",
    "Reference repositories are cloned git repos providing documentation, code, and context for AI agents. They are read-only snapshots — do not edit, modify, reorganize, or write to any file within a reference path. If you need to change reference content, ask the user to update the upstream repo.",
    ""
  ];
  for (const ref of profile.enabledReferences) {
    lines.push(`- \`${ref.name}\`: ${ref.description} Path: \`${referencePath(profile, ref)}\`.`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeReferenceIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const content = referenceIndexContent(profile);
  const indexPath = referenceIndexPath(paths);
  const options: WriteFileOptions = { category: "index" };
  if (onComplete) options.onComplete = onComplete;
  return writeFileOutcome(indexPath, content, options);
}

export async function planReferenceIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const options: WriteFileOptions = { category: "index" };
  if (onComplete) options.onComplete = onComplete;
  return planFileOutcome(referenceIndexPath(paths), referenceIndexContent(profile), options);
}

async function readReferenceState(paths: RuntimePaths): Promise<ReferenceState> {
  try {
    return referenceStateSchema.parse(
      JSON.parse(await readFile(referenceStatePath(paths), "utf8"))
    );
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return { version: 1, profiles: {} };
  }
}

export async function syncReferences(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: ReferenceSyncOptions = {}
): Promise<OperationOutcome[]> {
  const operations = collectOperations(options.onComplete);
  let state: ReferenceState;
  try {
    state = await readReferenceState(paths);
  } catch (error) {
    failReference(operations, referenceStatePath(paths), error);
  }

  for (const reference of profile.enabledReferences) {
    options.onStart?.({
      category: "reference",
      action: "reconcile",
      target: referencePath(profile, reference),
      detail: reference.name
    });
    try {
      operations.complete(await reconcileReference(profile, reference, runGitCommand));
      state = await retainOwnership(
        paths,
        state,
        profile.name,
        reference.name,
        operations.complete
      );
    } catch (error) {
      handleReferenceFailure(operations, referencePath(profile, reference), error);
    }
  }

  const desired = new Set(profile.enabledReferences.map((reference) => reference.name));
  const otherProfiles = Object.entries(state.profiles).filter(
    ([profileName]) => profileName !== profile.name
  );
  const retainedElsewhere = new Set(otherProfiles.flatMap(([, names]) => names));
  for (const name of state.profiles[profile.name] ?? []) {
    if (desired.has(name)) continue;
    if (retainedElsewhere.has(name)) {
      state = await releaseOwnership(paths, state, profile.name, name, operations.complete);
      continue;
    }
    options.onStart?.({
      category: "reference",
      action: "remove",
      target: path.join(profile.referencesDir, name),
      detail: name
    });
    try {
      const outcome = await removeManagedReference(profile, name, runGitCommand);
      if (outcome) operations.complete(outcome);
      state = await releaseOwnership(paths, state, profile.name, name, operations.complete);
    } catch (error) {
      handleReferenceFailure(operations, path.join(profile.referencesDir, name), error, "remove");
    }
  }

  return operations.outcomes;
}

export async function planReferences(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: ReferenceSyncOptions = {}
): Promise<OperationOutcome[]> {
  const operations = collectOperations(options.onComplete);
  let state: ReferenceState;
  try {
    state = await readReferenceState(paths);
  } catch (error) {
    failReference(operations, referenceStatePath(paths), error);
  }

  for (const reference of profile.enabledReferences) {
    const destination = referencePath(profile, reference);
    options.onStart?.({
      category: "reference",
      action: "reconcile",
      target: destination,
      detail: reference.name
    });
    const exists = await pathExists(destination);
    operations.complete({
      category: "reference",
      action: "reconcile",
      status: "planned",
      target: destination,
      significance: "meaningful",
      detail: exists
        ? `${reference.name}: upstream synchronization would be checked; upstream state not checked`
        : `${reference.name}: checkout would be cloned`
    });
  }

  const desired = new Set(profile.enabledReferences.map((reference) => reference.name));
  const retainedElsewhere = new Set(
    Object.entries(state.profiles)
      .filter(([profileName]) => profileName !== profile.name)
      .flatMap(([, names]) => names)
  );
  for (const name of state.profiles[profile.name] ?? []) {
    if (desired.has(name) || retainedElsewhere.has(name)) continue;
    const destination = path.join(profile.referencesDir, name);
    operations.complete({
      category: "reference",
      action: "remove",
      status: "planned",
      target: destination,
      significance: "meaningful",
      detail: (await pathExists(destination))
        ? `${name}: managed checkout would be checked and removed if safe`
        : `${name}: absent checkout ownership would be released`
    });
  }

  return operations.outcomes;
}

function isSafeReferenceName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && path.basename(name) === name;
}

export async function syncReference(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  name: string,
  options: ReferenceSyncOptions = {}
): Promise<OperationOutcome[]> {
  const operations = collectOperations(options.onComplete);
  const ref =
    profile.enabledReferences.find((entry) => entry.name === name) ??
    profile.manifests.references.find((entry) => entry.name === name);
  if (!ref) failReference(operations, name, new Error(`Unknown reference: ${name}`));

  try {
    options.onStart?.({
      category: "reference",
      action: "reconcile",
      target: referencePath(profile, ref),
      detail: ref.name
    });
    operations.complete(await reconcileReference(profile, ref, runGitCommand));
    const state = await readReferenceState(paths);
    await retainOwnership(paths, state, profile.name, ref.name, operations.complete);
  } catch (error) {
    handleReferenceFailure(operations, referencePath(profile, ref), error);
  }

  return operations.outcomes;
}

async function reconcileReference(
  profile: ResolvedProfile,
  reference: ReferenceEntry,
  runGit: RunGit
): Promise<OperationOutcome> {
  if (!isSafeReferenceName(reference.name)) {
    throw new ReferenceBlockedError(`Unsafe reference name: ${reference.name}`);
  }
  const destination = referencePath(profile, reference);
  await mkdir(profile.referencesDir, { recursive: true });
  if (!(await pathExists(destination))) {
    const cloneArgs = ["clone"];
    if (reference.ref) cloneArgs.push("--branch", reference.ref);
    cloneArgs.push(reference.url, destination);
    await runGit("git", cloneArgs, { stdio: "pipe" });
    const after = await revisionAt(destination, "HEAD", runGit);
    return {
      category: "reference",
      action: "reconcile",
      status: "created",
      target: destination,
      significance: "meaningful",
      changes: ["revision"],
      after,
      detail: reference.name
    };
  }

  const checkout = await inspectCheckout(destination, reference.url, runGit);
  const target = await fetchTarget(destination, reference.ref, runGit);
  const relation = await revisionRelation(destination, checkout.revision, target, runGit);
  if (relation.ahead > 0) {
    const state = relation.behind > 0 ? "divergent commits" : "unpushed commits";
    throw new ReferenceBlockedError(`Cannot update ${reference.name}: checkout has ${state}`);
  }
  if (relation.behind > 0) {
    await runGit("git", ["-C", destination, "merge", "--ff-only", target], { stdio: "pipe" });
  }
  const after = await revisionAt(destination, "HEAD", runGit);
  return {
    category: "reference",
    action: "reconcile",
    status: after === checkout.revision ? "unchanged" : "updated",
    target: destination,
    significance: "meaningful",
    changes: after === checkout.revision ? [] : ["revision"],
    before: checkout.revision,
    after,
    detail: reference.name
  };
}

async function inspectCheckout(
  destination: string,
  expectedRemote: string,
  runGit: RunGit
): Promise<{ revision: string }> {
  const entry = await lstat(destination);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ReferenceBlockedError(`Reference path is not a direct directory: ${destination}`);
  }

  try {
    const root = await gitOutput(destination, ["rev-parse", "--show-toplevel"], runGit);
    if (path.resolve(root) !== path.resolve(destination)) {
      throw new ReferenceBlockedError(
        `Reference path is not the Git checkout root: ${destination}`
      );
    }
    const remote = await gitOutput(destination, ["remote", "get-url", "origin"], runGit);
    if (remote !== expectedRemote) {
      throw new ReferenceBlockedError(
        `Origin mismatch at ${destination}: expected ${expectedRemote}, found ${remote}`
      );
    }
  } catch (error) {
    if (error instanceof ReferenceBlockedError) throw error;
    throw new ReferenceBlockedError(`Reference path is not an owned Git checkout: ${destination}`);
  }

  const status = await gitOutput(
    destination,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    runGit
  );
  if (status !== "") {
    const reason = status.split("\n").some((line) => line.startsWith("??"))
      ? "local edits or untracked files"
      : "local edits";
    throw new ReferenceBlockedError(`Cannot reconcile ${destination}: checkout has ${reason}`);
  }
  return { revision: await revisionAt(destination, "HEAD", runGit) };
}

async function fetchTarget(
  destination: string,
  ref: string | undefined,
  runGit: RunGit
): Promise<string> {
  const fetchArgs = ref ? ["fetch", "origin", ref] : ["fetch", "--prune", "origin"];
  try {
    await runGit("git", ["-C", destination, ...fetchArgs], { stdio: "pipe" });
  } catch (error) {
    if (!(error instanceof ExecaError) || !isStaleRemoteRefError(error)) throw error;
    await runGit("git", ["-C", destination, "remote", "prune", "origin"], { stdio: "pipe" });
    await runGit("git", ["-C", destination, ...fetchArgs], { stdio: "pipe" });
  }
  if (ref) return "FETCH_HEAD";
  try {
    await revisionAt(destination, "@{upstream}", runGit);
    return "@{upstream}";
  } catch (error) {
    throw new ReferenceBlockedError(`Checkout has no configured upstream: ${destination}`, {
      cause: error
    });
  }
}

async function removeManagedReference(
  profile: ResolvedProfile,
  name: string,
  runGit: RunGit
): Promise<OperationOutcome | undefined> {
  if (!isSafeReferenceName(name)) {
    throw new ReferenceBlockedError(`Unsafe managed reference name: ${name}`);
  }
  const destination = path.join(profile.referencesDir, name);
  if (!(await pathExists(destination))) return undefined;

  const reference = managedReferenceDefinition(profile, name);
  const checkout = await inspectCheckout(destination, reference.url, runGit);
  const target = await fetchTarget(destination, reference.ref, runGit);
  const relation = await revisionRelation(destination, checkout.revision, target, runGit);
  if (relation.ahead > 0) {
    const state = relation.behind > 0 ? "divergent commits" : "unpushed commits";
    throw new ReferenceBlockedError(`Cannot remove ${name}: checkout has ${state}`);
  }
  await requireSafeRemovalState(destination, name, runGit);

  await rm(destination, { recursive: true });
  return {
    category: "reference",
    action: "remove",
    status: "removed",
    target: destination,
    significance: "meaningful",
    changes: ["revision"],
    before: checkout.revision,
    detail: name
  };
}

async function requireSafeRemovalState(
  destination: string,
  name: string,
  runGit: RunGit
): Promise<void> {
  const stashRefs = await gitOutput(
    destination,
    ["for-each-ref", "--format=%(refname)", "refs/stash"],
    runGit
  );
  if (stashRefs !== "") {
    throw new ReferenceBlockedError(`Cannot remove ${name}: checkout has stashed work`);
  }

  const unpublishedCommits = await gitOutput(
    destination,
    ["rev-list", "--branches", "--not", "--remotes=origin"],
    runGit
  );
  if (unpublishedCommits !== "") {
    throw new ReferenceBlockedError(
      `Cannot remove ${name}: checkout has unpublished local branch commits`
    );
  }
}

function managedReferenceDefinition(profile: ResolvedProfile, name: string): ReferenceEntry {
  const matches = [profile.manifests, ...eachUpstream(profile.manifests)].flatMap((manifests) =>
    manifests.references.filter((reference) => reference.name === name)
  );
  const identities = new Map(
    matches.map((reference) => [`${reference.url}\0${reference.ref ?? ""}`, reference])
  );
  if (identities.size !== 1) {
    const reason = identities.size === 0 ? "is absent from the catalog" : "is ambiguous";
    throw new ReferenceBlockedError(`Managed identity for ${name} ${reason}`);
  }
  const reference = identities.values().next().value;
  if (!reference) throw new ReferenceBlockedError(`Managed identity for ${name} is unavailable`);
  return reference;
}

async function revisionRelation(
  destination: string,
  revision: string,
  target: string,
  runGit: RunGit
): Promise<{ ahead: number; behind: number }> {
  const output = await gitOutput(
    destination,
    ["rev-list", "--left-right", "--count", `${revision}...${target}`],
    runGit
  );
  const match = /^(\d+)\s+(\d+)$/.exec(output);
  if (!match) throw new Error(`Unexpected Git revision relation at ${destination}: ${output}`);
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

async function revisionAt(destination: string, revision: string, runGit: RunGit): Promise<string> {
  return gitOutput(destination, ["rev-parse", "--verify", revision], runGit);
}

async function gitOutput(
  destination: string,
  args: readonly string[],
  runGit: RunGit
): Promise<string> {
  const result = await runGit("git", ["-C", destination, ...args], { stdio: "pipe" });
  return result.stdout.trim();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function retainOwnership(
  paths: RuntimePaths,
  state: ReferenceState,
  profileName: string,
  name: string,
  onComplete: OperationCompletion
): Promise<ReferenceState> {
  const current = state.profiles[profileName] ?? [];
  if (current.includes(name)) {
    completeOwnership(paths, profileName, name, "unchanged", onComplete);
    return state;
  }
  const next = withProfileReferences(state, profileName, [...current, name]);
  await writeJsonFileAtomic(referenceStatePath(paths), next);
  completeOwnership(paths, profileName, name, "updated", onComplete);
  return next;
}

async function releaseOwnership(
  paths: RuntimePaths,
  state: ReferenceState,
  profileName: string,
  name: string,
  onComplete: OperationCompletion
): Promise<ReferenceState> {
  const current = state.profiles[profileName] ?? [];
  const remaining = current.filter((ownedName) => ownedName !== name);
  const next = withProfileReferences(state, profileName, remaining);
  await writeJsonFileAtomic(referenceStatePath(paths), next);
  completeOwnership(paths, profileName, name, "updated", onComplete);
  return next;
}

function withProfileReferences(
  state: ReferenceState,
  profileName: string,
  references: string[]
): ReferenceState {
  const profiles = { ...state.profiles };
  if (references.length === 0) delete profiles[profileName];
  else profiles[profileName] = references;
  return { version: 1, profiles };
}

function completeOwnership(
  paths: RuntimePaths,
  profileName: string,
  name: string,
  status: "updated" | "unchanged",
  onComplete: OperationCompletion
): void {
  onComplete({
    category: "bookkeeping",
    action: "write",
    status,
    target: referenceStatePath(paths),
    significance: "internal",
    detail: `${profileName}/${name}`
  });
}

function handleReferenceFailure(
  operations: OperationCollector,
  target: string,
  cause: unknown,
  action: "reconcile" | "remove" = "reconcile"
): never {
  const message = cause instanceof Error ? cause.message : String(cause);
  operations.complete({
    category: "reference",
    action,
    status: cause instanceof ReferenceBlockedError ? "blocked" : "failed",
    target,
    significance: "meaningful",
    detail: message
  });
  throw new ReferenceReconciliationError(message, operations.outcomes, cause);
}

function failReference(operations: OperationCollector, target: string, cause: unknown): never {
  return handleReferenceFailure(operations, target, cause);
}

export function isStaleRemoteRefError(error: GitError): boolean {
  return (
    (error.stderr ?? "").includes("some local refs could not be updated") &&
    (error.stderr ?? "").includes("git remote prune origin")
  );
}

export async function writeExtraFoldersIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const folders = profile.extraFolders;
  const indexPath = extraFoldersIndexPath(paths);

  if (folders.length === 0) {
    const options: WriteFileOptions = { category: "index" };
    if (onComplete) options.onComplete = onComplete;
    return removePathOutcome(indexPath, options);
  }

  const content = extraFoldersIndexContent(paths, profile);
  const options: WriteFileOptions = { category: "index" };
  if (onComplete) options.onComplete = onComplete;
  return writeFileOutcome(indexPath, content, options);
}

export async function planExtraFoldersIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const options: WriteFileOptions = { category: "index" };
  if (onComplete) options.onComplete = onComplete;
  const indexPath = extraFoldersIndexPath(paths);
  if (profile.extraFolders.length === 0) return planRemovePathOutcome(indexPath, options);
  return planFileOutcome(indexPath, extraFoldersIndexContent(paths, profile), options);
}

export function extraFoldersIndexContent(paths: RuntimePaths, profile: ResolvedProfile): string {
  const folders = profile.extraFolders;
  const lines = [
    "# Extra Folders",
    "",
    "Use this as the capability map for cross-repository work or when a named repository's role is unclear. Descriptions identify each folder's role; permissions state the allowed access.",
    ""
  ];
  for (const folder of folders) {
    const absPath = expandHome(folder.path, paths.home);
    const suffix = folder.description ? ` - ${folder.description}` : "";
    lines.push(`- \`${absPath}\`${suffix} (read: ${folder.read}, edit: ${folder.edit})`);
  }
  lines.push("");
  return lines.join("\n");
}

export function referenceRows(profile: ResolvedProfile): string[] {
  const enabled = new Set(profile.enabledReferences.map((ref) => ref.name));
  return profile.manifests.references.map((ref) => {
    const marker = enabled.has(ref.name) ? "enabled" : "available";
    return `${ref.name}\t${marker}\t${expandHome(referencePath(profile, ref), profile.referencesDir)}\t${ref.description}`;
  });
}
