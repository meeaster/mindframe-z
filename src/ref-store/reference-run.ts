import { writeJsonFileAtomic } from "../core/fs-util.js";
import { eachUpstream, type ReferenceEntry } from "../core/manifests.js";
import { referenceStatePath, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import path from "node:path";
import {
  type OperationCompletion,
  type OperationCollector,
  type OperationLifecycleNotification,
  type OperationOutcome,
  type OperationStart,
  type OperationStartNotification
} from "../core/operations.js";
import { ExecaError } from "execa";
import { z } from "zod";
import { ReferenceSyncCancelledError, throwIfReferenceSyncCancelled } from "./reference-lock.js";

export const referenceStateSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), z.array(z.string()))
});

export type ReferenceState = z.infer<typeof referenceStateSchema>;

export interface RunGit {
  (
    file: string,
    args: readonly string[],
    options: { stdio: "pipe"; cancelSignal?: AbortSignal }
  ): Promise<{
    stdout: string;
  }>;
}

export type WriteReferenceState = (file: string, state: ReferenceState) => Promise<void>;

export const writeReferenceState: WriteReferenceState = writeJsonFileAtomic;

export class ReferenceBlockedError extends Error {}

export class ReferenceStatePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReferenceStatePersistenceError";
  }
}

export interface ReferenceRunOptions {
  onStart?: OperationStartNotification;
  onComplete?: OperationCompletion;
  onLifecycle?: OperationLifecycleNotification;
  runGit: RunGit;
  writeState: WriteReferenceState;
  signal?: AbortSignal;
}

export interface ReferenceRunActions {
  reconcileReference: (
    profile: ResolvedProfile,
    reference: ReferenceEntry,
    runGit: RunGit
  ) => Promise<OperationOutcome>;
  removeReference: (
    profile: ResolvedProfile,
    name: string,
    runGit: RunGit
  ) => Promise<OperationOutcome | undefined>;
}

export const REFERENCE_SYNC_CONCURRENCY = 4;

export type ReferenceFailureReason = "cancellation" | "persistence" | "unexpected";

export type ReferenceTaskResult =
  | {
      kind: "success";
      ordinal: number;
      outcomes: readonly [OperationOutcome, OperationOutcome];
    }
  | {
      kind: "expected-failure";
      ordinal: number;
      outcomes: readonly [OperationOutcome];
      cause: Error;
    }
  | {
      kind: "fatal";
      ordinal: number;
      outcomes: readonly OperationOutcome[];
      reason: ReferenceFailureReason;
      cause: Error;
    };

export type ReferenceBatchResult =
  | {
      kind: "success";
      state: ReferenceState;
      results: readonly ReferenceTaskResult[];
    }
  | {
      kind: "expected-failure";
      state: ReferenceState;
      results: readonly ReferenceTaskResult[];
      cause: Error;
    }
  | {
      kind: "fatal";
      state: ReferenceState;
      results: readonly ReferenceTaskResult[];
      reason: ReferenceFailureReason;
      cause: Error;
    };

export type ReferenceCleanupResult =
  | {
      kind: "success";
      state: ReferenceState;
      outcomes: readonly OperationOutcome[];
    }
  | {
      kind: "expected-failure";
      state: ReferenceState;
      outcomes: readonly OperationOutcome[];
      cause: Error;
    }
  | {
      kind: "fatal";
      state: ReferenceState;
      outcomes: readonly OperationOutcome[];
      reason: ReferenceFailureReason;
      cause: Error;
    };

class OwnershipStateWriter {
  #state: ReferenceState;
  readonly #writeState: WriteReferenceState;
  readonly #order: ReadonlyMap<string, number>;
  #tail = Promise.resolve();
  #failed = false;
  #failure: ReferenceStatePersistenceError | undefined;

  constructor(
    state: ReferenceState,
    writeState: WriteReferenceState,
    order: ReadonlyMap<string, number> = new Map()
  ) {
    this.#state = state;
    this.#writeState = writeState;
    this.#order = order;
  }

  get state(): ReferenceState {
    return this.#state;
  }

