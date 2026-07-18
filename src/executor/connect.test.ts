import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { profileSchema, type ExecutorAuthenticationMethod } from "../core/manifests.js";
import { createRuntimePaths, executorManagedPath } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { ExecutorAdapter, ExecutorConnection, ExecutorIntegration } from "./adapter.js";
import { connectExecutor } from "./connect.js";
import { executorConnectionAddress } from "./contract.js";

function profileWithMethods(
  methods: ExecutorAuthenticationMethod[],
  selections?: Record<string, string>
): ResolvedProfile {
  return {
    name: "personal",
    agents: ["opencode"],
    profile: profileSchema.parse({ name: "personal" }),
    manifests: {} as ResolvedProfile["manifests"],
    sources: {} as ResolvedProfile["sources"],
    instructionFiles: [],
    referencesDir: "/tmp/references",
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    mcpServers: [
      {
        name: "example",
        route: "executor",
        connections: selections ?? (methods.length === 1 ? { main: methods[0]!.slug } : {}),
        server: {
          type: "remote",
          description: "Example",
          url: "https://example.test/mcp",
          transport: "http",
          executor: { authentication: methods }
        }
      }
    ],
    extraFolders: []
  };
}

function connection(template: string, name = "main"): ExecutorConnection {
  return {
    owner: "user",
    name,
    integration: "example",
    template,
    provider: template === "none" ? "none" : "oauth",
    address: executorConnectionAddress("user", "example", name),
    identityLabel: null,
    expiresAt: null,
    oauthClient: template === "none" ? null : "client",
    oauthClientOwner: template === "none" ? null : "user",
    oauthScope: template === "none" ? null : "read",
    missingOAuthScopes: [],
    lastHealth: { status: "healthy", checkedAt: Date.now() }
  };
}

function fakeAdapter(): {
  adapter: ExecutorAdapter;
  calls: string[];
  connections: Map<string, ExecutorConnection[]>;
  integrations: Map<string, ExecutorIntegration>;
} {
  const calls: string[] = [];
  const integrations = new Map<string, ExecutorIntegration>();
  const connections = new Map<string, ExecutorConnection[]>();
  const adapter: ExecutorAdapter = {
    baseUrl: "http://fake",
    dataDir: "/tmp/data",
    async getIntegration(slug) {
      return integrations.get(slug) ?? null;
    },
    async updateIntegration() {},
    async addServer(server) {
      integrations.set(server.slug, {
        slug: server.slug,
        description: server.description,
        kind: "mcp",
        canRemove: true,
        canRefresh: true,
        config: server.config as unknown as Record<string, unknown>
      });
      calls.push("add");
    },
    async configureServer(slug, config) {
      const current = integrations.get(slug);
      if (current) current.config = config;
      calls.push("configure");
    },
    async configureAuth(slug, methods) {
      const current = integrations.get(slug);
      if (current) current.config.authenticationTemplate = methods;
      calls.push("auth");
    },
    async removeIntegration() {},
    async listConnections(slug) {
      return connections.get(slug) ?? [];
    },
    async createNoAuthConnection(slug, name) {
      calls.push("no-auth");
      connections.set(slug, [connection("none", name)]);
    },
    async refreshConnection(integration, name) {
      calls.push(`refresh:${name}`);
      return [
        {
          address: `tools.${integration}.user.${name}.example_tool`,
          owner: "user",
          integration,
          connection: name,
          name: "example_tool",
          pluginId: "test",
          description: "Example tool"
        }
      ];
    },
    async checkHealth(_integration, name) {
      calls.push(`health:${name}`);
      return { status: "healthy", checkedAt: Date.now() };
    },
    async cancelOAuth() {
      calls.push("cancel");
    },
    async startApiKeyHandoff(input) {
      calls.push("handoff");
      connections.set("example", [
        { ...connection("api-key"), name: input.label, identityLabel: input.label }
      ]);
    },
    async authorizeOAuth(input) {
      calls.push("oauth");
      const next = connection("oauth", input.name);
      connections.set("example", [
        ...(connections.get("example") ?? []).filter((candidate) => candidate.name !== input.name),
        next
      ]);
      return next;
    },
    async close() {
      calls.push("close");
    }
  };
  return { adapter, calls, connections, integrations };
}

