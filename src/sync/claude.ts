import { readJsonObject } from "../core/fs-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { SyncResult, SyncCandidate } from "./types.js";

export async function syncClaude(
  settingsPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];
  const existing = await readJsonObject(settingsPath);

  const managedKeys = new Set(Object.keys(profile.profile.claude.settings));
  managedKeys.add("model");
  managedKeys.add("permissions");
  managedKeys.add("additionalDirectories");

  for (const [key, value] of Object.entries(existing)) {
    if (!managedKeys.has(key)) {
      candidates.push({
        target: "claude",
        yamlPrefix: "claude.settings",
        key,
        value
      });
    }
  }

  return { candidates };
}
