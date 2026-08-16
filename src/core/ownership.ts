import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "./fs-util.js";
import { profileConfigsDir, type RuntimePaths } from "./paths.js";

export type OwnershipTarget = "mise";

export interface OwnershipEntry {
  snapshots: string[];
  host: string[];
}

export interface OwnershipManifest {
  version: 1;
  targets: Partial<Record<OwnershipTarget, OwnershipEntry>>;
}

export interface RenderOwnership {
  target: OwnershipTarget;
  snapshots: string[];
  host: string[];
}

const manifestName = ".mfz-owned.json";
const activeProfileName = ".active-profile";
const ownershipEntrySchema = z.object({
  snapshots: z.array(z.string()),
  host: z.array(z.string())
});
const ownershipManifestSchema = z.object({
  version: z.literal(1),
  targets: z.record(z.string(), ownershipEntrySchema)
});

export function ownershipManifestPath(paths: RuntimePaths, profileName: string): string {
  return path.join(profileConfigsDir(paths, profileName), manifestName);
}

export function activeProfilePath(paths: RuntimePaths): string {
  return path.join(paths.configsDir, activeProfileName);
}

export async function readActiveProfile(paths: RuntimePaths): Promise<string | undefined> {
  try {
    const value = (await readFile(activeProfilePath(paths), "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function readOwnership(
  paths: RuntimePaths,
  profileName: string,
  target: OwnershipTarget
): Promise<OwnershipEntry> {
  try {
    const parsed = ownershipManifestSchema
      .partial({ version: true })
      .parse(JSON.parse(await readFile(ownershipManifestPath(paths, profileName), "utf8")));
    const entry = parsed.targets?.[target];
    if (!entry) return { snapshots: [], host: [] };
    const snapshotRoot = path.join(profileConfigsDir(paths, profileName), "mise");
    const hostRoot = paths.miseConfigDir;
    const safe = (root: string, value: string): boolean => {
      if (path.isAbsolute(value) || value.includes("\\")) return false;
      const resolved = path.resolve(root, value);
      const relative = path.relative(root, resolved);
      return (
        relative === value &&
        relative !== "" &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      );
    };
    return {
      snapshots: entry.snapshots.filter((value) => safe(snapshotRoot, value)),
      host: entry.host.filter((value) => safe(hostRoot, value))
    };
  } catch {
    return { snapshots: [], host: [] };
  }
}

export async function writeOwnership(
  paths: RuntimePaths,
  profileName: string,
  ownership: RenderOwnership
): Promise<void> {
  const file = ownershipManifestPath(paths, profileName);
  let manifest: OwnershipManifest = { version: 1, targets: {} };
  try {
    manifest = ownershipManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    // A corrupt ownership file cannot authorize cleanup; replace it with current state.
  }
  manifest.targets[ownership.target] = relativeOwnership(
    paths,
    profileName,
    ownership.target,
    ownership
  );
  await writeJsonFileAtomic(file, manifest);
}

export function relativeOwnership(
  paths: RuntimePaths,
  profileName: string,
  target: OwnershipTarget,
  ownership: RenderOwnership
): OwnershipEntry {
  const snapshotRoot = path.join(profileConfigsDir(paths, profileName), "mise");
  const hostRoot = paths.miseConfigDir;
  return {
    snapshots: ownership.snapshots.map((file) => path.relative(snapshotRoot, file)),
    host: ownership.host.map((file) => path.relative(hostRoot, file))
  };
}
