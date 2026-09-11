import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { mindframeZDir, type RuntimePaths } from "../core/paths.js";

const homeLockName = "references.lock";

const referencesLockSuffix = ".mfz-references.lock";

const lockScopes = new WeakSet<object>();

declare const referenceLockScopeBrand: unique symbol;

export type ReferenceLockScope = {
  readonly [referenceLockScopeBrand]: true;
};

export class ReferenceResourceBusyError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(
      `Reference synchronization is already active for ${lockPath}; retry after the active run finishes (if no run is active, remove the lock after verifying that fact)`
    );
    this.name = "ReferenceResourceBusyError";
    this.lockPath = lockPath;
  }
}

export class ReferenceSyncCancelledError extends Error {
  constructor() {
    super("Reference synchronization cancelled");
    this.name = "ReferenceSyncCancelledError";
  }
}

export async function referenceLockPaths(
  paths: RuntimePaths,
  referencesDir: string
): Promise<string[]> {
  const [homeStateDir, physicalReferencesDir] = await Promise.all([
    canonicalizePhysicalPath(mindframeZDir(paths.home)),
    canonicalizePhysicalPath(referencesDir)
  ]);

  return [
    path.join(homeStateDir, homeLockName),
    `${physicalReferencesDir}${referencesLockSuffix}`
  ].sort();
}

export async function canonicalizePhysicalPath(target: string): Promise<string> {
  let current = path.resolve(target);
  const missingSuffix: string[] = [];

  while (true) {
    try {
      const existing = await realpath(current);

      return path.join(existing, ...missingSuffix.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;

      const parent = path.dirname(current);

      if (parent === current) throw error;
      missingSuffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function acquireReferenceLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ReferenceResourceBusyError(lockPath);
    }

    throw error;
  }

  return async () => {
    await rm(lockPath, { recursive: true, force: true });
  };
}

async function releaseReferenceLocks(releases: Array<() => Promise<void>>): Promise<void> {
  let failure: unknown;

  for (const release of [...releases].reverse()) {
    try {
      await release();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) throw failure;
}

export async function withReferenceResourceLock<T>(
  paths: RuntimePaths,
  referencesDir: string,
  action: (signal: AbortSignal, scope: ReferenceLockScope) => Promise<T>,
  callerSignal?: AbortSignal
): Promise<T> {
  if (callerSignal?.aborted) throw new ReferenceSyncCancelledError();

  const releases: Array<() => Promise<void>> = [];

  try {
    for (const lockPath of await referenceLockPaths(paths, referencesDir)) {
      releases.push(await acquireReferenceLock(lockPath));
    }
  } catch (error) {
    await releaseReferenceLocks(releases);
    throw error;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const onInterrupt = () => controller.abort();

  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });

  process.on("SIGINT", onInterrupt);

  // SAFETY: This frozen token is created only inside the active lock scope and is
  // checked against the module-private WeakSet before locked implementations run.
  const scope = Object.freeze({}) as ReferenceLockScope;
  lockScopes.add(scope);

  try {
    const result = await action(controller.signal, scope);

    if (controller.signal.aborted) throw new ReferenceSyncCancelledError();

    return result;
  } finally {
    lockScopes.delete(scope);
    callerSignal?.removeEventListener("abort", onAbort);
    process.off("SIGINT", onInterrupt);
    await releaseReferenceLocks(releases);
  }
}

export function assertReferenceLockScope(scope: ReferenceLockScope): void {
  if (!lockScopes.has(scope)) throw new Error("Reference synchronization requires an active lock");
}

export function throwIfReferenceSyncCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReferenceSyncCancelledError();
}
