import path from "node:path";
import { findProjectRoot } from "../core/git-root.js";
import { globalSkillStatePath, type RuntimePaths } from "../core/paths.js";

export type SkillToggleTarget = "opencode" | "claude-code" | "codex";

export type SkillConfigPaths =
  | {
      readonly scope: "repo";
      readonly repoRoot: string;
      readonly home: string;
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

export async function resolveSkillConfigPaths(
  paths: RuntimePaths,
  cwd = process.cwd()
): Promise<SkillConfigPaths> {
  const repoRoot = await findProjectRoot(cwd);
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
    global,
    state
  };
}
