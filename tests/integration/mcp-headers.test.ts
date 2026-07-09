import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

// The `{env:NAME}` catalog token has one meaning and three renderings: OpenCode
// resolves the token itself, Claude wants `${NAME}`, and Codex wants the bare
// variable name in a separate `env_http_headers` table. Nothing else pins the
// per-renderer half of that contract, so a "unify the header code" refactor
// could leak a secret-bearing token into the wrong file shape unnoticed.
describe("mcp remote header rendering", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());

    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  context7:",
        "    description: Docs.",
        "    type: remote",
        "    transport: http",
        "    url: https://mcp.context7.com/mcp",
        "  local-helper:",
        "    description: Local helper.",
        "    type: local",
        "    command: [tool-helper, --serve]",
        "  exa:",
        "    description: Search.",
        "    type: remote",
        "    transport: http",
        "    url: https://mcp.exa.invalid/mcp",
        "    headers:",
        '      x-api-key: "{env:EXA_API_KEY}"',
        "      x-client: mindframe-z",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [opencode, claude-code, codex]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "mcp:",
        "  exa:",
        "    agents: { opencode: true, claude-code: true, codex: true }",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);
  });

  it("passes the env token through to OpenCode verbatim", async () => {
    const config = JSON.parse(
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ) as { mcp: Record<string, { headers?: Record<string, string> }> };

    expect(config.mcp.exa?.headers).toEqual({
      "x-api-key": "{env:EXA_API_KEY}",
      "x-client": "mindframe-z"
    });
  });

  it("rewrites the env token to shell expansion for Claude", async () => {
    const mcp = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    ) as Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;

    expect(mcp.exa).toEqual({
      type: "http",
      url: "https://mcp.exa.invalid/mcp",
      headers: {
        "x-api-key": "${EXA_API_KEY}",
        "x-client": "mindframe-z"
      }
    });
  });

  it("splits literal and env headers into separate Codex tables", async () => {
    const config = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as { mcp_servers: Record<string, unknown> };

    expect(config.mcp_servers.exa).toEqual({
      url: "https://mcp.exa.invalid/mcp",
      enabled: true,
      http_headers: { "x-client": "mindframe-z" },
      env_http_headers: { "x-api-key": "EXA_API_KEY" }
    });
  });
});
