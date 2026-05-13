import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { expandHome, profileConfigsDir } from "../core/paths.js";
import { filterMcpForTarget, type ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";

function toJsonc(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function collectPluginFiles(
  root: string,
  configsOpencode: string,
  pluginNames: readonly string[]
): Promise<RenderResult["files"]> {
  const sourceDir = path.join(root, "opencode", "plugins");
  try {
    await stat(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const selected = new Set(pluginNames);
  const includeAll = selected.size === 0;
  const files: RenderResult["files"] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const sourcePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(sourcePath);
        continue;
      }
      if (!entry.isFile() || !/\.[cm]?[jt]s$/.test(entry.name)) continue;
      const relative = path.relative(sourceDir, sourcePath);
      const pluginName = relative.split(path.sep)[0]?.replace(/\.[cm]?[jt]s$/, "");
      if (!includeAll && (!pluginName || !selected.has(pluginName))) continue;
      files.push({
        path: path.join(configsOpencode, "plugins", relative),
        content: await readFile(sourcePath, "utf8")
      });
    }
  }

  await walk(sourceDir);
  return files;
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
    files.push({
      path: path.join(configsOpencode, "commands", fileName),
      content: await readFile(path.join(sourceDir, fileName), "utf8")
    });
  }

  return files;
}

export async function renderOpenCode(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsOpencode = path.join(configsProfile, "opencode");
  const configPath = path.join(configsOpencode, "opencode.jsonc");
  const pluginFiles = await collectPluginFiles(
    paths.root,
    configsOpencode,
    profile.profile.opencode_plugins
  );
  const plugin = pluginFiles.map((file) => `file://${file.path}`);
  const commandFiles = await collectCommandFiles(
    paths.root,
    configsOpencode,
    profile.enabledCommands
  );
  const instructions = [
    path.join(configsProfile, "AGENTS.md"),
    path.join(configsProfile, "references.md")
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
  const machinePermission = profile.manifests.machine.opencode.permission;
  const config = {
    ...profile.profile.opencode,
    ...(machinePermission ? { permission: machinePermission } : {}),
    $schema: "https://opencode.ai/config.json",
    instructions,
    plugin,
    mcp
  };

  return {
    files: [...pluginFiles, ...commandFiles, { path: configPath, content: toJsonc(config) }],
    links: [
      { linkPath: path.join(paths.opencodeConfigDir, "opencode.jsonc"), targetPath: configPath },
      {
        linkPath: path.join(paths.opencodeConfigDir, "commands"),
        targetPath: path.join(configsOpencode, "commands")
      }
    ]
  };
}
