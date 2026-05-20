import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { machineSchema } from "./manifests.js";

export type AgentName = "opencode" | "claude-code";
export type ToolTarget = "opencode" | "claude-code" | "mise" | "dotfiles";
export type InfraTarget = "mise" | "dotfiles";
export type ApplyTarget = ToolTarget | "all";
export type ApplyAgent = AgentName | "all";

export interface RuntimePaths {
  root: string;
  home: string;
  configsDir: string;
  opencodeConfigDir: string;
  claudeDir: string;
  miseConfigDir: string;
}

export interface PathOptions {
  root?: string | undefined;
  home?: string | undefined;
  opencodeConfigDir?: string | undefined;
  claudeDir?: string | undefined;
}

export function packageRootFromImport(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "../..");
}

export function expandHome(value: string, home = process.env.HOME ?? ""): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function machineRepoPath(home: string): string | undefined {
  try {
    const parsed = YAML.parse(readFileSync(path.join(home, ".mindframe-z", "config.yml"), "utf8"));
    return machineSchema.parse(parsed).repo_path;
  } catch {
    return undefined;
  }
}

export function resolveRoot(input?: string, home = process.env.HOME ?? ""): string {
  return path.resolve(
    expandHome(input ?? process.env.MFZ_ROOT ?? machineRepoPath(home) ?? process.cwd(), home)
  );
}

export function createRuntimePaths(options: PathOptions = {}): RuntimePaths {
  const home = path.resolve(
    expandHome(options.home ?? process.env.MFZ_HOME ?? process.env.HOME ?? process.cwd())
  );
  const root = resolveRoot(options.root, home);
  return {
    root,
    home,
    configsDir: path.join(root, "configs"),
    opencodeConfigDir: path.resolve(
      expandHome(
        options.opencodeConfigDir ??
          process.env.OPENCODE_CONFIG_DIR ??
          path.join(home, ".config", "opencode"),
        home
      )
    ),
    claudeDir: path.resolve(
      expandHome(
        options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
        home
      )
    ),
    miseConfigDir: path.resolve(
      expandHome(process.env.MISE_CONFIG_DIR ?? path.join(home, ".config", "mise"), home)
    )
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function profileConfigsDir(paths: RuntimePaths, profileName: string): string {
  return path.join(paths.configsDir, profileName);
}

export function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function targetList(target: ApplyTarget): ToolTarget[] {
  return target === "all" ? ["opencode", "claude-code", "mise", "dotfiles"] : [target];
}

export function infraTargetList(target: InfraTarget | "all"): InfraTarget[] {
  return target === "all" ? ["mise", "dotfiles"] : [target];
}

export function agentList(agent: ApplyAgent, profileAgents: AgentName[]): AgentName[] {
  return agent === "all" ? profileAgents : [agent];
}
