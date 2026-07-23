import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { executorDesiredPath, executorManagedPath, type RuntimePaths } from "../core/paths.js";
import { pathExists } from "../core/fs-util.js";
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
  operation?: {
    status: "incomplete" | "complete";
    desiredIntegrations: string[];
    startedAt: string;
  };
  integrations: Record<
    string,
    { digest: string; lastReconciledAt: string; connections?: Record<string, string> }
  >;
}

const managedStateSchema = z.object({
  version: z.literal(1),
  profile: z.string(),
  complete: z.boolean().optional(),
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
    return { ...parsed, complete: parsed.complete === true } as ManagedState;
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

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function writeSnapshots(
  paths: RuntimePaths,
  profileName: string,
  desired: ExecutorDesiredState,
  managed: ManagedState
): Promise<void> {
  await writeJsonAtomic(executorDesiredPath(paths, profileName), desired);
  await writeJsonAtomic(executorManagedPath(paths, profileName), managed);
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
  checkpoint: ReconcileCheckpoint
): Promise<void> {
  let current = await adapter.getIntegration(desired.slug);
  if (!current) {
    await adapter.addServer(desired);
    await checkpoint(desired.slug);
    result.added.push(desired.slug);
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
      await checkpoint(desired.slug);
      result.updated.push(desired.slug);
      changed = true;
    }
    if (classification.configurationChanged) {
      const serverConfig = Object.fromEntries(
        Object.entries(desired.config).filter(([key]) => key !== "authenticationTemplate")
      );
      await adapter.configureServer(desired.slug, serverConfig);
      await checkpoint(desired.slug);
      result.updated.push(desired.slug);
      changed = true;
      current = (await adapter.getIntegration(desired.slug)) ?? current;
    }
    if (classification.authenticationChanged) {
      const methods = desired.config.authenticationTemplate ?? [{ slug: "none", kind: "none" }];
      await adapter.configureAuth(desired.slug, methods, "replace");
      await checkpoint(desired.slug);
      result.updated.push(desired.slug);
      changed = true;
    }
    if (!changed) result.reused.push(desired.slug);
  }
}

async function ensureDeclaredConnection(
  adapter: ExecutorAdapter,
  server: ExecutorDesiredServer,
  result: ExecutorReconcileResult,
  checkpoint: ReconcileCheckpoint
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
      await checkpoint(server.slug);
      result.addedConnections.push(connectionKey(server.slug, connection.name));
    }
  }
  if (classification.blockers.length > 0) throw new Error(classification.blockers[0]);
  for (const connection of classification.connections) {
    const required = requiredConnection(server, connection);
    if (required) result.requiredConnections.push(required);
    if (connection.kind === "compatible") {
      result.reusedConnections.push(connectionKey(server.slug, connection.name));
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
      return {
        ...digestPlan,
        planning: "metadata-unavailable",
        blockers: ["live Executor metadata unavailable; health and durable state are unknown"]
      };
    }
    try {
      return await planExecutorWithMetadata(attached, desired, digestPlan);
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
  await writeSnapshots(paths, profile.name, desired, managed);
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
    await writeSnapshots(paths, profile.name, desired, managed);
  };
  for (const server of desired.integrations) {
    await reconcileServer(adapter, server, result, checkpoint);
    await ensureDeclaredConnection(adapter, server, result, checkpoint);
    await checkpoint(server.slug);
  }

  for (const slug of Object.keys(previous.integrations)) {
    if (desired.integrations.some((server) => server.slug === slug)) continue;
    if (sharedOwnedSlugs.has(slug)) {
      result.retained.push(slug);
      delete managed.integrations[slug];
      await writeSnapshots(paths, profile.name, desired, managed);
      continue;
    }
    const current = await adapter.getIntegration(slug);
    if (!current) continue;
    const removal = classifyExecutorRemoval(slug, current, await adapter.listConnections(slug));
    if (removal.blockers.length > 0) throw new Error(removal.blockers[0]);
    await adapter.removeIntegration(slug);
    result.removed.push(slug);
    delete managed.integrations[slug];
    await writeSnapshots(paths, profile.name, desired, managed);
  }

  if (result.requiredConnections.length > 0) {
    throw new Error(requiredConnectionsMessage(result.requiredConnections));
  }

  managed.complete = true;
  if (managed.operation) managed.operation.status = "complete";
  await writeSnapshots(paths, profile.name, desired, managed);
  return result;
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
