import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { expandHome, profileConfigsDir } from "../core/paths.js";
import { deepMerge, filterMcpForTarget, type ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";
import { mergeSkillOverrides } from "../core/skill-overrides.js";
import { hasManagedZsh, zshSecretsDir } from "../core/zsh.js";

interface OpenCodeRenderOptions {
  readonly skillOverrides?: Record<string, boolean>;
}

function toJsonc(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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
    } else if (entry.isFile() && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      files.push({
        path: destPath,
        content: await readFile(srcPath, "utf8")
      });
    }
  }
}

async function collectPluginFiles(
  root: string,
  configsOpencode: string,
  pluginNames: readonly string[]
): Promise<{ files: RenderResult["files"]; entries: string[] }> {
  const sourceDir = path.join(root, "opencode", "plugins");
  try {
    await stat(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], entries: [] };
    throw error;
  }

  let names: string[];
  if (pluginNames.length > 0) {
    names = [...pluginNames];
  } else {
    const dirEntries = await readdir(sourceDir, { withFileTypes: true });
    const discovered = new Set<string>();
    for (const entry of dirEntries) {
      if (entry.isDirectory()) {
        discovered.add(entry.name);
      } else if (entry.isFile()) {
        const match = entry.name.match(/^(.+)\.[cm]?[jt]s$/);
        if (match) discovered.add(match[1]!);
      }
    }
    names = [...discovered];
  }

  const files: RenderResult["files"] = [];
  const entries: string[] = [];
  const sourceExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

  for (const name of names) {
    const dirPath = path.join(sourceDir, name);
    let isDir = false;
    try {
      const s = await stat(dirPath);
      isDir = s.isDirectory();
    } catch {
      // not a directory
    }

    if (isDir) {
      await copyDirContents(dirPath, path.join(configsOpencode, "plugins", name), files);
      entries.push(`file://${path.join(configsOpencode, "plugins", name)}`);
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
        path: path.join(configsOpencode, "plugins", destRel),
        content
      });
      entries.push(`file://${path.join(configsOpencode, "plugins", destRel)}`);
      break;
    }
  }

  return { files, entries };
}

async function collectCommandFiles(
  root: string,
  configsOpencode: string,
  commandNames: readonly string[]
): Promise<RenderResult["files"]> {
  const sourceDir = path.join(root, "opencode", "commands");
  const files: RenderResult["files"] = [];

  for (const commandName of commandNames) {
    const fileName = `${commandName}.md`;
    const filePath = path.join(sourceDir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown command: ${commandName}`);
      }
      throw error;
    }
    files.push({
      path: path.join(configsOpencode, "commands", fileName),
      content
    });
  }

  return files;
}

async function collectAgentFiles(
  root: string,
  configsOpencode: string,
  agentNames: readonly string[]
): Promise<RenderResult["files"]> {
  const sourceDir = path.join(root, "opencode", "agents");
  const files: RenderResult["files"] = [];

  for (const agentName of agentNames) {
    const fileName = `${agentName}.md`;
    const filePath = path.join(sourceDir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown agent: ${agentName}`);
      }
      throw error;
    }
    files.push({
      path: path.join(configsOpencode, "agents", fileName),
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
  const configPath = path.join(configsOpencode, "opencode.jsonc");
  const pluginResult = await collectPluginFiles(
    paths.root,
    configsOpencode,
    profile.profile.opencode.plugins
  );
  const plugin = pluginResult.entries;
  const commandFiles = await collectCommandFiles(
    paths.root,
    configsOpencode,
    profile.enabledCommands
  );
  const agentFiles = await collectAgentFiles(
    paths.root,
    configsOpencode,
    profile.enabledAgents
  );
  const instructions = [
    path.join(configsProfile, "AGENTS.md"),
    path.join(paths.home, ".mindframe-z", "references.md")
  ];
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
    instructions.push(path.join(paths.home, ".mindframe-z", "extra_folders.md"));
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
  const renderedConfig = mergeSkillOverrides("opencode", config, options.skillOverrides ?? {});

  const files: RenderResult["files"] = [
    ...pluginResult.files,
    ...commandFiles,
    ...agentFiles,
    { path: configPath, content: toJsonc(renderedConfig) }
  ];
  const links: RenderResult["links"] = [
    { linkPath: path.join(paths.opencodeConfigDir, "opencode.jsonc"), targetPath: configPath },
    {
      linkPath: path.join(paths.opencodeConfigDir, "commands"),
      targetPath: path.join(configsOpencode, "commands")
    },
    {
      linkPath: path.join(paths.opencodeConfigDir, "agents"),
      targetPath: path.join(configsOpencode, "agents")
    }
  ];

  const agentTask = profile.profile.opencode.agent_task;
  if (agentTask) {
    const agentTaskPath = path.join(configsOpencode, "agent-task.json");
    files.push({ path: agentTaskPath, content: toJsonc(agentTask) });
    links.push({
      linkPath: path.join(paths.opencodeConfigDir, "agent-task.json"),
      targetPath: agentTaskPath
    });
  }

  return { files, links };
}
