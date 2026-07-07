import { z } from "zod";
import { codexPluginSchema } from "../core/manifests.js";
import type { ResolvedProfile } from "../core/profile.js";
import { readTomlObject } from "../core/skill-overrides.js";
import { CODEX_DERIVED_KEYS } from "../renderers/codex.js";
import type { SyncCandidate, SyncResult } from "./types.js";

const codexPluginTableSchema = z.record(z.string(), codexPluginSchema).catch({});

export async function syncCodex(
  snapshotConfigPath: string,
  localConfigPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];
  const existing = await readTomlObject(snapshotConfigPath);
  const local = await readTomlObject(localConfigPath);
  const declaredPlugins = new Set(Object.keys(profile.profile.codex.plugins));
  const localPlugins = codexPluginTableSchema.parse(local.plugins);

  for (const [id, plugin] of Object.entries(localPlugins)) {
    if (declaredPlugins.has(id) || !plugin.enabled) continue;
    candidates.push({
      target: "codex",
      yamlPrefix: "codex.plugins",
      key: id,
      value: { enabled: true }
    });
  }

  const managedKeys = new Set(Object.keys(profile.profile.codex.config));
  for (const [key, value] of Object.entries(existing)) {
    if (CODEX_DERIVED_KEYS.has(key) || managedKeys.has(key)) continue;
    candidates.push({ target: "codex", yamlPrefix: "codex.config", key, value });
  }
  return { candidates };
}
