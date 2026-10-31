import { stat } from "node:fs/promises";
import path from "node:path";
import {
  expandHome,
  extraFoldersIndexPath,
  opencodeSkillSnapshotDir,
  profileConfigsDir,
  referenceIndexPath,
  type RuntimePaths
} from "../core/paths.js";
import {
  assertOpenCodeConfigOwned,
  executorBridgeName,
  filterMcpForTarget,
  requiresExecutorBridge,
  type ResolvedOpenCodePlugin,
  type ResolvedProfile
} from "../core/profile.js";
import { jsonFileContent } from "../core/fs-util.js";
import type { OpenCodePluginEntry, RenderResult } from "../core/render.js";
import { hasManagedZsh, zshSecretsDir } from "../core/zsh.js";
import { collectOpenCodeMarkdownFiles } from "./opencode-files.js";
import { openCodeExecutorEntry } from "./executor.js";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../core/json.js";
import { z } from "zod";

// OpenCode loads plugin folders in place and reads their package exports, so MFZ only checks that each folder exists.
async function renderPluginEntries(
  plugins: readonly ResolvedOpenCodePlugin[],
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<OpenCodePluginEntry[]> {
  const pluginOptions = profile.profile.opencode.plugin_options;
  const rendered: OpenCodePluginEntry[] = [];

  for (const plugin of plugins) {
    const target = await pluginTarget(plugin, paths);
    const options = pluginOptions[plugin.name];

    rendered.push(options ? { package: target, options } : target);
  }

  return rendered;
}

async function pluginTarget(plugin: ResolvedOpenCodePlugin, paths: RuntimePaths): Promise<string> {
  switch (plugin.source) {
    case "npm":
      return `${plugin.package}@${plugin.version}`;
    case "git":
      return `${plugin.repo}${plugin.ref ? `#${plugin.ref}` : ""}${plugin.subdirectory ? `::path:${plugin.subdirectory}` : ""}`;
    case "local":
    case "path": {
      const directory =
        plugin.source === "local"
          ? path.join(plugin.sourceRoot, plugin.path)
          : expandHome(plugin.path, paths.home);

      const isDirectory = await stat(directory).then(
        (info) => info.isDirectory(),
        () => false
      );

      if (!isDirectory) {
        throw new Error(`OpenCode plugin ${plugin.name} has no plugin directory at ${directory}`);
      }

      return `file://${directory}`;
    }
  }
}

export function mergeOpenCodeCliPlugins(
  cli: JsonObject,
  managedEntries: readonly OpenCodePluginEntry[],
  previouslyManagedEntries: readonly OpenCodePluginEntry[]
) {
  const plugins = Array.isArray(cli.plugins) ? cli.plugins : [];
  const previousPackages = previouslyManagedEntries.map(pluginPackage);

  const preserved = plugins.filter((entry) => {
    const parsed = pluginEntrySchema.safeParse(entry);

    return !parsed.success || !previousPackages.includes(pluginPackage(parsed.data));
  });

  const nextPlugins = [...preserved, ...managedEntries];

  if (plugins.length === 0 && managedEntries.length === 0 && !Array.isArray(cli.plugins))
    return cli;

  if (nextPlugins.length === 0) {
    const { plugins: _, ...withoutPlugins } = cli;

    return withoutPlugins;
  }

  return { ...cli, plugins: nextPlugins };
}

const pluginObjectEntrySchema = z.object({ package: z.string(), options: jsonObjectSchema });

const pluginEntrySchema: z.ZodType<OpenCodePluginEntry> = z.union([
  z.string(),
  pluginObjectEntrySchema
]);

export function parseOpenCodePluginEntries(value: JsonValue | undefined): OpenCodePluginEntry[] {
  const parsed = z.array(pluginEntrySchema).safeParse(value);

  return parsed.success ? parsed.data : [];
}

function pluginPackage(entry: OpenCodePluginEntry): string {
  const parsed = z.string().safeParse(entry);

  return parsed.success ? parsed.data : pluginObjectEntrySchema.parse(entry).package;
}

type NativePermissionRule = ResolvedProfile["profile"]["opencode"]["permissions"][number];

function nativeBoundary(absPath: string): string {
  const normalized = absPath.replace(/[\\/]+$/, "") || path.parse(absPath).root;

  return path.join(normalized, "*");
}

function nativeMcp(profile: ResolvedProfile, paths: RuntimePaths) {
  const servers = Object.fromEntries(
    filterMcpForTarget(profile, "opencode").map(({ name, server, enabled }) => {
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

  if (requiresExecutorBridge(profile, "opencode")) {
    servers[executorBridgeName] = openCodeExecutorEntry(profile);
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

  // Profile rules come after folder access, which they may refine, and before the protected denies, which they can't
  // reopen because OpenCode applies the last matching rule.
  rules.push(...profile.profile.opencode.permissions);

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

export async function renderOpenCode(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  assertOpenCodeConfigOwned(profile.profile);

  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsOpenCode = path.join(configsProfile, "opencode");
  const configPath = path.join(configsOpenCode, "opencode.jsonc");
  const packagePath = path.join(configsOpenCode, "package.json");
  const commandsPath = path.join(configsOpenCode, "commands");
  const agentsPath = path.join(configsOpenCode, "agents");
  const skillsPath = opencodeSkillSnapshotDir(paths, profile.name);
  const useGlobalInstructions = profile.profile.opencode.global_instructions === true;

  const instructions = useGlobalInstructions
    ? []
    : [path.join(configsProfile, "AGENTS.md"), referenceIndexPath(paths)];

  if (!useGlobalInstructions && profile.extraFolders.length > 0)
    instructions.push(extraFoldersIndexPath(paths));

  const plugins = profile.enabledOpenCodePlugins ?? [];

  const serverPluginEntries = await renderPluginEntries(
    plugins.filter((plugin) => !plugin.tui_only),
    paths,
    profile
  );

  const tuiPluginEntries = await renderPluginEntries(
    plugins.filter((plugin) => plugin.tui_only),
    paths,
    profile
  );

  const commandFiles = await collectOpenCodeMarkdownFiles(
    (name) => profile.sources.commands.get(name)?.root ?? paths.root,
    configsOpenCode,
    "commands",
    profile.enabledOpenCodeCommands
  );

  const agentFiles = await collectOpenCodeMarkdownFiles(
    (name) => profile.sources.agents.get(name)?.root ?? paths.root,
    configsOpenCode,
    "agents",
    profile.enabledOpenCodeAgents
  );

  const config = {
    ...profile.profile.opencode.config,
    $schema: "https://opencode.ai/config.json",
    instructions,
    mcp: nativeMcp(profile, paths)
  };

  if (serverPluginEntries.length > 0) Object.assign(config, { plugins: serverPluginEntries });
  Object.assign(config, {
    skills: [skillsPath],
    permissions: nativePermissions(paths, profile)
  });
  const hasDependencies = Object.keys(profile.profile.opencode.dependencies).length > 0;

  const files: RenderResult["files"] = [
    ...commandFiles,
    ...agentFiles,
    { path: configPath, content: jsonFileContent(config) },
    ...(hasDependencies
      ? [
          {
            path: packagePath,
            content: jsonFileContent({ dependencies: profile.profile.opencode.dependencies })
          }
        ]
      : [])
  ];

  const links: RenderResult["links"] = [
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
    { linkPath: path.join(paths.opencodeConfigDir, "agents"), targetPath: agentsPath }
  ];

  const result: RenderResult = {
    files,
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
        targetPath: path.join(configsOpenCode, "cli.json")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "tui.json"),
        targetPath: path.join(configsOpenCode, "tui.json")
      },
      ...(!hasDependencies
        ? [
            {
              linkPath: path.join(paths.opencodeConfigDir, "package.json"),
              targetPath: path.join(configsOpenCode, "package.json")
            }
          ]
        : []),
      {
        linkPath: path.join(paths.opencodeConfigDir, "delegate-general.json"),
        targetPath: path.join(configsOpenCode, "delegate-general.json")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "node_modules"),
        targetPath: path.join(configsOpenCode, "node_modules")
      }
    ]
  };

  // Profile `cli.plugins` entries, such as "-opencode.sidebar.context" to turn off a built-in TUI plugin, are managed
  // like TUI plugin registrations, so they merge beside the user's own entries instead of replacing them.
  const { plugins: cliPlugins, ...cliSettings } = profile.profile.opencode.cli;

  result.cliPlugins = {
    path: path.join(paths.opencodeConfigDir, "cli.json"),
    entries: [...parseOpenCodePluginEntries(cliPlugins), ...tuiPluginEntries],
    registryPath: path.join(paths.home, ".mindframe-z", "opencode-cli-plugins.json"),
    settings: cliSettings
  };

  return result;
}
