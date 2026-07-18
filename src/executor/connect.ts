import type { RuntimePaths } from "../core/paths.js";
import type { ExecutorAuthenticationMethod } from "../core/manifests.js";
import type { ResolvedProfile } from "../core/profile.js";
import { createExecutorAdapter, type ExecutorAdapter, type ExecutorConnection } from "./adapter.js";
import { executorConnectionAddress } from "./contract.js";
import { buildExecutorDesiredState, executorAuthentication } from "./model.js";
import { ensureExecutorIntegration } from "./reconcile.js";

interface ConnectOptions {
  adapter?: ExecutorAdapter;
  interactive?: boolean;
  method?: string;
  connection?: string;
  repair?: boolean;
}

function chooseMethod(
  methods: readonly ExecutorAuthenticationMethod[],
  requested: string | undefined,
  integration: string
): ExecutorAuthenticationMethod {
  if (requested) {
    const method = methods.find((entry) => entry.slug === requested);
    if (!method) {
      throw new Error(
        `Executor integration ${integration} has no authentication method ${requested}`
      );
    }
    return method;
  }
  if (methods.length === 1) return methods[0]!;
  const oauth = methods.find((entry) => entry.kind === "oauth2");
  if (oauth) return oauth;
  throw new Error(
    `Executor integration ${integration} has multiple authentication methods; choose one with --method (${methods.map((entry) => entry.slug).join(", ")})`
  );
}

function connectionFor(
  connections: readonly ExecutorConnection[],
  integration: string,
  method: ExecutorAuthenticationMethod,
  name: string,
  allowOrganizationDefault = false,
  identityLabel?: string
): ExecutorConnection | undefined {
  return connections.find(
    (connection) =>
      (connection.owner === "user" || (allowOrganizationDefault && connection.owner === "org")) &&
      connection.name === name &&
      connection.template === method.slug &&
      connection.integration === integration &&
      connection.address === executorConnectionAddress(connection.owner, integration, name) &&
      (identityLabel === undefined || connection.identityLabel === identityLabel)
  );
}

