import { readFile } from "node:fs/promises";
import path from "node:path";
import { planFileOutcome, writeFileOutcome, type WriteFileOptions } from "./file-operations.js";
import type { MachineManifest } from "./manifests.js";
import type { OperationCompletion, OperationOutcome } from "./operations.js";
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
  machine: MachineManifest,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const fragmentPath = gitIdentityFragmentPath(paths);
  const options: WriteFileOptions = {};
  if (onComplete) options.onComplete = onComplete;
  return writeFileOutcome(fragmentPath, renderGitIdentityFragment(machine), options);
}

export async function planGitIdentityFragment(
  paths: RuntimePaths,
  machine: MachineManifest,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const options: WriteFileOptions = {};
  if (onComplete) options.onComplete = onComplete;
  return planFileOutcome(
    gitIdentityFragmentPath(paths),
    renderGitIdentityFragment(machine),
    options
  );
}

export async function ensureGitConfigInclude(
  paths: RuntimePaths,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const { configPath, content } = await intendedGitConfig(paths);
  const options: WriteFileOptions = {};
  if (onComplete) options.onComplete = onComplete;
  return writeFileOutcome(configPath, content, options);
}

export async function planGitConfigInclude(
  paths: RuntimePaths,
  onComplete?: OperationCompletion
): Promise<OperationOutcome> {
  const { configPath, content } = await intendedGitConfig(paths);
  const options: WriteFileOptions = {};
  if (onComplete) options.onComplete = onComplete;
  return planFileOutcome(configPath, content, options);
}

async function intendedGitConfig(paths: RuntimePaths): Promise<{
  configPath: string;
  content: string;
}> {
  const configPath = globalGitConfigPath(paths);
  const includeLine = renderGitIncludeLine(paths);
  let existing = "";
  try {
    existing = await readFile(configPath, "utf8");
  } catch {
    // Missing ~/.gitconfig is created below.
  }

  const lines = existing.split("\n");
  const managedInclude = includeLine.trim();
  const managedIncludeIndexes: number[] = [];
  let inUnconditionalInclude = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*\[/.test(line)) {
      inUnconditionalInclude = /^\s*\[\s*include\s*\]\s*(?:[#;].*)?$/i.test(line);
      continue;
    }
    if (inUnconditionalInclude && line.trim() === managedInclude) {
      managedIncludeIndexes.push(index);
    }
  }

  if (managedIncludeIndexes.length === 1) return { configPath, content: existing };

  if (managedIncludeIndexes.length > 1) {
    const redundantManagedIncludes = new Set(managedIncludeIndexes.slice(1));
    const content = lines.filter((_line, index) => !redundantManagedIncludes.has(index)).join("\n");
    return { configPath, content };
  }

  const content = [existing.trimEnd(), "", "[include]", includeLine, ""]
    .filter((part, index) => part !== "" || index > 0)
    .join("\n");
  return { configPath, content };
}
