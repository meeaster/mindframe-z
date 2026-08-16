import path from "node:path";
import { z } from "zod";
import type { RuntimePaths } from "../core/paths.js";
import {
  expandHome,
  extraFoldersIndexPath,
  profileConfigsDir,
  referenceIndexPath
} from "../core/paths.js";
import { parseEnvRef } from "../core/env-ref.js";
import { isPlainObject, jsonFileContent, readJsonObject } from "../core/fs-util.js";
import {
  deepMerge,
  executorBridgeName,
  filterMcpForTarget,
  requiresExecutorBridge,
  type ResolvedProfile
} from "../core/profile.js";
import type { RenderResult } from "../core/render.js";
import { jsonObjectSchema, type JsonObject } from "../core/json.js";
import { hasManagedZsh, zshSecretsDir } from "../core/zsh.js";
import { claudeExecutorEntry } from "./executor.js";

function claudePermissionPattern(absPath: string): string {
  const normalized = absPath.replace(/\/+$/, "") || "/";
  return `${normalized.startsWith("/") ? "/" : ""}${normalized}/**`;
}

function mergeClaudePermissions(
  existing: JsonObject["permissions"],
  generated: Record<string, string[]>
): JsonObject {
  const merged = jsonObjectSchema.safeParse(existing).data ?? {};

  for (const key of ["allow", "deny"] as const) {
    const current = Array.isArray(merged[key])
      ? merged[key].filter((value): value is string => {
          const result = z.string().safeParse(value);
          return result.success;
        })
      : [];
    merged[key] = [...new Set([...current, ...(generated[key] ?? [])])];
  }

  return merged;
}

function stripEnvRef(value: string): string {
  const name = parseEnvRef(value);
  return name === null ? value : `\${${name}}`;
}

function renderClaudeMcpServer(server: ResolvedProfile["mcpServers"][number], home: string) {
  if (server.server.type === "remote") {
    const entry = {
      type: server.server.transport === "sse" ? "sse" : "http",
      url: server.server.url
    };
    if (server.server.headers) {
      Object.assign(entry, {
        headers: Object.fromEntries(
          Object.entries(server.server.headers).map(([k, v]) => [k, stripEnvRef(v)])
        )
      });
    }
    return entry;
  }

  const [command, ...args] = server.server.command.map((part) => expandHome(part, home));
  const entry = { type: "stdio", command };
  if (args.length > 0) Object.assign(entry, { args });
  if (server.server.env) Object.assign(entry, { env: server.server.env });
  return entry;
}

function mergeClaudeMcp(
  existingClaudeJson: JsonObject,
  managedMcp: JsonObject,
  managedServerNames: Set<string>
) {
  const existingMcpServersRaw = existingClaudeJson.mcpServers;
  const existingMcpServers = jsonObjectSchema.safeParse(existingMcpServersRaw).data ?? {};

  for (const serverName of managedServerNames) {
    delete existingMcpServers[serverName];
  }

  return {
    ...existingClaudeJson,
    mcpServers: {
      ...existingMcpServers,
      ...managedMcp
    }
  };
}

