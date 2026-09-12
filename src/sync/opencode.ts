import { readJsoncObject } from "../core/fs-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import { syncDocumentSchema, unmanagedCandidates, type SyncResult } from "./types.js";

export async function syncOpenCode(
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
    ...Object.keys(profile.profile.opencode.config)
  ]);

  return {
    candidates: unmanagedCandidates(existing, "opencode", "opencode.config", managedKeys)
  };
}
