import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { globalSkillStatePath, type AgentName, type RuntimePaths } from "../core/paths.js";

export type SkillToggleTarget = AgentName;

export type SkillConfigPaths =
  | {
      readonly scope: "repo";
      readonly repoRoot: string;
      readonly home: string;
      readonly active: Record<SkillToggleTarget, string>;
      readonly global: Record<SkillToggleTarget, string>;
      readonly state: Record<SkillToggleTarget, string>;
    }
  | {
      readonly scope: "global";
      readonly home: string;
      readonly active: Record<SkillToggleTarget, string>;
      readonly global: Record<SkillToggleTarget, string>;
      readonly state: Record<SkillToggleTarget, string>;
    };

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd });
    const gitRoot = stdout.trim();
    return gitRoot.length > 0 ? gitRoot : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveSkillConfigPaths(
  paths: RuntimePaths,
  cwd = process.cwd()
): Promise<SkillConfigPaths> {
  const repoRoot = await findGitRoot(cwd);
  const global = {
    opencode: path.join(paths.opencodeConfigDir, "opencode.jsonc"),
    "claude-code": path.join(paths.claudeDir, "settings.json"),
    codex: path.join(paths.codexDir, "config.toml")
  };
  const state = {
    opencode: globalSkillStatePath(paths, "opencode"),
    "claude-code": globalSkillStatePath(paths, "claude-code"),
    codex: globalSkillStatePath(paths, "codex")
  };
  if (!repoRoot) return { scope: "global", home: paths.home, active: global, global, state };
  return {
    scope: "repo",
    repoRoot,
    home: paths.home,
    active: {
      opencode: path.join(repoRoot, ".opencode", "opencode.jsonc"),
      "claude-code": path.join(repoRoot, ".claude", "settings.local.json"),
      codex: path.join(repoRoot, ".codex", "config.toml")
    },
    global,
    state
  };
}

async function gitPath(root: string, gitPath: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--git-path", gitPath], { cwd: root });
  return path.resolve(root, stdout.trim());
}

async function ensureGitExcluded(root: string, pattern: string): Promise<void> {
  const excludeFile = await gitPath(root, "info/exclude");
  try {
    const content = await readFile(excludeFile, "utf8");
    if (content.split("\n").some((line) => line.trimEnd() === pattern)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(excludeFile), { recursive: true });
  await appendFile(excludeFile, `\n${pattern}\n`, "utf8");
}

export async function ensureActiveGitExcluded(
  configPaths: SkillConfigPaths,
  target: SkillToggleTarget
): Promise<void> {
  if (configPaths.scope === "repo") {
    await ensureGitExcluded(configPaths.repoRoot, excludePattern(target));
  }
}

function excludePattern(target: SkillToggleTarget): string {
  if (target === "opencode") return ".opencode/opencode.jsonc";
  return target === "codex" ? ".codex/config.toml" : ".claude/settings.local.json";
}
