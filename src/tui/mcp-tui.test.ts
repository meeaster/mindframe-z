import { describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../core/profile.js";
import { validateMcpTuiStates, type McpState } from "./mcp-tui.js";

function profile(): ResolvedProfile {
  return {
    name: "test",
    agents: ["opencode", "claude-code", "codex"],
    profile: {
      name: "test",
      description: "",
      agents: ["opencode", "claude-code", "codex"],
      instructions: [],
      references: [],
      skills: {},
      mcp: {},
      opencode: {
        config: {},
        dependencies: {},
        plugins: [],
        tui: {},
        tui_plugins: [],
        commands: [],
        agents: []
      },
      opencode_v2: {
        config: {},
        dependencies: {},
        cli: {},
        plugins: [],
        tui_plugins: [],
        commands: [],
        agents: []
      },
      claude: { settings: {} },
      codex: { config: {}, plugins: {} },
      pi: { settings: {}, subagent_config: {} },
      thread: { stores: [], defaults: {}, credentials: "subscription" },
      dotfiles: {},
      extra_folders: []
    },
    manifests: {
      homeManifest: {},
      root: "/tmp",
      aliasPath: [],
      references: [],
      skills: [],
      mcpServers: {},
      profiles: new Map(),
      miseFiles: new Map(),
      machine: {
        references_dir: "~/.mindframe-z/references",
        extra_folders: [],
        git: {},
        sandbox: {},
        thread: { stores: [] },
        work: {},
        archives: [],
        opencode: {},
        claude: {}
      }
    },
    sources: {
      references: new Map(),
      skills: new Map(),
      mcp: new Map(),
      instructions: new Map(),
      plugins: new Map(),
      commands: new Map(),
      agents: new Map()
    },
    instructionFiles: [],
    referencesDir: "/tmp",
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    enabledOpenCodeV2Commands: [],
    enabledOpenCodeV2Agents: [],
    enabledOpenCodeV2Plugins: [],
    enabledOpenCodeV2TuiPlugins: [],
    extraFolders: [],
    miseLayers: [],
    mcpServers: [
      {
        name: "context7",
        agents: { opencode: true, "claude-code": true, codex: true },
        server: { type: "remote", url: "https://example.invalid/mcp", description: "" }
      }
    ]
  };
}

function states(claude: boolean) {
  return {
    opencode: { context7: false },
    "claude-code": { context7: claude },
    codex: { context7: false }
  } satisfies Record<"opencode" | "claude-code" | "codex", McpState>;
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
