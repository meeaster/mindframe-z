import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { profileSchema } from "../core/manifests.js";
import { createRuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { mergeOpenCodeV2CliPlugins, renderOpenCodeV2 } from "./opencode-v2.js";

function profile(home: string): ResolvedProfile {
  const manifest = profileSchema.parse({
    name: "personal",
    agents: ["opencode-v2"],
    dotfiles: { ".zshrc": "managed" },
    extra_folders: [
      { path: path.join(home, "extra"), description: "Extra", read: "ask", edit: "deny" }
    ],
    opencode: {
      dependencies: { helper: "1.2.3" },
      plugins: ["missing-v1-plugin"],
      tui: { leader_timeout: 1000 },
      tui_plugins: ["missing-v1-tui-plugin"],
      delegate_general: {
        models: [{ id: "test/model", variants: ["low"] }]
      }
    },
    opencode_v2: {
      config: { model: "v2/model" },
      cli: { theme: "dark" }
    }
  });
  return {
    name: "personal",
    agents: ["opencode-v2"],
    profile: manifest,
    manifests: {} as ResolvedProfile["manifests"],
    sources: {} as ResolvedProfile["sources"],
    instructionFiles: [],
    referencesDir: path.join(home, "references"),
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
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
        agents: { "opencode-v2": true }
      },
      {
        name: "local",
        server: {
          type: "local",
          description: "Local server",
          command: ["helper", "--serve"],
          env: { MODE: "test" }
        },
        agents: { "opencode-v2": false }
      }
    ],
    extraFolders: manifest.extra_folders
  };
}

function renderedConfig(
  result: Awaited<ReturnType<typeof renderOpenCodeV2>>
): Record<string, unknown> {
  const file = result.files.find((entry) => entry.path.endsWith("opencode-v2/opencode.jsonc"));
  if (!file) throw new Error("OpenCode V2 config was not rendered");
  return JSON.parse(file.content) as Record<string, unknown>;
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
    paths.activeOpenCodeRuntime = "v2";
    const result = await renderOpenCodeV2(paths, {
      ...profile(home),
      enabledOpenCodeV2TuiPlugins: ["example"],
      sources: { plugins: new Map([["example", { root }]]) } as ResolvedProfile["sources"]
    });

    expect(result.localFiles?.map((file) => file.path)).toContain(
      path.join(paths.configsDir, "personal", "opencode-v2", "plugins", "tui", "example", "index.ts")
    );
    expect(result.localFiles?.some((file) => file.path.includes("node_modules"))).toBe(false);
    expect(result.links.some((link) => link.linkPath.endsWith("node_modules"))).toBe(false);
  });

  it("links active V2 runtime dependencies from the profile", async () => {
    const home = "/tmp/mfz-opencode-v2-runtime-dependencies";
    const paths = createRuntimePaths({ root: "/tmp/root", home });
    paths.activeOpenCodeRuntime = "v2";
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
    paths.activeOpenCodeRuntime = "v2";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await renderOpenCodeV2(paths, profile(home));
      const config = renderedConfig(result);
      const mcp = config.mcp as { servers: Record<string, Record<string, unknown>> };

      expect(config).toMatchObject({
        $schema: "https://opencode.ai/config.json",
        model: "v2/model",
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
        linkPath: path.join(paths.opencodeConfigDir, "opencode.jsonc"),
        targetPath: path.join(paths.configsDir, "personal", "opencode-v2", "opencode.jsonc")
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
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
        ...createRuntimePaths({ root: "/tmp/root", home: "/tmp/home" }),
        activeOpenCodeRuntime: "v2"
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

  it("renders V2 CLI settings for the global CLI config merge", async () => {
    const resolved = profile("/tmp/mfz-opencode-v2-cli-settings");
    resolved.profile.opencode_v2.cli = { theme: { name: "dracula" } };
    const result = await renderOpenCodeV2(
      {
        ...createRuntimePaths({ root: "/tmp/root", home: "/tmp/home" }),
        activeOpenCodeRuntime: "v2"
      },
      resolved
    );
    expect(result.cliPlugins?.settings).toEqual({ theme: { name: "dracula" } });
  });
});