describe("Executor connect workflows", () => {
  it("creates and verifies an explicitly declared no-auth connection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-none-"));
    const { adapter, calls } = fakeAdapter();
    await connectExecutor(
      createRuntimePaths({ root, home: root }),
      profileWithMethods([{ slug: "none", kind: "none" }]),
      "example",
      { adapter, interactive: false }
    );
    expect(calls).toEqual(["add", "no-auth", "health:main", "refresh:main"]);
    await connectExecutor(
      createRuntimePaths({ root, home: root }),
      profileWithMethods([{ slug: "none", kind: "none" }]),
      "example",
      { adapter, interactive: false }
    );
    expect(calls.filter((call) => call === "no-auth")).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });

  it("uses an explicit browser handoff for API keys without receiving a value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-key-"));
    const { adapter, calls } = fakeAdapter();
    await connectExecutor(
      createRuntimePaths({ root, home: root }),
      profileWithMethods([
        {
          slug: "api-key",
          kind: "apikey",
          placements: [{ carrier: "header", name: "X-API-Key", variable: "api_key" }]
        }
      ]),
      "example",
      { adapter, interactive: true }
    );
    expect(calls).toContain("handoff");
    expect(calls).not.toContain("credential");
    await rm(root, { recursive: true, force: true });
  });

  it("does not authorize OAuth from a noninteractive connect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-oauth-"));
    const { adapter, calls } = fakeAdapter();
    await expect(
      connectExecutor(
        createRuntimePaths({ root, home: root }),
        profileWithMethods([{ slug: "oauth", kind: "oauth2" }]),
        "example",
        { adapter, interactive: false }
      )
    ).rejects.toThrow(/authentication is required/);
    expect(calls).not.toContain("oauth");
    await rm(root, { recursive: true, force: true });
  });

  it("reuses an existing compatible connection without another authorization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-reuse-"));
    const { adapter, calls, connections } = fakeAdapter();
    const originalAdd = adapter.addServer;
    adapter.addServer = async (server) => {
      await originalAdd(server);
      connections.set(server.slug, [connection("oauth")]);
    };
    await connectExecutor(
      createRuntimePaths({ root, home: root }),
      profileWithMethods([{ slug: "oauth", kind: "oauth2" }]),
      "example",
      { adapter, interactive: true }
    );
    expect(calls).not.toContain("oauth");
    expect(calls).toContain("refresh:main");
    calls.length = 0;
    await connectExecutor(
      createRuntimePaths({ root, home: root }),
      profileWithMethods([{ slug: "oauth", kind: "oauth2" }]),
      "example",
      { adapter, interactive: true, repair: true }
    );
    expect(calls).toContain("oauth");
    await rm(root, { recursive: true, force: true });
  });

  it("waits for a correlated API-key generation instead of accepting a preexisting repair", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-key-repair-"));
    const { adapter, calls, connections } = fakeAdapter();
    connections.set("example", [connection("api-key")]);
    let handoffLabel = "";
    adapter.startApiKeyHandoff = async (input) => {
      calls.push("handoff");
      handoffLabel = input.label;
      setTimeout(() => {
        connections.set("example", [
          connection("api-key"),
          {
            ...connection("api-key"),
            name: "main",
            identityLabel: input.label
          }
        ]);
      }, 25);
    };

    await connectExecutor(
      createRuntimePaths({ root, home: root }),
      profileWithMethods([
        {
          slug: "api-key",
          kind: "apikey",
          placements: [{ carrier: "header", name: "X-API-Key", variable: "api_key" }]
        }
      ]),
      "example",
      { adapter, interactive: true, repair: true }
    );

    expect(handoffLabel).toBe("main");
    expect(calls).toContain("health:main");
    await rm(root, { recursive: true, force: true });
  });

  it("rejects ambiguous connection selection before creating an adapter or starting OAuth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-ambiguous-"));
    const { adapter, calls } = fakeAdapter();
    await expect(
      connectExecutor(
        createRuntimePaths({ root, home: root }),
        profileWithMethods([{ slug: "oauth", kind: "oauth2" }], {
          publicsafety: "oauth",
          tylertech: "oauth"
        }),
        "example",
        { adapter, interactive: true }
      )
    ).rejects.toThrow(/multiple named connections.*publicsafety, tylertech/);
    expect(calls).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("authorizes only the selected named connection and preserves its sibling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-named-"));
    const { adapter, calls, connections } = fakeAdapter();
    const existing = connection("oauth", "publicsafety");
    connections.set("example", [existing]);

    await connectExecutor(
      createRuntimePaths({ root, home: root }),
      profileWithMethods([{ slug: "oauth", kind: "oauth2" }], {
        publicsafety: "oauth",
        tylertech: "oauth"
      }),
      "example",
      { adapter, connection: "tylertech", interactive: true }
    );

    expect(calls).toContain("oauth");
    expect(calls).toContain("health:tylertech");
    expect(calls).toContain("refresh:tylertech");
    expect(connections.get("example")?.map((item) => item.name)).toEqual([
      "publicsafety",
      "tylertech"
    ]);
    await rm(root, { recursive: true, force: true });
  });

  it("only prepares the selected integration and leaves managed apply state untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-connect-scope-"));
    const paths = createRuntimePaths({ root, home: root });
    const managedPath = executorManagedPath(paths, "personal");
    const managed = `${JSON.stringify({
      version: 1,
      profile: "personal",
      complete: true,
      integrations: {
        unrelated: { digest: "digest", lastReconciledAt: new Date().toISOString() }
      }
    })}\n`;
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(managedPath, managed, "utf8");
    const { adapter, integrations } = fakeAdapter();
    integrations.set("unrelated", {
      slug: "unrelated",
      description: "Unrelated",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      config: {}
    });

    await connectExecutor(paths, profileWithMethods([{ slug: "none", kind: "none" }]), "example", {
      adapter,
      interactive: false
    });

    expect(integrations.has("unrelated")).toBe(true);
    await expect(readFile(managedPath, "utf8")).resolves.toBe(managed);
    await rm(root, { recursive: true, force: true });
  });
});
