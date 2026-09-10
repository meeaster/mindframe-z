import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { executorDesiredPath, executorManagedPath, type RuntimePaths } from "../core/paths.js";
import { pathExists } from "../core/fs-util.js";
import { writeJsonAtomicOutcome } from "../core/file-operations.js";
import type {
  OperationCompletion,
  OperationOutcome,
  PlannedOperationEffect
} from "../core/operations.js";
import type { ResolvedProfile } from "../core/profile.js";
import { createExecutorAdapter, attachExecutorAdapter, type ExecutorAdapter } from "./adapter.js";
import {
  buildExecutorDesiredState,
  executorConfigDigest,
  type ExecutorDesiredServer,
  type ExecutorDesiredState
} from "./model.js";
import {
  classifyExecutorIntegration,
  classifyExecutorRemoval,
  type ExecutorConnectionClassification
} from "./lifecycle.js";

export interface ManagedState {
  version: 1;
  profile: string;
  complete: boolean;
  operation?:
    | {
        status: "incomplete" | "complete";
        desiredIntegrations: string[];
        startedAt: string;
      }
    | undefined;
  integrations: Record<
    string,
    { digest: string; lastReconciledAt: string; connections?: Record<string, string> | undefined }
  >;
}

const managedStateSchema = z.object({
  version: z.literal(1),
  profile: z.string(),
  complete: z.boolean().default(false),
  operation: z
    .object({
      status: z.enum(["incomplete", "complete"]),
      desiredIntegrations: z.array(z.string()),
      startedAt: z.string()
    })
    .optional(),
  integrations: z.record(
    z.string(),
    z
      .object({
        digest: z.string(),
        lastReconciledAt: z.string(),
        connections: z.record(z.string(), z.string()).optional()
      })
      .strict()
  )
});

export interface ExecutorReconcileResult {
  desired: ExecutorDesiredState;
  added: string[];
  updated: string[];
  reused: string[];
  removed: string[];
  addedConnections: string[];
  reusedConnections: string[];
  retained: string[];
  requiredConnections: ExecutorRequiredConnection[];
  planning?: "managed-digest-only" | "metadata-unavailable" | "live-metadata-unverified";
  blockers?: string[];
}

export interface ExecutorRequiredConnection {
  integration: string;
  name: string;
  authentication: "oauth" | "api-key";
  reason: "missing" | "missing-oauth-scopes";
}

export async function readManagedState(
  paths: RuntimePaths,
  profileName: string
): Promise<ManagedState | undefined> {
  try {
    const parsed = managedStateSchema.parse(
      JSON.parse(await readFile(executorManagedPath(paths, profileName), "utf8"))
    );
    const { operation, ...state } = parsed;
    return operation === undefined ? state : { ...state, operation };
  } catch {
    return undefined;
  }
}

