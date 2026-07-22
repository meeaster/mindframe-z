import { readJsoncObject } from "../core/fs-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { SyncResult, SyncCandidate } from "./types.js";

export async function syncOpencode(
  configPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];
  const existing = await readJsoncObject(configPath);

  const derived = new Set(["$schema", "instructions", "plugin", "mcp", "permission"]);
  const managedKeys = new Set(Object.keys(profile.profile.opencode.config));

  for (const [key, value] of Object.entries(existing)) {
    if (derived.has(key)) continue;
    if (!managedKeys.has(key)) {
      candidates.push({
        target: "opencode",
        yamlPrefix: "opencode.config",
        key,
        value
      });
    }
  }

  return { candidates };
}
