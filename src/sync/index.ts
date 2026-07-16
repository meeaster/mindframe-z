import { readFile, readdir, writeFile } from "node:fs/promises";
import * as readline from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import path from "node:path";
import { execa } from "execa";
import { parse, stringify } from "smol-toml";
import YAML from "yaml";
import { eachUpstream } from "../core/manifests.js";
import { profileConfigsDir, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { syncMise } from "./mise.js";
import { syncOpencode } from "./opencode.js";
import { syncClaude } from "./claude.js";
import { syncCodex } from "./codex.js";
import type { SyncCandidate } from "./types.js";

type ProfileChoice =
  | { kind: "profile"; name: string }
  | { kind: "skip" }
  | { kind: "unknown"; answer: string };

interface SyncTarget {
  label: string;
  root: string;
  profile: string;
  upstream: boolean;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

export function setNested(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  value: unknown
): void {
  const parts = prefix.split(".").filter(Boolean);
  const leaf = parts.pop();
  if (!leaf) return;

  let current = obj;
  for (const part of parts) {
    current = ensureRecord(current, part);
  }
  ensureRecord(current, leaf)[key] = value;
}

export function parseProfileChoice(answer: string, profileNames: readonly string[]): ProfileChoice {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "skip" || trimmed === "" || trimmed === "s") return { kind: "skip" };
  if (profileNames.includes(trimmed)) return { kind: "profile", name: trimmed };
  const match = profileNames.find((name) => name.startsWith(trimmed));
  return match ? { kind: "profile", name: match } : { kind: "unknown", answer: trimmed };
}

async function readProfileYaml(
  root: string,
  targetProfile: string
): Promise<Record<string, unknown>> {
  const yamlPath = path.join(root, "profiles", targetProfile, "profile.yml");
  try {
    const parsed = YAML.parse(await readFile(yamlPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable profile YAML starts from the minimum profile shape.
  }
  return { name: targetProfile };
}

async function writeProfileYaml(
  root: string,
  targetProfile: string,
  doc: Record<string, unknown>
): Promise<void> {
  const yamlPath = path.join(root, "profiles", targetProfile, "profile.yml");
  await writeFile(yamlPath, YAML.stringify(doc, { lineWidth: 120 }), "utf8");
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
  ensureRecord(doc, section)[candidate.key] = candidate.value;
  await writeFile(tomlPath, stringify(doc), "utf8");
}

async function promptProfileChoice(
  message: string,
  profileNames: string[],
  quoteProfiles = false
): Promise<string | null> {
  const rl = readline.createInterface({ input: processStdin, output: processStdout });
  try {
    const options = profileNames.map((name) => (quoteProfiles ? `"${name}"` : name)).join(", ");
    const choice = parseProfileChoice(
      await rl.question(`${message}\n  Add to [${options}, skip]: `),
      profileNames
    );
    if (choice.kind === "profile") return choice.name;
    if (choice.kind === "unknown") {
      console.log(`  Unknown profile "${choice.answer}". Use: ${options}, skip`);
    }
    return null;
  } finally {
    rl.close();
  }
}

async function promptUser(
  candidate: SyncCandidate,
  profileNames: string[]
): Promise<string | null> {
  const formatted =
    typeof candidate.value === "string" ? candidate.value : JSON.stringify(candidate.value);
  return promptProfileChoice(
    `Unmanaged ${candidate.target}.${candidate.yamlPrefix}.${candidate.key} = ${formatted}`,
    profileNames,
    true
  );
}

interface UnknownCommand {
  name: string;
}

async function syncCommands(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<UnknownCommand[]> {
  let entries;
  try {
    entries = await readdir(path.join(paths.root, "opencode", "commands"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const enabled = new Set(profile.enabledCommands);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({ name: entry.name.slice(0, -3) }))
    .filter((command) => !enabled.has(command.name));
}

async function promptCommandUser(
  command: UnknownCommand,
  profileNames: string[]
): Promise<string | null> {
  return promptProfileChoice(`Unmanaged command: ${command.name}`, profileNames);
}

async function enableCommandInProfile(root: string, targetProfile: string, commandName: string) {
  const doc = await readProfileYaml(root, targetProfile);
  const oc = ensureRecord(doc, "opencode");
  if (!Array.isArray(oc.commands)) oc.commands = [];
  const profileCommands = oc.commands as unknown[];
  if (!profileCommands.includes(commandName)) profileCommands.push(commandName);
  await writeProfileYaml(root, targetProfile, doc);
}

async function isPushable(root: string): Promise<boolean> {
  try {
    await execa("git", ["push", "--dry-run"], { cwd: root, timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

async function syncTargets(profile: ResolvedProfile): Promise<SyncTarget[]> {
  const targets: SyncTarget[] = [...profile.manifests.profiles.keys()].map((name) => ({
    label: name,
    root: profile.manifests.root,
    profile: name,
    upstream: false
  }));
  for (const upstream of eachUpstream(profile.manifests)) {
    if (!(await isPushable(upstream.root))) continue;
    const prefix = upstream.aliasPath.join("/");
    for (const name of upstream.profiles.keys()) {
      targets.push({
        label: `${prefix}/${name}`,
        root: upstream.root,
        profile: name,
        upstream: true
      });
    }
  }
  return targets;
}

/**
 * Assign each unmanaged item to a destination profile. When `targetProfile` names an
 * available profile it is used for every item without prompting; otherwise `prompt`
 * decides per item, and items the user skips (a `null` answer) are dropped.
 */
export async function resolveMoves<T>(
  items: readonly T[],
  targetProfile: string | undefined,
  availableProfiles: string[],
  prompt: (item: T, profiles: string[]) => Promise<string | null>
): Promise<{ item: T; targetProfile: string }[]> {
  const moves: { item: T; targetProfile: string }[] = [];
  for (const item of items) {
    const chosen =
      targetProfile && availableProfiles.includes(targetProfile)
        ? targetProfile
        : await prompt(item, availableProfiles);
    if (chosen) moves.push({ item, targetProfile: chosen });
  }
  return moves;
}

export async function runSync(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  targetProfile?: string
): Promise<void> {
  const configsProfile = profileConfigsDir(paths, profile.name);

  const mcp = path.join(configsProfile, "mise", "config.toml");
  const ocp = path.join(configsProfile, "opencode", "opencode.jsonc");
  const clp = path.join(configsProfile, "claude", "settings.json");
  const cdx = path.join(configsProfile, "codex", "config.toml");

  const [miseResult, opencodeResult, claudeResult, codexResult, commandCandidates] =
    await Promise.all([
      syncMise(mcp, profile),
      profile.agents.includes("opencode")
        ? syncOpencode(ocp, profile)
        : Promise.resolve({ candidates: [] }),
      profile.agents.includes("claude-code")
        ? syncClaude(clp, profile)
        : Promise.resolve({ candidates: [] }),
      profile.agents.includes("codex")
        ? syncCodex(cdx, path.join(paths.codexDir, "config.toml"), profile)
        : Promise.resolve({ candidates: [] }),
      profile.agents.includes("opencode") ? syncCommands(paths, profile) : Promise.resolve([])
    ]);

  const candidates = [
    ...miseResult.candidates,
    ...opencodeResult.candidates,
    ...claudeResult.candidates,
    ...codexResult.candidates
  ];

  if (candidates.length === 0 && commandCandidates.length === 0) {
    console.log("No unmanaged keys found — everything is in sync.");
    return;
  }

  const availableTargets = await syncTargets(profile);
  const availableProfiles = availableTargets.map((target) => target.label);
  const targetByLabel = new Map(availableTargets.map((target) => [target.label, target]));

  const manualMoves = await resolveMoves(candidates, targetProfile, availableProfiles, promptUser);
  const commandMoves = await resolveMoves(
    commandCandidates,
    targetProfile,
    availableProfiles,
    promptCommandUser
  );

  for (const { item: command, targetProfile } of commandMoves) {
    const target = targetByLabel.get(targetProfile)!;
    await enableCommandInProfile(target.root, target.profile, command.name);
    console.log(`  Updated ${target.label}/profile.yml: opencode.commands.${command.name}`);
    if (target.upstream) console.log(`  Written to upstream home ${target.label} — uncommitted`);
  }

  for (const { item: candidate, targetProfile } of manualMoves) {
    const target = targetByLabel.get(targetProfile)!;
    if (candidate.target === "mise") {
      await writeMiseToml(target.root, target.profile, candidate);
      console.log(
        `  Updated ${target.label}/mise.toml: ${miseTomlSection(candidate)}.${candidate.key}`
      );
    } else {
      const doc = await readProfileYaml(target.root, target.profile);

      setNested(doc, candidate.yamlPrefix, candidate.key, candidate.value);

      await writeProfileYaml(target.root, target.profile, doc);
      console.log(
        `  Updated ${target.label}/profile.yml: ${candidate.yamlPrefix}.${candidate.key}`
      );
    }
    if (target.upstream) console.log(`  Written to upstream home ${target.label} — uncommitted`);
  }

  console.log("Sync complete. Run `mfz apply` to re-render.");
}