export async function renderClaude(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsClaude = path.join(configsProfile, "claude");
  const claudeMdPath = path.join(configsClaude, "CLAUDE.md");
  const settingsPath = path.join(configsClaude, "settings.json");
  const mcpPath = path.join(configsClaude, "mcp.json");
  const extraFolders = profile.extraFolders;
  const allowPermissions: string[] = [];
  const denyPermissions: string[] = [];
  const additionalDirectories: string[] = [];

  const refPattern = claudePermissionPattern(profile.referencesDir);
  allowPermissions.push(`Read(${refPattern})`);
  denyPermissions.push(`Edit(${refPattern})`);

  if (hasManagedZsh(profile)) {
    const pattern = claudePermissionPattern(zshSecretsDir(paths));
    denyPermissions.push(`Read(${pattern})`);
    denyPermissions.push(`Edit(${pattern})`);
  }

  for (const folder of extraFolders) {
    const absPath = expandHome(folder.path, paths.home);
    const pattern = claudePermissionPattern(absPath);

    if (folder.read === "allow") {
      allowPermissions.push(`Read(${pattern})`);
      additionalDirectories.push(absPath);
    } else if (folder.read === "deny") {
      denyPermissions.push(`Read(${pattern})`);
    }

    if (folder.edit === "allow") {
      allowPermissions.push(`Edit(${pattern})`);
    } else if (folder.edit === "deny") {
      denyPermissions.push(`Edit(${pattern})`);
    }
  }

  const claudeMdLines = [
    "# CLAUDE.md",
    "",
    `@${path.join(configsProfile, "AGENTS.md")}`,
    `@${referenceIndexPath(paths)}`
  ];
  if (extraFolders.length > 0) {
    claudeMdLines.push(`@${extraFoldersIndexPath(paths)}`);
  }
  claudeMdLines.push(
    "",
    "## Claude Code",
    "",
    "Use the shared AI configuration rendered by mindframe-z."
  );
  const claudeMd = claudeMdLines.join("\n") + "\n";

  const permissions: Record<string, string[]> = {};
  if (allowPermissions.length > 0) permissions.allow = allowPermissions;
  if (denyPermissions.length > 0) permissions.deny = denyPermissions;
  const { permissions: machinePermissions, ...machineClaudeRest } =
    profile.manifests.machine.claude;
  const profileSettings = { ...profile.profile.claude.settings };
  if (profile.profile.claude.model) profileSettings.model = profile.profile.claude.model;
  const settings = jsonObjectSchema.parse(deepMerge(profileSettings, machineClaudeRest));
  settings.permissions = mergeClaudePermissions(
    mergeClaudePermissions(
      jsonObjectSchema.safeParse(settings.permissions).data ?? {},
      permissions
    ),
    z.record(z.string(), z.array(z.string())).safeParse(machinePermissions).data ?? {}
  );
  if (additionalDirectories.length > 0) {
    settings.additionalDirectories = additionalDirectories;
  }
  const managedClaudeMcp = jsonObjectSchema.parse(
    Object.fromEntries(
      filterMcpForTarget(profile, "claude-code").map((server) => [
        server.name,
        renderClaudeMcpServer(server, paths.home)
      ])
    )
  );
  if (requiresExecutorBridge(profile, "claude-code"))
    managedClaudeMcp[executorBridgeName] = claudeExecutorEntry(profile);
  const localSettingsPath = path.join(paths.claudeDir, "settings.json");
  const localClaudeJsonPath = path.join(paths.home, ".claude.json");
  const existingClaudeJson = jsonObjectSchema.parse(await readJsonObject(localClaudeJsonPath));
  const existingMcpServers = jsonObjectSchema.safeParse(existingClaudeJson.mcpServers).data;
  const existingExecutor = existingMcpServers?.[executorBridgeName];
  const existingExecutorEnv = isPlainObject(existingExecutor)
    ? jsonObjectSchema.safeParse(existingExecutor.env).data
    : undefined;
  const hasGeneratedExecutor =
    isPlainObject(existingExecutor) &&
    existingExecutor.type === "stdio" &&
    existingExecutor.command === "executor" &&
    Array.isArray(existingExecutor.args) &&
    ((existingExecutor.args.includes("--scope") &&
      existingExecutorEnv !== undefined &&
      "EXECUTOR_DATA_DIR" in existingExecutorEnv) ||
      (existingExecutor.args[0] === "mcp" && existingExecutor.args.includes("--elicitation-mode")));
  const managedClaudeServerNames = new Set([
    ...profile.mcpServers.map((server) => server.name),
    ...(requiresExecutorBridge(profile) || hasGeneratedExecutor ? [executorBridgeName] : [])
  ]);
  const mergedSettings = deepMerge(await readJsonObject(localSettingsPath), settings);
  const mergedClaudeJson = mergeClaudeMcp(
    existingClaudeJson,
    managedClaudeMcp,
    managedClaudeServerNames
  );

  return {
    files: [
      { path: claudeMdPath, content: claudeMd },
      { path: settingsPath, content: jsonFileContent(settings) },
      { path: mcpPath, content: jsonFileContent(managedClaudeMcp) }
    ],
    localFiles: [
      { path: localSettingsPath, content: jsonFileContent(mergedSettings) },
      { path: localClaudeJsonPath, content: jsonFileContent(mergedClaudeJson) }
    ],
    links: [{ linkPath: path.join(paths.claudeDir, "CLAUDE.md"), targetPath: claudeMdPath }]
  };
}
