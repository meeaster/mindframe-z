import path from "node:path";
import type { RuntimePaths } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";

export const zshSecretsFileName = "zsh.env";

export function hasManagedZsh(profile: ResolvedProfile): boolean {
  return Object.hasOwn(profile.profile.dotfiles, ".zshrc");
}

export function zshSecretsDir(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "secrets");
}

export function zshSecretsFile(paths: RuntimePaths): string {
  return path.join(zshSecretsDir(paths), zshSecretsFileName);
}

export function zshLocalFile(paths: RuntimePaths): string {
  return path.join(paths.home, ".zshrc.local");
}
