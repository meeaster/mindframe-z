import type { ResolvedProfile } from "../core/profile.js";
import { readTomlObject } from "../core/skill-overrides.js";
import { CODEX_DERIVED_KEYS } from "../renderers/codex.js";
import type { SyncCandidate, SyncResult } from "./types.js";

export async function syncCodex(configPath: string, profile: ResolvedProfile): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];
  const existing = await readTomlObject(configPath);

  const managedKeys = new Set(Object.keys(profile.profile.codex.config));
  for (const [key, value] of Object.entries(existing)) {
    if (CODEX_DERIVED_KEYS.has(key) || managedKeys.has(key)) continue;
    candidates.push({ target: "codex", yamlPrefix: "codex.config", key, value });
  }
  return { candidates };
}
