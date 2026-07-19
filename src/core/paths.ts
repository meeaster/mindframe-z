import { access, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { machineSchema } from "./manifests.js";
import { expandHome } from "./path-util.js";

export { expandHome } from "./path-util.js";

export type AgentName = "opencode" | "claude-code" | "codex" | "pi";
export type ToolTarget = "opencode" | "claude-code" | "codex" | "pi" | "mise" | "dotfiles";
export type InfraTarget = "mise" | "dotfiles";
export type ApplyAgent = AgentName | "all";

export interface RuntimePaths {
  root: string;
  home: string;
  configsDir: string;
  opencodeConfigDir: string;
  claudeDir: string;
  codexDir: string;
  piDir: string;
  miseConfigDir: string;
}

export interface PathOptions {
  root?: string | undefined;
  home?: string | undefined;
  opencodeConfigDir?: string | undefined;
  claudeDir?: string | undefined;
  codexDir?: string | undefined;
  piDir?: string | undefined;
}

// Canonical location of the per-home `.mindframe-z` state directory. Every
// on-disk path mfz owns hangs off this, so the directory name lives in exactly
// one place (the store-path contract in paths.test.ts pins the layout below).
export function mindframeZDir(home: string): string {
  return path.join(home, ".mindframe-z");
}

export function packageRootFromImport(importMetaUrl: string): string {
  // Resolve the engine root by finding the nearest package.json, so it works
  // identically from source (src/*, two levels up) and the compiled dist tree
  // (dist/src/*, three levels up).
  const start = path.dirname(fileURLToPath(importMetaUrl));
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(start, "../..");
}

function machineHomePath(home: string): string | undefined {
  try {
    const parsed = YAML.parse(readFileSync(path.join(mindframeZDir(home), "config.yml"), "utf8"));
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
    configsDir: path.join(mindframeZDir(home), "configs"),
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
    piDir: path.resolve(
      expandHome(
        options.piDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"),
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

export function executorDataDir(): string {
  return path.resolve(process.env.EXECUTOR_DATA_DIR ?? path.join(homedir(), ".executor"));
}

export function executorConfigPath(paths: RuntimePaths, profileName: string): string {
  return path.join(profileConfigsDir(paths, profileName), "executor", "executor.jsonc");
}

export function executorDesiredPath(paths: RuntimePaths, profileName: string): string {
  return path.join(profileConfigsDir(paths, profileName), "executor", "desired.json");
}

export function executorManagedPath(paths: RuntimePaths, profileName: string): string {
  return path.join(profileConfigsDir(paths, profileName), "executor", "managed.json");
}

export function skillCacheRoot(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "cache", "skills");
}

export function skillCandidatesRoot(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "skill-candidates");
}

export function skillSnapshotDir(paths: RuntimePaths, profileName: string): string {
  return path.join(profileConfigsDir(paths, profileName), "skills");
}

export function skillSnapshotManifestPath(paths: RuntimePaths, profileName: string): string {
  return path.join(skillSnapshotDir(paths, profileName), ".mfz-manifest.yml");
}

export function vendorLockPath(root: string): string {
  return path.join(root, "skills", "vendor.lock.yml");
}

export function globalSkillStatePath(paths: RuntimePaths, target: AgentName): string {
  return path.join(mindframeZDir(paths.home), "skill-overrides", `${target}.json`);
}

export function overrideStorePath(home: string): string {
  return path.join(mindframeZDir(home), "overrides.json");
}

// Generated index of enabled references, embedded into every agent's instructions
// (referenced by @-path for Claude, read inline for Codex, listed for OpenCode).
export function referenceIndexPath(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "references.md");
}

// Companion index of extra folder grants; only embedded when the profile grants any.
export function extraFoldersIndexPath(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "extra_folders.md");
}

export function threadStoreRoot(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "threads");
}

// Read-only, write-once cache of sessions hydrated from an S3 archive because they
// vanished from their live harness store. Gitignored; mounted read-only into the
// thread tools container (as a subtree of the existing whole-~/.mindframe-z mount).
export function archiveCacheRoot(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "archive-cache");
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
  return path.join(mindframeZDir(paths.home), "thread-destinations", destination);
}

export function threadPath(paths: RuntimePaths, slug: string): string {
  return path.join(threadStoreRoot(paths), slug);
}

export function threadRunsRoot(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "thread-runs", "runs");
}

export function threadSweepRoot(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "thread-sweep");
}

export function threadRunPath(paths: RuntimePaths, runId: string): string {
  return path.join(threadRunsRoot(paths), runId);
}

export function threadCliLogPath(paths: RuntimePaths): string {
  return path.join(mindframeZDir(paths.home), "thread-runs", "cli.log");
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