async function waitForConnection(
  adapter: ExecutorAdapter,
  integration: string,
  method: ExecutorAuthenticationMethod,
  name: string,
  identityLabel: string,
  allowOrganizationDefault = false,
  timeoutMs = 120_000
): Promise<ExecutorConnection> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connection = connectionFor(
      await adapter.listConnections(integration),
      integration,
      method,
      name,
      allowOrganizationDefault,
      identityLabel
    );
    if (connection?.identityLabel !== identityLabel) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (connection) return connection;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Executor connection ${integration}/${name} was not completed before the timeout`
  );
}

function apiKeyHandoffGeneration(integration: string, connection: string): { label: string } {
  return { label: connection };
}

async function verifyConnection(
  adapter: ExecutorAdapter,
  integration: string,
  connection: ExecutorConnection,
  allowOrganizationDefault = false
): Promise<number> {
  if (
    (connection.owner !== "user" && !(allowOrganizationDefault && connection.owner === "org")) ||
    connection.integration !== integration ||
    connection.address !== executorConnectionAddress(connection.owner, integration, connection.name)
  ) {
    throw new Error(
      `Executor connection ${integration}/${connection.name} returned an invalid selected-connection identity`
    );
  }
  const health = await adapter.checkHealth(integration, connection.name);
  if (health.status !== "healthy") {
    throw new Error(
      `Executor connection ${integration}/${connection.name} is not healthy: ${health.status}`
    );
  }
  const tools = await adapter.refreshConnection(integration, connection.name);
  if (tools.length === 0) {
    throw new Error(`Executor connection ${integration}/${connection.name} exposed no tools`);
  }
  const mismatched = tools.find(
    (tool) =>
      tool.owner !== connection.owner ||
      tool.integration !== integration ||
      tool.connection !== connection.name ||
      !tool.address.startsWith(
        `${executorConnectionAddress(connection.owner, integration, connection.name)}.`
      )
  );
  if (mismatched) {
    throw new Error(
      `Executor connection ${integration}/${connection.name} returned a tool for a different connection`
    );
  }
  return tools.length;
}

export async function connectExecutor(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  integration: string,
  options: ConnectOptions = {}
): Promise<void> {
  const desired = buildExecutorDesiredState(profile, paths.home).integrations.find(
    (entry) => entry.slug === integration
  );
  if (!desired) {
    throw new Error(
      `Profile ${profile.name} does not declare Executor integration: ${integration}`
    );
  }
  const methods = executorAuthentication(desired);
  if (methods.length === 0) {
    throw new Error(`Executor integration ${integration} has no declared authentication method`);
  }
  const connectionNames = Object.keys(desired.connections);
  const name = options.connection;
  if (name !== undefined && desired.connections[name] === undefined) {
    throw new Error(
      `Executor integration ${integration} has no declared connection ${name}; choose one of ${connectionNames.join(", ")}`
    );
  }
  if (name === undefined && connectionNames.length !== 1) {
    throw new Error(
      `Executor integration ${integration} has multiple named connections; pass --connection <name> (${connectionNames.join(", ")})`
    );
  }
  const selectedName = name ?? connectionNames[0];
  if (!selectedName) {
    throw new Error(`Executor integration ${integration} has no resolved connection`);
  }
  const methodSlug = desired.connections[selectedName];
  const method = chooseMethod(methods, methodSlug, integration);
  const allowOrganizationDefault =
    desired.config.transport === "stdio" && method.kind === "none" && selectedName === "default";
  if (options.method !== undefined && options.method !== method.slug) {
    throw new Error(
      `Executor connection ${integration}/${selectedName} selects authentication method ${method.slug}, not ${options.method}`
    );
  }
  const adapter = options.adapter ?? (await createExecutorAdapter({}));
  try {
    await ensureExecutorIntegration(adapter, desired);

    let connection = connectionFor(
      await adapter.listConnections(integration),
      integration,
      method,
      selectedName,
      allowOrganizationDefault
    );
    if (connection && !options.repair) {
      const tools = await verifyConnection(
        adapter,
        integration,
        connection,
        allowOrganizationDefault
      );
      console.log(`reused\t${integration}/${connection.name}\t${tools} tools`);
      return;
    }

    if (method.kind === "none") {
      if (!connection) {
        await adapter.createNoAuthConnection(integration, selectedName, method.slug);
        connection = connectionFor(
          await adapter.listConnections(integration),
          integration,
          method,
          selectedName,
          allowOrganizationDefault
        );
      }
    } else {
      if (!(options.interactive ?? Boolean(process.stdin.isTTY))) {
        throw new Error(
          `Executor authentication is required for ${integration}/${selectedName}; rerun 'mfz executor connect ${integration} --connection ${selectedName}' interactively`
        );
      }
      if (method.kind === "oauth2") {
        if (desired.config.transport !== "remote") {
          throw new Error(`Executor OAuth integration ${integration} must use a remote MCP server`);
        }
        connection = await adapter.authorizeOAuth({
          integration,
          endpoint: desired.config.endpoint,
          name: selectedName,
          template: method.slug,
          ...(method.discoveryUrl ? { discoveryUrl: method.discoveryUrl } : {}),
          ...(method.registrationScopes ? { registrationScopes: method.registrationScopes } : {}),
          interactive: true
        });
      } else {
        const generation = apiKeyHandoffGeneration(integration, selectedName);
        await adapter.startApiKeyHandoff({
          integration,
          template: method.slug,
          label: generation.label
        });
        connection = await waitForConnection(
          adapter,
          integration,
          method,
          selectedName,
          generation.label,
          allowOrganizationDefault
        );
      }
    }

    if (!connection) {
      throw new Error(`Executor connection ${integration}/${selectedName} was not created`);
    }
    const tools = await verifyConnection(
      adapter,
      integration,
      connection,
      allowOrganizationDefault
    );
    console.log(`connected\t${integration}/${connection.name}\t${tools} tools`);
  } finally {
    if (!options.adapter) await adapter.close();
  }
}
