import { readdir, readFile, stat } from "node:fs/promises";
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
import type { OpenCodeV2PluginEntry, RenderResult } from "../core/render.js";
import { hasManagedZsh, zshSecretsDir } from "../core/zsh.js";
import { collectOpenCodeMarkdownFiles } from "./opencode-files.js";
import { openCodeV2ExecutorEntry } from "./executor.js";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../core/json.js";
import { z } from "zod";

async function copyDirContents(
  src: string,
  dest: string,
  files: RenderResult["files"]
): Promise<void> {
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(srcPath, destPath, files);
    } else if (entry.isFile() && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push({ path: destPath, content: await readFile(srcPath, "utf8") });
    }
  }
}

async function collectPluginFiles(
  rootByName: (name: string) => string,
  pluginsDir: string,
  pluginNames: readonly string[],
  directoryEntry: boolean
): Promise<{ files: RenderResult["files"]; entries: string[] }> {
  const files: RenderResult["files"] = [];
  const entries: string[] = [];
  const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

  for (const name of pluginNames) {
    const sourceDir = path.join(rootByName(name), "opencode", "plugins");
    const versionDir = path.join(sourceDir, name, "v2");
    const legacyDir = path.join(sourceDir, name);
    let dirPath = versionDir;
    try {
      if (!(await stat(dirPath)).isDirectory()) dirPath = legacyDir;
    } catch {
      dirPath = legacyDir;
    }

    let isDir = false;
    try {
      isDir = (await stat(dirPath)).isDirectory();
    } catch {
      // Missing plugin directories are reported by the entry fallback below.
    }
    if (isDir) {
      if (!directoryEntry) {
        entries.push(`file://${dirPath}`);
        continue;
      }
      await copyDirContents(dirPath, path.join(pluginsDir, name), files);
      entries.push(`file://${path.join(pluginsDir, name)}`);
      continue;
    }

    for (const ext of sourceExtensions) {
      const filePath = path.join(sourceDir, `${name}${ext}`);
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const destRel = `${name}${ext}`;
      files.push({ path: path.join(pluginsDir, destRel), content });
      entries.push(`file://${path.join(pluginsDir, destRel)}`);
      break;
    }
  }
  return { files, entries };
}

export function mergeOpenCodeV2CliPlugins(
  cli: JsonObject,
  managedEntries: readonly OpenCodeV2PluginEntry[],
  previouslyManagedEntries: readonly OpenCodeV2PluginEntry[]
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
const pluginEntrySchema: z.ZodType<OpenCodeV2PluginEntry> = z.union([
  z.string(),
  pluginObjectEntrySchema
]);

export function parseOpenCodeV2PluginEntries(
  value: JsonValue | undefined
): OpenCodeV2PluginEntry[] {
  const parsed = z.array(pluginEntrySchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function pluginPackage(entry: OpenCodeV2PluginEntry): string {
  const parsed = z.string().safeParse(entry);
  return parsed.success ? parsed.data : pluginObjectEntrySchema.parse(entry).package;
}

function configurePluginEntries(
  entries: readonly string[],
  pluginsPath: string,
  optionsByName: JsonObject
): OpenCodeV2PluginEntry[] {
  const prefix = `file://${pluginsPath}${path.sep}`;
  return entries.map((entry) => {
    const managedName = entry.startsWith(prefix)
      ? entry
          .slice(prefix.length)
          .split(path.sep)[0]!
          .replace(/\.[cm]?[jt]sx?$/, "")
      : Object.keys(optionsByName).find((name) => {
          const packagePath = `${path.sep}opencode${path.sep}plugins${path.sep}${name}`;
          return entry.endsWith(packagePath) || entry.includes(`${packagePath}${path.sep}`);
        });
    if (!managedName) return entry;
    const options = jsonObjectSchema.safeParse(optionsByName[managedName]);
    return options.success ? { package: entry, options: options.data } : entry;
  });
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
    (name) => profile.sources?.plugins?.get(name)?.root ?? paths.root,
    pluginsPath,
    profile.enabledOpenCodeV2Plugins ?? [],
    false
  );
  const tuiPluginResult = await collectPluginFiles(
    (name) => profile.sources?.plugins?.get(name)?.root ?? paths.root,
    tuiPluginsPath,
    profile.enabledOpenCodeV2TuiPlugins ?? [],
    true
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
  const pluginOptions = profile.profile.opencode_v2.plugin_options;
  const serverPluginEntries = configurePluginEntries(
    pluginResult.entries,
    pluginsPath,
    pluginOptions
  );
  const tuiPluginEntries = configurePluginEntries(
    tuiPluginResult.entries,
    tuiPluginsPath,
    pluginOptions
  );
  const config = {
    ...profile.profile.opencode_v2.config,
    $schema: "https://opencode.ai/config.json",
    instructions,
    mcp: nativeMcp(profile, paths)
  };
  if (serverPluginEntries.length > 0) Object.assign(config, { plugins: serverPluginEntries });
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
    { linkPath: path.join(paths.opencodeConfigDir, "agents"), targetPath: agentsPath },
    {
      linkPath: path.join(paths.opencodeConfigDir, "plugins", "tui"),
      targetPath: tuiPluginsPath
    }
  ];

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
        targetPath: path.join(configsOpenCodeV2, "tui.json")
      },
      ...(!hasDependencies
        ? [
            {
              linkPath: path.join(paths.opencodeConfigDir, "package.json"),
              targetPath: path.join(configsOpenCodeV2, "package.json")
            }
          ]
        : []),
      {
        linkPath: path.join(paths.opencodeConfigDir, "delegate-general.json"),
        targetPath: path.join(configsOpenCodeV2, "delegate-general.json")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "commands"),
        targetPath: commandsPath
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "agents"),
        targetPath: agentsPath
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "node_modules"),
        targetPath: path.join(configsOpenCodeV2, "node_modules")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "plugins"),
        targetPath: pluginsPath
      }
    ]
  };
  result.cliPlugins = {
    path: path.join(paths.opencodeConfigDir, "cli.json"),
    entries: tuiPluginEntries,
    registryPath: path.join(paths.home, ".mindframe-z", "opencode-v2-cli-plugins.json"),
    settings: profile.profile.opencode_v2.cli
  };
  return result;
}
