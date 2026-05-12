import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import type { ResolvedProfile } from "../core/profile.js";
import type { SyncResult, SyncCandidate } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function syncMise(configPath: string, profile: ResolvedProfile): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf8");
    existing = parse(raw) as Record<string, unknown>;
  } catch {
    return { candidates };
  }

  const managedTools = new Set(Object.keys(profile.profile.mise.tools));
  const managedEnv = new Set(Object.keys(profile.profile.mise.env));
  const managedAliases = new Set(Object.keys(profile.profile.mise.tool_alias));

  const existingTools = existing.tools;
  if (isRecord(existingTools)) {
    for (const key of Object.keys(existingTools)) {
      if (!managedTools.has(key)) {
        candidates.push({
          target: "mise",
          yamlPrefix: "mise.tools",
          key,
          value: existingTools[key],
        });
      }
    }
  }

  const existingEnv = existing.env;
  if (isRecord(existingEnv)) {
    for (const key of Object.keys(existingEnv)) {
      if (!managedEnv.has(key)) {
        candidates.push({
          target: "mise",
          yamlPrefix: "mise.env",
          key,
          value: existingEnv[key],
        });
      }
    }
  }

  const existingAliases = existing.tool_alias;
  if (isRecord(existingAliases)) {
    for (const key of Object.keys(existingAliases)) {
      if (!managedAliases.has(key)) {
        candidates.push({
          target: "mise",
          yamlPrefix: "mise.tool_alias",
          key,
          value: existingAliases[key],
        });
      }
    }
  }

  return { candidates };
}
