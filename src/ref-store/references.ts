import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execa, ExecaError } from "execa";
import { type ReferenceEntry } from "../core/manifests.js";
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
  type OperationLifecycleNotification,
  type OperationStart,
  type OperationStartNotification
} from "../core/operations.js";
import {
  assertReferenceLockScope,
  canonicalizePhysicalPath,
  withReferenceResourceLock,
  type ReferenceLockScope
} from "./reference-lock.js";
import {
  appendReferenceBatchOutcomes,
  appendReferenceCleanupOutcomes,
  managedReferenceDefinition,
  referenceFailureMessage,
  referenceStateSchema,
  runDeselectedReferences,
  runSelectedReferences,
  writeReferenceState,
  type ReferenceBatchResult,
  type ReferenceCleanupResult,
  type ReferenceState,
  type ReferenceRunOptions,
  type RunGit,
  type WriteReferenceState,
  ReferenceBlockedError,
  referenceLifecycleKey
} from "./reference-run.js";

export type { ReferenceState, RunGit, WriteReferenceState } from "./reference-run.js";

export {
  ReferenceStatePersistenceError,
  REFERENCE_SYNC_CONCURRENCY,
  referenceLifecycleKey
} from "./reference-run.js";

type GitError = ExecaError<{ stdio: "pipe" }>;

export interface ReferenceSyncOptions {
  onStart?: OperationStartNotification;
  onComplete?: OperationCompletion;
  onLifecycle?: OperationLifecycleNotification;
  runGit?: RunGit;
  writeState?: WriteReferenceState;
  signal?: AbortSignal;
}

export class ReferenceReconciliationError extends Error {
  readonly outcomes: readonly OperationOutcome[];

  constructor(message: string, outcomes: readonly OperationOutcome[], cause: unknown) {
    super(message, { cause });
    this.name = "ReferenceReconciliationError";
    this.outcomes = [...outcomes];
  }
}

export class ReferenceInvariantError extends Error {}

async function runGitCommand(
  file: string,
  args: readonly string[],
  options: { stdio: "pipe"; cancelSignal?: AbortSignal }
): Promise<{ stdout: string }> {
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
  return withReferenceResourceLock(
    paths,
    profile.referencesDir,
    (signal, scope) => syncReferencesLocked(paths, profile, { ...options, signal }, scope),
    options.signal
  );
}

export async function syncReferencesLocked(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: ReferenceSyncOptions,
  scope: ReferenceLockScope
): Promise<OperationOutcome[]> {
  assertReferenceLockScope(scope);
  const operations = collectOperations(options.onComplete);
  await validateReferenceDestinations(profile.enabledReferences, profile);

  const runGit = referenceGitRunner(options);
  let state: ReferenceState;

  try {
    state = await readReferenceState(paths);
  } catch (error) {
    failReference(operations, referenceStatePath(paths), error);
  }

  const runOptions: ReferenceRunOptions = {
    ...options,
    runGit,
    writeState: options.writeState ?? writeReferenceState
  };

  const selected = await runSelectedReferences(
    paths,
    profile,
    profile.enabledReferences,
    state,
    runOptions,
    { reconcileReference, removeReference: removeManagedReference }
  );

  state = completeReferenceBatch(operations, selected);

  const cleanup = await runDeselectedReferences(
    paths,
    profile,
    state,
    profile.enabledReferences.length,
    runOptions,
    { reconcileReference, removeReference: removeManagedReference }
  );

  appendReferenceCleanupOutcomes(operations, cleanup);
  completeReferenceCleanup(operations, cleanup);

  return operations.outcomes;
}

