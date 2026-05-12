import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
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
  pluginNames: readonly string[],
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
        content: await readFile(sourcePath, "utf8"),
      });
    }
  }

  await walk(sourceDir);
  return files;
}

export async function renderOpenCode(
  paths: RuntimePaths,
  profile: ResolvedProfile,
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsOpencode = path.join(configsProfile, "opencode");
  const configPath = path.join(configsOpencode, "opencode.jsonc");
  const pluginFiles = await collectPluginFiles(
    paths.root,
    configsOpencode,
    profile.profile.opencode_plugins,
  );
  const plugin = pluginFiles.map((file) => `file://${file.path}`);
  const instructions = [
    path.join(configsProfile, "AGENTS.md"),
    path.join(configsProfile, "references.md"),
  ];
  const mcp = Object.fromEntries(
    filterMcpForTarget(profile, "opencode").map(({ name, server, enabled }) => {
      if (server.type === "remote") {
        return [name, { type: "remote", url: server.url, enabled }];
      }
      return [
        name,
        {
          type: "local",
          command: server.command.map((part) => expandHome(part, paths.home)),
          enabled,
          ...(server.env ? { env: server.env } : {}),
        },
      ];
    }),
  );

  // Read existing config to preserve unmanaged keys
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // File doesn't exist yet
  }

  // Remove profile-managed keys from existing (they'll be overwritten)
  const managedKeys = new Set(Object.keys(profile.profile.opencode));
  const unmanaged = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !managedKeys.has(key)),
  );

  // Derived keys that are always overwritten
  const config = {
    // Start with unmanaged existing keys
    ...unmanaged,
    // Then managed keys from profile (overwrites existing)
    ...profile.profile.opencode,
    // Then derived keys (always overwrite)
    $schema: "https://opencode.ai/config.json",
    instructions,
    plugin,
    mcp,
  };

  return {
    files: [...pluginFiles, { path: configPath, content: toJsonc(config) }],
    links: [
      { linkPath: path.join(paths.opencodeConfigDir, "opencode.jsonc"), targetPath: configPath },
    ],
  };
}
