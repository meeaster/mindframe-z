import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa, ExecaError } from "execa";
import { writeTextFile } from "../core/fs-util.js";
import type { ReferenceEntry } from "../core/manifests.js";
import {
  expandHome,
  extraFoldersIndexPath,
  referenceIndexPath,
  type RuntimePaths
} from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";

type RunGit = (file: string, args: readonly string[], options: { stdio: "pipe" }) => Promise<void>;
type GitError = ExecaError<{ stdio: "pipe" }>;

async function runGitCommand(
  file: string,
  args: readonly string[],
  options: { stdio: "pipe" }
): Promise<void> {
  await execa(file, args, options);
}

export function referencePath(profile: ResolvedProfile, reference: ReferenceEntry): string {
  return path.join(profile.referencesDir, reference.name);
}

export function referenceIndexContent(profile: ResolvedProfile): string {
  const lines = [
    "# Enabled References",
    "",
    "Reference repositories are cloned git repos providing documentation, code, and context for AI agents. They are read-only snapshots — do not edit, modify, reorganize, or write to any file within a reference path. If you need to change reference content, ask the user to update the upstream repo.",
    ""
  ];
  for (const ref of profile.enabledReferences) {
    lines.push(`- \`${ref.name}\`: ${ref.description} Path: \`${referencePath(profile, ref)}\`.`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeReferenceIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<string> {
  const content = referenceIndexContent(profile);
  const indexPath = referenceIndexPath(paths);
  await writeTextFile(indexPath, content);
  return indexPath;
}

export async function syncReference(
  profile: ResolvedProfile,
  name: string,
  runGit: RunGit = runGitCommand
): Promise<string> {
  const ref =
    profile.enabledReferences.find((entry) => entry.name === name) ??
    profile.manifests.references.find((entry) => entry.name === name);
  if (!ref) throw new Error(`Unknown reference: ${name}`);
  const destination = referencePath(profile, ref);
  await mkdir(profile.referencesDir, { recursive: true });
  let destinationExists = true;
  try {
    await access(destination);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    destinationExists = false;
  }
  if (destinationExists) {
    await updateReference(destination, ref.ref, runGit);
    return `updated ${name} at ${destination}`;
  }
  const cloneArgs = ["clone"];
  if (ref.ref) cloneArgs.push("--branch", ref.ref);
  cloneArgs.push(ref.url, destination);
  await runGit("git", cloneArgs, { stdio: "pipe" });
  return `cloned ${name} to ${destination}`;
}

async function updateReference(
  destination: string,
  ref: string | undefined,
  runGit: RunGit
): Promise<void> {
  if (ref) {
    await runGit("git", ["-C", destination, "fetch", "origin", ref], { stdio: "pipe" });
    await runGit("git", ["-C", destination, "checkout", "--force", "-B", ref, `origin/${ref}`], {
      stdio: "pipe"
    });
    return;
  }
  try {
    await pullReference(destination, runGit);
  } catch (error) {
    if (!(error instanceof ExecaError) || !isStaleRemoteRefError(error)) throw error;
    await runGit("git", ["-C", destination, "remote", "prune", "origin"], { stdio: "pipe" });
    await pullReference(destination, runGit);
  }
}

async function pullReference(destination: string, runGit: RunGit): Promise<void> {
  await runGit("git", ["-C", destination, "pull", "--ff-only"], { stdio: "pipe" });
}

export function isStaleRemoteRefError(error: GitError): boolean {
  return (
    (error.stderr ?? "").includes("some local refs could not be updated") &&
    (error.stderr ?? "").includes("git remote prune origin")
  );
}

export async function writeExtraFoldersIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<string | undefined> {
  const folders = profile.extraFolders;
  const indexPath = extraFoldersIndexPath(paths);

  if (folders.length === 0) {
    await rm(indexPath, { force: true });
    return undefined;
  }

  const content = extraFoldersIndexContent(paths, profile);
  await writeTextFile(indexPath, content);
  return indexPath;
}

export function extraFoldersIndexContent(paths: RuntimePaths, profile: ResolvedProfile): string {
  const folders = profile.extraFolders;
  const lines = [
    "# Extra Folders",
    "",
    "Use this as the capability map for cross-repository work or when a named repository's role is unclear. Descriptions identify each folder's role; permissions state the allowed access.",
    ""
  ];
  for (const folder of folders) {
    const absPath = expandHome(folder.path, paths.home);
    const suffix = folder.description ? ` - ${folder.description}` : "";
    lines.push(`- \`${absPath}\`${suffix} (read: ${folder.read}, edit: ${folder.edit})`);
  }
  lines.push("");
  return lines.join("\n");
}

export function referenceRows(profile: ResolvedProfile): string[] {
  const enabled = new Set(profile.enabledReferences.map((ref) => ref.name));
  return profile.manifests.references.map((ref) => {
    const marker = enabled.has(ref.name) ? "enabled" : "available";
    return `${ref.name}\t${marker}\t${expandHome(referencePath(profile, ref), profile.referencesDir)}\t${ref.description}`;
  });
}
