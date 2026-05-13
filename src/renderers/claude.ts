import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";

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

  return {
    files: [
      { path: claudeMdPath, content: claudeMd },
      { path: settingsPath, content: `${JSON.stringify(settings, null, 2)}\n` }
    ],
    links: [
      { linkPath: path.join(paths.claudeDir, "CLAUDE.md"), targetPath: claudeMdPath },
      { linkPath: path.join(paths.claudeDir, "settings.json"), targetPath: settingsPath }
    ]
  };
}
