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

export async function applySkill(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget,
  dryRun: boolean
): Promise<string> {
  const command = buildNpxSkillsCommand(paths, skill, target);
  if (dryRun) return command.join(" ");
  const [binary, ...args] = command;
  if (!binary) throw new Error("No skills command generated");
  await execa(binary, args, { stdio: "inherit" });
  return command.join(" ");
}
