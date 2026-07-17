import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { executorDesiredPath, executorManagedPath, type RuntimePaths } from "../core/paths.js";
import { fileExists } from "../core/fs-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  createExecutorAdapter,
  attachExecutorAdapter,
  type ExecutorAdapter,
  type ExecutorIntegration
} from "./adapter.js";
import {
  buildExecutorDesiredState,
  executorConfigDigest,
  type ExecutorDesiredServer,
  type ExecutorDesiredState
} from "./model.js";

export interface ManagedState {
  version: 1;
  profile: string;
  complete?: boolean;
  integrations: Record<string, { digest: string; lastReconciledAt: string }>;
}

const managedStateSchema = z.object({
  version: z.literal(1),
  profile: z.string(),
  complete: z.boolean().optional(),
  integrations: z.record(
    z.string(),
    z.object({ digest: z.string(), lastReconciledAt: z.string() }).strict()
  )
});

export interface ExecutorReconcileResult {
  desired: ExecutorDesiredState;
  added: string[];
  updated: string[];
  reused: string[];
  removed: string[];
  planning?: "managed-digest-only" | "metadata-unavailable" | "live-metadata-unverified";
  blockers?: string[];
}

export async function readManagedState(
  paths: RuntimePaths,
  profileName: string
): Promise<ManagedState | undefined> {
  try {
    return managedStateSchema.parse(
      JSON.parse(await readFile(executorManagedPath(paths, profileName), "utf8"))
    ) as ManagedState;
  } catch {
    return undefined;
  }
}

async function readManaged(paths: RuntimePaths, profileName: string): Promise<ManagedState> {
  return (
    (await readManagedState(paths, profileName)) ?? {
      version: 1,
      profile: profileName,
      integrations: {}
    }
  );
}

