import { describe, expect, it } from "vitest";
import { profileSchema } from "../core/manifests.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  claudeExecutorEntry,
  codexExecutorEntry,
  executorBridgeArgs,
  openCodeExecutorEntry,
  openCodeV2ExecutorEntry
} from "./executor.js";

function profile(): ResolvedProfile {
  return {
    name: "personal",
    agents: ["opencode", "claude-code", "codex"],
    profile: profileSchema.parse({ name: "personal", executor: { timeout_ms: 45_000 } }),
    // SAFETY: executor entry rendering only reads profile executor settings.
    manifests: {} as ResolvedProfile["manifests"],
    // SAFETY: executor entry rendering only reads profile executor settings.
    sources: {} as ResolvedProfile["sources"],
    instructionFiles: [],
    referencesDir: "/tmp/references",
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    enabledOpenCodeV2Commands: [],
    enabledOpenCodeV2Agents: [],
    mcpServers: [],
    extraFolders: [],
    miseLayers: []
  };
}

describe("Executor bridge rendering", () => {
  it("uses native Executor data and scope defaults without injected paths", () => {
    const resolved = profile();

    expect(executorBridgeArgs(resolved)).toEqual(["mcp", "--elicitation-mode", "browser"]);
    expect(openCodeExecutorEntry(resolved)).toEqual({
      type: "local",
      command: ["executor", "mcp", "--elicitation-mode", "browser"],
      timeout: 45_000,
      enabled: true
    });
    expect(openCodeV2ExecutorEntry(resolved)).toEqual({
      type: "local",
      command: ["executor", "mcp", "--elicitation-mode", "browser"],
      timeout: { startup: 45_000, catalog: 45_000, execution: 45_000 },
      disabled: false
    });
    expect(claudeExecutorEntry(resolved)).toEqual({
      type: "stdio",
      command: "executor",
      args: ["mcp", "--elicitation-mode", "browser"]
    });
    expect(codexExecutorEntry(resolved)).toEqual({
      command: "executor",
      args: ["mcp", "--elicitation-mode", "browser"],
      startup_timeout_sec: 45,
      tool_timeout_sec: 45
    });
  });
});
