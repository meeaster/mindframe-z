import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MachineManifest } from "./manifests.js";
import type { RuntimePaths } from "./paths.js";

export function gitIdentityFragmentPath(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "gitconfig");
}

export function globalGitConfigPath(paths: RuntimePaths): string {
  return path.join(paths.home, ".gitconfig");
}

function quoteGitConfigValue(value: string): string {
  return JSON.stringify(value);
}

export function renderGitIdentityFragment(machine: MachineManifest): string {
  const entries = [
    machine.git.name ? `\tname = ${quoteGitConfigValue(machine.git.name)}` : undefined,
    machine.git.email ? `\temail = ${quoteGitConfigValue(machine.git.email)}` : undefined
  ].filter((line): line is string => Boolean(line));

  return [
    "# Managed by mindframe-z. Edit ~/.mindframe-z/config.yml, then run mfz apply.",
    ...(entries.length > 0 ? ["[user]", ...entries] : []),
    ""
  ].join("\n");
}

export function renderGitIncludeLine(paths: RuntimePaths): string {
  return `\tpath = ${gitIdentityFragmentPath(paths)}`;
}

export async function writeGitIdentityFragment(
  paths: RuntimePaths,
  machine: MachineManifest
): Promise<string> {
  const fragmentPath = gitIdentityFragmentPath(paths);
  await mkdir(path.dirname(fragmentPath), { recursive: true });
  await writeFile(fragmentPath, renderGitIdentityFragment(machine), "utf8");
  return fragmentPath;
}

export async function ensureGitConfigInclude(paths: RuntimePaths): Promise<string> {
  const configPath = globalGitConfigPath(paths);
  const includeLine = renderGitIncludeLine(paths);
  let existing = "";
  try {
    existing = await readFile(configPath, "utf8");
  } catch {
    // Missing ~/.gitconfig is created below.
  }

  const lines = existing.split("\n");
  const withoutManagedInclude = lines.filter((line) => line.trim() !== includeLine.trim());
  const next = [withoutManagedInclude.join("\n").trimEnd(), "", "[include]", includeLine, ""]
    .filter((part, index) => part !== "" || index > 0)
    .join("\n");

  if (next !== existing) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, next, "utf8");
  }
  return configPath;
}
