import { readFile, writeFile } from "node:fs/promises";
import * as readline from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import YAML from "yaml";
import { profileConfigsDir, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { syncMise } from "./mise.js";
import { syncOpencode } from "./opencode.js";
import { syncClaude } from "./claude.js";
import type { SyncCandidate } from "./types.js";

function setNested(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  value: unknown,
): void {
  const parts = prefix.split(".");
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i === parts.length - 1) {
      const inner = current[part];
      if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
        (inner as Record<string, unknown>)[key] = value;
      } else {
        current[part] = { [key]: value };
      }
    } else {
      if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
  }
}

function miseTomlSection(candidate: SyncCandidate): string {
  const parts = candidate.yamlPrefix.split(".");
  return parts.length > 1 ? parts[1]! : "tools";
}

async function writeMiseToml(root: string, targetProfile: string, candidate: SyncCandidate) {
  const tomlPath = path.join(root, "profiles", targetProfile, "mise.toml");
  let doc: Record<string, unknown> = {};
  try {
    const raw = await readFile(tomlPath, "utf8");
    doc = parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist — start fresh
  }
  const section = miseTomlSection(candidate);
  if (!doc[section] || typeof doc[section] !== "object" || Array.isArray(doc[section])) {
    doc[section] = {};
  }
  (doc[section] as Record<string, unknown>)[candidate.key] = candidate.value;
  await writeFile(tomlPath, stringify(doc), "utf8");
}

async function promptUser(
  candidate: SyncCandidate,
  profileNames: string[],
): Promise<string | null> {
  const rl = readline.createInterface({ input: processStdin, output: processStdout });
  try {
    const formatted =
      typeof candidate.value === "string" ? candidate.value : JSON.stringify(candidate.value);
    const options = profileNames.map((n) => `"${n}"`).join(", ");
    const answer = await rl.question(
      `Unmanaged ${candidate.target}.${candidate.yamlPrefix}.${candidate.key} = ${formatted}\n  Add to [${options}, skip]: `,
    );
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "skip" || trimmed === "" || trimmed === "s") return null;
    if (profileNames.includes(trimmed)) return trimmed;
    const match = profileNames.find((n) => n.startsWith(trimmed));
    if (match) return match;
    console.log(`  Unknown profile "${trimmed}". Use: ${options}, skip`);
    return null;
  } finally {
    rl.close();
  }
}

export async function runSync(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  targetProfile?: string,
): Promise<void> {
  const configsProfile = profileConfigsDir(paths, profile.name);

  const mcp = path.join(configsProfile, "mise", "config.toml");
  const ocp = path.join(configsProfile, "opencode", "opencode.jsonc");
  const clp = path.join(configsProfile, "claude", "settings.json");

  const [miseResult, opencodeResult, claudeResult] = await Promise.all([
    syncMise(mcp, profile),
    syncOpencode(ocp, profile),
    syncClaude(clp, profile),
  ]);

  const candidates = [
    ...miseResult.candidates,
    ...opencodeResult.candidates,
    ...claudeResult.candidates,
  ];

  if (candidates.length === 0) {
    console.log("No unmanaged keys found — everything is in sync.");
    return;
  }

  const availableProfiles = ["base", profile.name];
  const uniqueProfiles = [...new Set(availableProfiles)];

  const manualMoves: { candidate: SyncCandidate; targetProfile: string }[] = [];

  for (const candidate of candidates) {
    const chosen =
      targetProfile && uniqueProfiles.includes(targetProfile)
        ? targetProfile
        : await promptUser(candidate, uniqueProfiles);
    if (chosen) {
      manualMoves.push({ candidate, targetProfile: chosen });
    }
  }

  for (const { candidate, targetProfile } of manualMoves) {
    if (candidate.target === "mise") {
      await writeMiseToml(paths.root, targetProfile, candidate);
      console.log(
        `  Updated ${targetProfile}/mise.toml: ${miseTomlSection(candidate)}.${candidate.key}`,
      );
    } else {
      const yamlPath = path.join(paths.root, "profiles", targetProfile, "profile.yml");
      let doc: Record<string, unknown>;
      try {
        const raw = await readFile(yamlPath, "utf8");
        doc = YAML.parse(raw) as Record<string, unknown>;
      } catch {
        doc = { name: targetProfile };
      }

      setNested(doc, candidate.yamlPrefix, candidate.key, candidate.value);

      const yaml = YAML.stringify(doc, { lineWidth: 120 });
      await writeFile(yamlPath, yaml, "utf8");
      console.log(
        `  Updated ${targetProfile}/profile.yml: ${candidate.yamlPrefix}.${candidate.key}`,
      );
    }
  }

  console.log("Sync complete. Run `mindframe-z apply` to re-render.");
}
