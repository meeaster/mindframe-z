import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

// Remote MCP servers can carry `{env:NAME}` header tokens. Each agent renders
// that token in its own dialect: Claude Code keeps a single `headers` map with
// the value rewritten to `${NAME}`, while Codex splits literal headers from
// env-backed ones into `http_headers` / `env_http_headers`. This suite pins
// that per-agent translation so a future reshaping of the parseEnvRef seam
// cannot silently change what lands in the rendered configs.
describe("mcp env-ref header translation", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());

    // Add a remote server that mixes a literal header with an `{env:NAME}` one.
    const mcpPath = path.join(root, "catalog", "mcp.yml");
    const secureApi = [
      "  secure-api:",
      "    description: Secure API.",
      "    type: remote",
      "    transport: http",
      "    url: https://api.invalid/mcp",
      "    headers:",
      '      Authorization: "{env:API_TOKEN}"',
      "      X-Client: literal-value",
      ""
    ].join("\n");
    await writeFile(mcpPath, (await readFile(mcpPath, "utf8")) + secureApi, "utf8");

    // Activate codex and enable the server for both header-carrying agents.
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    const profileYml = (await readFile(profilePath, "utf8"))
      .replace("agents: [opencode, claude-code]", "agents: [opencode, claude-code, codex]")
      .replace(
        "mcp:\n  context7:\n    agents: { opencode: true, claude-code: true }",
        "mcp:\n  context7:\n    agents: { opencode: true, claude-code: true }\n" +
          "  secure-api:\n    agents: { claude-code: true, codex: true }"
      );
    await writeFile(profilePath, profileYml, "utf8");
  });

  it("rewrites env-ref headers into each agent's native dialect", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "all"]);

    const claudeMcp = JSON.parse(
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    ) as Record<string, { headers?: Record<string, string> }>;
    // Claude keeps one headers map; the env token becomes `${NAME}`, the literal
    // header is passed through untouched.
    expect(claudeMcp["secure-api"]).toMatchObject({
      type: "http",
      url: "https://api.invalid/mcp",
      headers: {
        Authorization: "${API_TOKEN}",
        "X-Client": "literal-value"
      }
    });

    const codexConfig = parse(
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    ) as {
      mcp_servers: Record<
        string,
        {
          url?: string;
          enabled?: boolean;
          http_headers?: Record<string, string>;
          env_http_headers?: Record<string, string>;
        }
      >;
    };
    // Codex splits the two: literals stay under http_headers, env tokens move to
    // env_http_headers as the bare variable name.
    expect(codexConfig.mcp_servers["secure-api"]).toEqual({
      url: "https://api.invalid/mcp",
      enabled: true,
      http_headers: { "X-Client": "literal-value" },
      env_http_headers: { Authorization: "API_TOKEN" }
    });
  });
});
