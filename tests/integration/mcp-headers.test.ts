import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, parseJson, parseToml, setupIntegrationFixture } from "./support.js";

const OpenCodeConfig = z.object({
  mcp: z.object({
    servers: z.record(
      z.string(),
      z.object({ url: z.string(), headers: z.record(z.string(), z.string()).optional() })
    )
  })
});

const ClaudeMcp = z
  .object({
    exa: z.object({ type: z.string(), url: z.string(), headers: z.record(z.string(), z.string()) }),
    secretpath: z.object({ type: z.string(), url: z.string() }),
    tailnet: z.object({ type: z.string(), url: z.string() })
  })
  .passthrough();

const CodexConfig = z.object({
  mcp_servers: z
    .object({
      exa: z.object({
        url: z.string(),
        enabled: z.boolean(),
        http_headers: z.record(z.string(), z.string()),
        env_http_headers: z.record(z.string(), z.string())
      }),
      tailnet: z.object({ url: z.string(), enabled: z.boolean() })
    })
    .passthrough()
});

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
        "  secretpath:",
        "    description: Server behind a secret URL path.",
        "    type: remote",
        "    transport: http",
        "    url: http://mcp.secret.invalid:9583/{env:SECRET_PATH}",
        "  tailnet:",
        "    description: Self-hosted server, localhost unless a profile says otherwise.",
        "    type: remote",
        "    transport: http",
        "    url: http://localhost:4400/mcp",
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
        "    agents: [opencode, claude-code, codex]",
        "  secretpath:",
        "    agents: [claude-code]",
        "  tailnet:",
        "    agents: [opencode, claude-code, codex]",
        "    url: https://grif.{env:TEST_TAILNET}/mcp",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"], { TEST_TAILNET: "example.ts.net" });
  });

  it("passes the env token through to OpenCode verbatim", async () => {
    const config = parseJson(
      OpenCodeConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    expect(config.mcp.servers.exa?.headers).toEqual({
      "x-api-key": "{env:EXA_API_KEY}",
      "x-client": "mindframe-z"
    });
  });

  it("rewrites the env token to shell expansion for Claude", async () => {
    const mcp = parseJson(
      ClaudeMcp,
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    );

    expect(mcp.exa).toEqual({
      type: "http",
      url: "https://mcp.exa.invalid/mcp",
      headers: {
        "x-api-key": "${EXA_API_KEY}",
        "x-client": "mindframe-z"
      }
    });
  });

  it("rewrites env tokens embedded in a Claude server URL", async () => {
    const mcp = parseJson(
      ClaudeMcp,
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    );

    expect(mcp.secretpath).toEqual({
      type: "http",
      url: "http://mcp.secret.invalid:9583/${SECRET_PATH}"
    });
  });

  it("splits literal and env headers into separate Codex tables", async () => {
    const config = parseToml(
      CodexConfig,
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    );

    expect(config.mcp_servers.exa).toEqual({
      url: "https://mcp.exa.invalid/mcp",
      enabled: true,
      http_headers: { "x-client": "mindframe-z" },
      env_http_headers: { "x-api-key": "EXA_API_KEY" }
    });
  });

  // A profile url replaces the catalog URL; each harness then renders its env token its own way.
  it("renders a profile URL override with each harness's env handling", async () => {
    const opencode = parseJson(
      OpenCodeConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    const claude = parseJson(
      ClaudeMcp,
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    );

    const codex = parseToml(
      CodexConfig,
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    );

    expect(opencode.mcp.servers.tailnet?.url).toBe("https://grif.{env:TEST_TAILNET}/mcp");
    expect(claude.tailnet.url).toBe("https://grif.${TEST_TAILNET}/mcp");
    expect(codex.mcp_servers.tailnet).toEqual({
      url: "https://grif.example.ts.net/mcp",
      enabled: true
    });
  });

  it("fails the apply when a Codex URL's env variable is unset", async () => {
    await expect(
      cli("mfz", root, home, ["apply", "--no-link"], { TEST_TAILNET: "" })
    ).rejects.toThrow(
      "Codex MCP server tailnet URL references {env:TEST_TAILNET}, which is not set"
    );
  });
});
