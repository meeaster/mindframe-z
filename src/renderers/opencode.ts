import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import {
  expandHome,
  extraFoldersIndexPath,
  profileConfigsDir,
  referenceIndexPath
} from "../core/paths.js";
import {
  deepMerge,
  filterMcpForTarget,
  skillRuntimeDefaults,
  type ResolvedProfile
} from "../core/profile.js";
import { jsonFileContent } from "../core/fs-util.js";
import type { RenderResult } from "../core/render.js";
import { mergeSkillOverrides } from "../core/skill-overrides.js";
import { hasManagedZsh, zshSecretsDir } from "../core/zsh.js";

interface OpenCodeRenderOptions {
  readonly skillOverrides?: Record<string, boolean>;
}

async function copyDirContents(
  src: string,
  dest: string,
  files: RenderResult["files"]
): Promise<void> {
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(srcPath, destPath, files);
    } else if (entry.isFile() && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push({
        path: destPath,
        content: await readFile(srcPath, "utf8")
      });
    }
  }
}

async function collectPluginFiles(
  localRoot: string,
  rootByName: (name: string) => string,
  pluginsDir: string,
  pluginNames: readonly string[],
  directoryEntry = true,
  discover = true
): Promise<{ files: RenderResult["files"]; entries: string[] }> {
  let names: string[];
  if (pluginNames.length > 0) {
    names = [...pluginNames];
  } else if (discover) {
    const sourceDir = path.join(localRoot, "opencode", "plugins");
    try {
      await stat(sourceDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], entries: [] };
      throw error;
    }
    const dirEntries = await readdir(sourceDir, { withFileTypes: true });
    const discovered = new Set<string>();
    for (const entry of dirEntries) {
      if (entry.isDirectory()) {
        discovered.add(entry.name);
      } else if (entry.isFile()) {
        const match = entry.name.match(/^(.+)\.[cm]?[jt]sx?$/);
        if (match) discovered.add(match[1]!);
      }
    }
    names = [...discovered];
  } else {
    names = [];
  }

  const files: RenderResult["files"] = [];
  const entries: string[] = [];
  const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

  for (const name of names) {
    const sourceDir = path.join(rootByName(name), "opencode", "plugins");
    const dirPath = path.join(sourceDir, name);
    let isDir = false;
    try {
      const s = await stat(dirPath);
      isDir = s.isDirectory();
    } catch {
      // not a directory
    }

    if (isDir) {
      await copyDirContents(dirPath, path.join(pluginsDir, name), files);
      if (directoryEntry) {
        try {
          await stat(path.join(dirPath, "package.json"));
          entries.push(`file://${path.join(pluginsDir, name)}`);
          continue;
        } catch {
          // Legacy local directory plugins use an index module.
        }
        const entry = await sourceExtensions.reduce<Promise<string | undefined>>(
          async (found, ext) => {
            if (await found) return found;
            try {
              await stat(path.join(dirPath, `index${ext}`));
              return `index${ext}`;
            } catch {
              return undefined;
            }
          },
          Promise.resolve(undefined)
        );
        if (!entry) throw new Error(`Unknown OpenCode plugin: ${name} (missing index module)`);
        entries.push(`file://${path.join(pluginsDir, name, entry)}`);
      } else {
        entries.push(`file://${path.join(pluginsDir, name)}`);
      }
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
      files.push({
        path: path.join(pluginsDir, destRel),
        content
      });
      entries.push(`file://${path.join(pluginsDir, destRel)}`);
      break;
    }
  }

  return { files, entries };
}

