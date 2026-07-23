import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimePaths, executorConfigPath, executorDataDir } from "../core/paths.js";
import {
  createExecutorAdapter,
  createExecutorHttpAdapter,
  redactExecutorError,
  type ExecutorAdapter
} from "./adapter.js";

const adapters: ExecutorAdapter[] = [];
const executorInstalled = await execa("executor", ["--version"], { reject: false })
  .then((result) => result.exitCode === 0)
  .catch(() => false);

async function withExecutorDataDir<T>(dataDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.EXECUTOR_DATA_DIR;
  process.env.EXECUTOR_DATA_DIR = dataDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EXECUTOR_DATA_DIR;
    else process.env.EXECUTOR_DATA_DIR = previous;
  }
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

describe("Executor adapter contract", () => {
  it("redacts bearer, OAuth, API-key, and browser query secrets", () => {
    const output = redactExecutorError(
      "Bearer bearer-secret access_token=access-secret refresh_token=refresh-secret api-key=api-secret credential_provider=provider-secret client_secret=snake-secret client-secret=hyphen-secret clientSecret=camel-secret https://example.test/callback?code=code-secret&state=state-secret"
    );
    expect(output).not.toContain("bearer-secret");
    expect(output).not.toContain("access-secret");
    expect(output).not.toContain("refresh-secret");
    expect(output).not.toContain("api-secret");
    expect(output).not.toContain("provider-secret");
    expect(output).not.toContain("snake-secret");
    expect(output).not.toContain("hyphen-secret");
    expect(output).not.toContain("camel-secret");
    expect(output).not.toContain("code-secret");
    expect(output).not.toContain("state-secret");
  });

  it("rejects connection and tool responses whose address identity is malformed", async () => {
    const connectionAdapter = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "loopback-secret",
      fetch: async () =>
        new Response(
          JSON.stringify([
            {
              owner: "user",
              name: "publicsafety",
              integration: "example",
              template: "none",
              provider: "none",
              address: "tools.example.user.publicsafety.wrong",
              identityLabel: null,
              expiresAt: null,
              oauthClient: null,
              oauthClientOwner: null,
              oauthScope: null,
              missingOAuthScopes: [],
              lastHealth: null
            }
          ]),
          { status: 200 }
        )
    });
    await expect(connectionAdapter.listConnections("example")).rejects.toThrow(/invalid response/);

    const toolAdapter = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "loopback-secret",
      fetch: async () =>
        new Response(
          JSON.stringify([
            {
              address: "tools.example.user.publicsafety.example_tool",
              owner: "user",
              integration: "example",
              connection: "publicsafety",
              name: "example_tool",
              pluginId: "test",
              description: "Example tool"
            }
          ]),
          { status: 200 }
        )
    });
    await expect(toolAdapter.refreshConnection("example", "publicsafety")).resolves.toHaveLength(1);
  });

  it("rejects unsafe connection names before they can become dotted addresses", async () => {
    const adapter = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "loopback-secret",
      fetch: async () => new Response("[]", { status: 200 })
    });
    await expect(adapter.createNoAuthConnection("example", "public.safety")).rejects.toThrow(
      /address-safe/
    );
  });

  it.skipIf(!executorInstalled)(
    "registers, reads, and creates a no-auth connection in disposable state",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-contract-"));
      await withExecutorDataDir(path.join(root, ".executor"), async () => {
        const adapter = await createExecutorAdapter({});
        adapters.push(adapter);

        await adapter.addServer({
          slug: "contract-server",
          name: "contract-server",
          description: "Disposable contract server",
          connections: {},
          config: {
            transport: "remote",
            endpoint: "https://example.invalid/mcp",
            remoteTransport: "auto"
          }
        });

        await expect(adapter.getIntegration("contract-server")).resolves.toMatchObject({
          slug: "contract-server",
          config: { endpoint: "https://example.invalid/mcp" }
        });
        await adapter.createNoAuthConnection("contract-server", "main");
        await expect(adapter.listConnections("contract-server")).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              owner: "user",
              name: "main",
              template: "none"
            })
          ])
        );
        await adapter.close();
      });
      await rm(root, { recursive: true, force: true });
    },
    30_000
  );

  it.skipIf(!executorInstalled)(
    "attaches every profile to the shared native Executor daemon and store",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-daemon-"));
      await withExecutorDataDir(path.join(root, ".executor"), async () => {
        const first = await createExecutorAdapter({});
        const second = await createExecutorAdapter({});
        const other = await createExecutorAdapter({});
        adapters.push(first, second, other);

        expect(second.baseUrl).toBe(first.baseUrl);
        expect(other.baseUrl).toBe(first.baseUrl);
        expect(other.dataDir).toBe(first.dataDir);
        const manifest = JSON.parse(
          await readFile(path.join(first.dataDir, "server-control", "server.json"), "utf8")
        ) as { scopeDir?: string | null };
        expect(manifest.scopeDir).toBeNull();
        await Promise.all([first.close(), second.close(), other.close()]);
      });
      await rm(root, { recursive: true, force: true });
    },
    30_000
  );

  it("uses metadata-only HTTP calls and never submits guessed credentials", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const requestFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/mcp/servers/example")) {
        return new Response(
          JSON.stringify({
            slug: "example",
            description: "Example",
            kind: "mcp",
            canRemove: true,
            canRefresh: true,
            config: { endpoint: "https://example.test/mcp" }
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    };
    const adapter = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "loopback-secret",
      fetch: requestFetch
    });

    await expect(adapter.getIntegration("example")).resolves.toMatchObject({
      slug: "example"
    });
    await adapter.createNoAuthConnection("example", "main");

    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer loopback-secret"
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      integration: "example",
      name: "main",
      values: {}
    });
    expect(String(calls[1]?.init?.body)).not.toMatch(/token|secret|api[-_]?key/i);
  });

  it("normalizes malformed, unauthorized, and timed-out loopback responses", async () => {
    const malformed = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "secret",
      fetch: async () => new Response("not-json", { status: 200 })
    });
    await expect(malformed.getIntegration("example")).rejects.toThrow(/malformed JSON/);

    const unauthorized = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "secret",
      fetch: async () =>
        new Response("Bearer bearer-secret access_token=access-secret", { status: 401 })
    });
    await expect(unauthorized.getIntegration("example")).rejects.toThrow(/\[redacted\]/);
    await expect(unauthorized.getIntegration("example")).rejects.not.toThrow(
      /bearer-secret|access-secret/
    );

    const timedOut = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "secret",
      requestTimeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true
          });
        })
    });
    await expect(timedOut.getIntegration("example")).rejects.toThrow(/request aborted/);
  });

  it("uses replacement auth mode and the MCP removal endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const adapter = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "loopback-secret",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response("{}", { status: 200 });
      }
    });

    await adapter.configureAuth("example", [{ slug: "none", kind: "none" }], "replace");
    await adapter.removeIntegration("example");

    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ mode: "replace" });
    expect(calls[1]?.url).toBe("http://127.0.0.1:1234/api/mcp/servers/example");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("encodes API-key placements through the adapter contract without values", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "loopback-secret",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      }
    });
    await adapter.configureAuth(
      "example",
      [
        {
          slug: "api-key",
          kind: "apikey",
          placements: [
            { carrier: "header", name: "X-API-Key", variable: "api_key", prefix: "Bearer " },
            { carrier: "query", name: "tenant", variable: "tenant_id" }
          ]
        }
      ],
      "replace"
    );
    expect(body).toMatchObject({
      mode: "replace",
      authenticationTemplate: [
        {
          slug: "api-key",
          type: "apiKey",
          headers: {
            "X-API-Key": ["Bearer ", { type: "variable", name: "api_key" }]
          },
          queryParams: {
            tenant: [{ type: "variable", name: "tenant_id" }]
          }
        }
      ]
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|token|value/i);
  });

  it("rejects an unavailable Executor binary before daemon startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-binary-"));
    const paths = createRuntimePaths({ root, home: root });
    await withExecutorDataDir(path.join(root, ".executor"), async () => {
      await expect(
        createExecutorAdapter({ binary: path.join(root, "missing-executor") })
      ).rejects.toThrow(/Executor is unavailable/);
      await expect(access(executorDataDir())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(executorConfigPath(paths, "version"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    });
    await rm(root, { recursive: true, force: true });
  });
});
