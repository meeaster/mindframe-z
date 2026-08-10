import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { profileSchema } from "../core/manifests.js";
import { createRuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { renderOpenCodeV2 } from "./opencode-v2.js";

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
  it("renders native MCP, permissions, CLI, and isolated paths without reading V1 plugins", async () => {
    const home = "/tmp/mfz-opencode-v2-renderer";
    const paths = createRuntimePaths({ root: "/tmp/root", home });
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
          resource: path.join(home, ".config", "opencode-v2", "service.json"),
          effect: "deny"
        }
      ]);
      expect(
        JSON.parse(result.files.find((entry) => entry.path.endsWith("cli.json"))!.content)
      ).toEqual({ theme: "dark" });
      expect(result.links).toContainEqual({
        linkPath: path.join(paths.opencodeV2ConfigDir, "opencode.jsonc"),
        targetPath: path.join(paths.configsDir, "personal", "opencode-v2", "opencode.jsonc")
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("OpenCode V1 plugins omitted from OpenCode V2 render")
      );
      expect(warning).toHaveBeenCalledWith(
        "warning\tOpenCode V1 TUI config omitted from OpenCode V2 render"
      );
      expect(warning).toHaveBeenCalledWith(
        "warning\tOpenCode V1 dependencies omitted from OpenCode V2 render"
      );
      expect(warning).toHaveBeenCalledWith(
        "warning\tOpenCode V1 delegate_general omitted from OpenCode V2 render"
      );
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
});
