import type { RuntimePaths } from "../core/paths.js";
import { executorDataDir, executorScopeDir } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";

export function executorBridgeArgs(paths: RuntimePaths, profile: ResolvedProfile): string[] {
  return [
    "mcp",
    "--scope",
    executorScopeDir(paths, profile.name),
    "--elicitation-mode",
    profile.profile.executor?.elicitation ?? "browser"
  ];
}

export function executorBridgeEnvironment(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Record<string, string> {
  return {
    EXECUTOR_DATA_DIR: executorDataDir(paths, profile.name),
    EXECUTOR_SCOPE_DIR: executorScopeDir(paths, profile.name)
  };
}

export function executorTimeout(profile: ResolvedProfile): number {
  return profile.profile.executor?.timeout_ms ?? 60_000;
}

export function openCodeExecutorEntry(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Record<string, unknown> {
  return {
    type: "local",
    command: ["executor", ...executorBridgeArgs(paths, profile)],
    environment: executorBridgeEnvironment(paths, profile),
    timeout: executorTimeout(profile),
    enabled: true
  };
}

export function claudeExecutorEntry(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Record<string, unknown> {
  return {
    type: "stdio",
    command: "executor",
    args: executorBridgeArgs(paths, profile),
    env: executorBridgeEnvironment(paths, profile)
  };
}

export function codexExecutorEntry(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Record<string, unknown> {
  return {
    command: "executor",
    args: executorBridgeArgs(paths, profile),
    env: executorBridgeEnvironment(paths, profile),
    startup_timeout_sec: Math.ceil(executorTimeout(profile) / 1000),
    tool_timeout_sec: Math.ceil(executorTimeout(profile) / 1000)
  };
}
