import { readFile, readdir, writeFile } from "node:fs/promises";
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
import { syncSkills, type UnknownSkill } from "./skills.js";
import type { SyncCandidate } from "./types.js";

type ProfileChoice =
  | { kind: "profile"; name: string }
  | { kind: "skip" }
  | { kind: "unknown"; answer: string };

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function setNested(
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

async function promptSkillUser(
  skill: UnknownSkill,
  profileNames: string[]
): Promise<string | null> {
  return promptProfileChoice(
    `Unmanaged skill: ${skill.name} (${skill.entry.repo ?? ""})`,
    profileNames
  );
}

async function writeSkillsCatalog(root: string, skills: UnknownSkill[]): Promise<void> {
  const yamlPath = path.join(root, "shared", "skills.yml");
  let doc: Record<string, unknown>;
  try {
    doc = YAML.parse(await readFile(yamlPath, "utf8")) as Record<string, unknown>;
  } catch {
    doc = { skills: [] };
  }
  if (!Array.isArray(doc.skills)) doc.skills = [];
  const catalog = doc.skills as unknown[];
  const existing = new Set(
    catalog
      .map((skill: unknown) =>
        skill && typeof skill === "object" && !Array.isArray(skill)
          ? (skill as Record<string, unknown>).name
          : undefined
      )
      .filter((name: unknown): name is string => typeof name === "string")
  );
  for (const skill of skills) {
    if (!existing.has(skill.name)) {
      catalog.push(skill.entry);
      existing.add(skill.name);
    }
  }
  await writeFile(yamlPath, YAML.stringify(doc, { lineWidth: 120 }), "utf8");
}

async function enableSkillInProfile(root: string, targetProfile: string, skillName: string) {
  const doc = await readProfileYaml(root, targetProfile);
  const profileSkills = ensureRecord(doc, "skills");
  if (!(skillName in profileSkills)) profileSkills[skillName] = ["opencode"];
  await writeProfileYaml(root, targetProfile, doc);
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

export async function runSync(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  targetProfile?: string
): Promise<void> {
  const configsProfile = profileConfigsDir(paths, profile.name);

  const mcp = path.join(configsProfile, "mise", "config.toml");
  const ocp = path.join(configsProfile, "opencode", "opencode.jsonc");
  const clp = path.join(configsProfile, "claude", "settings.json");

  const [miseResult, opencodeResult, claudeResult, skillCandidates, commandCandidates] =
    await Promise.all([
      syncMise(mcp, profile),
      profile.agents.includes("opencode")
        ? syncOpencode(ocp, profile)
        : Promise.resolve({ candidates: [] }),
      profile.agents.includes("claude-code")
        ? syncClaude(clp, profile)
        : Promise.resolve({ candidates: [] }),
      syncSkills(paths.home, profile.manifests, profile.agents),
      profile.agents.includes("opencode") ? syncCommands(paths, profile) : Promise.resolve([])
    ]);

  const candidates = [
    ...miseResult.candidates,
    ...opencodeResult.candidates,
    ...claudeResult.candidates
  ];

  if (candidates.length === 0 && skillCandidates.length === 0 && commandCandidates.length === 0) {
    console.log("No unmanaged keys found — everything is in sync.");
    return;
  }

  const availableProfiles = [...profile.manifests.profiles.keys()];

  const manualMoves: { candidate: SyncCandidate; targetProfile: string }[] = [];
  const skillMoves: { skill: UnknownSkill; targetProfile: string }[] = [];
  const commandMoves: { command: UnknownCommand; targetProfile: string }[] = [];

  for (const candidate of candidates) {
    const chosen =
      targetProfile && availableProfiles.includes(targetProfile)
        ? targetProfile
        : await promptUser(candidate, availableProfiles);
    if (chosen) {
      manualMoves.push({ candidate, targetProfile: chosen });
    }
  }

  for (const skill of skillCandidates) {
    const chosen =
      targetProfile && availableProfiles.includes(targetProfile)
        ? targetProfile
        : await promptSkillUser(skill, availableProfiles);
    if (chosen) {
      skillMoves.push({ skill, targetProfile: chosen });
    }
  }

  for (const command of commandCandidates) {
    const chosen =
      targetProfile && availableProfiles.includes(targetProfile)
        ? targetProfile
        : await promptCommandUser(command, availableProfiles);
    if (chosen) {
      commandMoves.push({ command, targetProfile: chosen });
    }
  }

  if (skillMoves.length > 0) {
    await writeSkillsCatalog(
      paths.root,
      skillMoves.map(({ skill }) => skill)
    );
    console.log("  Updated shared/skills.yml");
    for (const { skill, targetProfile } of skillMoves) {
      await enableSkillInProfile(paths.root, targetProfile, skill.name);
      console.log(`  Updated ${targetProfile}/profile.yml: skills.${skill.name}`);
    }
  }

  for (const { command, targetProfile } of commandMoves) {
    await enableCommandInProfile(paths.root, targetProfile, command.name);
    console.log(`  Updated ${targetProfile}/profile.yml: opencode.commands.${command.name}`);
  }

  for (const { candidate, targetProfile } of manualMoves) {
    if (candidate.target === "mise") {
      await writeMiseToml(paths.root, targetProfile, candidate);
      console.log(
        `  Updated ${targetProfile}/mise.toml: ${miseTomlSection(candidate)}.${candidate.key}`
      );
    } else {
      const doc = await readProfileYaml(paths.root, targetProfile);

      setNested(doc, candidate.yamlPrefix, candidate.key, candidate.value);

      await writeProfileYaml(paths.root, targetProfile, doc);
      console.log(
        `  Updated ${targetProfile}/profile.yml: ${candidate.yamlPrefix}.${candidate.key}`
      );
    }
  }

  console.log("Sync complete. Run `mfz apply` to re-render.");
}
