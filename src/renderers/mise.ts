import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";

function miseToolsToToml(
  tools: Record<string, string | Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tools)) {
    result[key] = value;
  }
  return result;
}

export async function renderMise(
  paths: RuntimePaths,
  profile: ResolvedProfile,
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsMise = path.join(configsProfile, "mise");
  const configPath = path.join(configsMise, "config.toml");

  const { tools, env, tool_alias } = profile.profile.mise;
  const managed = {
    ...(Object.keys(tools).length > 0 ? { tools: miseToolsToToml(tools) } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(tool_alias).length > 0 ? { tool_alias } : {}),
  };

  let merged: Record<string, unknown> = {};
  try {
    const existing = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    merged = { ...existing };
  } catch {
    // File doesn't exist yet — start fresh
  }

  // Overwrite managed keys, preserve unmanaged
  const managedEntries = Object.entries(managed);
  for (const [section, value] of managedEntries) {
    if (typeof value === "object" && value !== null) {
      merged[section] = {
        ...(merged[section] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      merged[section] = value;
    }
  }

  const content = Object.keys(merged).length > 0 ? stringify(merged) : "";

  return {
    files: [{ path: configPath, content }],
    links: [{ linkPath: path.join(paths.miseConfigDir, "config.toml"), targetPath: configPath }],
  };
}
