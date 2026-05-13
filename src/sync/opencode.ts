import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import type { ResolvedProfile } from "../core/profile.js";
import type { SyncResult, SyncCandidate } from "./types.js";

export async function syncOpencode(
  configPath: string,
  profile: ResolvedProfile
): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    return { candidates };
  }

  const derived = new Set(["$schema", "instructions", "plugin", "mcp"]);
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
