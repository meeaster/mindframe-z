import path from "node:path";
import {
  expandHome,
  extraFoldersIndexPath,
  opencodeV1SnapshotDir,
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
import { collectPluginFiles } from "./opencode.js";
import { openCodeV2ExecutorEntry } from "./executor.js";

export function mergeOpenCodeV2CliPlugins(
  cli: Record<string, unknown>,
  managedEntries: readonly string[],
  previouslyManagedEntries: readonly string[]
) {
  const plugins = Array.isArray(cli.plugins) ? cli.plugins : [];
  const preserved = plugins.filter(
    (entry) => typeof entry !== "string" || !previouslyManagedEntries.includes(entry)
  );
  const nextPlugins = [...preserved, ...managedEntries];

  if (plugins.length === 0 && managedEntries.length === 0 && !Array.isArray(cli.plugins))
    return cli;
  if (nextPlugins.length === 0) {
    const { plugins: _, ...withoutPlugins } = cli;
    return withoutPlugins;
  }
  return { ...cli, plugins: nextPlugins };
}

interface NativePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

function nativeBoundary(absPath: string): string {
  const normalized = absPath.replace(/[\\/]+$/, "") || path.parse(absPath).root;
  return path.join(normalized, "*");
}

function nativeMcp(profile: ResolvedProfile, paths: RuntimePaths) {
  const servers = Object.fromEntries(
    filterMcpForTarget(profile, "opencode-v2").map(({ name, server, enabled }) => {
      if (server.type === "remote") {
        const entry = { type: "remote", url: server.url, disabled: !enabled };
        if (server.headers) Object.assign(entry, { headers: server.headers });
        return [name, entry];
      }
      const entry = {
        type: "local",
        command: server.command.map((part) => expandHome(part, paths.home)),
        disabled: !enabled
      };
      if (server.env) Object.assign(entry, { environment: server.env });
      return [name, entry];
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
    resource: path.join(paths.opencodeConfigDir, "service.json"),
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
  const pluginsPath = path.join(configsOpenCodeV2, "plugins");
  const tuiPluginsPath = path.join(pluginsPath, "tui");
  const configPath = path.join(configsOpenCodeV2, "opencode.jsonc");
  const packagePath = path.join(configsOpenCodeV2, "package.json");
  const commandsPath = path.join(configsOpenCodeV2, "commands");
  const agentsPath = path.join(configsOpenCodeV2, "agents");
  const skillsPath = opencodeV2SkillSnapshotDir(paths, profile.name);
  const useGlobalInstructions = profile.profile.opencode_v2.global_instructions === true;
  const instructions = useGlobalInstructions
    ? []
    : [path.join(configsProfile, "AGENTS.md"), referenceIndexPath(paths)];
  if (!useGlobalInstructions && profile.extraFolders.length > 0)
    instructions.push(extraFoldersIndexPath(paths));

  const pluginResult = await collectPluginFiles(
    paths.root,
    (name) => profile.sources?.plugins?.get(name)?.root ?? paths.root,
    pluginsPath,
    profile.enabledOpenCodeV2Plugins ?? [],
    true,
    false,
    "v2"
  );
  const tuiPluginResult = await collectPluginFiles(
    paths.root,
    (name) => profile.sources?.plugins?.get(name)?.root ?? paths.root,
    tuiPluginsPath,
    profile.enabledOpenCodeV2TuiPlugins ?? [],
    true,
    false,
    "v2"
  );

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
    mcp: nativeMcp(profile, paths)
  };
  if (pluginResult.entries.length > 0) Object.assign(config, { plugins: pluginResult.entries });
  Object.assign(config, {
    skills: [skillsPath],
    permissions: nativePermissions(paths, profile)
  });
  const hasDependencies = Object.keys(profile.profile.opencode_v2.dependencies).length > 0;
  const files: RenderResult["files"] = [
    ...commandFiles,
    ...agentFiles,
    { path: configPath, content: jsonFileContent(config) },
    ...(hasDependencies
      ? [
          {
            path: packagePath,
            content: jsonFileContent({ dependencies: profile.profile.opencode_v2.dependencies })
          }
        ]
      : [])
  ];
  const links: RenderResult["links"] =
    paths.activeOpenCodeRuntime === "v2"
      ? [
          ...(useGlobalInstructions
            ? [
                {
                  linkPath: path.join(paths.opencodeConfigDir, "AGENTS.md"),
                  targetPath: path.join(configsProfile, "AGENTS.md")
                }
              ]
            : []),
          {
            linkPath: path.join(paths.opencodeConfigDir, "opencode.jsonc"),
            targetPath: configPath
          },
          ...(hasDependencies
            ? [
                {
                  linkPath: path.join(paths.opencodeConfigDir, "package.json"),
                  targetPath: packagePath
                }
              ]
            : []),
          { linkPath: path.join(paths.opencodeConfigDir, "commands"), targetPath: commandsPath },
          { linkPath: path.join(paths.opencodeConfigDir, "agents"), targetPath: agentsPath },
          {
            linkPath: path.join(paths.opencodeConfigDir, "plugins", "tui"),
            targetPath: tuiPluginsPath
          }
        ]
      : [];

  const result: RenderResult = {
    files,
    localFiles: [
      ...new Map(
        [...pluginResult.files, ...tuiPluginResult.files].map((file) => [file.path, file])
      ).values()
    ],
    localStaleFiles: [pluginsPath],
    links,
    staleLinks: [
      ...(useGlobalInstructions
        ? []
        : [
            {
              linkPath: path.join(paths.opencodeConfigDir, "AGENTS.md"),
              targetPath: path.join(configsProfile, "AGENTS.md")
            }
          ]),
      {
        linkPath: path.join(paths.opencodeConfigDir, "cli.json"),
        targetPath: path.join(configsOpenCodeV2, "cli.json")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "tui.json"),
        targetPath: path.join(opencodeV1SnapshotDir(paths, profile.name), "tui.json")
      },
      ...(!hasDependencies
        ? [
            {
              linkPath: path.join(paths.opencodeConfigDir, "package.json"),
              targetPath: path.join(opencodeV1SnapshotDir(paths, profile.name), "package.json")
            }
          ]
        : []),
      {
        linkPath: path.join(paths.opencodeConfigDir, "delegate-general.json"),
        targetPath: path.join(opencodeV1SnapshotDir(paths, profile.name), "delegate-general.json")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "commands"),
        targetPath: path.join(opencodeV1SnapshotDir(paths, profile.name), "commands")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "agents"),
        targetPath: path.join(opencodeV1SnapshotDir(paths, profile.name), "agents")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "node_modules"),
        targetPath: path.join(opencodeV1SnapshotDir(paths, profile.name), "node_modules")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "plugins"),
        targetPath: path.join(paths.configsDir, profile.name, "opencode-v1", "plugins")
      }
    ]
  };
  if (paths.activeOpenCodeRuntime === "v2") {
    result.cliPlugins = {
      path: path.join(paths.opencodeConfigDir, "cli.json"),
      entries: tuiPluginResult.entries,
      registryPath: path.join(paths.home, ".mindframe-z", "opencode-v2-cli-plugins.json"),
      settings: profile.profile.opencode_v2.cli
    };
  }
  return result;
}
