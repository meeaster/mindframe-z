import { readJsoncObject } from "../core/fs-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import { unmanagedCandidates, type SyncResult } from "./types.js";

export async function syncOpencode(
  configPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const existing = await readJsoncObject(configPath);

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