export async function readManagedStates(paths: RuntimePaths): Promise<ManagedState[]> {
  let entries;
  try {
    entries = await readdir(paths.configsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const states: ManagedState[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readManagedState(paths, entry.name);
    if (state) states.push({ ...state, profile: entry.name });
  }
  return states;
}

async function readManaged(paths: RuntimePaths, profileName: string): Promise<ManagedState> {
  return (
    (await readManagedState(paths, profileName)) ?? {
      version: 1,
      profile: profileName,
      complete: false,
      integrations: {}
    }
  );
}

export async function hasManagedExecutorState(
  paths: RuntimePaths,
  profileName: string
): Promise<boolean> {
  return pathExists(executorManagedPath(paths, profileName));
}

async function writeSnapshots(
  paths: RuntimePaths,
  profileName: string,
  desired: ExecutorDesiredState,
  managed: ManagedState,
  onComplete?: OperationCompletion
): Promise<void> {
  const options = {
    category: "bookkeeping" as const,
    significance: "internal" as const
  };
  if (onComplete) Object.assign(options, { onComplete });
  await writeJsonAtomicOutcome(executorDesiredPath(paths, profileName), desired, options);
  await writeJsonAtomicOutcome(executorManagedPath(paths, profileName), managed, options);
}

function emptyResult(desired: ExecutorDesiredState): ExecutorReconcileResult {
  return {
    desired,
    added: [],
    updated: [],
    reused: [],
    removed: [],
    addedConnections: [],
    reusedConnections: [],
    retained: [],
    requiredConnections: []
  };
}

function connectionKey(integration: string, name: string): string {
  return `${integration}/${name}`;
}

export function planExecutor(
  desired: ExecutorDesiredState,
  previous: ManagedState,
  sharedOwnedSlugs: ReadonlySet<string> = new Set()
): ExecutorReconcileResult {
  const desiredSlugs = new Set(desired.integrations.map((server) => server.slug));
  return {
    desired,
    added: desired.integrations
      .filter((server) => previous.integrations[server.slug] === undefined)
      .map((server) => server.slug),
    updated: desired.integrations
      .filter((server) => {
        const managed = previous.integrations[server.slug];
        return managed !== undefined && managed.digest !== executorConfigDigest(server);
      })
      .map((server) => server.slug),
    reused: desired.integrations
      .filter(
        (server) => previous.integrations[server.slug]?.digest === executorConfigDigest(server)
      )
      .map((server) => server.slug),
    removed: Object.keys(previous.integrations).filter(
      (slug) => !desiredSlugs.has(slug) && !sharedOwnedSlugs.has(slug)
    ),
    addedConnections: [],
    reusedConnections: [],
    retained: Object.keys(previous.integrations).filter(
      (slug) => !desiredSlugs.has(slug) && sharedOwnedSlugs.has(slug)
    ),
    requiredConnections: [],
    planning: "managed-digest-only"
  };
}

async function planExecutorWithMetadata(
  adapter: ExecutorAdapter,
  desired: ExecutorDesiredState,
  base: ExecutorReconcileResult
): Promise<ExecutorReconcileResult> {
  const added = new Set(base.added);
  const updated = new Set(base.updated);
  const reused = new Set(base.reused);
  const removed = new Set(base.removed);
  const addedConnections = new Set(base.addedConnections);
  const reusedConnections = new Set(base.reusedConnections);
  const requiredConnections: ExecutorRequiredConnection[] = [];
  const blockers: string[] = [];

  for (const server of desired.integrations) {
    const current = await adapter.getIntegration(server.slug);
    const classification = classifyExecutorIntegration(
      server,
      {
        current,
        connections: current ? await adapter.listConnections(server.slug) : []
      },
      { requireCredentialedConnections: false, allowConnectionRepair: true }
    );
    if (classification.integration === "missing") {
      added.add(server.slug);
      updated.delete(server.slug);
      reused.delete(server.slug);
    } else if (classification.integration === "updated") {
      updated.add(server.slug);
      added.delete(server.slug);
      reused.delete(server.slug);
    } else {
      reused.add(server.slug);
      added.delete(server.slug);
      updated.delete(server.slug);
    }
    for (const connection of classification.connections) {
      if (connection.kind === "missing" && !connection.requiresConnection) {
        addedConnections.add(connectionKey(server.slug, connection.name));
      } else if (connection.kind === "compatible") {
        reusedConnections.add(connectionKey(server.slug, connection.name));
      }
      const required = requiredConnection(server, connection);
      if (required) requiredConnections.push(required);
    }
    blockers.push(...classification.blockers);
  }

  for (const slug of base.removed) {
    const current = await adapter.getIntegration(slug);
    const removal = classifyExecutorRemoval(
      slug,
      current,
      current ? await adapter.listConnections(slug) : []
    );
    if (!removal.removable) blockers.push(...removal.blockers);
  }

  return {
    ...base,
    added: [...added],
    updated: [...updated],
    reused: [...reused],
    removed: [...removed],
    addedConnections: [...addedConnections],
    reusedConnections: [...reusedConnections],
    requiredConnections,
    planning: "live-metadata-unverified",
    blockers
  };
}

async function preflightReconciliation(
  adapter: ExecutorAdapter,
  desired: readonly ExecutorDesiredServer[],
  previous: ManagedState,
  options: {
    retainedSlugs?: ReadonlySet<string>;
  } = {}
): Promise<void> {
  for (const server of desired) {
    const current = await adapter.getIntegration(server.slug);
    const classification = classifyExecutorIntegration(
      server,
      {
        current,
        connections: current ? await adapter.listConnections(server.slug) : []
      },
      {
        requireCredentialedConnections: false,
        allowConnectionRepair: true
      }
    );
    if (classification.blockers.length > 0) throw new Error(classification.blockers[0]);
  }

  const desiredSlugs = new Set(desired.map((server) => server.slug));
  for (const slug of Object.keys(previous.integrations)) {
    if (desiredSlugs.has(slug)) continue;
    if (options.retainedSlugs?.has(slug)) continue;
    const current = await adapter.getIntegration(slug);
    const removal = classifyExecutorRemoval(
      slug,
      current,
      current ? await adapter.listConnections(slug) : []
    );
    if (removal.blockers.length > 0) throw new Error(removal.blockers[0]);
  }
}

type ReconcileCheckpoint = (slug: string) => Promise<void>;

async function reconcileServer(
  adapter: ExecutorAdapter,
  desired: ExecutorDesiredServer,
  result: ExecutorReconcileResult,
  checkpoint: ReconcileCheckpoint,
  onComplete?: OperationCompletion
): Promise<void> {
  let current = await adapter.getIntegration(desired.slug);
  if (!current) {
    await adapter.addServer(desired);
    result.added.push(desired.slug);
    onComplete?.({
      category: "executor",
      action: "reconcile",
      status: "created",
      target: desired.slug,
      significance: "meaningful"
    });
    await checkpoint(desired.slug);
    current = await adapter.getIntegration(desired.slug);
    if (!current) throw new Error(`Executor registered ${desired.slug} but could not read it back`);
  } else {
    const classification = classifyExecutorIntegration(
      desired,
      { current, connections: await adapter.listConnections(desired.slug) },
      { requireCredentialedConnections: false, allowConnectionRepair: true }
    );
    if (classification.blockers.length > 0) throw new Error(classification.blockers[0]);
    let changed = false;
    if (classification.descriptionChanged) {
      await adapter.updateIntegration(desired.slug, { description: desired.description });
      result.updated.push(desired.slug);
      onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "updated",
        target: desired.slug,
        significance: "meaningful",
        detail: "description"
      });
      await checkpoint(desired.slug);
      changed = true;
    }
    if (classification.configurationChanged) {
      const serverConfig = Object.fromEntries(
        Object.entries(desired.config).filter(([key]) => key !== "authenticationTemplate")
      );
      await adapter.configureServer(desired.slug, serverConfig);
      result.updated.push(desired.slug);
      onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "updated",
        target: desired.slug,
        significance: "meaningful",
        detail: "configuration"
      });
      await checkpoint(desired.slug);
      changed = true;
      current = (await adapter.getIntegration(desired.slug)) ?? current;
    }
    const hasCredentialedConnection = Object.values(desired.connections).some(
      (method) => method !== "none"
    );
    if (classification.authenticationChanged && !hasCredentialedConnection) {
      const methods = desired.config.authenticationTemplate ?? [{ slug: "none", kind: "none" }];
      await adapter.configureAuth(desired.slug, methods, "replace");
      result.updated.push(desired.slug);
      onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "updated",
        target: desired.slug,
        significance: "meaningful",
        detail: "authentication"
      });
      await checkpoint(desired.slug);
      changed = true;
    }
    if (!changed) {
      result.reused.push(desired.slug);
      onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "unchanged",
        target: desired.slug,
        significance: "meaningful"
      });
    }
  }
}

