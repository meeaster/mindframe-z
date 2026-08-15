import type { ResolvedProfile } from "../core/profile.js";

export function executorBridgeArgs(profile: ResolvedProfile): string[] {
  return ["mcp", "--elicitation-mode", profile.profile.executor?.elicitation ?? "browser"];
}

export function executorTimeout(profile: ResolvedProfile): number {
  return profile.profile.executor?.timeout_ms ?? 60_000;
}

export function openCodeExecutorEntry(profile: ResolvedProfile) {
  return {
    type: "local",
    command: ["executor", ...executorBridgeArgs(profile)],
    timeout: executorTimeout(profile),
    enabled: true
  };
}

export function openCodeV2ExecutorEntry(profile: ResolvedProfile) {
  const timeout = executorTimeout(profile);
  return {
    type: "local",
    command: ["executor", ...executorBridgeArgs(profile)],
    timeout: { startup: timeout, catalog: timeout, execution: timeout },
    disabled: false
  };
}

export function claudeExecutorEntry(profile: ResolvedProfile) {
  return {
    type: "stdio",
    command: "executor",
    args: executorBridgeArgs(profile)
  };
}

export function codexExecutorEntry(profile: ResolvedProfile) {
  return {
    command: "executor",
    args: executorBridgeArgs(profile),
    startup_timeout_sec: Math.ceil(executorTimeout(profile) / 1000),
    tool_timeout_sec: Math.ceil(executorTimeout(profile) / 1000)
  };
}
