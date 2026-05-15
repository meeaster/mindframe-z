import path from "node:path";
import { readFile } from "node:fs/promises";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";

function deepMergeSettings(base: Record<string, unknown>, override: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMergeSettings(
        existing as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function readExistingSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function renderClaude(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsClaude = path.join(configsProfile, "claude");
  const claudeMdPath = path.join(configsClaude, "CLAUDE.md");
  const settingsPath = path.join(configsClaude, "settings.json");
  const claudeMd =
    [
      "# CLAUDE.md",
      "",
      `@${path.join(configsProfile, "AGENTS.md")}`,
      `@${path.join(configsProfile, "references.md")}`,
      "",
      "## Claude Code",
      "",
      "Use the shared AI configuration rendered by mindframe-z."
    ].join("\n") + "\n";

  const settings = {
    ...profile.profile.claude.settings,
    ...(profile.profile.claude.model ? { model: profile.profile.claude.model } : {})
  };
  const localSettingsPath = path.join(paths.claudeDir, "settings.json");
  const mergedSettings = deepMergeSettings(await readExistingSettings(localSettingsPath), settings);

  return {
    files: [
      { path: claudeMdPath, content: claudeMd },
      { path: settingsPath, content: `${JSON.stringify(settings, null, 2)}\n` }
    ],
    localFiles: [
      { path: localSettingsPath, content: `${JSON.stringify(mergedSettings, null, 2)}\n` }
    ],
    links: [{ linkPath: path.join(paths.claudeDir, "CLAUDE.md"), targetPath: claudeMdPath }]
  };
}
