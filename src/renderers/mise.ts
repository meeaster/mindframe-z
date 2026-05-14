import path from "node:path";
import { stringify } from "smol-toml";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";

function miseToolsToToml(
  tools: Record<string, string | Record<string, unknown>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tools)) {
    result[key] = value;
  }
  return result;
}

export async function renderMise(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsMise = path.join(configsProfile, "mise");
  const configPath = path.join(configsMise, "config.toml");

  const { tools, env, tool_alias, settings } = profile.profile.mise;
  const managed = {
    ...(Object.keys(tools).length > 0 ? { tools: miseToolsToToml(tools) } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(tool_alias).length > 0 ? { tool_alias } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  };

  const content = Object.keys(managed).length > 0 ? stringify(managed) : "";

  return {
    files: [{ path: configPath, content }],
    links: [{ linkPath: path.join(paths.miseConfigDir, "config.toml"), targetPath: configPath }]
  };
}
