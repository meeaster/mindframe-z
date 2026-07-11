import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import { deepMerge, type ResolvedProfile } from "../core/profile.js";
import { readJsonObject } from "../core/fs-util.js";
import type { RenderResult } from "../core/render.js";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

async function renderPiAgents(paths: RuntimePaths, profile: ResolvedProfile): Promise<string> {
  const parts: string[] = [];
  for (const file of profile.instructionFiles) parts.push(await readFile(file, "utf8"));
  for (const file of [
    path.join(paths.home, ".mindframe-z", "references.md"),
    ...(profile.extraFolders.length > 0
      ? [path.join(paths.home, ".mindframe-z", "extra_folders.md")]
      : [])
  ]) {
    try {
      parts.push(await readFile(file, "utf8"));
    } catch {
      // Dry-run renders may happen before local indexes are written.
    }
  }
  return (
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
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
  const agents = await renderPiAgents(paths, profile);
  const files: RenderResult["files"] = [
    { path: settingsPath, content: json(settings) },
    { path: agentsPath, content: agents }
  ];
  const localFiles: NonNullable<RenderResult["localFiles"]> = [
    {
      path: localSettingsPath,
      content: json(deepMerge(await readJsonObject(localSettingsPath), settings))
    },
    { path: localAgentsPath, content: agents }
  ];

  const subagentConfig = profile.profile.pi.subagent_config;
  if (hasKeys(subagentConfig)) {
    const subagentConfigPath = path.join(configsPi, "extensions", "subagent", "config.json");
    const localSubagentConfigPath = path.join(paths.piDir, "extensions", "subagent", "config.json");
    files.push({ path: subagentConfigPath, content: json(subagentConfig) });
    localFiles.push({
      path: localSubagentConfigPath,
      content: json(deepMerge(await readJsonObject(localSubagentConfigPath), subagentConfig))
    });
  }

  return { files, localFiles, links: [] };
}
