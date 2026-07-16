import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { cli, makeTempDir, setupIntegrationFixture } from "./support.js";

async function configureLocalProbe(root: string, script: string): Promise<void> {
  await appendFile(
    path.join(root, "catalog", "mcp.yml"),
    [
      "  probe-server:",
      "    description: Probe server.",
      "    type: local",
      `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}]`,
      "    env: { HOME: /tmp/mfz-probe-server-home }",
      ""
    ].join("\n"),
    "utf8"
  );
  const profilePath = path.join(root, "profiles", "personal", "profile.yml");
  const profile = await readFile(profilePath, "utf8");
  const marker = "  context7:\n    agents: { opencode: true, claude-code: true }\n";
  expect(profile).toContain(marker);
  await writeFile(
    profilePath,
    profile.replace(
      marker,
      [
        "  context7:",
        "    agents: { opencode: false }",
        "  probe-server:",
        "    agents: { opencode: true }",
        ""
      ].join("\n")
    ),
    "utf8"
  );
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("context overrides and MCP probes", () => {
  it("uses effective profile, global, and project skill visibility", async () => {
    const { root, home } = await setupIntegrationFixture();
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    const profile = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      profile.replace(
        "    model: test/model\n",
        [
          "    model: test/model",
          "    permission:",
          "      skill:",
          '        "*": deny',
          "        local-skill: allow",
          ""
        ].join("\n")
      ),
      "utf8"
    );
    await mkdir(path.join(home, ".mindframe-z", "skill-overrides"), { recursive: true });
    await writeFile(
      path.join(home, ".mindframe-z", "skill-overrides", "opencode.json"),
      JSON.stringify({ "local-skill": false }),
      "utf8"
    );
    await writeFile(
      path.join(home, ".mindframe-z", "overrides.json"),
      JSON.stringify({
        projects: {
          [root]: { opencode: { skills: { "local-skill": true } } }
        }
      }),
      "utf8"
    );
    await execa("git", ["init", "-q", root]);

    const projectResult = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode"],
      {},
      undefined,
      root
    );
    expect(projectResult.stdout).toContain(
      "local-skill  ~22 catalogue; ~18 body inventory on invocation"
    );
    expect(projectResult.stdout).toContain("Skills (1 skill | ~22 catalogue");
    expect(projectResult.stdout).not.toContain("all-skill  ");

    const otherRoot = await makeTempDir();
    await execa("git", ["init", "-q", otherRoot]);
    const otherResult = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode"],
      {},
      undefined,
      otherRoot
    );
    expect(otherResult.stdout).not.toContain("Notes:");
    expect(otherResult.stdout).not.toContain("local-skill  ");
  });

  it("reports effective MCP membership separately for each harness", async () => {
    const { root, home } = await setupIntegrationFixture();
    await execa("git", ["init", "-q", root]);
    await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
    await writeFile(
      path.join(home, ".mindframe-z", "overrides.json"),
      JSON.stringify({ projects: { [root]: { opencode: { mcp: { context7: false } } } } }),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["context"], {}, undefined, root);

    expect(result.stdout).toContain("Per request (none)");
    expect(result.stdout).toContain("MCP servers (0 enabled; 1 disabled)");
    expect(result.stdout).not.toContain("context7  disabled");
    expect(result.stdout).toContain(
      "MCP schema inventory (2 enabled | loading unknown; excluded from Per request)"
    );
  });

  it("does not connect during static analysis and measures a local stdio probe", async () => {
    const { root, home } = await setupIntegrationFixture();
    const inspectedDirectory = await makeTempDir();
    const script = path.join(root, "probe-server.mjs");
    await writeFile(
      script,
      [
        "import { writeFileSync } from 'node:fs';",
        "let buffer = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  while (buffer.includes('\\n')) {",
        "    const end = buffer.indexOf('\\n');",
        "    const line = buffer.slice(0, end);",
        "    buffer = buffer.slice(end + 1);",
        "    if (!line.trim()) continue;",
        "    const request = JSON.parse(line);",
        "    if (process.env.MCP_PROBE_MARKER) writeFileSync(process.env.MCP_PROBE_MARKER, 'started');",
        "    if (process.env.MCP_PROBE_CWD_MARKER) writeFileSync(process.env.MCP_PROBE_CWD_MARKER, process.cwd());",
        "    if (process.env.MCP_PROBE_HOME_MARKER) writeFileSync(process.env.MCP_PROBE_HOME_MARKER, process.env.HOME ?? '');",
        "    if (!Object.prototype.hasOwnProperty.call(request, 'id')) continue;",
        "    const result = request.method === 'initialize'",
        "      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }, instructions: 'private server instruction' }",
        "      : { tools: [{ name: 'private_tool', description: 'private tool description', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] };",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
        "  }",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await configureLocalProbe(root, script);
    const marker = path.join(root, "probe-started");
    const cwdMarker = path.join(root, "probe-cwd");
    const homeMarker = path.join(root, "probe-home");
    const env = {
      MCP_PROBE_MARKER: marker,
      MCP_PROBE_CWD_MARKER: cwdMarker,
      MCP_PROBE_HOME_MARKER: homeMarker
    };

    const staticResult = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode"],
      env,
      undefined,
      inspectedDirectory
    );
    expect(staticResult.stdout).toContain(
      "probe-server  enabled | schemas unmeasured (not probed)"
    );
    await expect(access(marker)).rejects.toThrow();

    const probeResult = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode", "--probe-mcp"],
      env,
      undefined,
      inspectedDirectory
    );
    expect(probeResult.stdout).toContain(`Context | personal | ${inspectedDirectory}`);
    expect(probeResult.stdout).not.toContain("MCP probes");
    expect(probeResult.stdout).toContain("MCP servers (1 enabled; 1 disabled)");
    expect(probeResult.stdout).toContain(
      "probe-server  enabled | 1 tool | schemas 139 chars (~35); instructions 26 chars (~7)"
    );
    expect(probeResult.stdout).toContain("not sandboxed");
    expect(probeResult.stdout).not.toContain("private server instruction");
    expect(probeResult.stdout).not.toContain("private tool description");
    await expect(access(marker)).resolves.toBeUndefined();
    await expect(readFile(cwdMarker, "utf8")).resolves.toBe(inspectedDirectory);
    await expect(readFile(homeMarker, "utf8")).resolves.toMatch(/mfz-context-mcp-/);
    await expect(readFile(homeMarker, "utf8")).resolves.not.toBe("/tmp/mfz-probe-server-home");
  });

  it("keeps OpenCode skill catalogues visible when Claude-only invocation metadata is present", async () => {
    const { root, home } = await setupIntegrationFixture();
    await mkdir(path.join(home, ".agents", "skills", "local-skill"), { recursive: true });
    await writeFile(
      path.join(home, ".agents", "skills", "local-skill", "SKILL.md"),
      ["---", "disable-model-invocation: true", "---", "", "Skill body.", ""].join("\n"),
      "utf8"
    );

    const result = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode"],
      {},
      undefined,
      root
    );
    expect(result.stdout).toContain("local-skill  ~24 catalogue; ~13 body inventory on invocation");
    expect(result.stdout).not.toContain("model invocation disabled; catalogue is not advertised");
  });

  it("measures a remote HTTP probe without provider or tool calls", async () => {
    const { root, home } = await setupIntegrationFixture();
    const methods: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number;
          method?: string;
        };
        methods.push(body.method ?? "");
        if (body.method === "notifications/initialized") {
          response.statusCode = 204;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "remote-fixture", version: "1" },
                    instructions: "remote private instruction"
                  }
                : {
                    tools: [
                      {
                        name: "remote_private_tool",
                        description: "remote private description",
                        inputSchema: { type: "object", properties: {} }
                      }
                    ]
                  }
          })
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
    const catalogPath = path.join(root, "catalog", "mcp.yml");
    const catalog = await readFile(catalogPath, "utf8");
    await writeFile(
      catalogPath,
      catalog.replace("https://mcp.context7.com/mcp", `http://127.0.0.1:${address.port}/mcp`),
      "utf8"
    );

    try {
      const result = await cli(
        "mfz",
        root,
        home,
        ["context", "--agent", "opencode", "--probe-mcp"],
        {},
        undefined,
        root
      );
      expect(result.stdout).toContain("context7  enabled | 1 tool");
      expect(result.stdout).not.toContain("remote private instruction");
      expect(result.stdout).not.toContain("remote private description");
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    } finally {
      await closeServer(server);
    }
  });

  it("probes one shared enabled server once across active harnesses and hides failures", async () => {
    const fixture = await setupIntegrationFixture();
    await execa("git", ["init", "-q", fixture.root]);
    await mkdir(path.join(fixture.home, ".mindframe-z"), { recursive: true });
    await writeFile(
      path.join(fixture.home, ".mindframe-z", "overrides.json"),
      JSON.stringify({
        projects: { [fixture.root]: { "claude-code": { mcp: { "local-helper": false } } } }
      }),
      "utf8"
    );
    const methods: string[] = [];
    const server = createServer((_request, response) => {
      methods.push("request");
      response.statusCode = 401;
      response.end("credential=private-value");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
    const catalogPath = path.join(fixture.root, "catalog", "mcp.yml");
    const catalog = await readFile(catalogPath, "utf8");
    await writeFile(
      catalogPath,
      catalog.replace("https://mcp.context7.com/mcp", `http://127.0.0.1:${address.port}/mcp`),
      "utf8"
    );
    try {
      const result = await cli(
        "mfz",
        fixture.root,
        fixture.home,
        ["context", "--probe-mcp"],
        {},
        undefined,
        fixture.root
      );
      expect(result.stdout).toContain("MCP servers (1 enabled)");
      expect(result.stdout).toContain(
        "MCP schema inventory (1 enabled; 1 disabled | loading unknown; excluded from Per request)"
      );
      expect(result.stdout.match(/context7  enabled \| unavailable/g)).toHaveLength(2);
      expect(result.stdout).not.toContain("credential=private-value");
      expect(methods).toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });

  it("reports configured remote SSE probes as unavailable", async () => {
    const { root, home } = await setupIntegrationFixture();
    const catalogPath = path.join(root, "catalog", "mcp.yml");
    const catalog = await readFile(catalogPath, "utf8");
    await writeFile(catalogPath, catalog.replace("transport: http", "transport: sse"), "utf8");

    const result = await cli(
      "mfz",
      root,
      home,
      ["context", "--agent", "opencode", "--probe-mcp"],
      {},
      undefined,
      root
    );
    expect(result.stdout).toContain("context7  enabled | unavailable");
  });
});
