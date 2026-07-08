import { execa } from "execa";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolTarget } from "../core/paths.js";
import type { RuntimePaths } from "../core/paths.js";
import type { SkillEntry } from "../core/manifests.js";

interface ListedInstalledSkill {
  name: string;
  agents?: string[];
}

function targetSkillsDir(paths: RuntimePaths, target: ToolTarget): string | null {
  switch (target) {
    case "opencode":
      return path.join(paths.home, ".agents", "skills");
    case "claude-code":
      return path.join(paths.claudeDir, "skills");
    case "codex":
      return path.join(paths.home, ".agents", "skills");
    default:
      return null;
  }
}

function targetAgentDisplayName(
  target: Extract<ToolTarget, "opencode" | "claude-code" | "codex">
): string {
  if (target === "claude-code") return "Claude Code";
  return target === "codex" ? "Codex" : "OpenCode";
}

async function listSkillDirectories(skillsDir: string): Promise<Set<string>> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return new Set();
  }

  const installed = new Set<string>();
  for (const entry of entries) {
    const skillDir = path.join(skillsDir, entry.name);
    try {
      const dirStat = await stat(skillDir);
      if (!dirStat.isDirectory()) continue;
      await access(path.join(skillDir, "SKILL.md"));
      installed.add(entry.name);
    } catch {
      // Ignore non-skill entries and dangling links.
    }
  }

  return installed;
}

function skillsCliEnv(paths: RuntimePaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: paths.home,
    OPENCODE_CONFIG_DIR: paths.opencodeConfigDir,
    CLAUDE_CONFIG_DIR: paths.claudeDir
  };
}

async function listCliInstalledSkills(paths: RuntimePaths): Promise<ListedInstalledSkill[]> {
  try {
    const { stdout } = await execa("skills", ["list", "-g", "--json"], {
      env: skillsCliEnv(paths),
      timeout: 30000
    });
    return JSON.parse(stdout) as ListedInstalledSkill[];
  } catch {
    return [];
  }
}

export function buildSkillsCommand(
  paths: RuntimePaths,
  skill: SkillEntry & { sourceRoot?: string },
  target: ToolTarget
): string[] {
  const agent =
    target === "claude-code" ? "claude-code" : target === "codex" ? "codex" : "opencode";
  if (skill.source === "local") {
    return [
      "skills",
      "add",
      path.join(skill.sourceRoot ?? paths.root, "skills"),
      ...(skill.skill ? ["--skill", skill.skill] : []),
      // Grouped skills live under skills/<group>/<skill>/; --full-depth makes the
      // CLI recurse past its default depth-1 walk so nested skills are discovered.
      "--full-depth",
      "-a",
      agent,
      "-g",
      "-y"
    ];
  }
  if (!skill.repo) throw new Error(`Git skill ${skill.name} is missing repo`);
  return [
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

export function buildSkillsRemoveCommand(
  skill: SkillEntry,
  target?: Extract<ToolTarget, "opencode" | "claude-code" | "codex">
): string[] {
  const agent =
    target === "claude-code"
      ? "claude-code"
      : target === "codex"
        ? "codex"
        : target === "opencode"
          ? "opencode"
          : null;
  return ["skills", "remove", skill.name, "-g", ...(agent ? ["-a", agent] : []), "-y"];
}

export function buildSkillsUpdateCommand(skill: SkillEntry): string[] | null {
  if (skill.source === "local") return null;
  return ["skills", "update", skill.name, "-g", "-y"];
}

export async function listInstalledSkills(
  paths: RuntimePaths,
  target: Extract<ToolTarget, "opencode" | "claude-code" | "codex">
): Promise<Set<string>> {
  const skillsDir = targetSkillsDir(paths, target);
  if (!skillsDir) return new Set();

  const installed = await listSkillDirectories(skillsDir);
  const cliSkills = await listCliInstalledSkills(paths);
  const targetAgent = targetAgentDisplayName(target);
  for (const skill of cliSkills) {
    if (skill.agents?.includes(targetAgent)) installed.add(skill.name);
  }

  return installed;
}

async function runCommand(
  paths: RuntimePaths,
  command: string[],
  emptyCommandMessage: string
): Promise<string> {
  const [binary, ...args] = command;
  if (!binary) throw new Error(emptyCommandMessage);
  await execa(binary, args, { env: skillsCliEnv(paths), stdio: "inherit" });
  return command.join(" ");
}

export async function applySkill(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget,
  dryRun: boolean,
  installedSkills?: ReadonlySet<string>
): Promise<string> {
  const command = buildSkillsCommand(paths, skill, target);
  if (dryRun) return command.join(" ");

  if (target !== "opencode" && target !== "claude-code" && target !== "codex") {
    return runCommand(paths, command, "No skills command generated");
  }

  if ((installedSkills ?? (await listInstalledSkills(paths, target))).has(skill.name)) {
    return `skipped: ${skill.name} (already installed)`;
  }

  return runCommand(paths, command, "No skills command generated");
}

export async function removeSkill(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: Extract<ToolTarget, "opencode" | "claude-code" | "codex"> | undefined,
  dryRun: boolean,
  installedSkills?: ReadonlySet<string>
): Promise<string> {
  const command = buildSkillsRemoveCommand(skill, target);
  if (dryRun) return command.join(" ");

  if (target && !(installedSkills ?? (await listInstalledSkills(paths, target))).has(skill.name)) {
    return `skipped: ${skill.name} (not installed)`;
  }

  return runCommand(paths, command, "No skills command generated");
}

export async function updateSkill(
  paths: RuntimePaths,
  skill: SkillEntry,
  target: ToolTarget,
  dryRun: boolean
): Promise<string> {
  const updateCommand = buildSkillsUpdateCommand(skill);
  if (!updateCommand) {
    const command = buildSkillsCommand(paths, skill, target);
    if (dryRun) return command.join(" ");
    return runCommand(paths, command, "No skills command generated");
  }

  if (dryRun) return updateCommand.join(" ");
  return runCommand(paths, updateCommand, "No skills update command generated");
}