async function collectMarkdownFiles(
  rootByName: (name: string) => string,
  configsOpencode: string,
  kind: "commands" | "agents",
  names: readonly string[]
): Promise<RenderResult["files"]> {
  const files: RenderResult["files"] = [];
  const label = kind === "commands" ? "command" : "agent";

  for (const name of names) {
    const sourceDir = path.join(rootByName(name), "opencode", kind);
    const fileName = `${name}.md`;
    const filePath = path.join(sourceDir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown ${label}: ${name}`);
      }
      throw error;
    }
    files.push({
      path: path.join(configsOpencode, kind, fileName),
      content
    });
  }

  return files;
}

export async function renderOpenCode(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: OpenCodeRenderOptions = {}
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsOpencode = path.join(configsProfile, "opencode");
  const pluginsPath = path.join(configsOpencode, "plugins");
  const appliedPluginsPath = path.join(paths.opencodeConfigDir, "plugins", "mindframe-z");
  const configPath = path.join(configsOpencode, "opencode.jsonc");
  const tuiConfigPath = path.join(configsOpencode, "tui.json");
  const packagePath = path.join(configsOpencode, "package.json");
  const pluginResult = await collectPluginFiles(
    paths.root,
    (name) => profile.sources.plugins.get(name)?.root ?? paths.root,
    appliedPluginsPath,
    profile.profile.opencode.plugins
  );
  const tuiPluginResult = await collectPluginFiles(
    paths.root,
    (name) => profile.sources.plugins.get(name)?.root ?? paths.root,
    appliedPluginsPath,
    profile.profile.opencode.tui_plugins,
    true,
    false
  );
  const plugin = pluginResult.entries;
  const commandFiles = await collectMarkdownFiles(
    (name) => profile.sources.commands.get(name)?.root ?? paths.root,
    configsOpencode,
    "commands",
    profile.enabledCommands
  );
  const agentFiles = await collectMarkdownFiles(
    (name) => profile.sources.agents.get(name)?.root ?? paths.root,
    configsOpencode,
    "agents",
    profile.enabledAgents
  );
  const instructions = [path.join(configsProfile, "AGENTS.md"), referenceIndexPath(paths)];
  const mcp = Object.fromEntries(
    filterMcpForTarget(profile, "opencode").map(({ name, server, enabled }) => {
      if (server.type === "remote") {
        return [
          name,
          {
            type: "remote",
            url: server.url,
            enabled,
            ...(server.headers ? { headers: server.headers } : {})
          }
        ];
      }
      return [
        name,
        {
          type: "local",
          command: server.command.map((part) => expandHome(part, paths.home)),
          enabled,
          ...(server.env ? { env: server.env } : {})
        }
      ];
    })
  );
  const extraFolders = profile.extraFolders;
  const externalDirectory: Record<string, string> = {};
  const edit: Record<string, string> = {};

  const refPattern = `${profile.referencesDir}/**`;
  externalDirectory[refPattern] = "allow";
  edit[refPattern] = "deny";

  if (hasManagedZsh(profile)) {
    const pattern = `${zshSecretsDir(paths)}/**`;
    externalDirectory[pattern] = "deny";
    edit[pattern] = "deny";
  }

  for (const folder of extraFolders) {
    const absPath = expandHome(folder.path, paths.home);
    const pattern = `${absPath}/**`;
    externalDirectory[pattern] = folder.read;
    if (folder.edit !== "allow") {
      edit[pattern] = folder.edit;
    }
  }

  const folderPermission = { external_directory: externalDirectory, edit };
  const machinePermission = profile.manifests.machine.opencode.permission as
    | Record<string, unknown>
    | undefined;
  const mergedPerms = machinePermission
    ? deepMerge(folderPermission, machinePermission)
    : folderPermission;

  if (extraFolders.length > 0) {
    instructions.push(extraFoldersIndexPath(paths));
  }

  const profilePermission = profile.profile.opencode.config.permission as
    | Record<string, unknown>
    | undefined;
  const permission = profilePermission ? deepMerge(profilePermission, mergedPerms) : mergedPerms;
  const config = {
    ...profile.profile.opencode.config,
    ...(permission ? { permission } : {}),
    $schema: "https://opencode.ai/config.json",
    instructions,
    plugin,
    mcp
  };
  const renderedConfig = mergeSkillOverrides("opencode", config, {
    ...skillRuntimeDefaults(profile, "opencode"),
    ...options.skillOverrides
  });
  const hasTuiConfig =
    Object.keys(profile.profile.opencode.tui).length > 0 || tuiPluginResult.entries.length > 0;
  const tuiConfig = hasTuiConfig
    ? {
        ...profile.profile.opencode.tui,
        $schema: "https://opencode.ai/tui.json",
        plugin: tuiPluginResult.entries
      }
    : undefined;
  const dependencies = profile.profile.opencode.dependencies;
  const hasDependencies = Object.keys(dependencies).length > 0;

  const pluginFiles = [
    ...new Map(
      [...pluginResult.files, ...tuiPluginResult.files].map((file) => [file.path, file])
    ).values()
  ];
  const files: RenderResult["files"] = [
    ...commandFiles,
    ...agentFiles,
    { path: configPath, content: jsonFileContent(renderedConfig) },
    ...(hasDependencies ? [{ path: packagePath, content: jsonFileContent({ dependencies }) }] : []),
    ...(tuiConfig ? [{ path: tuiConfigPath, content: jsonFileContent(tuiConfig) }] : [])
  ];
  const links: RenderResult["links"] = [
    { linkPath: path.join(paths.opencodeConfigDir, "opencode.jsonc"), targetPath: configPath },
    ...(tuiConfig
      ? [{ linkPath: path.join(paths.opencodeConfigDir, "tui.json"), targetPath: tuiConfigPath }]
      : []),
    ...(hasDependencies
      ? [{ linkPath: path.join(paths.opencodeConfigDir, "package.json"), targetPath: packagePath }]
      : []),
    {
      linkPath: path.join(paths.opencodeConfigDir, "commands"),
      targetPath: path.join(configsOpencode, "commands")
    },
    {
      linkPath: path.join(paths.opencodeConfigDir, "agents"),
      targetPath: path.join(configsOpencode, "agents")
    }
  ];

  const delegateGeneral = profile.profile.opencode.delegate_general;
  if (delegateGeneral) {
    const delegateGeneralPath = path.join(configsOpencode, "delegate-general.json");
    files.push({ path: delegateGeneralPath, content: jsonFileContent(delegateGeneral) });
    links.push({
      linkPath: path.join(paths.opencodeConfigDir, "delegate-general.json"),
      targetPath: delegateGeneralPath
    });
  }

  return {
    files,
    localFiles: pluginFiles,
    localStaleFiles: [appliedPluginsPath],
    links,
    staleFiles: hasDependencies
      ? [pluginsPath, path.join(configsOpencode, "agent-task.json")]
      : [pluginsPath, packagePath, path.join(configsOpencode, "agent-task.json")],
    staleLinks: [
      {
        linkPath: path.join(configsOpencode, "node_modules"),
        targetPath: path.join(paths.opencodeConfigDir, "node_modules")
      },
      {
        linkPath: path.join(paths.opencodeConfigDir, "agent-task.json"),
        targetPath: path.join(configsOpencode, "agent-task.json")
      },
      ...(!hasDependencies
        ? [
            {
              linkPath: path.join(paths.opencodeConfigDir, "package.json"),
              targetPath: packagePath
            }
          ]
        : [])
    ]
  };
}
