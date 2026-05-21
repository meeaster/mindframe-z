import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { ReferenceEntry } from "../core/manifests.js";
import { expandHome, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";

export function referencePath(profile: ResolvedProfile, reference: ReferenceEntry): string {
  return path.join(profile.referencesDir, reference.name);
}

export async function writeReferenceIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<string> {
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
  const indexPath = path.join(paths.home, ".mindframe-z", "references.md");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, lines.join("\n"), "utf8");
  return indexPath;
}

export async function syncReference(profile: ResolvedProfile, name: string): Promise<string> {
  const ref =
    profile.enabledReferences.find((entry) => entry.name === name) ??
    profile.manifests.references.find((entry) => entry.name === name);
  if (!ref) throw new Error(`Unknown reference: ${name}`);
  const destination = referencePath(profile, ref);
  await mkdir(profile.referencesDir, { recursive: true });
  try {
    await access(destination);
    await execa("git", ["-C", destination, "pull", "--ff-only"], { stdio: "pipe" });
    return `updated ${name} at ${destination}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await execa("git", ["clone", ref.url, destination], { stdio: "pipe" });
      return `cloned ${name} to ${destination}`;
    }
    throw error;
  }
}

export async function writeExtraFoldersIndex(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<string | undefined> {
  const folders = profile.extraFolders;
  const indexPath = path.join(paths.home, ".mindframe-z", "extra_folders.md");

  if (folders.length === 0) {
    await rm(indexPath, { force: true });
    return undefined;
  }

  const lines = [
    "# Extra Folders",
    "",
    "Additional directories outside the workspace that agents are permitted to access. Each entry lists the effective permissions granted. When in doubt about whether a path is accessible, check this file.",
    ""
  ];
  for (const folder of folders) {
    const absPath = expandHome(folder.path, paths.home);
    const suffix = folder.description ? ` - ${folder.description}` : "";
    lines.push(`- \`${absPath}\`${suffix} (read: ${folder.read}, edit: ${folder.edit})`);
  }
  lines.push("");

  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, lines.join("\n"), "utf8");
  return indexPath;
}

export function referenceRows(profile: ResolvedProfile): string[] {
  const enabled = new Set(profile.enabledReferences.map((ref) => ref.name));
  return profile.manifests.references.map((ref) => {
    const marker = enabled.has(ref.name) ? "enabled" : "available";
    return `${ref.name}\t${marker}\t${expandHome(referencePath(profile, ref), profile.referencesDir)}\t${ref.description}`;
  });
}
