import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { ReferenceEntry } from "../core/manifests.js";
import { expandHome, profileConfigsDir, type RuntimePaths } from "../core/paths.js";
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
  const indexPath = path.join(profileConfigsDir(paths, profile.name), "references.md");
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

export function referenceRows(profile: ResolvedProfile): string[] {
  const enabled = new Set(profile.enabledReferences.map((ref) => ref.name));
  return profile.manifests.references.map((ref) => {
    const marker = enabled.has(ref.name) ? "enabled" : "available";
    return `${ref.name}\t${marker}\t${expandHome(referencePath(profile, ref), profile.referencesDir)}\t${ref.description}`;
  });
}
