import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimePaths,
  executorConfigPath,
  executorDataDir,
  executorScopeDir
} from "../core/paths.js";
import {
  createExecutorAdapter,
  createExecutorHttpAdapter,
  redactExecutorError,
  type ExecutorAdapter
} from "./adapter.js";

const adapters: ExecutorAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

describe("Executor v1.5.33 adapter contract", () => {
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

  it("uses the effective dynamic client slug and keeps OAuth state out of opener argv", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const opened: string[] = [];
    const connection = {
      owner: "user",
      name: "main",
      integration: "example",
      template: "oauth",
      provider: "oauth-provider",
      identityLabel: "test-user",
      expiresAt: Date.now() + 60_000,
      oauthClient: "effective-client",
      oauthClientOwner: "user",
      oauthScope: "read",
      missingOAuthScopes: [],
      lastHealth: { status: "healthy", checkedAt: Date.now() }
    };
    const adapter = createExecutorHttpAdapter({
      baseUrl: "http://127.0.0.1:1234",
      token: "loopback-secret",
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/api/oauth/probe")) {
          return new Response(
            JSON.stringify({
              authorizationUrl: "https://provider.test/authorize",
              tokenUrl: "https://provider.test/token",
              registrationEndpoint: "https://provider.test/register"
            }),
            { status: 200 }
          );
        }
        if (url.endsWith("/api/oauth/clients/register-dynamic")) {
          return new Response(JSON.stringify({ client: "effective-client" }), { status: 200 });
        }
        if (url.endsWith("/api/oauth/start")) {
          return new Response(
            JSON.stringify({
              status: "redirect",
              authorizationUrl: "https://provider.test/authorize?state=state-secret",
              state: "state-secret"
            }),
            { status: 200 }
          );
        }
        if (url.includes("/api/connections?integration=example")) {
          return new Response(JSON.stringify([connection]), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }
    });

    await adapter.authorizeOAuth({
      integration: "example",
      endpoint: "https://example.test/mcp",
      name: "main",
      template: "oauth",
      scopes: ["read"],
      interactive: true
    });

    const startCall = calls.find((call) => call.url.endsWith("/api/oauth/start"));
    expect(JSON.parse(String(startCall?.init?.body))).toMatchObject({ client: "effective-client" });
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\//);
    expect(opened[0]).not.toContain("state-secret");
  });

  it("registers, reads, and creates a no-auth connection in disposable state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-contract-"));
    const adapter = await createExecutorAdapter({
      paths: createRuntimePaths({ root, home: root }),
      profileName: "contract"
    });
    adapters.push(adapter);

    await adapter.addServer({
      slug: "contract-server",
      name: "contract-server",
      description: "Disposable contract server",
      config: {
        transport: "remote",
        endpoint: "https://example.invalid/mcp",
        remoteTransport: "auto",
        authenticationTemplate: [{ slug: "none", kind: "none" }]
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
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it("reuses a profile daemon and isolates another profile scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-daemon-"));
    const paths = createRuntimePaths({ root, home: root });
    const first = await createExecutorAdapter({ paths, profileName: "personal" });
    const second = await createExecutorAdapter({ paths, profileName: "personal" });
    const other = await createExecutorAdapter({ paths, profileName: "other" });
    adapters.push(first, second, other);

    expect(second.baseUrl).toBe(first.baseUrl);
    expect(other.baseUrl).not.toBe(first.baseUrl);
    expect(other.dataDir).not.toBe(first.dataDir);
    await Promise.all([first.close(), second.close(), other.close()]);
    await rm(root, { recursive: true, force: true });
  }, 30_000);

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

  it("rejects an unsupported Executor binary before daemon startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-version-"));
    const paths = createRuntimePaths({ root, home: root });
    await expect(
      createExecutorAdapter({ paths, profileName: "version", binary: process.execPath })
    ).rejects.toThrow(/Unsupported Executor version/);
    await expect(access(executorDataDir(paths, "version"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(executorScopeDir(paths, "version"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(executorConfigPath(paths, "version"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await rm(root, { recursive: true, force: true });
  });
});
