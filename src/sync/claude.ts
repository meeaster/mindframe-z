import { readFile } from "node:fs/promises";
import type { ResolvedProfile } from "../core/profile.js";
import type { SyncResult, SyncCandidate } from "./types.js";

export async function syncClaude(
  settingsPath: string,
  profile: ResolvedProfile,
): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { candidates };
  }

  const managedKeys = new Set(Object.keys(profile.profile.claude.settings));
  managedKeys.add("model");

  for (const [key, value] of Object.entries(existing)) {
    if (!managedKeys.has(key)) {
      candidates.push({
        target: "claude",
        yamlPrefix: "claude.settings",
        key,
        value,
      });
    }
  }

  return { candidates };
}