async function ensureDeclaredConnection(
  adapter: ExecutorAdapter,
  server: ExecutorDesiredServer,
  result: ExecutorReconcileResult,
  checkpoint: ReconcileCheckpoint,
  onComplete?: OperationCompletion
): Promise<void> {
  const current = await adapter.getIntegration(server.slug);
  const classification = classifyExecutorIntegration(
    server,
    {
      current,
      connections: current ? await adapter.listConnections(server.slug) : []
    },
    { requireCredentialedConnections: false, allowConnectionRepair: true }
  );
  const actionable = classification.connections.filter(
    (connection): connection is Extract<ExecutorConnectionClassification, { kind: "missing" }> =>
      connection.kind === "missing"
  );
  for (const connection of actionable) {
    if (connection.method === "none") {
      await adapter.createNoAuthConnection(server.slug, connection.name, connection.method);
      result.addedConnections.push(connectionKey(server.slug, connection.name));
      onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "created",
        target: connectionKey(server.slug, connection.name),
        significance: "meaningful",
        detail: "connection"
      });
      await checkpoint(server.slug);
    }
  }
  if (classification.blockers.length > 0) throw new Error(classification.blockers[0]);
  for (const connection of classification.connections) {
    const required = requiredConnection(server, connection);
    if (required) result.requiredConnections.push(required);
    if (connection.kind === "compatible") {
      result.reusedConnections.push(connectionKey(server.slug, connection.name));
      onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "unchanged",
        target: connectionKey(server.slug, connection.name),
        significance: "meaningful",
        detail: "connection"
      });
    }
  }
}

