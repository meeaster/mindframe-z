import { access, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { machineSchema } from "./manifests.js";

export type AgentName = "opencode" | "claude-code" | "codex";
export type ToolTarget = "opencode" | "claude-code" | "codex" | "mise" | "dotfiles";
export type InfraTarget = "mise" | "dotfiles";
export type ApplyAgent = AgentName | "all";

export interface RuntimePaths {
  root: string;
  home: string;
  configsDir: string;
  opencodeConfigDir: string;
  claudeDir: string;
  codexDir: string;
  miseConfigDir: string;
}

export interface PathOptions {
  root?: string | undefined;
  home?: string | undefined;
  opencodeConfigDir?: string | undefined;
  claudeDir?: string | undefined;
  codexDir?: string | undefined;
}

export function packageRootFromImport(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "../..");
}

export function expandHome(value: string, home = process.env.HOME ?? ""): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function machineHomePath(home: string): string | undefined {
  try {
    const parsed = YAML.parse(readFileSync(path.join(home, ".mindframe-z", "config.yml"), "utf8"));
    return machineSchema.parse(parsed).home_path;
  } catch {
    return undefined;
  }
}

export function resolveRoot(input?: string, home = process.env.HOME ?? ""): string {
  return path.resolve(
    expandHome(input ?? process.env.MFZ_ROOT ?? machineHomePath(home) ?? process.cwd(), home)
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
    configsDir: path.join(home, ".mindframe-z", "configs"),
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
    codexDir: path.resolve(
      expandHome(options.codexDir ?? process.env.CODEX_HOME ?? path.join(home, ".codex"), home)
    ),
    miseConfigDir: path.resolve(
      expandHome(process.env.MISE_CONFIG_DIR ?? path.join(home, ".config", "mise"), home)
    )
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function profileConfigsDir(paths: RuntimePaths, profileName: string): string {
  return path.join(paths.configsDir, profileName);
}

export function globalSkillStatePath(paths: RuntimePaths, target: AgentName): string {
  return path.join(paths.home, ".mindframe-z", "skill-overrides", `${target}.json`);
}

export function overrideStorePath(home: string): string {
  return path.join(home, ".mindframe-z", "overrides.json");
}

export function threadStoreRoot(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "threads");
}

// Read-only, write-once cache of sessions hydrated from an S3 archive because they
// vanished from their live harness store. Gitignored; mounted read-only into the
// thread tools container (as a subtree of the existing whole-~/.mindframe-z mount).
export function archiveCacheRoot(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "archive-cache");
}

// OpenCode resolves its own data directory via `XDG_DATA_HOME` (falling back to
// `<home>/.local/share`) — the same precedence the `xdg-basedir` package it depends on
// uses internally. Mirrored here so mfz's direct db reads and its `opencode export`
// shell-out always agree with the real `opencode` binary on the same on-disk database,
// even under mfz's own --home/MFZ_HOME override (used by tests and sandboxed runs).
export function opencodeDataHome(paths: RuntimePaths): string {
  return process.env.XDG_DATA_HOME ?? path.join(paths.home, ".local", "share");
}

export function opencodeDbPath(paths: RuntimePaths): string {
  return path.join(opencodeDataHome(paths), "opencode", "opencode.db");
}

export function threadDestinationRoot(paths: RuntimePaths, destination: string): string {
  return path.join(paths.home, ".mindframe-z", "thread-destinations", destination);
}

export function threadPath(paths: RuntimePaths, slug: string): string {
  return path.join(threadStoreRoot(paths), slug);
}

export function threadRunsRoot(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "thread-runs", "runs");
}

export function threadSweepRoot(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "thread-sweep");
}

export function threadRunPath(paths: RuntimePaths, runId: string): string {
  return path.join(threadRunsRoot(paths), runId);
}

export function threadCliLogPath(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "thread-runs", "cli.log");
}

export function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function infraTargetList(target: InfraTarget | "all"): InfraTarget[] {
  return target === "all" ? ["mise", "dotfiles"] : [target];
}

export function agentList(agent: ApplyAgent, profileAgents: AgentName[]): AgentName[] {
  return agent === "all" ? profileAgents : [agent];
}
