import path from "node:path";
import {
  expandHome,
  extraFoldersIndexPath,
  opencodeV2SkillSnapshotDir,
  profileConfigsDir,
  referenceIndexPath,
  type RuntimePaths
} from "../core/paths.js";
import {
  assertOpenCodeV2ConfigOwned,
  executorBridgeName,
  filterMcpForTarget,
  requiresExecutorBridge,
  type ResolvedProfile
} from "../core/profile.js";
import { jsonFileContent } from "../core/fs-util.js";
import type { RenderResult } from "../core/render.js";
import { hasManagedZsh, zshSecretsDir } from "../core/zsh.js";
import { collectOpenCodeMarkdownFiles } from "./opencode-files.js";
import { openCodeV2ExecutorEntry } from "./executor.js";

interface NativePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

function nativeBoundary(absPath: string): string {
  const normalized = absPath.replace(/[\\/]+$/, "") || path.parse(absPath).root;
  return path.join(normalized, "*");
}

function nativeMcp(profile: ResolvedProfile, paths: RuntimePaths): Record<string, unknown> {
  const servers: Record<string, unknown> = Object.fromEntries(
    filterMcpForTarget(profile, "opencode-v2").map(({ name, server, enabled }) => {
      if (server.type === "remote") {
        return [
          name,
          {
            type: "remote",
            url: server.url,
            disabled: !enabled,
            ...(server.headers ? { headers: server.headers } : {})
          }
        ];
      }
      return [
        name,
        {
          type: "local",
          command: server.command.map((part) => expandHome(part, paths.home)),
          disabled: !enabled,
          ...(server.env ? { environment: server.env } : {})
        }
      ];
    })
  );
  if (requiresExecutorBridge(profile, "opencode-v2")) {
    servers[executorBridgeName] = openCodeV2ExecutorEntry(profile);
  }
  return { servers };
}

function nativePermissions(paths: RuntimePaths, profile: ResolvedProfile): NativePermissionRule[] {
  const rules: NativePermissionRule[] = [];

  for (const folder of profile.extraFolders) {
    const boundary = nativeBoundary(expandHome(folder.path, paths.home));
    rules.push(
      { action: "external_directory", resource: boundary, effect: folder.read },
      { action: "read", resource: boundary, effect: folder.read },
      { action: "edit", resource: boundary, effect: folder.edit }
    );
  }

  const references = nativeBoundary(profile.referencesDir);
  rules.push(
    { action: "external_directory", resource: references, effect: "allow" },
    { action: "read", resource: references, effect: "allow" },
    { action: "edit", resource: references, effect: "deny" }
  );

  if (hasManagedZsh(profile)) {
    const secrets = nativeBoundary(zshSecretsDir(paths));
    rules.push(
      { action: "external_directory", resource: secrets, effect: "deny" },
      { action: "read", resource: secrets, effect: "deny" },
      { action: "edit", resource: secrets, effect: "deny" }
    );
  }

  rules.push({
    action: "read",
    resource: path.join(paths.opencodeV2ConfigDir, "service.json"),
    effect: "deny"
  });

  return rules;
}

export async function renderOpenCodeV2(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  assertOpenCodeV2ConfigOwned(profile.profile);

  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsOpenCodeV2 = path.join(configsProfile, "opencode-v2");
  const configPath = path.join(configsOpenCodeV2, "opencode.jsonc");
  const cliPath = path.join(configsOpenCodeV2, "cli.json");
  const commandsPath = path.join(configsOpenCodeV2, "commands");
  const agentsPath = path.join(configsOpenCodeV2, "agents");
  const skillsPath = opencodeV2SkillSnapshotDir(paths, profile.name);
  const instructions = [path.join(configsProfile, "AGENTS.md"), referenceIndexPath(paths)];
  if (profile.extraFolders.length > 0) instructions.push(extraFoldersIndexPath(paths));

  const omittedPlugins = [
    ...profile.profile.opencode.plugins.map((name) => `plugin:${name}`),
    ...profile.profile.opencode.tui_plugins.map((name) => `tui-plugin:${name}`)
  ];
  if (omittedPlugins.length > 0) {
    console.warn(
      `warning\tOpenCode V1 plugins omitted from OpenCode V2 render: ${omittedPlugins.join(", ")}`
    );
  }
  if (Object.keys(profile.profile.opencode.tui).length > 0) {
    console.warn("warning\tOpenCode V1 TUI config omitted from OpenCode V2 render");
  }
  if (Object.keys(profile.profile.opencode.dependencies).length > 0) {
    console.warn("warning\tOpenCode V1 dependencies omitted from OpenCode V2 render");
  }
  if (profile.profile.opencode.delegate_general !== undefined) {
    console.warn("warning\tOpenCode V1 delegate_general omitted from OpenCode V2 render");
  }

  const commandFiles = await collectOpenCodeMarkdownFiles(
    (name) => profile.sources.commands.get(name)?.root ?? paths.root,
    configsOpenCodeV2,
    "commands",
    profile.enabledOpenCodeV2Commands
  );
  const agentFiles = await collectOpenCodeMarkdownFiles(
    (name) => profile.sources.agents.get(name)?.root ?? paths.root,
    configsOpenCodeV2,
    "agents",
    profile.enabledOpenCodeV2Agents
  );
  const config = {
    ...profile.profile.opencode_v2.config,
    $schema: "https://opencode.ai/config.json",
    instructions,
    mcp: nativeMcp(profile, paths),
    skills: [skillsPath],
    permissions: nativePermissions(paths, profile)
  };
  const hasCli = Object.keys(profile.profile.opencode_v2.cli).length > 0;
  const files: RenderResult["files"] = [
    ...commandFiles,
    ...agentFiles,
    { path: configPath, content: jsonFileContent(config) },
    ...(hasCli
      ? [{ path: cliPath, content: jsonFileContent(profile.profile.opencode_v2.cli) }]
      : [])
  ];
  const links: RenderResult["links"] = [
    { linkPath: path.join(paths.opencodeV2ConfigDir, "opencode.jsonc"), targetPath: configPath },
    ...(hasCli
      ? [{ linkPath: path.join(paths.opencodeV2ConfigDir, "cli.json"), targetPath: cliPath }]
      : []),
    { linkPath: path.join(paths.opencodeV2ConfigDir, "commands"), targetPath: commandsPath },
    { linkPath: path.join(paths.opencodeV2ConfigDir, "agents"), targetPath: agentsPath }
  ];

  return {
    files,
    links,
    staleFiles: hasCli ? [] : [cliPath],
    staleLinks: hasCli
      ? []
      : [{ linkPath: path.join(paths.opencodeV2ConfigDir, "cli.json"), targetPath: cliPath }]
  };
}