export async function hasManagedExecutorState(
  paths: RuntimePaths,
  profileName: string
): Promise<boolean> {
  return fileExists(executorManagedPath(paths, profileName));
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function integrationConfig(integration: ExecutorIntegration): Record<string, unknown> {
  return integration.config;
}

function authTemplates(config: Record<string, unknown>): unknown[] {
  const templates = config.authenticationTemplate;
  return Array.isArray(templates) ? templates : [];
}

function hasDurableState(
  connections: readonly {
    template: string;
    provider?: string | null;
    oauthClient?: string | null;
    oauthScope?: string | null;
    expiresAt?: number | null;
  }[]
): boolean {
  return connections.some(
    (connection) =>
      connection.template !== "none" ||
      (connection.provider !== "" && connection.provider !== "none") ||
      connection.oauthClient != null ||
      connection.oauthScope != null ||
      connection.expiresAt != null
  );
}

const dangerousConfigFields = [
  "transport",
  "endpoint",
  "resource",
  "remoteTransport",
  "command",
  "args",
  "env"
] as const;

function changedDangerousConfigFields(
  current: Record<string, unknown>,
  desired: Record<string, unknown>
): string[] {
  return dangerousConfigFields.filter((field) => !sameJson(current[field], desired[field]));
}

function normalizedScopes(value: string): string {
  return value.split(/\s+/).filter(Boolean).sort().join(" ");
}

function changedOAuthScopes(
  connections: readonly { oauthScope?: string | null }[],
  desired: ExecutorDesiredServer
): boolean {
  if (!desired.oauth) return false;
  const requested = normalizedScopes(desired.oauth.scopes.join(" "));
  return connections.some(
    (connection) =>
      connection.oauthScope != null && normalizedScopes(connection.oauthScope) !== requested
  );
}

function desiredTemplates(server: ExecutorDesiredServer): unknown[] {
  return authTemplates(server.config as unknown as Record<string, unknown>);
}

function templatesChanged(
  integration: ExecutorIntegration,
  desired: ExecutorDesiredServer
): boolean {
  return !sameJson(authTemplates(integrationConfig(integration)), desiredTemplates(desired));
}

function emptyResult(desired: ExecutorDesiredState): ExecutorReconcileResult {
  return { desired, added: [], updated: [], reused: [], removed: [] };
}

export function planExecutor(
  desired: ExecutorDesiredState,
  previous: ManagedState
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
    removed: Object.keys(previous.integrations).filter((slug) => !desiredSlugs.has(slug)),
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
  const blockers: string[] = [];

  for (const server of desired.integrations) {
    const current = await adapter.getIntegration(server.slug);
    if (!current) {
      added.add(server.slug);
      updated.delete(server.slug);
      reused.delete(server.slug);
      continue;
    }
    const currentConfig = integrationConfig(current);
    const desiredConfig = server.config as unknown as Record<string, unknown>;
    const connections = await adapter.listConnections(server.slug);
    const durable = hasDurableState(connections);
    const dangerous = changedDangerousConfigFields(currentConfig, desiredConfig);
    if (durable && dangerous.length > 0) {
      blockers.push(
        `Executor ${server.slug} has durable state and changed metadata: ${dangerous.join(", ")}`
      );
    }
    if (durable && templatesChanged(current, server)) {
      blockers.push(`Executor ${server.slug} has a durable auth-template change`);
    }
    if (durable && changedOAuthScopes(connections, server)) {
      blockers.push(`Executor ${server.slug} has a durable OAuth scope change`);
    }
    const main = connections.find(
      (connection) => connection.owner === "user" && connection.name === "main"
    );
    if (!main && server.oauth) {
      blockers.push(`Executor OAuth authorization is required for ${server.slug}`);
    }
    if (main && server.oauth && main.missingOAuthScopes.length > 0) {
      blockers.push(`Executor ${server.slug}/main is missing required OAuth scopes`);
    }
    const configChanged = !sameJson(
      { ...currentConfig, authenticationTemplate: undefined },
      { ...desiredConfig, authenticationTemplate: undefined }
    );
    if (
      configChanged ||
      current.description !== server.description ||
      templatesChanged(current, server)
    ) {
      updated.add(server.slug);
      reused.delete(server.slug);
    } else {
      reused.add(server.slug);
      added.delete(server.slug);
      updated.delete(server.slug);
    }
  }

  for (const slug of base.removed) {
    const current = await adapter.getIntegration(slug);
    if (!current) {
      removed.delete(slug);
      continue;
    }
    const connections = await adapter.listConnections(slug);
    if (hasDurableState(connections)) {
      blockers.push(
        `Executor ${slug} has durable state and requires explicit disconnect before removal`
      );
    }
  }

  return {
    ...base,
    added: [...added],
    updated: [...updated],
    reused: [...reused],
    removed: [...removed],
    planning: "live-metadata-unverified",
    blockers
  };
}

async function preflightReconciliation(
  adapter: ExecutorAdapter,
  desired: readonly ExecutorDesiredServer[],
  previous: ManagedState
): Promise<void> {
  for (const server of desired) {
    const current = await adapter.getIntegration(server.slug);
    if (!current) continue;
    const connections = await adapter.listConnections(server.slug);
    const currentConfig = integrationConfig(current);
    const desiredConfig = server.config as unknown as Record<string, unknown>;
    const durable = hasDurableState(connections);
    const dangerous = changedDangerousConfigFields(currentConfig, desiredConfig);
    if (durable && dangerous.length > 0) {
      throw new Error(
        `Executor ${server.slug} has durable connection state; refusing dangerous configuration changes: ${dangerous.join(", ")}`
      );
    }
    if (templatesChanged(current, server) && durable) {
      throw new Error(
        `Executor auth-template change for ${server.slug} would strand existing connection state; disconnect it explicitly before applying`
      );
    }
    if (durable && changedOAuthScopes(connections, server)) {
      throw new Error(
        `Executor OAuth scope change for ${server.slug} would strand existing connection state; disconnect it explicitly before applying`
      );
    }
  }

  const desiredSlugs = new Set(desired.map((server) => server.slug));
  for (const slug of Object.keys(previous.integrations)) {
    if (desiredSlugs.has(slug)) continue;
    const current = await adapter.getIntegration(slug);
    if (!current) continue;
    if (hasDurableState(await adapter.listConnections(slug))) {
      throw new Error(
        `Executor integration ${slug} has durable connection state; disconnect it explicitly before removing it from the profile`
      );
    }
  }
}

async function assertNonInteractiveOAuthReady(
  adapter: ExecutorAdapter,
  desired: readonly ExecutorDesiredServer[]
): Promise<void> {
  for (const server of desired) {
    if (!server.oauth) continue;
    const current = await adapter.getIntegration(server.slug);
    if (!current) {
      throw new Error(
        `Executor OAuth authorization is required for ${server.slug}; rerun apply interactively`
      );
    }
    const connection = (await adapter.listConnections(server.slug)).find(
      (item) => item.owner === "user" && item.name === "main"
    );
    if (!connection || connection.missingOAuthScopes.length > 0) {
      throw new Error(
        `Executor OAuth authorization is required for ${server.slug}; rerun apply interactively`
      );
    }
  }
}

async function reconcileServer(
  adapter: ExecutorAdapter,
  desired: ExecutorDesiredServer,
  result: ExecutorReconcileResult,
  interactive: boolean
): Promise<void> {
  let current = await adapter.getIntegration(desired.slug);
  if (!current) {
    await adapter.addServer(desired);
    result.added.push(desired.slug);
    current = await adapter.getIntegration(desired.slug);
    if (!current) throw new Error(`Executor registered ${desired.slug} but could not read it back`);
  } else {
    let mustRefresh = false;
    if (current.description !== desired.description) {
      await adapter.updateIntegration(desired.slug, { description: desired.description });
      result.updated.push(desired.slug);
      mustRefresh = true;
    }
    const currentConfig = integrationConfig(current);
    const desiredConfig = desired.config as unknown as Record<string, unknown>;
    const currentTemplates = authTemplates(currentConfig);
    const nextTemplates = desiredTemplates(desired);
    const templateChanged = !sameJson(currentTemplates, nextTemplates);
    const configChanged = !sameJson(
      { ...currentConfig, authenticationTemplate: undefined },
      { ...desiredConfig, authenticationTemplate: undefined }
    );
    const connections = await adapter.listConnections(desired.slug);
    const durable = hasDurableState(connections);
    const dangerous = changedDangerousConfigFields(currentConfig, desiredConfig);
    if (durable && dangerous.length > 0) {
      throw new Error(
        `Executor ${desired.slug} has durable connection state; refusing dangerous configuration changes: ${dangerous.join(", ")}`
      );
    }
    if (templateChanged && durable) {
      throw new Error(
        `Executor auth-template change for ${desired.slug} would strand existing connection state; disconnect it explicitly before applying`
      );
    }
    if (durable && changedOAuthScopes(connections, desired)) {
      throw new Error(
        `Executor OAuth scope change for ${desired.slug} would strand existing connection state; disconnect it explicitly before applying`
      );
    }
    if (configChanged) {
      await adapter.configureServer(desired.slug, desiredConfig);
      result.updated.push(desired.slug);
      mustRefresh = true;
      current = (await adapter.getIntegration(desired.slug)) ?? current;
    }
    if (templateChanged) {
      await adapter.configureAuth(desired.slug, nextTemplates, "replace");
      result.updated.push(desired.slug);
      mustRefresh = true;
    }
    if (mustRefresh && connections.length > 0) {
      const existingConnection = connections.find(
        (item) => item.owner === "user" && item.name === "main"
      );
      if (existingConnection) await adapter.refreshConnection(desired.slug, "main");
    }
  }

  const connections = await adapter.listConnections(desired.slug);
  const connectionName = "main";
  let connection = connections.find(
    (item) => item.owner === "user" && item.name === connectionName
  );
  const hadConnection = connection !== undefined;
  if (!connection) {
    if (desired.oauth) {
      await adapter.authorizeOAuth({
        integration: desired.slug,
        endpoint: desired.config.transport === "remote" ? desired.config.endpoint : desired.slug,
        name: connectionName,
        template: desired.oauth.template,
        scopes: desired.oauth.scopes,
        interactive
      });
    } else {
      await adapter.createNoAuthConnection(desired.slug, connectionName);
    }
    connection = (await adapter.listConnections(desired.slug)).find(
      (item) => item.owner === "user" && item.name === connectionName
    );
  }
  if (!connection)
    throw new Error(`Executor connection ${desired.slug}/${connectionName} was not created`);
  if (desired.oauth && connection.missingOAuthScopes.length > 0) {
    throw new Error(
      `Executor connection ${desired.slug}/${connectionName} is missing required OAuth scopes; authorize it again in Executor`
    );
  }
  const health = await adapter.checkHealth(desired.slug, connectionName);
  if (health.status !== "healthy") {
    throw new Error(
      `Executor connection ${desired.slug}/${connectionName} is not healthy: ${health.status}`
    );
  }
  if (desired.oauth && (health.missingOAuthScopes?.length ?? 0) > 0) {
    throw new Error(
      `Executor connection ${desired.slug}/${connectionName} is missing required OAuth scopes; authorize it again in Executor`
    );
  }
  if (hadConnection) result.reused.push(desired.slug);
}

export async function reconcileExecutor(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: { dryRun?: boolean; interactive?: boolean; adapter?: ExecutorAdapter } = {}
): Promise<ExecutorReconcileResult | undefined> {
  const desired = buildExecutorDesiredState(profile, paths.home);
  const managedFilePresent = await fileExists(executorManagedPath(paths, profile.name));
  const previous = await readManaged(paths, profile.name);
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
    const digestPlan = planExecutor(desired, previous);
    const attached =
      options.adapter ?? (await attachExecutorAdapter({ paths, profileName: profile.name }));
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

  const adapter =
    options.adapter ?? (await createExecutorAdapter({ paths, profileName: profile.name }));
  const managed: ManagedState = {
    version: 1,
    profile: profile.name,
    complete: false,
    integrations: { ...previous.integrations }
  };
  if (!options.interactive) await assertNonInteractiveOAuthReady(adapter, desired.integrations);
  await preflightReconciliation(adapter, desired.integrations, previous);
  for (const server of desired.integrations) {
    await reconcileServer(
      adapter,
      server,
      result,
      options.interactive ?? Boolean(process.stdin.isTTY)
    );
    managed.integrations[server.slug] = {
      digest: executorConfigDigest(server),
      lastReconciledAt: new Date().toISOString()
    };
    await writeSnapshots(paths, profile.name, desired, managed);
  }

  for (const slug of Object.keys(previous.integrations)) {
    if (desired.integrations.some((server) => server.slug === slug)) continue;
    const current = await adapter.getIntegration(slug);
    if (!current) continue;
    const connections = await adapter.listConnections(slug);
    if (hasDurableState(connections)) {
      throw new Error(
        `Executor integration ${slug} has durable connection state; disconnect it explicitly before removing it from the profile`
      );
    }
    await adapter.removeIntegration(slug);
    result.removed.push(slug);
    delete managed.integrations[slug];
    await writeSnapshots(paths, profile.name, desired, managed);
  }

  managed.complete = true;
  await writeSnapshots(paths, profile.name, desired, managed);
  return result;
}

export function executorPlanSummary(result: ExecutorReconcileResult | undefined): string {
  if (!result) return "no Executor routes";
  const actions = [
    ...result.added.map((name) => `add ${name}`),
    ...result.updated.map((name) => `update ${name}`),
    ...result.removed.map((name) => `remove ${name}`),
    ...result.reused.map((name) => `reuse ${name}`)
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
