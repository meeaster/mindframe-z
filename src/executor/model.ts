import { createHash } from "node:crypto";
import type { ExecutorAuthenticationMethod, McpServer } from "../core/manifests.js";
import { expandHome } from "../core/paths.js";
import {
  validateExecutorMcpServer,
  type ResolvedMcpServer,
  type ResolvedProfile
} from "../core/profile.js";

export interface ExecutorConnectionDurability {
  template: string;
  provider?: string | null;
  credentialBindings?: Readonly<Record<string, string>> | undefined;
  oauthClient?: string | null;
  oauthScope?: string | null;
  expiresAt?: number | null;
}

export function executorConnectionHasDurableState(
  connection: ExecutorConnectionDurability
): boolean {
  const hasCredentialBindings = Object.keys(connection.credentialBindings ?? {}).length > 0;
  if (connection.template === "none") return hasCredentialBindings;
  return true;
}

export interface ExecutorRemoteConfig {
  transport: "remote";
  endpoint: string;
  remoteTransport: "auto" | "streamable-http" | "sse";
  authenticationTemplate?: ExecutorAuthenticationMethod[];
}

export interface ExecutorStdioConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  authenticationTemplate?: ExecutorAuthenticationMethod[];
}

export interface ExecutorDesiredServer {
  slug: string;
  name: string;
  description: string;
  config: ExecutorRemoteConfig | ExecutorStdioConfig;
  connections: Record<string, string>;
}

export interface ExecutorDesiredState {
  version: 1;
  profile: string;
  integrations: ExecutorDesiredServer[];
}

export function executorAuthentication(
  server: ExecutorDesiredServer
): ExecutorAuthenticationMethod[] {
  return server.config.authenticationTemplate ?? [{ slug: "none", kind: "none" }];
}

function remoteConfig(server: Extract<McpServer, { type: "remote" }>): ExecutorRemoteConfig {
  const remoteTransport =
    server.executor?.transport ?? (server.transport === "sse" ? "sse" : "auto");
  return {
    transport: "remote",
    endpoint: server.url,
    remoteTransport,
    authenticationTemplate: server.executor?.authentication ?? [{ slug: "none", kind: "none" }]
  };
}

function stdioConfig(
  name: string,
  server: Extract<McpServer, { type: "local" }>,
  home: string
): ExecutorStdioConfig {
  const [command, ...args] = server.command;
  if (!command) throw new Error(`Executor route for ${name} has no local command`);
  return {
    transport: "stdio",
    command: expandHome(command, home),
    ...(args.length > 0 ? { args: args.map((arg) => expandHome(arg, home)) } : {}),
    authenticationTemplate: server.executor?.authentication ?? [{ slug: "none", kind: "none" }]
  };
}

export function desiredExecutorServer(
  entry: ResolvedMcpServer,
  home = process.env.HOME ?? ""
): ExecutorDesiredServer {
  if (entry.route !== "executor") {
    throw new Error(`MCP server ${entry.name} is not Executor-routed`);
  }
  validateExecutorMcpServer(entry.name, entry.server);
  const connections =
    Object.keys(entry.connections).length > 0
      ? entry.connections
      : entry.server.executor?.authentication && entry.server.executor.authentication.length > 1
        ? (() => {
            throw new Error(
              `Executor MCP server ${entry.name} declares multiple authentication methods; declare named connections with their authentication slugs`
            );
          })()
        : { main: entry.server.executor?.authentication?.[0]?.slug ?? "none" };
  return {
    slug: entry.name,
    name: entry.name,
    description: entry.server.description,
    connections: Object.fromEntries(
      Object.entries(connections).sort(([left], [right]) => left.localeCompare(right))
    ),
    config:
      entry.server.type === "remote"
        ? remoteConfig(entry.server)
        : stdioConfig(entry.name, entry.server, home)
  };
}

export function buildExecutorDesiredState(
  profile: ResolvedProfile,
  home = process.env.HOME ?? ""
): ExecutorDesiredState {
  return {
    version: 1,
    profile: profile.name,
    integrations: profile.mcpServers
      .filter((entry) => entry.route === "executor")
      .map((entry) => desiredExecutorServer(entry, home))
      .sort((left, right) => left.slug.localeCompare(right.slug))
  };
}

export function normalizedExecutorConfig(server: ExecutorDesiredServer): Record<string, unknown> {
  return {
    name: server.name,
    description: server.description,
    config: server.config,
    connections: server.connections
  };
}

export function executorConfigDigest(server: ExecutorDesiredServer): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedExecutorConfig(server)))
    .digest("hex");
}
