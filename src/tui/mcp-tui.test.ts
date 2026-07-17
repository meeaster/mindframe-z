import { describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../core/profile.js";
import { validateMcpTuiStates, type McpState } from "./mcp-tui.js";

function profile(): ResolvedProfile {
  return {
    mcpServers: [
      {
        name: "context7",
        route: "direct",
        agents: { opencode: true, "claude-code": true, codex: true },
        server: { type: "remote", url: "https://example.invalid/mcp", description: "" }
      }
    ]
  } as unknown as ResolvedProfile;
}

function states(claude: boolean): Record<"opencode" | "claude-code" | "codex", McpState> {
  return {
    opencode: { context7: false },
    "claude-code": { context7: claude },
    codex: { context7: false }
  };
}

describe("MCP TUI capability validation", () => {
  it("rejects a pending Claude disable", () => {
    expect(() => validateMcpTuiStates(profile(), states(false))).toThrow(
      "no supported configured-but-disabled state"
    );
  });

  it("allows native OpenCode and Codex disabled states", () => {
    expect(() => validateMcpTuiStates(profile(), states(true))).not.toThrow();
  });
});
