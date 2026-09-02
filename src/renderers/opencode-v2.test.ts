import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { profileSchema } from "../core/manifests.js";
import { createRuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { renderTarget } from "../core/render.js";
import type { JsonObject } from "../core/json.js";
import { mergeOpenCodeV2CliPlugins, renderOpenCodeV2 } from "./opencode-v2.js";

function profile(home: string): ResolvedProfile {
  const manifest = profileSchema.parse({
    name: "personal",
    agents: ["opencode-v2"],
    dotfiles: { ".zshrc": "managed" },
    extra_folders: [
      { path: path.join(home, "extra"), description: "Extra", read: "ask", edit: "deny" }
    ],
    opencode_v2: {
      config: { model: "v2/model" },
      cli: { theme: "dark" },
      global_instructions: true
    }
  });
  return {
    name: "personal",
    agents: ["opencode-v2"],
    profile: manifest,
    // SAFETY: this fixture exercises only renderer fields and never reads manifest/source metadata.
    manifests: {} as ResolvedProfile["manifests"],
    // SAFETY: this fixture supplies the plugin source map separately in the relevant test.
    sources: {} as ResolvedProfile["sources"],
    instructionFiles: [],
    instructionReferences: [],
    referencesDir: path.join(home, "references"),
    enabledReferences: [],
    enabledSkills: [],
    enabledOpenCodeV2Commands: [],
    enabledOpenCodeV2Agents: [],
    mcpServers: [
      {
        name: "remote",
        server: {
          type: "remote",
          description: "Remote server",
          transport: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" }
        },
        agents: { opencode: true }
      },
      {
        name: "local",
        server: {
          type: "local",
          description: "Local server",
          command: ["helper", "--serve"],
          env: { MODE: "test" }
        },
        agents: { opencode: false }
      }
    ],
    extraFolders: manifest.extra_folders,
    miseLayers: []
  };
}

function renderedConfig(result: Awaited<ReturnType<typeof renderOpenCodeV2>>): JsonObject {
  const file = result.files.find((entry) => entry.path.endsWith("opencode-v2/opencode.jsonc"));
  if (!file) throw new Error("OpenCode V2 config was not rendered");
  // SAFETY: the renderer serializes this file from a JSON object.
  return JSON.parse(file.content) as JsonObject;
}

describe("OpenCode V2 renderer", () => {
  it("does not render plugin development dependencies", async () => {
    const home = "/tmp/mfz-opencode-v2-plugin-dependencies";
    const root = "/tmp/mfz-opencode-v2-plugin-source";
    const source = path.join(root, "opencode", "plugins", "example", "v2");
    await mkdir(path.join(source, "node_modules", "helper"), { recursive: true });
    await writeFile(path.join(source, "index.ts"), "export default {}\n");
    await writeFile(path.join(source, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(source, "node_modules", "helper", "index.js"), "export default {}\n");

    const paths = createRuntimePaths({ root, home });
    const result = await renderOpenCodeV2(paths, {
      ...profile(home),
      enabledOpenCodeV2TuiPlugins: ["example"],
      // SAFETY: only the plugin map is read by collectPluginFiles in this test.
      sources: { plugins: new Map([["example", { root }]]) } as ResolvedProfile["sources"]
    });

    expect(result.localFiles?.map((file) => file.path)).toContain(
      path.join(
        paths.configsDir,
        "personal",
        "opencode-v2",
        "plugins",
        "tui",
        "example",
        "index.ts"
      )
    );
    expect(result.localFiles?.some((file) => file.path.includes("node_modules"))).toBe(false);
    expect(result.links.some((link) => link.linkPath.endsWith("node_modules"))).toBe(false);
  });

  it("renders the same configured options for server and TUI plugin assets", async () => {
    const home = "/tmp/mfz-opencode-v2-plugin-options";
    const root = "/tmp/mfz-opencode-v2-plugin-options-source";
    const source = path.join(root, "opencode", "plugins", "work-ledger");
    await rm(root, { recursive: true, force: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "index.ts"), "export default {}\n");
    await writeFile(
      path.join(source, "package.json"),
      '{"type":"module","exports":{".":"./index.ts","./tui":"./tui/index.tsx"}}\n'
    );

    const paths = createRuntimePaths({ root, home });
    const resolved = profile(home);
    resolved.profile.opencode_v2.plugin_options = {
      "work-ledger": { root: "~/workspace/knowledge/personal-knowledge/ledgers" }
    };
    const result = await renderOpenCodeV2(paths, {
      ...resolved,
      enabledOpenCodeV2Plugins: ["work-ledger"],
      enabledOpenCodeV2TuiPlugins: ["work-ledger"],
      // SAFETY: collectPluginFiles reads only the root field from this renderer fixture.
      sources: {
        plugins: new Map([["work-ledger", { root }]])
      } as ResolvedProfile["sources"]
    });
    const options = { root: "~/workspace/knowledge/personal-knowledge/ledgers" };

    expect(renderedConfig(result).plugins).toEqual([
      {
        package: `file://${source}`,
        options
      }
    ]);
    expect(result.cliPlugins?.entries).toEqual([
      {
        package: `file://${path.join(home, ".mindframe-z", "configs", "personal", "opencode-v2", "plugins", "tui", "work-ledger")}`,
        options
      }
    ]);
  });

  it("links active V2 runtime dependencies from the profile", async () => {
    const home = "/tmp/mfz-opencode-v2-runtime-dependencies";
    const paths = createRuntimePaths({ root: "/tmp/root", home });
    const resolved = profile(home);
    resolved.profile.opencode_v2.dependencies = { "@opencode-ai/plugin": "0.0.0-next-17403" };

    const result = await renderOpenCodeV2(paths, resolved);
    const manifest = result.files.find((file) => file.path.endsWith("opencode-v2/package.json"));

    expect(manifest?.content).toContain('"@opencode-ai/plugin": "0.0.0-next-17403"');
    expect(result.links).toContainEqual({
      linkPath: path.join(paths.opencodeConfigDir, "package.json"),
      targetPath: path.join(paths.configsDir, "personal", "opencode-v2", "package.json")
    });
  });

  it("renders native MCP, permissions, CLI, and isolated paths without reading V1 plugins", async () => {
    const home = "/tmp/mfz-opencode-v2-renderer";
    const paths = createRuntimePaths({ root: "/tmp/root", home });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await renderOpenCodeV2(paths, profile(home));
      const config = renderedConfig(result);
      // SAFETY: nativeMcp always renders the config.mcp object with a servers map.
      const mcp = config.mcp as { servers: JsonObject };

      expect(config).toMatchObject({
        $schema: "https://opencode.ai/config.json",
        model: "v2/model",
        instructions: [],
        skills: [path.join(paths.configsDir, "personal", "opencode-v2", "skills")]
      });
      expect(config.plugin).toBeUndefined();
      expect(mcp.servers).toEqual({
        remote: {
          type: "remote",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
          disabled: false
        },
        local: {
          type: "local",
          command: ["helper", "--serve"],
          environment: { MODE: "test" },
          disabled: true
        }
      });
      expect(config.permissions).toEqual([
        {
          action: "external_directory",
          resource: path.join(home, "extra", "*"),
          effect: "ask"
        },
        {
          action: "read",
          resource: path.join(home, "extra", "*"),
          effect: "ask"
        },
        {
          action: "edit",
          resource: path.join(home, "extra", "*"),
          effect: "deny"
        },
        {
          action: "external_directory",
          resource: path.join(home, "references", "*"),
          effect: "allow"
        },
        {
          action: "read",
          resource: path.join(home, "references", "*"),
          effect: "allow"
        },
        {
          action: "edit",
          resource: path.join(home, "references", "*"),
          effect: "deny"
        },
        {
          action: "external_directory",
          resource: path.join(home, ".mindframe-z", "secrets", "*"),
          effect: "deny"
        },
        {
          action: "read",
          resource: path.join(home, ".mindframe-z", "secrets", "*"),
          effect: "deny"
        },
        {
          action: "edit",
          resource: path.join(home, ".mindframe-z", "secrets", "*"),
          effect: "deny"
        },
        {
          action: "read",
          resource: path.join(home, ".config", "opencode", "service.json"),
          effect: "deny"
        }
      ]);
      expect(result.files.some((entry) => entry.path.endsWith("cli.json"))).toBe(false);
      expect(result.links.some((link) => link.linkPath.endsWith("cli.json"))).toBe(false);
      expect(result.links).toContainEqual({
        linkPath: path.join(paths.opencodeConfigDir, "AGENTS.md"),
        targetPath: path.join(paths.configsDir, "personal", "AGENTS.md")
      });
      expect(result.links).toContainEqual({
        linkPath: path.join(paths.opencodeConfigDir, "opencode.jsonc"),
        targetPath: path.join(paths.configsDir, "personal", "opencode-v2", "opencode.jsonc")
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("renders indexes into the globally discovered V2 AGENTS file", async () => {
    const home = "/tmp/mfz-opencode-v2-global-instructions";
    const paths = createRuntimePaths({ root: "/tmp/root", home });
    const result = await renderTarget(paths, profile(home), "opencode-v2");
    const agents = result.files.find((entry) => entry.path.endsWith("personal/AGENTS.md"));

    expect(agents?.content).toContain("# Enabled References");
    expect(agents?.content).toContain("# Extra Folders");
    expect(result.links).toContainEqual({
      linkPath: path.join(paths.opencodeConfigDir, "AGENTS.md"),
      targetPath: path.join(paths.configsDir, "personal", "AGENTS.md")
    });
  });

  it("copies on-demand instructions and advertises their rendered path", async () => {
    const root = "/tmp/mfz-opencode-v2-instruction-references-root";
    const home = "/tmp/mfz-opencode-v2-instruction-references-home";
    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(root, "instructions"), { recursive: true });
    const sourcePath = path.join(root, "instructions", "BROWSER.md");
    await writeFile(sourcePath, "# Browser\n\nUse the managed profile.\n");
    const paths = createRuntimePaths({ root, home });
    const stalePath = path.join(
      home,
      ".mindframe-z",
      "configs",
      "personal",
      "instruction-references",
      "stale.md"
    );
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, "stale\n");
    const resolved = profile(home);
    resolved.instructionReferences = [
      {
        name: "browser",
        path: "instructions/BROWSER.md",
        sourcePath,
        description: "For browser automation"
      }
    ];

    const result = await renderTarget(paths, resolved, "opencode-v2");
    const agents = result.files.find((entry) => entry.path.endsWith("personal/AGENTS.md"));
    const reference = result.files.find((entry) =>
      entry.path.endsWith("instruction-references/browser.md")
    );

    expect(agents?.content).toContain("## On-Demand Instructions");
    expect(agents?.content).toContain(reference?.path);
    expect(reference?.content).toBe("# Browser\n\nUse the managed profile.\n");
    expect(result.staleFiles).toContain(stalePath);
    if (!reference) throw new Error("expected rendered instruction reference");

    await mkdir(path.dirname(reference.path), { recursive: true });
    await writeFile(reference.path, reference.content);
    const dotfiles = await renderTarget(paths, resolved, "dotfiles");
    expect(dotfiles.staleFiles).not.toContain(reference.path);
  });

  it("rejects V2 config ownership collisions", async () => {
    const home = "/tmp/mfz-opencode-v2-owned";
    const paths = createRuntimePaths({ root: "/tmp/root", home });
    const resolved = profile(home);
    resolved.profile.opencode_v2.config.permissions = [];

    await expect(renderOpenCodeV2(paths, resolved)).rejects.toThrow(
      "OpenCode V2 config field permissions is generated by mindframe-z"
    );
  });

  it("does not register quarantined V2 TUI plugins as server plugins", async () => {
    const resolved = profile("/tmp/mfz-opencode-v2-tui");
    resolved.enabledOpenCodeV2TuiPlugins = ["advisor"];
    const result = await renderOpenCodeV2(
      {
        ...createRuntimePaths({ root: "/tmp/root", home: "/tmp/home" })
      },
      resolved
    );
    expect(renderedConfig(result).plugins).toBeUndefined();
    expect(result.localFiles?.some((file) => file.path.includes("advisor"))).toBe(false);
  });

  it("merges only its previously registered TUI plugin URLs into CLI settings", () => {
    const ownedPath = "/tmp/mfz/plugins/tui";
    const managed = `file://${ownedPath}/session-cost-tui`;
    const userOwnedPath = `file://${ownedPath}/user-plugin`;
    expect(
      mergeOpenCodeV2CliPlugins(
        {
          theme: "dark",
          plugins: [
            "npm:other-plugin",
            { path: "file:///user/plugin", enabled: false },
            managed,
            userOwnedPath
          ]
        },
        [managed],
        [managed]
      )
    ).toEqual({
      theme: "dark",
      plugins: [
        "npm:other-plugin",
        { path: "file:///user/plugin", enabled: false },
        userOwnedPath,
        managed
      ]
    });
  });

  it("replaces managed object entries when options change and preserves user entries", () => {
    const packageUrl = "file:///tmp/mfz/plugins/tui/work-ledger";
    const previous = { package: packageUrl, options: { root: "/old" } };
    const next = { package: packageUrl, options: { root: "/new" } };
    const user = { package: "npm:user-plugin", options: { enabled: false } };

    expect(mergeOpenCodeV2CliPlugins({ plugins: [previous, user] }, [next], [previous])).toEqual({
      plugins: [user, next]
    });
    expect(mergeOpenCodeV2CliPlugins({ plugins: [previous, user] }, [], [previous])).toEqual({
      plugins: [user]
    });
  });

  it("renders V2 CLI settings for the global CLI config merge", async () => {
    const resolved = profile("/tmp/mfz-opencode-v2-cli-settings");
    resolved.profile.opencode_v2.cli = { theme: { name: "dracula" } };
    const result = await renderOpenCodeV2(
      {
        ...createRuntimePaths({ root: "/tmp/root", home: "/tmp/home" })
      },
      resolved
    );
    expect(result.cliPlugins?.settings).toEqual({ theme: { name: "dracula" } });
  });
});
