import type { ExecutorAuthenticationMethod } from "../core/manifests.js";
import {
  encodeExecutorAuthenticationMethod,
  type ExecutorConnection,
  type ExecutorIntegration
} from "./adapter.js";
import { executorConnectionHasDurableState, type ExecutorDesiredServer } from "./model.js";

export interface ObservedExecutorIntegration {
  current: ExecutorIntegration | null;
  connections: readonly ExecutorConnection[];
}

export type ExecutorConnectionClassification =
  | {
      kind: "missing";
      name: string;
      method: string;
      requiresConnection: boolean;
    }
  | {
      kind: "compatible";
      name: string;
      method: string;
      connection: ExecutorConnection;
      cachedHealth: string;
    }
  | {
      kind: "wrong-template";
      name: string;
      method: string;
      connection: ExecutorConnection;
    }
  | {
      kind: "missing-oauth-scopes";
      name: string;
      method: string;
      connection: ExecutorConnection;
    };

export interface ExecutorLifecycleClassification {
  integration: "missing" | "updated" | "reused";
  current: ExecutorIntegration | null;
  durable: boolean;
  descriptionChanged: boolean;
  configurationChanged: boolean;
  changedConfigurationFields: string[];
  authenticationChanged: boolean;
  connections: ExecutorConnectionClassification[];
  undeclaredDurableConnections: ExecutorConnection[];
  blockers: string[];
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function integrationConfig(integration: ExecutorIntegration): Record<string, unknown> {
  return integration.config;
}

function authTemplates(config: Record<string, unknown>): Record<string, unknown>[] {
  const templates = config.authenticationTemplate;
  return Array.isArray(templates)
    ? templates.filter(
        (template): template is Record<string, unknown> =>
          typeof template === "object" && template !== null
      )
    : [];
}

function desiredAuthTemplates(
  server: ExecutorDesiredServer
): readonly ExecutorAuthenticationMethod[] {
  return server.config.authenticationTemplate ?? [{ slug: "none", kind: "none" }];
}

function changedConfigurationFields(
  current: Record<string, unknown>,
  desired: Record<string, unknown>
): string[] {
  return dangerousConfigFields.filter((field) => !sameJson(current[field], desired[field]));
}

function currentManagedConnection(
  desired: ExecutorDesiredServer,
  connections: readonly ExecutorConnection[],
  name: string,
  method: string
): ExecutorConnection | undefined {
  const userConnection = connections.find(
    (connection) => connection.owner === "user" && connection.name === name
  );
  if (userConnection) return userConnection;
  if (desired.config.transport !== "stdio" || name !== "default" || method !== "none") {
    return undefined;
  }
  return connections.find((connection) => connection.owner === "org" && connection.name === name);
}

function connectionKey(integration: string, name: string): string {
  return `${integration}/${name}`;
}

function authTemplateChangedForDurableConnection(
  current: ExecutorIntegration,
  desired: ExecutorDesiredServer,
  connections: readonly ExecutorConnection[]
): boolean {
  const currentBySlug = new Map(
    authTemplates(integrationConfig(current)).map((method) => [method.slug, method])
  );
  const desiredBySlug = new Map(
    desiredAuthTemplates(desired).map((method) => [
      method.slug,
      encodeExecutorAuthenticationMethod(method)
    ])
  );
  return [...new Set(connections.map((connection) => connection.template))].some(
    (slug) =>
      !desiredBySlug.has(slug) || !sameJson(currentBySlug.get(slug), desiredBySlug.get(slug))
  );
}

export function classifyExecutorIntegration(
  desired: ExecutorDesiredServer,
  observed: ObservedExecutorIntegration,
  options: {
    requireCredentialedConnections?: boolean;
    allowConnectionRepair?: boolean;
  } = {}
): ExecutorLifecycleClassification {
  const current = observed.current;
  const desiredConfig = desired.config as unknown as Record<string, unknown>;
  const requireCredentialedConnections = options.requireCredentialedConnections ?? true;
  const allowConnectionRepair = options.allowConnectionRepair ?? false;
  const durable = observed.connections.some(executorConnectionHasDurableState);
  const descriptionChanged = current?.description !== desired.description;
  const currentConfig = current ? integrationConfig(current) : {};
  const changedFields = current ? changedConfigurationFields(currentConfig, desiredConfig) : [];
  const configurationChanged = current
    ? !sameJson(
        { ...currentConfig, authenticationTemplate: undefined },
        { ...desiredConfig, authenticationTemplate: undefined }
      )
    : true;
  const authenticationChanged = current
    ? !sameJson(
        authTemplates(currentConfig),
        desiredAuthTemplates(desired).map(encodeExecutorAuthenticationMethod)
      )
    : true;
  const connections: ExecutorConnectionClassification[] = Object.entries(desired.connections).map(
    ([name, method]) => {
      const connection = currentManagedConnection(desired, observed.connections, name, method);
      if (!connection) {
        return {
          kind: "missing",
          name,
          method,
          requiresConnection: method !== "none"
        };
      }
      if (connection.template !== method) {
        return { kind: "wrong-template", name, method, connection };
      }
      const authentication = desiredAuthTemplates(desired).find((entry) => entry.slug === method);
      const missingDeclaredScopes =
        authentication?.kind === "oauth2"
          ? connection.missingOAuthScopes.filter((scope) =>
              authentication.registrationScopes?.includes(scope)
            )
          : [];
      if (missingDeclaredScopes.length > 0) {
        return { kind: "missing-oauth-scopes", name, method, connection };
      }
      return {
        kind: "compatible",
        name,
        method,
        connection,
        cachedHealth: connection.lastHealth?.status ?? "unknown"
      };
    }
  );
  const undeclaredDurableConnections = observed.connections.filter(
    (connection) =>
      desired.connections[connection.name] === undefined &&
      executorConnectionHasDurableState(connection)
  );
  const blockers: string[] = [];

  if (current && durable && changedFields.length > 0) {
    blockers.push(
      `Executor ${desired.slug} has durable state and changed metadata: ${changedFields.join(", ")}`
    );
  }
  if (current && authTemplateChangedForDurableConnection(current, desired, observed.connections)) {
    blockers.push(
      `Executor ${desired.slug} has a durable auth-template change; disconnect referenced connections before applying`
    );
  }
  for (const connection of connections) {
    if (connection.kind === "wrong-template") {
      blockers.push(
        `Executor connection ${connectionKey(desired.slug, connection.name)} binds ${connection.connection.template}, but the profile selects ${connection.method}; explicitly clean up or repair that named connection before applying`
      );
    }
    if (connection.kind === "missing-oauth-scopes" && !allowConnectionRepair) {
      blockers.push(
        `Executor connection ${connectionKey(desired.slug, connection.name)} is missing OAuth scopes; run mfz executor connect ${desired.slug} --connection ${connection.name}`
      );
    }
    if (
      connection.kind === "missing" &&
      connection.requiresConnection &&
      requireCredentialedConnections
    ) {
      blockers.push(
        `Executor connection is required for ${connectionKey(desired.slug, connection.name)}; run mfz executor connect ${desired.slug} --connection ${connection.name}`
      );
    }
  }
  for (const connection of undeclaredDurableConnections) {
    blockers.push(
      `Executor connection ${connectionKey(desired.slug, connection.name)} is durable but not declared; explicitly disconnect that named connection before removing it from the profile`
    );
  }

  return {
    integration: current
      ? descriptionChanged || configurationChanged || authenticationChanged
        ? "updated"
        : "reused"
      : "missing",
    current,
    durable,
    descriptionChanged,
    configurationChanged,
    changedConfigurationFields: changedFields,
    authenticationChanged,
    connections,
    undeclaredDurableConnections,
    blockers
  };
}

export function classifyExecutorRemoval(
  slug: string,
  current: ExecutorIntegration | null,
  connections: readonly ExecutorConnection[]
): { removable: boolean; blockers: string[] } {
  if (!current) return { removable: false, blockers: [] };
  if (connections.some(executorConnectionHasDurableState)) {
    return {
      removable: false,
      blockers: [
        `Executor integration ${slug} has durable connection state; disconnect it explicitly before removing it from the profile`
      ]
    };
  }
  return { removable: true, blockers: [] };
}
