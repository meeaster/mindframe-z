import { readJsonObject } from "../core/fs-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import { syncDocumentSchema, unmanagedCandidates, type SyncResult } from "./types.js";

export async function syncClaude(
  settingsPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const existing = syncDocumentSchema.parse(await readJsonObject(settingsPath));

  const managedKeys = new Set(Object.keys(profile.profile.claude.settings));
  managedKeys.add("model");
  managedKeys.add("permissions");
  managedKeys.add("additionalDirectories");

  return { candidates: unmanagedCandidates(existing, "claude", "claude.settings", managedKeys) };
}
