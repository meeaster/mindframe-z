import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";
import { hasManagedZsh, zshLocalFile, zshSecretsFile } from "../core/zsh.js";

function renderZshrc(paths: RuntimePaths, content: string): string {
  const userBin = path.join(paths.home, ".local", "bin");

  return [
    "# Managed by mindframe-z. Edit the profile-owned .zshrc source, then run mfz apply.",
    `if [[ ":$PATH:" != *":${userBin}:"* ]]; then`,
    `  export PATH=${JSON.stringify(`${userBin}:$PATH`)}`,
    "fi",
    "",
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

function renderBashrc(paths: RuntimePaths, content: string): string {
  const userBin = path.join(paths.home, ".local", "bin");

  return [
    "# Managed by mindframe-z. Edit the profile-owned .bashrc source, then run mfz apply.",
    `case ":$PATH:" in`,
    `  *":${userBin}:"*) ;;`,
    `  *) export PATH=${JSON.stringify(`${userBin}:$PATH`)} ;;`,
    "esac",
    "",
    content.trimEnd(),
    ""
  ].join("\n");
}

function renderDotfile(paths: RuntimePaths, filename: string, content: string): string {
  if (filename === ".zshrc") return renderZshrc(paths, content);

  if (filename === ".bashrc") return renderBashrc(paths, content);

  return content;
}

export async function renderDotfiles(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsDotfiles = path.join(configsProfile, "dotfiles");
  const legacyOpencode2Path = path.join(configsDotfiles, ".local", "bin", "opencode2");

  const files = Object.entries(profile.profile.dotfiles).map(([filename, content]) => {
    const file: RenderResult["files"][number] = {
      path: path.join(configsDotfiles, filename),
      content: renderDotfile(paths, filename, content)
    };

    if (filename.startsWith(".local/bin/")) file.mode = 0o755;

    return file;
  });

  const links = Object.keys(profile.profile.dotfiles).map((filename) => ({
    linkPath: path.join(paths.home, filename),
    targetPath: path.join(configsDotfiles, filename)
  }));

  const result: RenderResult = {
    files,
    staleFiles: [legacyOpencode2Path],
    staleLinks: [
      {
        linkPath: path.join(paths.home, ".local", "bin", "opencode2"),
        targetPath: legacyOpencode2Path
      }
    ],
    links
  };

  if (hasManagedZsh(profile)) {
    result.localFiles = [{ path: zshSecretsFile(paths), content: "", ifMissing: true }];
  }

  return result;
}
