import { execa } from "execa";
import { pathExists } from "../core/fs-util.js";
import { executorDataDir, executorManagedPath, type RuntimePaths } from "../core/paths.js";
import { executorMcpServers, type ResolvedProfile } from "../core/profile.js";
import { attachExecutorAdapter } from "./adapter.js";
import { buildExecutorDesiredState } from "./model.js";
import { readManagedState, type ManagedState } from "./reconcile.js";
import { classifyExecutorIntegration, classifyExecutorRemoval } from "./lifecycle.js";

export type ExecutorRuntimeStatus = "not-required" | "absent" | "unavailable" | "attachable";
export type ExecutorManagedStatus = "absent" | "invalid" | "incomplete" | "complete";

export interface ExecutorDiagnosticConnection {
  integration: string;
  name: string;
  authentication: string;
  health: string;
  missingOAuthScopes: string[];
}

export interface ExecutorDiagnostic {
  required: boolean;
  profile: string;
  installedVersion: string;
  dataDir: string;
  runtime: ExecutorRuntimeStatus;
  managed: ExecutorManagedStatus;
  connections: ExecutorDiagnosticConnection[];
  blockers: string[];
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
  const dataDir = executorDataDir();
  const managedFilePresent = await pathExists(executorManagedPath(paths, profile.name));
  const managed = await readManagedState(paths, profile.name);
  const active = required || managedFilePresent;
  const diagnostic: ExecutorDiagnostic = {
    required,
    profile: profile.name,
    installedVersion: active
      ? await installedVersion(options.binary ?? "executor")
      : "not required",
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

  const adapter = await attachExecutorAdapter(options.fetch ? { fetch: options.fetch } : {});
  if (!adapter) {
    diagnostic.runtime = (await pathExists(dataDir)) ? "unavailable" : "absent";
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
      const classification = classifyExecutorIntegration(integration, {
        current,
        connections: current ? await adapter.listConnections(integration.slug) : []
      });
      if (!classification.current) {
        diagnostic.blockers.push(`Executor integration ${integration.slug} is not registered`);
      }
      for (const connection of classification.connections) {
        const observed = connection.kind === "missing" ? undefined : connection.connection;
        diagnostic.connections.push({
          integration: integration.slug,
          name: connection.name,
          authentication: connection.method,
          health: observed?.lastHealth?.status ?? "missing",
          missingOAuthScopes: observed ? [...observed.missingOAuthScopes] : []
        });
      }
      for (const connection of classification.undeclaredDurableConnections) {
        diagnostic.connections.push({
          integration: integration.slug,
          name: connection.name,
          authentication: connection.template,
          health: connection.lastHealth?.status ?? "unknown",
          missingOAuthScopes: [...connection.missingOAuthScopes]
        });
      }
      diagnostic.blockers.push(...classification.blockers);
    }
    for (const slug of Object.keys(managed?.integrations ?? {})) {
      if (desiredSlugs.has(slug)) continue;
      const current = await adapter.getIntegration(slug);
      if (!current) continue;
      const removal = classifyExecutorRemoval(slug, current, await adapter.listConnections(slug));
      diagnostic.blockers.push(...removal.blockers);
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
    `executor version\t${diagnostic.installedVersion}`,
    `executor data\t${diagnostic.dataDir}`,
    `executor runtime\t${diagnostic.runtime}\tmanaged ${diagnostic.managed}`,
    ...diagnostic.connections.map(
      (connection) =>
        `executor connection\t${connection.integration}/${connection.name}\tauth ${connection.authentication}\thealth ${connection.health}${
          connection.missingOAuthScopes.length > 0
            ? `\tmissing scopes ${connection.missingOAuthScopes.join(",")}`
            : ""
        }`
    ),
    ...diagnostic.blockers.map((blocker) => `executor blocker\t${blocker}`)
  ];
}
