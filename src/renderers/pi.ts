import path from "node:path";
import { profileConfigsDir, type RuntimePaths } from "../core/paths.js";
import { deepMerge, type ResolvedProfile } from "../core/profile.js";
import { jsonFileContent, readJsonObject } from "../core/fs-util.js";
import type { RenderResult } from "../core/render.js";
import { renderInlinedAgents } from "./agents-doc.js";

function hasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

export async function renderPi(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsPi = path.join(profileConfigsDir(paths, profile.name), "pi");
  const settingsPath = path.join(configsPi, "settings.json");
  const agentsPath = path.join(configsPi, "AGENTS.md");
  const localSettingsPath = path.join(paths.piDir, "settings.json");
  const localAgentsPath = path.join(paths.piDir, "AGENTS.md");

  const settings = profile.profile.pi.settings;
  const agents = await renderInlinedAgents(paths, profile);
  const files: RenderResult["files"] = [
    { path: settingsPath, content: jsonFileContent(settings) },
    { path: agentsPath, content: agents }
  ];
  const localFiles: NonNullable<RenderResult["localFiles"]> = [
    {
      path: localSettingsPath,
      content: jsonFileContent(deepMerge(await readJsonObject(localSettingsPath), settings))
    },
    { path: localAgentsPath, content: agents }
  ];

  const subagentConfig = profile.profile.pi.subagent_config;
  if (hasKeys(subagentConfig)) {
    const subagentConfigPath = path.join(configsPi, "extensions", "subagent", "config.json");
    const localSubagentConfigPath = path.join(paths.piDir, "extensions", "subagent", "config.json");
    files.push({ path: subagentConfigPath, content: jsonFileContent(subagentConfig) });
    localFiles.push({
      path: localSubagentConfigPath,
      content: jsonFileContent(
        deepMerge(await readJsonObject(localSubagentConfigPath), subagentConfig)
      )
    });
  }

  return { files, localFiles, links: [] };
}