  checkpoint(paths: RuntimePaths, profileName: string, name: string): Promise<OperationOutcome> {
    return this.#enqueue(async () => {
      const result = await retainOwnership(
        paths,
        this.#state,
        profileName,
        name,
        this.#writeState,
        this.#order
      );

      this.#state = result.state;

      return result.outcome;
    });
  }

  release(paths: RuntimePaths, profileName: string, name: string): Promise<OperationOutcome> {
    return this.#enqueue(async () => {
      const result = await releaseOwnership(
        paths,
        this.#state,
        profileName,
        name,
        this.#writeState
      );

      this.#state = result.state;

      return result.outcome;
    });
  }

  #enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(async () => {
      if (this.#failed) {
        throw new ReferenceStatePersistenceError("Reference ownership state writer has failed", {
          cause: this.#failure
        });
      }

      try {
        return await action();
      } catch (cause) {
        const failure = normalizePersistenceFailure(cause);
        this.#failed = true;
        this.#failure = failure;
        throw failure;
      }
    });

    this.#tail = operation.then(
      () => undefined,
      () => undefined
    );

    return operation;
  }
}

export function referenceLifecycleKey(ordinal: number, name: string): string {
  return `reference:${ordinal}:${name}`;
}

export async function runSelectedReferences(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  references: readonly ReferenceEntry[],
  state: ReferenceState,
  options: ReferenceRunOptions,
  actions: ReferenceRunActions
): Promise<ReferenceBatchResult> {
  const writer = new OwnershipStateWriter(
    state,
    options.writeState,
    references.length > 1
      ? new Map(references.map((reference, ordinal) => [reference.name, ordinal]))
      : new Map()
  );

  const results = new Map<number, ReferenceTaskResult>();
  const active = new Map<number, Promise<ReferenceTaskResult>>();
  let nextOrdinal = 0;
  let stopAdmitting = false;

  const admit = (reference: ReferenceEntry, ordinal: number): void => {
    const operation = referenceOperation(profile, reference, "reconcile");

    try {
      emitReferenceStart(options, operation, ordinal);
    } catch (cause) {
      const failure = toError(cause);

      stopAdmitting = true;
      results.set(ordinal, {
        kind: "fatal",
        ordinal,
        outcomes: [lifecycleObserverFailureOutcome(operation, failure)],
        reason: "unexpected",
        cause: failure
      });

      return;
    }

    const task = runReferenceTask(
      paths,
      profile,
      reference,
      ordinal,
      operation,
      writer,
      options,
      actions
    ).catch((cause: unknown) => {
      const failure = referenceFailureOutcome(operation, "failed", errorMessage(cause));

      const result: ReferenceTaskResult = {
        kind: "fatal",
        ordinal,
        outcomes: [failure],
        reason: "unexpected",
        cause: toError(cause)
      } satisfies ReferenceTaskResult;

      return completeReferenceTask(options, operation, ordinal, result, failure);
    });

    active.set(ordinal, task);
  };

  while (
    !stopAdmitting &&
    nextOrdinal < references.length &&
    active.size < REFERENCE_SYNC_CONCURRENCY
  ) {
    if (options.signal?.aborted) {
      stopAdmitting = true;
      break;
    }

    admit(references[nextOrdinal]!, nextOrdinal);
    nextOrdinal += 1;
  }

  while (active.size > 0) {
    const settled = await Promise.race(active.values());
    active.delete(settled.ordinal);
    results.set(settled.ordinal, settled);

    if (settled.kind === "fatal") stopAdmitting = true;

    if (stopAdmitting || options.signal?.aborted) {
      stopAdmitting = true;
      continue;
    }

    if (nextOrdinal < references.length) {
      admit(references[nextOrdinal]!, nextOrdinal);
      nextOrdinal += 1;
    }
  }

  const orderedResults = [...results.values()].sort((left, right) => left.ordinal - right.ordinal);

  const fatal = orderedResults.find(
    (result): result is Extract<ReferenceTaskResult, { kind: "fatal" }> => result.kind === "fatal"
  );

  if (fatal) {
    return {
      kind: "fatal",
      state: writer.state,
      results: orderedResults,
      reason: fatal.reason,
      cause: fatal.cause
    };
  }

  if (options.signal?.aborted) {
    return {
      kind: "fatal",
      state: writer.state,
      results: orderedResults,
      reason: "cancellation",
      cause: new ReferenceSyncCancelledError()
    };
  }

  const expectedFailure = orderedResults.find(
    (result): result is Extract<ReferenceTaskResult, { kind: "expected-failure" }> =>
      result.kind === "expected-failure"
  );

  if (expectedFailure) {
    return {
      kind: "expected-failure",
      state: writer.state,
      results: orderedResults,
      cause: expectedFailure.cause
    };
  }

  return { kind: "success", state: writer.state, results: orderedResults };
}