export async function planReferences(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: ReferenceSyncOptions = {}
): Promise<OperationOutcome[]> {
  const operations = collectOperations(options.onComplete);
  await validateReferenceDestinations(profile.enabledReferences, profile);
  let state: ReferenceState;

  try {
    state = await readReferenceState(paths);
  } catch (error) {
    failReference(operations, referenceStatePath(paths), error);
  }

  for (const [ordinal, reference] of profile.enabledReferences.entries()) {
    const destination = referencePath(profile, reference);
    const operation = referenceOperation(profile, reference, "reconcile");
    emitReferenceStart(options, operation, ordinal);
    const exists = await pathExists(destination);

    const outcome: OperationOutcome = {
      category: "reference",
      action: "reconcile",
      status: "planned",
      target: destination,
      significance: "meaningful",
      detail: exists
        ? `${reference.name}: upstream synchronization would be checked; upstream state not checked`
        : `${reference.name}: checkout would be cloned`
    };

    operations.complete(outcome);
    emitReferenceCompletion(options, operation, ordinal, outcome);
  }

  const desired = new Set(profile.enabledReferences.map((reference) => reference.name));

  const retainedElsewhere = new Set(
    Object.entries(state.profiles)
      .filter(([profileName]) => profileName !== profile.name)
      .flatMap(([, names]) => names)
  );

  for (const [index, name] of (state.profiles[profile.name] ?? []).entries()) {
    if (desired.has(name) || retainedElsewhere.has(name)) continue;
    const destination = path.join(profile.referencesDir, name);
    const operation = referenceOperationForName(profile, name, "remove");
    emitReferenceStart(options, operation, profile.enabledReferences.length + index);

    const outcome: OperationOutcome = {
      category: "reference",
      action: "remove",
      status: "planned",
      target: destination,
      significance: "meaningful",
      detail: (await pathExists(destination))
        ? `${name}: managed checkout would be checked and removed if safe`
        : `${name}: absent checkout ownership would be released`
    };

    operations.complete(outcome);
    emitReferenceCompletion(options, operation, profile.enabledReferences.length + index, outcome);
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
  return withReferenceResourceLock(
    paths,
    profile.referencesDir,
    (signal, scope) => syncReferenceLocked(paths, profile, name, { ...options, signal }, scope),
    options.signal
  );
}

export async function syncReferenceLocked(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  name: string,
  options: ReferenceSyncOptions,
  scope: ReferenceLockScope
): Promise<OperationOutcome[]> {
  assertReferenceLockScope(scope);
  const operations = collectOperations(options.onComplete);

  const ref =
    profile.enabledReferences.find((entry) => entry.name === name) ??
    profile.manifests.references.find((entry) => entry.name === name);

  if (!ref) failReference(operations, name, new Error(`Unknown reference: ${name}`));

  await validateReferenceDestinations([ref], profile);
  const runGit = referenceGitRunner(options);
  let state: ReferenceState;

  try {
    state = await readReferenceState(paths);
  } catch (error) {
    failReference(operations, referenceStatePath(paths), error);
  }

  const selected = await runSelectedReferences(
    paths,
    profile,
    [ref],
    state,
    {
      ...options,
      runGit,
      writeState: options.writeState ?? writeReferenceState
    },
    { reconcileReference, removeReference: removeManagedReference }
  );

  completeReferenceBatch(operations, selected);

  return operations.outcomes;
}

function referenceGitRunner(options: ReferenceSyncOptions): RunGit {
  const runGit = options.runGit ?? runGitCommand;
  const signal = options.signal;

  if (!signal) return runGit;

  return (file, args, gitOptions) =>
    runGit(file, args, { stdio: gitOptions.stdio, cancelSignal: signal });
}

function referenceOperation(
  profile: ResolvedProfile,
  reference: ReferenceEntry,
  action: "reconcile" | "remove"
): OperationStart {
  return referenceOperationForName(profile, reference.name, action);
}

function referenceOperationForName(
  profile: ResolvedProfile,
  name: string,
  action: "reconcile" | "remove"
): OperationStart {
  return {
    category: "reference",
    action,
    target: path.join(profile.referencesDir, name),
    detail: name
  };
}

function emitReferenceStart(
  options: ReferenceSyncOptions,
  operation: OperationStart,
  ordinal: number
): void {
  options.onStart?.(operation);
  options.onLifecycle?.({
    type: "start",
    key: referenceLifecycleKey(ordinal, operation.detail ?? operation.target),
    ordinal,
    operation
  });
}

function emitReferenceCompletion(
  options: ReferenceSyncOptions,
  operation: OperationStart,
  ordinal: number,
  outcome: OperationOutcome
): void {
  options.onLifecycle?.({
    type: "complete",
    key: referenceLifecycleKey(ordinal, operation.detail ?? operation.target),
    ordinal,
    outcome
  });
}

async function validateReferenceDestinations(
  references: readonly ReferenceEntry[],
  profile: ResolvedProfile
): Promise<void> {
  const destinations = new Map<string, string>();

  for (const reference of references) {
    const destination = await canonicalizePhysicalPath(referencePath(profile, reference));
    const previous = destinations.get(destination);

    if (previous !== undefined) {
      throw new ReferenceInvariantError(
        `References ${previous} and ${reference.name} resolve to the same checkout: ${destination}`
      );
    }

    destinations.set(destination, reference.name);
  }
}

function completeReferenceBatch(
  operations: OperationCollector,
  result: ReferenceBatchResult
): ReferenceState {
  appendReferenceBatchOutcomes(operations, result);

  if (result.kind === "success") return result.state;

  if (result.kind === "fatal" && result.reason === "cancellation") throw result.cause;

  if (result.kind === "fatal" && result.reason === "unexpected") {
    throwReferenceRunError(operations, referenceFailureMessage(result), result.cause);
  }

  throwReferenceRunError(operations, referenceFailureMessage(result), result.cause);
}

function completeReferenceCleanup(
  operations: OperationCollector,
  result: ReferenceCleanupResult
): void {
  if (result.kind === "success") return;

  if (result.kind === "fatal" && result.reason === "cancellation") throw result.cause;

  if (result.kind === "fatal" && result.reason === "unexpected") {
    throwReferenceRunError(operations, referenceFailureMessage(result), result.cause);
  }

  throwReferenceRunError(operations, referenceFailureMessage(result), result.cause);
}

function throwReferenceRunError(
  operations: OperationCollector,
  message: string,
  cause: unknown
): never {
  throw new ReferenceReconciliationError(message, operations.outcomes, cause);
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
