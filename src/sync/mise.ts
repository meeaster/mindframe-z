import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { z } from "zod";
import { ENGINE_MISE_DEFAULT_TOOLS } from "../core/mise-defaults.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { SyncResult, SyncCandidate } from "./types.js";

const renderedMiseSchema = z.object({
  tools: z.record(z.string(), z.unknown()).default({}),
  env: z.record(z.string(), z.unknown()).default({}),
  tool_alias: z.record(z.string(), z.unknown()).default({}),
  settings: z.record(z.string(), z.unknown()).default({})
});

export async function syncMise(configPath: string, profile: ResolvedProfile): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];

  let existing: z.infer<typeof renderedMiseSchema>;
  try {
    const raw = await readFile(configPath, "utf8");
    existing = renderedMiseSchema.parse(parse(raw));
  } catch {
    return { candidates };
  }

  const managedTools = new Set(Object.keys(profile.profile.mise.tools));
  const managedEnv = new Set(Object.keys(profile.profile.mise.env));
  const managedAliases = new Set(Object.keys(profile.profile.mise.tool_alias));
  const managedSettings = new Set(Object.keys(profile.profile.mise.settings));

  for (const key of Object.keys(existing.tools)) {
    if (
      key in ENGINE_MISE_DEFAULT_TOOLS &&
      existing.tools[key] ===
        ENGINE_MISE_DEFAULT_TOOLS[key as keyof typeof ENGINE_MISE_DEFAULT_TOOLS] &&
      !(key in profile.profile.mise.tools)
    ) {
      continue;
    }
    if (!managedTools.has(key)) {
      candidates.push({
        target: "mise",
        yamlPrefix: "mise.tools",
        key,
        value: existing.tools[key]
      });
    }
  }

  for (const key of Object.keys(existing.env)) {
    if (!managedEnv.has(key)) {
      candidates.push({
        target: "mise",
        yamlPrefix: "mise.env",
        key,
        value: existing.env[key]
      });
    }
  }

  for (const key of Object.keys(existing.tool_alias)) {
    if (!managedAliases.has(key)) {
      candidates.push({
        target: "mise",
        yamlPrefix: "mise.tool_alias",
        key,
        value: existing.tool_alias[key]
      });
    }
  }

  for (const key of Object.keys(existing.settings)) {
    if (!managedSettings.has(key)) {
      candidates.push({
        target: "mise",
        yamlPrefix: "mise.settings",
        key,
        value: existing.settings[key]
      });
    }
  }

  return { candidates };
}