async function runReferenceTask(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  reference: ReferenceEntry,
  ordinal: number,
  operation: OperationStart,
  writer: OwnershipStateWriter,
  options: ReferenceRunOptions,
  actions: ReferenceRunActions
): Promise<ReferenceTaskResult> {
  let checkoutOutcome: OperationOutcome;

  try {
    throwIfReferenceSyncCancelled(options.signal);
    checkoutOutcome = await actions.reconcileReference(profile, reference, options.runGit);
  } catch (cause) {
    if (options.signal?.aborted || cause instanceof ReferenceSyncCancelledError) {
      const cancelled = referenceFailureOutcome(
        operation,
        "failed",
        errorMessage(new ReferenceSyncCancelledError())
      );

      const result: ReferenceTaskResult = {
        kind: "fatal",
        ordinal,
        outcomes: [cancelled],
        reason: "cancellation",
        cause: new ReferenceSyncCancelledError()
      };

      return completeReferenceTask(options, operation, ordinal, result, cancelled);
    }

    if (isExpectedReferenceFailure(cause)) {
      const failure = referenceFailureOutcome(
        operation,
        cause instanceof ReferenceBlockedError ? "blocked" : "failed",
        errorMessage(cause)
      );

      const result: ReferenceTaskResult = {
        kind: "expected-failure",
        ordinal,
        outcomes: [failure],
        cause: toError(cause)
      };

      return completeReferenceTask(options, operation, ordinal, result, failure);
    }

    const failure = referenceFailureOutcome(operation, "failed", errorMessage(cause));

    const result: ReferenceTaskResult = {
      kind: "fatal",
      ordinal,
      outcomes: [failure],
      reason: "unexpected",
      cause: toError(cause)
    };

    return completeReferenceTask(options, operation, ordinal, result, failure);
  }

  let ownershipOutcome: OperationOutcome | undefined;

  try {
    throwIfReferenceSyncCancelled(options.signal);
    ownershipOutcome = await writer.checkpoint(paths, profile.name, reference.name);
    throwIfReferenceSyncCancelled(options.signal);
  } catch (cause) {
    if (options.signal?.aborted || cause instanceof ReferenceSyncCancelledError) {
      const cancelled = lifecycleFailureOutcome(
        operation,
        checkoutOutcome,
        `synchronization cancelled: ${errorMessage(new ReferenceSyncCancelledError())}`
      );

      const result: ReferenceTaskResult = {
        kind: "fatal",
        ordinal,
        outcomes: [checkoutOutcome, ...(ownershipOutcome ? [ownershipOutcome] : []), cancelled],
        reason: "cancellation",
        cause: new ReferenceSyncCancelledError()
      };

      return completeReferenceTask(options, operation, ordinal, result, cancelled);
    }

    const detail = `Could not record ownership for ${reference.name}: ${errorMessage(cause)}`;

    const failure = lifecycleFailureOutcome(
      operation,
      checkoutOutcome,
      `ownership failed: ${detail}`
    );

    const stateFailure = ownershipFailureOutcome(
      paths,
      profile.name,
      reference.name,
      "record",
      cause
    );

    const result: ReferenceTaskResult = {
      kind: "fatal",
      ordinal,
      outcomes: [checkoutOutcome, failure, stateFailure],
      reason: "persistence",
      cause: toError(cause)
    };

    return completeReferenceTask(options, operation, ordinal, result, failure);
  }

  const result: ReferenceTaskResult = {
    kind: "success",
    ordinal,
    outcomes: [checkoutOutcome, ownershipOutcome]
  };

  return completeReferenceTask(options, operation, ordinal, result, checkoutOutcome);
}

