import type { ResolvedProfile } from "../core/profile.js";

export function executorBridgeArgs(profile: ResolvedProfile): string[] {
  return ["mcp", "--elicitation-mode", profile.profile.executor?.elicitation ?? "browser"];
}

export function executorTimeout(profile: ResolvedProfile): number {
  return profile.profile.executor?.timeout_ms ?? 60_000;
}

export function openCodeExecutorEntry(profile: ResolvedProfile): Record<string, unknown> {
  return {
    type: "local",
    command: ["executor", ...executorBridgeArgs(profile)],
    timeout: executorTimeout(profile),
    enabled: true
  };
}

export function claudeExecutorEntry(profile: ResolvedProfile): Record<string, unknown> {
  return {
    type: "stdio",
    command: "executor",
    args: executorBridgeArgs(profile)
  };
}

export function codexExecutorEntry(profile: ResolvedProfile): Record<string, unknown> {
  return {
    command: "executor",
    args: executorBridgeArgs(profile),
    startup_timeout_sec: Math.ceil(executorTimeout(profile) / 1000),
    tool_timeout_sec: Math.ceil(executorTimeout(profile) / 1000)
  };
}
