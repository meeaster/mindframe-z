import path from "node:path";
import { globalSkillStatePath, type RuntimePaths } from "../core/paths.js";

export type SkillToggleTarget = "claude-code" | "codex";

export interface SkillConfigPaths {
  readonly home: string;
  readonly active: Record<SkillToggleTarget, string>;
  readonly state: Record<SkillToggleTarget, string>;
}

export function resolveSkillConfigPaths(paths: RuntimePaths): SkillConfigPaths {
  return {
    home: paths.home,
    active: {
      "claude-code": path.join(paths.claudeDir, "settings.json"),
      codex: path.join(paths.codexDir, "config.toml")
    },
    state: {
      "claude-code": globalSkillStatePath(paths, "claude-code"),
      codex: globalSkillStatePath(paths, "codex")
    }
  };
}
