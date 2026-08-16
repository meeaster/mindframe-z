import { readJsoncObject } from "../core/fs-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import { syncDocumentSchema, unmanagedCandidates, type SyncResult } from "./types.js";

export async function syncOpencode(
  configPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const existing = syncDocumentSchema.parse(await readJsoncObject(configPath));

  const managedKeys = new Set([
    "$schema",
    "instructions",
    "plugin",
    "mcp",
    "permission",
    ...Object.keys(profile.profile.opencode.config)
  ]);

  return { candidates: unmanagedCandidates(existing, "opencode", "opencode.config", managedKeys) };
}

export async function syncOpencodeV2(
  configPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const existing = syncDocumentSchema.parse(await readJsoncObject(configPath));
  const managedKeys = new Set([
    "$schema",
    "instructions",
    "mcp",
    "plugins",
    "skills",
    "permissions",
    ...Object.keys(profile.profile.opencode_v2.config)
  ]);
  return {
    candidates: unmanagedCandidates(existing, "opencode-v2", "opencode_v2.config", managedKeys)
  };
}
