import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import { expandHome } from "../core/paths.js";
import { parseEnvRef } from "../core/env-ref.js";
import { readJsonObject } from "../core/fs-util.js";
import { deepMerge, filterMcpForTarget, type ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";
import { hasManagedZsh, zshSecretsDir } from "../core/zsh.js";

function claudePermissionPattern(absPath: string): string {
  const normalized = absPath.replace(/\/+$/, "") || "/";
  return `${normalized.startsWith("/") ? "/" : ""}${normalized}/**`;
}

function mergeClaudePermissions(
  existing: unknown,
  generated: Record<string, string[]>
): Record<string, unknown> {
  const merged =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  for (const key of ["allow", "deny"] as const) {
    const current = Array.isArray(merged[key]) ? (merged[key] as string[]) : [];
    merged[key] = [...new Set([...current, ...(generated[key] ?? [])])];
  }

  return merged;
}

function stripEnvRef(value: string): string {
  const name = parseEnvRef(value);
  return name === null ? value : `\${${name}}`;
}

function renderClaudeMcpServer(
  server: ResolvedProfile["mcpServers"][number],
  home: string
): unknown {
  if (server.server.type === "remote") {
    return {
      type: server.server.transport === "sse" ? "sse" : "http",
      url: server.server.url,
      ...(server.server.headers
        ? {
            headers: Object.fromEntries(
              Object.entries(server.server.headers).map(([k, v]) => [k, stripEnvRef(v as string)])
            )
          }
        : {})
    };
  }

  const [command, ...args] = server.server.command.map((part) => expandHome(part, home));
  return {
    type: "stdio",
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(server.server.env ? { env: server.server.env } : {})
  };
}

function mergeClaudeMcp(
  existingClaudeJson: Record<string, unknown>,
  managedMcp: Record<string, unknown>,
  managedServerNames: Set<string>
): Record<string, unknown> {
  const existingMcpServersRaw = existingClaudeJson.mcpServers;
  const existingMcpServers =
    typeof existingMcpServersRaw === "object" &&
    existingMcpServersRaw !== null &&
    !Array.isArray(existingMcpServersRaw)
      ? { ...(existingMcpServersRaw as Record<string, unknown>) }
      : {};

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
    `@${path.join(paths.home, ".mindframe-z", "references.md")}`
  ];
  if (extraFolders.length > 0) {
    claudeMdLines.push(`@${path.join(paths.home, ".mindframe-z", "extra_folders.md")}`);
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
  const { permissions: machinePermissions, ...machineClaudeRest } = profile.manifests.machine
    .claude as Record<string, unknown> & { permissions?: Record<string, string[]> };
  const settings: Record<string, unknown> = deepMerge(
    {
      ...profile.profile.claude.settings,
      ...(profile.profile.claude.model ? { model: profile.profile.claude.model } : {})
    },
    machineClaudeRest
  );
  settings.permissions = mergeClaudePermissions(
    mergeClaudePermissions(settings.permissions, permissions),
    machinePermissions ?? {}
  );
  if (additionalDirectories.length > 0) {
    settings.additionalDirectories = additionalDirectories;
  }
  const managedClaudeMcp = Object.fromEntries(
    filterMcpForTarget(profile, "claude-code").map((server) => [
      server.name,
      renderClaudeMcpServer(server, paths.home)
    ])
  );
  const managedClaudeServerNames = new Set(profile.mcpServers.map((server) => server.name));
  const localSettingsPath = path.join(paths.claudeDir, "settings.json");
  const localClaudeJsonPath = path.join(paths.home, ".claude.json");
  const mergedSettings = deepMerge(await readJsonObject(localSettingsPath), settings);
  const mergedClaudeJson = mergeClaudeMcp(
    await readJsonObject(localClaudeJsonPath),
    managedClaudeMcp,
    managedClaudeServerNames
  );

  return {
    files: [
      { path: claudeMdPath, content: claudeMd },
      { path: settingsPath, content: `${JSON.stringify(settings, null, 2)}\n` },
      { path: mcpPath, content: `${JSON.stringify(managedClaudeMcp, null, 2)}\n` }
    ],
    localFiles: [
      { path: localSettingsPath, content: `${JSON.stringify(mergedSettings, null, 2)}\n` },
      { path: localClaudeJsonPath, content: `${JSON.stringify(mergedClaudeJson, null, 2)}\n` }
    ],
    links: [{ linkPath: path.join(paths.claudeDir, "CLAUDE.md"), targetPath: claudeMdPath }]
  };
}
