import { execa } from "execa";
import { fileExists } from "../core/fs-util.js";
import {
  executorDataDir,
  executorManagedPath,
  executorScopeDir,
  type RuntimePaths
} from "../core/paths.js";
import { executorMcpServers, type ResolvedProfile } from "../core/profile.js";
import { executorVersion, attachExecutorAdapter, type ExecutorConnection } from "./adapter.js";
import { buildExecutorDesiredState } from "./model.js";
import { readManagedState, type ManagedState } from "./reconcile.js";

export type ExecutorRuntimeStatus = "not-required" | "absent" | "unavailable" | "attachable";
export type ExecutorManagedStatus = "absent" | "invalid" | "incomplete" | "complete";

export interface ExecutorDiagnosticConnection {
  integration: string;
  name: string;
  health: string;
  missingOAuthScopes: string[];
}

export interface ExecutorDiagnostic {
  required: boolean;
  profile: string;
  installedVersion: string;
  expectedVersion: string;
  scopeDir: string;
  dataDir: string;
  runtime: ExecutorRuntimeStatus;
  managed: ExecutorManagedStatus;
  connections: ExecutorDiagnosticConnection[];
  blockers: string[];
}

function durableConnection(connection: ExecutorConnection): boolean {
  return (
    connection.template !== "none" ||
    (connection.provider !== "" && connection.provider !== "none") ||
    connection.oauthClient !== null ||
    connection.oauthScope !== null ||
    connection.expiresAt !== null
  );
}

async function installedVersion(binary: string): Promise<string> {
  try {
    const result = await execa(binary, ["--version"], { reject: false });
    if (result.exitCode !== 0) return "missing";
    return result.stdout.trim() || "unknown";
  } catch {
    return "missing";
  }
}

function managedStatus(
  filePresent: boolean,
  state: ManagedState | undefined
): ExecutorManagedStatus {
  if (!filePresent) return "absent";
  if (!state) return "invalid";
  return state.complete === true ? "complete" : "incomplete";
}

export async function inspectExecutor(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: {
    binary?: string;
    fetch?: typeof globalThis.fetch;
  } = {}
): Promise<ExecutorDiagnostic> {
  const required = executorMcpServers(profile).length > 0;
  const dataDir = executorDataDir(paths, profile.name);
  const scopeDir = executorScopeDir(paths, profile.name);
  const managedFilePresent = await fileExists(executorManagedPath(paths, profile.name));
  const managed = await readManagedState(paths, profile.name);
  const active = required || managedFilePresent;
  const diagnostic: ExecutorDiagnostic = {
    required,
    profile: profile.name,
    installedVersion: active
      ? await installedVersion(options.binary ?? "executor")
      : "not required",
    expectedVersion: executorVersion,
    scopeDir,
    dataDir,
    runtime: active ? "absent" : "not-required",
    managed: managedStatus(managedFilePresent, managed),
    connections: [],
    blockers: []
  };
  if (diagnostic.managed === "invalid") {
    diagnostic.blockers.push("Executor managed state is unreadable and requires repair");
  }
  if (!active) return diagnostic;

  const adapter = await attachExecutorAdapter({
    paths,
    profileName: profile.name,
    ...(options.fetch ? { fetch: options.fetch } : {})
  });
  if (!adapter) {
    diagnostic.runtime = (await fileExists(dataDir)) ? "unavailable" : "absent";
    if (required || diagnostic.managed !== "absent") {
      diagnostic.blockers.push("Executor runtime is not attachable without starting a daemon");
    }
    return diagnostic;
  }

  diagnostic.runtime = "attachable";
  const desired = buildExecutorDesiredState(profile, paths.home);
  const desiredSlugs = new Set(desired.integrations.map((integration) => integration.slug));
  try {
    for (const integration of desired.integrations) {
      const current = await adapter.getIntegration(integration.slug);
      if (!current) {
        diagnostic.blockers.push(`Executor integration ${integration.slug} is not registered`);
        continue;
      }
      const connections = await adapter.listConnections(integration.slug);
      for (const connection of connections) {
        diagnostic.connections.push({
          integration: integration.slug,
          name: connection.name,
          health: connection.lastHealth?.status ?? "unknown",
          missingOAuthScopes: [...connection.missingOAuthScopes]
        });
        if (connection.missingOAuthScopes.length > 0) {
          diagnostic.blockers.push(
            `Executor connection ${integration.slug}/${connection.name} is missing OAuth scopes`
          );
        }
      }
    }
    for (const slug of Object.keys(managed?.integrations ?? {})) {
      if (desiredSlugs.has(slug)) continue;
      const current = await adapter.getIntegration(slug);
      if (!current) continue;
      const connections = await adapter.listConnections(slug);
      if (connections.some(durableConnection)) {
        diagnostic.blockers.push(
          `Executor integration ${slug} has durable state and requires explicit disconnect before removal`
        );
      }
    }
  } catch {
    diagnostic.blockers.push("Executor metadata could not be read safely");
  } finally {
    await adapter.close();
  }
  return diagnostic;
}

export function executorDiagnosticLines(diagnostic: ExecutorDiagnostic): string[] {
  if (!diagnostic.required && diagnostic.managed === "absent") return [];
  return [
    `executor version\t${diagnostic.installedVersion}\texpected ${diagnostic.expectedVersion}`,
    `executor scope\t${diagnostic.scopeDir}`,
    `executor data\t${diagnostic.dataDir}`,
    `executor runtime\t${diagnostic.runtime}\tmanaged ${diagnostic.managed}`,
    ...diagnostic.connections.map(
      (connection) =>
        `executor connection\t${connection.integration}/${connection.name}\thealth ${connection.health}${
          connection.missingOAuthScopes.length > 0
            ? `\tmissing scopes ${connection.missingOAuthScopes.join(",")}`
            : ""
        }`
    ),
    ...diagnostic.blockers.map((blocker) => `executor blocker\t${blocker}`)
  ];
}
