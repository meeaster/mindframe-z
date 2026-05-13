import { execa } from "execa";
import path from "node:path";
import type { ToolTarget } from "../core/paths.js";
import type { RuntimePaths } from "../core/paths.js";
import type { SkillEntry } from "../core/manifests.js";

export function buildNpxSkillsCommand(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget
): string[] {
  const agent = target === "claude-code" ? "claude-code" : "opencode";
  if (skill.source === "local") {
    return [
      "npx",
      "skills",
      "add",
      path.join(paths.root, "skills"),
      ...(skill.skill ? ["--skill", skill.skill] : []),
      "-a",
      agent,
      "-g",
      "-y"
    ];
  }
  if (!skill.repo) throw new Error(`Git skill ${skill.name} is missing repo`);
  return [
    "npx",
    "skills",
    "add",
    skill.repo,
    ...(skill.skill ? ["--skill", skill.skill] : []),
    "-a",
    agent,
    "-g",
    "-y"
  ];
}

export function buildNpxSkillsUpdateCommand(skill: SkillEntry): string[] | null {
  if (skill.source === "local") return null;
  return ["npx", "skills", "update", skill.name, "-g", "-y"];
}

export async function listInstalledSkills(): Promise<Set<string>> {
  const { stdout } = await execa("npx", ["skills", "list", "-g", "--json"], { timeout: 30000 });
  const skills = JSON.parse(stdout) as { name: string }[];
  return new Set(skills.map((s) => s.name));
}

async function runCommand(command: string[], emptyCommandMessage: string): Promise<string> {
  const [binary, ...args] = command;
  if (!binary) throw new Error(emptyCommandMessage);
  await execa(binary, args, { stdio: "inherit" });
  return command.join(" ");
}

export async function applySkill(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget,
  dryRun: boolean,
  installedSkills?: ReadonlySet<string>
): Promise<string> {
  const command = buildNpxSkillsCommand(paths, skill, target);
  if (dryRun) return command.join(" ");

  if ((installedSkills ?? (await listInstalledSkills())).has(skill.name)) {
    return `skipped: ${skill.name} (already installed)`;
  }

  return runCommand(command, "No skills command generated");
}

export async function updateSkill(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget,
  dryRun: boolean
): Promise<string> {
  const updateCommand = buildNpxSkillsUpdateCommand(skill);
  if (!updateCommand) {
    const command = buildNpxSkillsCommand(paths, skill, target);
    if (dryRun) return command.join(" ");
    return runCommand(command, "No skills command generated");
  }

  if (dryRun) return updateCommand.join(" ");
  return runCommand(updateCommand, "No skills update command generated");
}
