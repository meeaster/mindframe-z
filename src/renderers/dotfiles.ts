import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { profileConfigsDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { RenderResult } from "../core/render.js";

export async function renderDotfiles(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<RenderResult> {
  const configsProfile = profileConfigsDir(paths, profile.name);
  const configsDotfiles = path.join(configsProfile, "dotfiles");

  const files = Object.entries(profile.profile.dotfiles).map(([filename, content]) => ({
    path: path.join(configsDotfiles, filename),
    content
  }));

  const links = Object.keys(profile.profile.dotfiles).map((filename) => ({
    linkPath: path.join(paths.home, filename),
    targetPath: path.join(configsDotfiles, filename)
  }));

  return { files, links };
}