export async function reconcileExecutor(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: {
    dryRun?: boolean;
    interactive?: boolean;
    adapter?: ExecutorAdapter;
    onComplete?: OperationCompletion;
  } = {}
): Promise<ExecutorReconcileResult | undefined> {
  const desired = buildExecutorDesiredState(profile, paths.home);
  const managedFilePresent = await pathExists(executorManagedPath(paths, profile.name));
  const previous = await readManaged(paths, profile.name);
  const sharedOwnedSlugs = new Set(
    (await readManagedStates(paths))
      .filter((state) => state.profile !== profile.name)
      .flatMap((state) => Object.keys(state.integrations))
  );
  if (desired.integrations.length === 0 && Object.keys(previous.integrations).length === 0) {
    if (managedFilePresent && (await readManagedState(paths, profile.name)) === undefined) {
      throw new Error(
        `Executor managed state for ${profile.name} is unreadable; repair or remove it before applying`
      );
    }
    return undefined;
  }
  const result = emptyResult(desired);
  if (options.dryRun) {
    const digestPlan = planExecutor(desired, previous, sharedOwnedSlugs);
    const attached = options.adapter ?? (await attachExecutorAdapter({}));
    if (!attached) {
      const plan = {
        ...digestPlan,
        planning: "metadata-unavailable",
        blockers: ["live Executor metadata unavailable; health and durable state are unknown"]
      } satisfies ExecutorReconcileResult;
      for (const outcome of executorPlanOutcomes(plan)) options.onComplete?.(outcome);
      return plan;
    }
    try {
      const plan = await planExecutorWithMetadata(attached, desired, digestPlan);
      for (const outcome of executorPlanOutcomes(plan)) options.onComplete?.(outcome);
      return plan;
    } finally {
      if (!options.adapter) await attached.close();
    }
  }

  const adapter = options.adapter ?? (await createExecutorAdapter({}));
  const managed: ManagedState = {
    version: 1,
    profile: profile.name,
    complete: false,
    operation: {
      status: "incomplete",
      desiredIntegrations: desired.integrations.map((server) => server.slug),
      startedAt: new Date().toISOString()
    },
    integrations: { ...previous.integrations }
  };
  await writeSnapshots(paths, profile.name, desired, managed, options.onComplete);
  await preflightReconciliation(adapter, desired.integrations, previous, {
    retainedSlugs: sharedOwnedSlugs
  });
  const checkpoint: ReconcileCheckpoint = async (slug) => {
    const server = desired.integrations.find((entry) => entry.slug === slug);
    if (!server) return;
    managed.integrations[slug] = {
      digest: executorConfigDigest(server),
      lastReconciledAt: new Date().toISOString(),
      connections: { ...server.connections }
    };
    await writeSnapshots(paths, profile.name, desired, managed, options.onComplete);
  };
  for (const server of desired.integrations) {
    await reconcileServer(adapter, server, result, checkpoint, options.onComplete);
    await ensureDeclaredConnection(adapter, server, result, checkpoint, options.onComplete);
    await checkpoint(server.slug);
  }

  for (const slug of Object.keys(previous.integrations)) {
    if (desired.integrations.some((server) => server.slug === slug)) continue;
    if (sharedOwnedSlugs.has(slug)) {
      result.retained.push(slug);
      delete managed.integrations[slug];
      options.onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "unchanged",
        target: slug,
        significance: "meaningful",
        detail: "retained by another profile"
      });
      await writeSnapshots(paths, profile.name, desired, managed, options.onComplete);
      continue;
    }
    const current = await adapter.getIntegration(slug);
    if (!current) continue;
    const removal = classifyExecutorRemoval(slug, current, await adapter.listConnections(slug));
    if (removal.blockers.length > 0) throw new Error(removal.blockers[0]);
    await adapter.removeIntegration(slug);
    result.removed.push(slug);
    options.onComplete?.({
      category: "executor",
      action: "reconcile",
      status: "removed",
      target: slug,
      significance: "meaningful"
    });
    delete managed.integrations[slug];
    await writeSnapshots(paths, profile.name, desired, managed, options.onComplete);
  }

  if (result.requiredConnections.length > 0) {
    for (const connection of result.requiredConnections) {
      options.onComplete?.({
        category: "executor",
        action: "reconcile",
        status: "blocked",
        target: connectionKey(connection.integration, connection.name),
        significance: "meaningful",
        detail: `${connection.authentication} connection ${connection.reason}`
      });
    }
    throw new Error(requiredConnectionsMessage(result.requiredConnections));
  }

  managed.complete = true;
  if (managed.operation) managed.operation.status = "complete";
  await writeSnapshots(paths, profile.name, desired, managed, options.onComplete);
  return result;
}

