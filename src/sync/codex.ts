import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import type { ResolvedProfile } from "../core/profile.js";
import type { SyncCandidate, SyncResult } from "./types.js";

export async function syncCodex(configPath: string, profile: ResolvedProfile): Promise<SyncResult> {
  const candidates: SyncCandidate[] = [];
  let existing: Record<string, unknown> = {};
  try {
    const parsed = parse(await readFile(configPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    return { candidates };
  }

  const derived = new Set(["mcp_servers", "permissions", "default_permissions"]);
  const managedKeys = new Set(Object.keys(profile.profile.codex.config));
  for (const [key, value] of Object.entries(existing)) {
    if (derived.has(key) || managedKeys.has(key)) continue;
    candidates.push({ target: "codex", yamlPrefix: "codex.config", key, value });
  }
  return { candidates };
}
