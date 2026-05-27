import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";
import { hasManagedZsh, zshLocalFile, zshSecretsFile } from "../core/zsh.js";

function renderZshrc(paths: RuntimePaths, content: string): string {
  return [
    "# Managed by mindframe-z. Edit the profile-owned .zshrc source, then run mfz apply.",
    `if [ -r ${JSON.stringify(zshSecretsFile(paths))} ]; then`,
    `  source ${JSON.stringify(zshSecretsFile(paths))}`,
    "fi",
    "",
    content.trimEnd(),
    "",
    `if [ -r ${JSON.stringify(zshLocalFile(paths))} ]; then`,
    `  source ${JSON.stringify(zshLocalFile(paths))}`,
    "fi",
    ""
  ].join("\n");
}

export async function renderDotfiles(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsDotfiles = path.join(configsProfile, "dotfiles");

  const files = Object.entries(profile.profile.dotfiles).map(([filename, content]) => ({
    path: path.join(configsDotfiles, filename),
    content: filename === ".zshrc" ? renderZshrc(paths, content) : content
  }));

  const links = Object.keys(profile.profile.dotfiles).map((filename) => ({
    linkPath: path.join(paths.home, filename),
    targetPath: path.join(configsDotfiles, filename)
  }));

  return {
    files,
    ...(hasManagedZsh(profile)
      ? { localFiles: [{ path: zshSecretsFile(paths), content: "", ifMissing: true }] }
      : {}),
    links
  };
}