export async function runDeselectedReferences(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  state: ReferenceState,
  startOrdinal: number,
  options: ReferenceRunOptions,
  actions: ReferenceRunActions
): Promise<ReferenceCleanupResult> {
  const writer = new OwnershipStateWriter(state, options.writeState);
  const desired = new Set(profile.enabledReferences.map((reference) => reference.name));

  const retainedElsewhere = new Set(
    Object.entries(state.profiles)
      .filter(([profileName]) => profileName !== profile.name)
      .flatMap(([, names]) => names)
  );

  const outcomes: OperationOutcome[] = [];
  let ordinal = startOrdinal;

  for (const name of state.profiles[profile.name] ?? []) {
    if (options.signal?.aborted) {
      return {
        kind: "fatal",
        state: writer.state,
        outcomes,
        reason: "cancellation",
        cause: new ReferenceSyncCancelledError()
      };
    }

    if (desired.has(name)) continue;

    if (retainedElsewhere.has(name)) {
      try {
        throwIfReferenceSyncCancelled(options.signal);
        outcomes.push(await writer.release(paths, profile.name, name));
        throwIfReferenceSyncCancelled(options.signal);
      } catch (cause) {
        if (options.signal?.aborted || cause instanceof ReferenceSyncCancelledError) {
          return {
            kind: "fatal",
            state: writer.state,
            outcomes,
            reason: "cancellation",
            cause: new ReferenceSyncCancelledError()
          };
        }

        const failure = ownershipFailureOutcome(paths, profile.name, name, "release", cause);
        outcomes.push(failure);

        return {
          kind: "fatal",
          state: writer.state,
          outcomes,
          reason: "persistence",
          cause: toError(cause)
        };
      }

      continue;
    }

    const operation = referenceOperationForName(profile, name, "remove");

    try {
      emitReferenceStart(options, operation, ordinal);
    } catch (cause) {
      const failure = toError(cause);

      return {
        kind: "fatal",
        state: writer.state,
        outcomes: [lifecycleObserverFailureOutcome(operation, failure)],
        reason: "unexpected",
        cause: failure
      };
    }

    let removalOutcome: OperationOutcome | undefined;

    try {
      throwIfReferenceSyncCancelled(options.signal);
      removalOutcome = await actions.removeReference(profile, name, options.runGit);

      if (removalOutcome) outcomes.push(removalOutcome);
      throwIfReferenceSyncCancelled(options.signal);
      outcomes.push(await writer.release(paths, profile.name, name));
      throwIfReferenceSyncCancelled(options.signal);
    } catch (cause) {
      if (options.signal?.aborted || cause instanceof ReferenceSyncCancelledError) {
        const failure = lifecycleFailureOutcome(
          operation,
          removalOutcome,
          `synchronization cancelled: ${errorMessage(new ReferenceSyncCancelledError())}`
        );

        outcomes.push(failure);

        const result: ReferenceCleanupResult = {
          kind: "fatal",
          state: writer.state,
          outcomes,
          reason: "cancellation",
          cause: new ReferenceSyncCancelledError()
        };

        return completeCleanupResult(options, operation, ordinal, result, failure);
      }

      if (cause instanceof ReferenceStatePersistenceError) {
        const detail = `Could not release ownership for ${name}: ${errorMessage(cause)}`;

        const failure = lifecycleFailureOutcome(
          operation,
          removalOutcome,
          `ownership failed: ${detail}`
        );

        outcomes.push(failure);
        outcomes.push(ownershipFailureOutcome(paths, profile.name, name, "release", cause));

        const result: ReferenceCleanupResult = {
          kind: "fatal",
          state: writer.state,
          outcomes,
          reason: "persistence",
          cause: toError(cause)
        };

        return completeCleanupResult(options, operation, ordinal, result, failure);
      }

      const failure = referenceFailureOutcome(
        operation,
        cause instanceof ReferenceBlockedError ? "blocked" : "failed",
        errorMessage(cause)
      );

      outcomes.push(failure);

      if (isExpectedReferenceFailure(cause)) {
        const result: ReferenceCleanupResult = {
          kind: "expected-failure",
          state: writer.state,
          outcomes,
          cause: toError(cause)
        };

        return completeCleanupResult(options, operation, ordinal, result, failure);
      }

      const result: ReferenceCleanupResult = {
        kind: "fatal",
        state: writer.state,
        outcomes,
        reason: "unexpected",
        cause: toError(cause)
      };

      return completeCleanupResult(options, operation, ordinal, result, failure);
    }

    const completionOutcome = removalOutcome ?? absentRemovalOutcome(operation, name);

    const result: ReferenceCleanupResult = {
      kind: "success",
      state: writer.state,
      outcomes
    };

    const completed = completeCleanupResult(options, operation, ordinal, result, completionOutcome);

    if (completed.kind !== "success") return completed;

    ordinal += 1;
  }

  return { kind: "success", state: writer.state, outcomes };
}

