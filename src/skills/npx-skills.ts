import { execa } from "execa";
import type { ToolTarget } from "../core/paths.js";
import { expandHome, type RuntimePaths } from "../core/paths.js";
import type { SkillEntry } from "../core/manifests.js";

export function buildNpxSkillsCommand(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget,
): string[] {
  const agent = target === "claude-code" ? "claude-code" : "opencode";
  if (skill.source === "local") {
    if (!skill.path) throw new Error(`Local skill ${skill.name} is missing path`);
    return [
      "npx",
      "skills",
      "add",
      expandHome(skill.path, paths.home),
      ...(skill.skill ? ["--skill", skill.skill] : []),
      "-a",
      agent,
      "-g",
      "-y",
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
    "-y",
  ];
}

export async function applySkill(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget,
  dryRun: boolean,
): Promise<string> {
  const command = buildNpxSkillsCommand(paths, skill, target);
  if (dryRun) return command.join(" ");
  const [binary, ...args] = command;
  if (!binary) throw new Error("No skills command generated");
  await execa(binary, args, { stdio: "inherit" });
  return command.join(" ");
}