function executorPlanOutcomes(result: ExecutorReconcileResult | undefined): OperationOutcome[] {
  if (!result) return [];
  const outcomes: OperationOutcome[] = [];
  const add = (
    status: OperationOutcome["status"],
    target: string,
    detail?: string,
    plannedEffect?: PlannedOperationEffect
  ) => {
    const outcome: OperationOutcome = {
      category: "executor",
      action: "reconcile",
      status,
      target,
      significance: "meaningful"
    };
    if (detail) outcome.detail = detail;
    if (plannedEffect) outcome.plannedEffect = plannedEffect;
    outcomes.push(outcome);
  };
  for (const target of new Set(result.added)) add("planned", target, undefined, "add");
  for (const target of new Set(result.updated)) add("planned", target, undefined, "update");
  for (const target of new Set(result.reused)) add("unchanged", target);
  for (const target of new Set(result.removed)) add("planned", target, undefined, "remove");
  for (const target of new Set(result.retained))
    add("unchanged", target, "retained by another profile");
  for (const target of new Set(result.addedConnections))
    add("planned", target, "connection", "add");
  for (const target of new Set(result.reusedConnections)) add("unchanged", target, "connection");
  for (const connection of result.requiredConnections) {
    add(
      "blocked",
      connectionKey(connection.integration, connection.name),
      `${connection.authentication} connection ${connection.reason}`
    );
  }
  for (const blocker of result.blockers ?? []) add("blocked", "Executor", blocker);
  return outcomes;
}

function requiredConnection(
  server: ExecutorDesiredServer,
  connection: ExecutorConnectionClassification
): ExecutorRequiredConnection | undefined {
  if (
    !(
      (connection.kind === "missing" && connection.requiresConnection) ||
      connection.kind === "missing-oauth-scopes"
    )
  ) {
    return undefined;
  }
  const method = server.config.authenticationTemplate?.find(
    (candidate) => candidate.slug === connection.method
  );
  if (method?.kind !== "oauth2" && method?.kind !== "apikey") return undefined;
  return {
    integration: server.slug,
    name: connection.name,
    authentication: method.kind === "oauth2" ? "oauth" : "api-key",
    reason: connection.kind === "missing-oauth-scopes" ? "missing-oauth-scopes" : "missing"
  };
}

export function requiredConnectionsMessage(
  connections: readonly ExecutorRequiredConnection[]
): string {
  const entries = connections.map((connection) => {
    const authentication = connection.authentication === "oauth" ? "OAuth" : "API key";
    const action =
      connection.reason === "missing-oauth-scopes" ? "; reconnect for required scopes" : "";
    return `- ${connection.integration}: connection name "${connection.name}" (${authentication}${action})`;
  });
  return [
    "Add or update these connections in the Executor app before applying:",
    ...entries,
    "Use the exact connection names shown, then rerun mfz apply."
  ].join("\n");
}

export function executorPlanSummary(result: ExecutorReconcileResult | undefined): string {
  if (!result) return "no Executor routes";
  const actions = [
    ...result.added.map((name) => `add ${name}`),
    ...result.updated.map((name) => `update ${name}`),
    ...result.removed.map((name) => `remove ${name}`),
    ...result.retained.map((name) => `retain ${name} (shared snapshot)`),
    ...result.reused.map((name) => `reuse ${name}`),
    ...result.addedConnections.map((name) => `add connection ${name}`),
    ...result.reusedConnections.map((name) => `reuse connection ${name}`),
    ...result.requiredConnections.map(
      (connection) =>
        `requires ${connection.authentication} connection ${connection.integration}/${connection.name}`
    )
  ];
  const summary = actions.length > 0 ? actions.join(", ") : "no Executor changes";
  const planning =
    result.planning === "managed-digest-only"
      ? " (managed digest only; live state not checked)"
      : result.planning === "metadata-unavailable"
        ? " (live state unavailable; health and durable state unknown)"
        : result.planning === "live-metadata-unverified"
          ? " (metadata attached; health was not refreshed in dry-run)"
          : "";
  const blockers =
    result.blockers && result.blockers.length > 0
      ? `; blockers: ${result.blockers.join("; ")}`
      : "";
  return `${summary}${planning}${blockers}`;
}
