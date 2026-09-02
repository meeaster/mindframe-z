import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentName, RuntimePaths } from "./paths.js";
import type { ResolvedProfile } from "./profile.js";
import {
  readOverrideStore,
  renderAllPayloads,
  writeProjectOverrideDelta
} from "./override-store.js";

async function tmpPaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-overrides-"));
  return {
    root,
    home: path.join(root, "home"),
    workRoot: path.join(root, "home", ".mindframe-z", "work", "v1"),
    workUnitsRoot: path.join(root, "home", ".mindframe-z", "work", "v1", "units"),
    configsDir: path.join(root, "home", ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(root, "opencode"),
    claudeDir: path.join(root, "claude"),
    codexDir: path.join(root, "codex"),
    piDir: path.join(root, "pi", "agent"),
    miseConfigDir: path.join(root, "mise")
  };
}

function profile(codexDefault: boolean): ResolvedProfile {
  // SAFETY: The test only exercises the mcpServers and enabledSkills fields.
  const result: Partial<ResolvedProfile> = {
    mcpServers: [
      {
        name: "jira",
        agents: { codex: codexDefault },
        server: { type: "remote", url: "https://jira.invalid", description: "" }
      }
    ],
    enabledSkills: []
  };
  // SAFETY: The test only exercises the mcpServers and enabledSkills fields.
  return result as ResolvedProfile;
}

// Defaults chosen so every override in the payload tests below flips a value:
// `pr-writer` defaults on and gets turned off, `dataviz` defaults off and gets
// turned on. That pins both directions of each boolean encoding. `mcpDefault`
// is per-target because only the flip each harness actually supports is worth
// pinning — Claude Code rejects disabling an MCP server (assertMcpToggleSupported).
function harnessProfile(
  target: Exclude<AgentName, "opencode-v2" | "pi">,
  mcpDefault: boolean
): ResolvedProfile {
  // SAFETY: The test only exercises the mcpServers and enabledSkills fields.
  const result: Partial<ResolvedProfile> = {
    mcpServers: [
      {
        name: "jira",
        agents: { [target]: mcpDefault },
        server: { type: "remote", url: "https://jira.invalid", description: "" }
      }
    ],
    enabledSkills: [
      {
        name: "pr-writer",
        description: "",
        source: "vendored",
        repo: "",
        ref: "",
        subtree: "",
        agents: { [target]: true },
        toggleable: false,
        targets: [],
        sourceRoot: ""
      },
      {
        name: "dataviz",
        description: "",
        source: "vendored",
        repo: "",
        ref: "",
        subtree: "",
        agents: { [target]: false },
        toggleable: false,
        targets: [],
        sourceRoot: ""
      }
    ]
  };
  // SAFETY: The test only exercises the mcpServers and enabledSkills fields.
  return result as ResolvedProfile;
}

describe("override store", () => {
  it("aborts corrupt reads without truncating the file", async () => {
    const paths = await tmpPaths();
    const file = path.join(paths.home, ".mindframe-z", "overrides.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json", "utf8");

    await expect(readOverrideStore(paths.home)).rejects.toThrow(file);
    await expect(readFile(file, "utf8")).resolves.toBe("not json");
  });

  it("stores only deltas and prunes entries returned to default", async () => {
    const paths = await tmpPaths();
    const projectRoot = path.join(paths.root, "repo");

    await writeProjectOverrideDelta(paths, profile(false), projectRoot, "codex", "mcp", {
      jira: true
    });
    expect((await readOverrideStore(paths.home)).projects[projectRoot]?.codex?.mcp).toEqual({
      jira: true
    });

    await writeProjectOverrideDelta(paths, profile(false), projectRoot, "codex", "mcp", {
      jira: false
    });
    expect((await readOverrideStore(paths.home)).projects).toEqual({});
  });

  it("re-renders stored payloads after profile defaults change", async () => {
    const paths = await tmpPaths();
    const projectRoot = path.join(paths.root, "repo");

    await writeProjectOverrideDelta(paths, profile(false), projectRoot, "codex", "mcp", {
      jira: true
    });
    expect(
      (await readOverrideStore(paths.home)).projects[projectRoot]?.codex?.payload?.argv
    ).toEqual(["-c", "mcp_servers.jira.enabled=true"]);

    await renderAllPayloads(paths, profile(true));
    expect((await readOverrideStore(paths.home)).projects).toEqual({});
  });

  // The claude wrapper passes this object to `claude --settings`, so it must stay
  // shaped like a Claude Code settings file and must not leak MCP overrides,
  // which Claude Code does not read from that flag.
  it("encodes claude-code project overrides as a settings payload without mcp", async () => {
    const paths = await tmpPaths();
    const projectRoot = path.join(paths.root, "repo");
    const claude = harnessProfile("claude-code", false);

    await writeProjectOverrideDelta(paths, claude, projectRoot, "claude-code", "mcp", {
      jira: true
    });
    await writeProjectOverrideDelta(paths, claude, projectRoot, "claude-code", "skills", {
      "pr-writer": false,
      dataviz: true
    });

    const section = (await readOverrideStore(paths.home)).projects[projectRoot]?.["claude-code"];
    expect(section?.mcp).toEqual({ jira: true });
    expect(section?.payload).toEqual({
      settings: { skillOverrides: { "pr-writer": "off", dataviz: "on" } }
    });
  });

  it("rejects overrides for names the profile does not offer the target", async () => {
    const paths = await tmpPaths();
    const projectRoot = path.join(paths.root, "repo");

    await expect(
      writeProjectOverrideDelta(
        paths,
        harnessProfile("codex", true),
        projectRoot,
        "codex",
        "skills",
        {
          "not-a-skill": true
        }
      )
    ).rejects.toThrow("Skill not-a-skill is not available for codex");
    await expect(
      writeProjectOverrideDelta(paths, harnessProfile("codex", true), projectRoot, "codex", "mcp", {
        "not-a-server": true
      })
    ).rejects.toThrow("MCP server not-a-server is not available for codex");
  });
});