export function appendReferenceBatchOutcomes(
  operations: OperationCollector,
  result: ReferenceBatchResult
): void {
  for (const task of result.results) appendOutcomes(operations, task.outcomes);
}

export function appendReferenceCleanupOutcomes(
  operations: OperationCollector,
  result: ReferenceCleanupResult
): void {
  appendOutcomes(operations, result.outcomes);
}

export function referenceFailureMessage(
  result:
    | Exclude<ReferenceBatchResult, { kind: "success" }>
    | Exclude<ReferenceCleanupResult, { kind: "success" }>
): string {
  const outcomes =
    "results" in result ? result.results.flatMap((task) => task.outcomes) : result.outcomes;

  const referenceFailures = outcomes.filter(
    (outcome) =>
      outcome.category === "reference" &&
      (outcome.status === "blocked" || outcome.status === "failed")
  );

  const failureOutcomes = referenceFailures.length
    ? referenceFailures
    : outcomes.filter(
        (outcome) => outcome.category === "bookkeeping" && outcome.status === "failed"
      );

  return (
    failureOutcomes.map((outcome) => outcome.detail ?? outcome.target).join("; ") ||
    result.cause.message
  );
}

function emitReferenceStart(
  options: ReferenceRunOptions,
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
  options: ReferenceRunOptions,
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

function completeReferenceTask(
  options: ReferenceRunOptions,
  operation: OperationStart,
  ordinal: number,
  result: ReferenceTaskResult,
  outcome: OperationOutcome
): ReferenceTaskResult {
  const observerFailure = notifyReferenceCompletion(options, operation, ordinal, outcome);

  if (!observerFailure) return result;

  return {
    kind: "fatal",
    ordinal,
    outcomes: [...result.outcomes, lifecycleObserverFailureOutcome(operation, observerFailure)],
    reason: "unexpected",
    cause: observerFailure
  };
}

function completeCleanupResult(
  options: ReferenceRunOptions,
  operation: OperationStart,
  ordinal: number,
  result: ReferenceCleanupResult,
  outcome: OperationOutcome
): ReferenceCleanupResult {
  const observerFailure = notifyReferenceCompletion(options, operation, ordinal, outcome);

  if (!observerFailure) return result;

  return {
    kind: "fatal",
    state: result.state,
    outcomes: [...result.outcomes, lifecycleObserverFailureOutcome(operation, observerFailure)],
    reason: "unexpected",
    cause: observerFailure
  };
}

function notifyReferenceCompletion(
  options: ReferenceRunOptions,
  operation: OperationStart,
  ordinal: number,
  outcome: OperationOutcome
): Error | undefined {
  try {
    emitReferenceCompletion(options, operation, ordinal, outcome);
  } catch (cause) {
    return toError(cause);
  }

  return undefined;
}

function lifecycleObserverFailureOutcome(
  operation: OperationStart,
  cause: Error
): OperationOutcome {
  return referenceFailureOutcome(
    operation,
    "failed",
    `lifecycle observer failed: ${errorMessage(cause)}`
  );
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

function referenceFailureOutcome(
  operation: OperationStart,
  status: "blocked" | "failed",
  detail: string
): OperationOutcome {
  return {
    category: "reference",
    action: operation.action,
    status,
    target: operation.target,
    significance: "meaningful",
    detail
  };
}

function lifecycleFailureOutcome(
  operation: OperationStart,
  effect: OperationOutcome | undefined,
  failure: string
): OperationOutcome {
  const effectText = effect ? `${effect.status}: ${effect.detail ?? effect.target}; ` : "";

  return referenceFailureOutcome(operation, "failed", `${effectText}${failure}`);
}

function absentRemovalOutcome(operation: OperationStart, name: string): OperationOutcome {
  return {
    category: "reference",
    action: operation.action,
    status: "unchanged",
    target: operation.target,
    significance: "meaningful",
    detail: `${name}: managed checkout is already absent`
  };
}

function ownershipOutcome(
  paths: RuntimePaths,
  profileName: string,
  name: string,
  status: "updated" | "unchanged"
): OperationOutcome {
  return {
    category: "bookkeeping",
    action: "write",
    status,
    target: referenceStatePath(paths),
    significance: "internal",
    detail: `${profileName}/${name}`
  };
}

function ownershipFailureOutcome(
  paths: RuntimePaths,
  profileName: string,
  name: string,
  action: "record" | "release",
  cause: unknown
): OperationOutcome {
  return {
    category: "bookkeeping",
    action: "write",
    status: "failed",
    target: referenceStatePath(paths),
    significance: "internal",
    detail: `Could not ${action} ownership for ${profileName}/${name}: ${errorMessage(cause)}`
  };
}

async function retainOwnership(
  paths: RuntimePaths,
  state: ReferenceState,
  profileName: string,
  name: string,
  writeState: WriteReferenceState,
  order: ReadonlyMap<string, number>
): Promise<{ state: ReferenceState; outcome: OperationOutcome }> {
  const current = state.profiles[profileName] ?? [];

  if (current.includes(name)) {
    return {
      state,
      outcome: ownershipOutcome(paths, profileName, name, "unchanged")
    };
  }

  const nextReferences = [...current, name];
  nextReferences.sort(
    (left, right) =>
      (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
  const next = withProfileReferences(state, profileName, nextReferences);
  await writeState(referenceStatePath(paths), next);

  return {
    state: next,
    outcome: ownershipOutcome(paths, profileName, name, "updated")
  };
}

async function releaseOwnership(
  paths: RuntimePaths,
  state: ReferenceState,
  profileName: string,
  name: string,
  writeState: WriteReferenceState
): Promise<{ state: ReferenceState; outcome: OperationOutcome }> {
  const current = state.profiles[profileName] ?? [];
  const remaining = current.filter((ownedName) => ownedName !== name);
  const next = withProfileReferences(state, profileName, remaining);
  await writeState(referenceStatePath(paths), next);

  return {
    state: next,
    outcome: ownershipOutcome(paths, profileName, name, "updated")
  };
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

function normalizePersistenceFailure(cause: unknown): ReferenceStatePersistenceError {
  if (cause instanceof ReferenceStatePersistenceError) return cause;

  return new ReferenceStatePersistenceError(errorMessage(cause), { cause });
}

function isExpectedReferenceFailure(cause: unknown): boolean {
  return cause instanceof ReferenceBlockedError || cause instanceof ExecaError;
}

function appendOutcomes(
  operations: OperationCollector,
  outcomes: readonly OperationOutcome[]
): void {
  for (const outcome of outcomes) operations.complete(outcome);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function managedReferenceDefinition(profile: ResolvedProfile, name: string): ReferenceEntry {
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
