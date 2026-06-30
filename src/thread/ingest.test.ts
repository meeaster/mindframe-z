import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import { threadPath } from "../core/paths.js";
import type { MachineManifest } from "../core/manifests.js";
import type { ResolvedProfile } from "../core/profile.js";
import { makeTempDir } from "../../tests/integration/support.js";
import { writeThreadManifest } from "./storage.js";
import { ingestThread } from "./ingest.js";
import type { AgentRunner, AgentRunResult } from "./runner.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function machine(): MachineManifest {
  return {
    references_dir: "~/references",
    extra_folders: [],
    git: {},
    sandbox: {},
    thread: { destinations: [] },
    opencode: {}
  };
}

function profile(): ResolvedProfile {
  return {
    name: "personal",
    agents: ["claude-code"],
    profile: {
      name: "personal",
      description: "Test profile",
      agents: ["claude-code"],
      instructions: [],
      references: [],
      skills: {},
      mcp: {},
      opencode: { config: {}, plugins: [], commands: [], agents: [] },
      claude: { settings: {} },
      mise: { tools: {}, env: {}, tool_alias: {}, settings: {} },
      thread: {
        destinations: [{ name: "personal", default: true, no_push: false }],
        defaults: {
          synthesize: "claude-code:sonnet@high",
          gather: "claude-code:haiku@low",
          discover: "claude-code:sonnet@high",
          session_sources: ["claude-code"]
        },
        credentials: "subscription"
      },
      dotfiles: {},
      extra_folders: []
    },
    manifests: {
      references: [],
      skills: [],
      mcpServers: {},
      profiles: new Map(),
      machine: machine()
    },
    instructionFiles: [],
    referencesDir: "/tmp/references",
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    mcpServers: [],
    extraFolders: []
  };
}

// A runner whose every dispatch returns an empty result, standing in for a gather
// that never read the session (e.g. a denied read it failed to recover from).
class EmptyDossierRunner implements AgentRunner {
  run(): Promise<AgentRunResult> {
    return Promise.resolve({
      text: "   \n",
      rawTrace: "",
      durationMs: 0,
      usage: {
        cost_usd: null,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: null
      }
    });
  }
}

describe("ingestThread", () => {
  it("aborts before synthesis when a gather yields an empty dossier", async () => {
    const home = await makeTempDir();
    const runtime = paths(home);
    const slug = "thread-empty";
    await writeThreadManifest(threadPath(runtime, slug), {
      slug,
      charter: "Design of per-session watermarks — deterministic TS-computed watermark.",
      destination: "personal",
      created_at: "2026-06-27T00:00:00.000Z",
      sessions: [],
      synthesis: {}
    });

    await expect(
      ingestThread({
        paths: runtime,
        profile: profile(),
        threadSlug: slug,
        sessionIds: ["a712ce9c-589a-46fc-b10f-e72c193e165c"],
        noPush: true,
        runner: new EmptyDossierRunner()
      })
    ).rejects.toThrow(/empty dossier/);
  });
});
