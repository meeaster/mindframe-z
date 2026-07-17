import { createHash } from "node:crypto";
import type { McpServer } from "../core/manifests.js";
import { expandHome } from "../core/paths.js";
import {
  validateExecutorMcpServer,
  type ResolvedMcpServer,
  type ResolvedProfile
} from "../core/profile.js";

export interface ExecutorRemoteConfig {
  transport: "remote";
  endpoint: string;
  remoteTransport: "auto" | "streamable-http" | "sse";
  authenticationTemplate: Array<{ slug: string; kind: "none" | "oauth2" }>;
}

export interface ExecutorStdioConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  authenticationTemplate: Array<{ slug: "none"; kind: "none" }>;
}

export interface ExecutorDesiredServer {
  slug: string;
  name: string;
  description: string;
  config: ExecutorRemoteConfig | ExecutorStdioConfig;
  oauth?: {
    template: string;
    scopes: string[];
  };
}

export interface ExecutorDesiredState {
  version: 1;
  profile: string;
  integrations: ExecutorDesiredServer[];
}

function executorAuth(server: McpServer): ExecutorDesiredServer["oauth"] {
  const oauth = server.executor?.oauth;
  if (!oauth) return undefined;
  return { template: oauth.template, scopes: [...oauth.scopes] };
}

function remoteConfig(
  name: string,
  server: Extract<McpServer, { type: "remote" }>
): ExecutorRemoteConfig {
  const oauth = executorAuth(server);
  const remoteTransport =
    server.executor?.transport ?? (server.transport === "sse" ? "sse" : "auto");
  return {
    transport: "remote",
    endpoint: server.url,
    remoteTransport,
    authenticationTemplate: [
      oauth
        ? { slug: oauth.template, kind: "oauth2" as const }
        : { slug: "none", kind: "none" as const }
    ]
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
    authenticationTemplate: [{ slug: "none", kind: "none" }]
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
  const oauth = executorAuth(entry.server);
  return {
    slug: entry.name,
    name: entry.name,
    description: entry.server.description,
    config:
      entry.server.type === "remote"
        ? remoteConfig(entry.name, entry.server)
        : stdioConfig(entry.name, entry.server, home),
    ...(oauth ? { oauth } : {})
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
    ...(server.oauth ? { oauth: server.oauth } : {})
  };
}

export function executorConfigDigest(server: ExecutorDesiredServer): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedExecutorConfig(server)))
    .digest("hex");
}
