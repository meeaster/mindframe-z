import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, setupIntegrationFixture } from "./support.js";

describe("mcp toggle integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
    await execa("git", ["init"], { cwd: root });
  });

  it("writes project MCP deltas to the override store", async () => {
    await cli(
      "mfz",
      root,
      home,
      ["mcp", "disable", "context7", "--agent", "opencode"],
      {},
      undefined,
      root
    );

    const store = JSON.parse(
      await readFile(path.join(home, ".mindframe-z", "overrides.json"), "utf8")
    ) as {
      projects?: Record<string, { opencode?: { mcp?: Record<string, boolean> } }>;
    };
    expect(store.projects?.[root]?.opencode?.mcp).toEqual({ context7: false });
    await expect(
      readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("prints status with override markers", async () => {
    await cli(
      "mfz",
      root,
      home,
      ["mcp", "disable", "context7", "--agent", "opencode"],
      {},
      undefined,
      root
    );

    const result = await cli("mfz", root, home, ["mcp", "status"], {}, undefined, root);

    expect(result.stdout).toContain("context7\topencode\tdisabled\toverridden");
  });

  it("preserves native Codex disable state", async () => {
    await cli(
      "mfz",
      root,
      home,
      ["mcp", "disable", "context7", "--agent", "codex"],
      {},
      undefined,
      root
    );

    const store = JSON.parse(
      await readFile(path.join(home, ".mindframe-z", "overrides.json"), "utf8")
    ) as {
      projects?: Record<string, { codex?: { mcp?: Record<string, boolean> } }>;
    };
    expect(store.projects?.[root]?.codex?.mcp).toEqual({ context7: false });
  });

  it("rejects Claude disable without recording an ineffective override", async () => {
    await expect(
      cli(
        "mfz",
        root,
        home,
        ["mcp", "disable", "context7", "--agent", "claude-code"],
        {},
        undefined,
        root
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("no supported configured-but-disabled state")
    });
    await expect(
      readFile(path.join(home, ".mindframe-z", "overrides.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unavailable harness toggles", async () => {
    await expect(
      cli(
        "mfz",
        root,
        home,
        ["mcp", "enable", "local-helper", "--agent", "opencode"],
        {},
        undefined,
        root
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("MCP server local-helper is not available for opencode")
    });
  });
});
