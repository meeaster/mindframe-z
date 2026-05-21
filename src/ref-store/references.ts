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
  const lines = ["# Enabled References", ""];
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
  const folders = profile.manifests.machine.extra_folders;
  const indexPath = path.join(paths.home, ".mindframe-z", "extra_folders.md");

  if (folders.length === 0) {
    await rm(indexPath, { force: true });
    return undefined;
  }

  const lines = ["# Extra Folders", ""];
  for (const folder of folders) {
    const absPath = expandHome(folder.path, paths.home);
    const permParts: string[] = [];
    if (folder.read !== "allow") permParts.push(`read: ${folder.read}`);
    if (folder.edit !== "allow") permParts.push(`edit: ${folder.edit}`);
    const suffix =
      folder.description || permParts.length > 0
        ? ` - ${[folder.description, ...(permParts.length > 0 ? [`(${permParts.join(", ")})`] : [])].filter(Boolean).join(" ")}`
        : "";
    lines.push(`- \`${absPath}\`${suffix}`);
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
