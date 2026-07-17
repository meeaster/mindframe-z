import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { profileSchema } from "../core/manifests.js";
import { createRuntimePaths, executorDesiredPath, executorManagedPath } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type {
  ExecutorAdapter,
  ExecutorConnection,
  ExecutorHealth,
  ExecutorIntegration
} from "./adapter.js";
import { reconcileExecutor } from "./reconcile.js";

function profileWithServer(
  name: string,
  endpoint: string,
  options: { description?: string; oauth?: boolean } = {}
): ResolvedProfile {
  return {
    name,
    agents: ["opencode"],
    profile: profileSchema.parse({ name }),
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
        server: {
          type: "remote",
          description: options.description ?? "Example",
          url: endpoint,
          transport: "http",
          ...(options.oauth ? { executor: { oauth: { template: "oauth", scopes: ["read"] } } } : {})
        }
      }
    ],
    extraFolders: []
  };
}

function emptyProfile(name: string): ResolvedProfile {
  return { ...profileWithServer(name, "https://example.test/mcp"), mcpServers: [] };
}

function fakeAdapter(): {
  adapter: ExecutorAdapter;
  mutations: string[];
  integrations: Map<string, ExecutorIntegration>;
  connections: Map<string, ExecutorConnection[]>;
} {
  const integrations = new Map<string, ExecutorIntegration>();
  const connections = new Map<string, ExecutorConnection[]>();
  const mutations: string[] = [];
  const healthy: ExecutorHealth = { status: "healthy", checkedAt: Date.now() };

  const adapter: ExecutorAdapter = {
    baseUrl: "http://fake",
    dataDir: "/tmp/fake-data",
    scopeDir: "/tmp/fake-scope",
    async getIntegration(slug) {
      return integrations.get(slug) ?? null;
    },
    async updateIntegration(slug, input) {
      const integration = integrations.get(slug);
      if (integration) {
        integration.description = input.description ?? integration.description;
        mutations.push(`update:${slug}`);
      }
    },
    async addServer(server) {
      integrations.set(server.slug, {
        slug: server.slug,
        description: server.description,
        kind: "mcp",
        canRemove: true,
        canRefresh: true,
        config: server.config as unknown as Record<string, unknown>
      });
      mutations.push(`add:${server.slug}`);
    },
    async configureServer(slug, config) {
      const integration = integrations.get(slug);
      if (integration) integration.config = config;
      mutations.push(`configure:${slug}`);
    },
    async configureAuth(slug, authenticationTemplate, mode) {
      const integration = integrations.get(slug);
      if (integration) integration.config.authenticationTemplate = authenticationTemplate;
      mutations.push(`auth:${slug}:${mode}`);
    },
    async removeIntegration(slug) {
      integrations.delete(slug);
      connections.delete(slug);
      mutations.push(`remove:${slug}`);
    },
    async listConnections(integration) {
      return connections.get(integration) ?? [];
    },
    async createNoAuthConnection(integration, name) {
      connections.set(integration, [
        {
          owner: "user",
          name,
          integration,
          template: "none",
          provider: "none",
          identityLabel: null,
          expiresAt: null,
          oauthClient: null,
          oauthClientOwner: null,
          oauthScope: null,
          missingOAuthScopes: [],
          lastHealth: healthy
        }
      ]);
      mutations.push(`connection:${integration}`);
    },
    async refreshConnection(integration) {
      mutations.push(`refresh:${integration}`);
    },
    async checkHealth() {
      return healthy;
    },
    async authorizeOAuth(input) {
      connections.set(input.integration, [
        {
          owner: "user",
          name: input.name,
          integration: input.integration,
          template: input.template,
          provider: "oauth-provider",
          identityLabel: "test-user",
          expiresAt: Date.now() + 60_000,
          oauthClient: "client-1",
          oauthClientOwner: "user",
          oauthScope: input.scopes.join(" "),
          missingOAuthScopes: [],
          lastHealth: healthy
        }
      ]);
      mutations.push(`oauth:${input.integration}`);
    },
    async close() {}
  };
  return { adapter, mutations, integrations, connections };
}

describe("Executor reconciliation", () => {
  it("registers, reuses, updates, isolates, and safely prunes disposable state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, mutations } = fakeAdapter();

    await expect(
      reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
        adapter,
        interactive: true
      })
    ).resolves.toMatchObject({ added: ["example"] });
    await expect(
      reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
        adapter,
        interactive: true
      })
    ).resolves.toMatchObject({ reused: ["example"], added: [] });
    await expect(
      reconcileExecutor(
        paths,
        profileWithServer("personal", "https://changed.example.test/mcp", {
          description: "Changed"
        }),
        { adapter, interactive: true }
      )
    ).resolves.toMatchObject({ updated: expect.arrayContaining(["example"]) });
    await expect(
      reconcileExecutor(paths, emptyProfile("personal"), { adapter, interactive: true })
    ).resolves.toMatchObject({ removed: ["example"] });

    const other = fakeAdapter();
    const otherPaths = createRuntimePaths({ root, home: root });
    await reconcileExecutor(
      otherPaths,
      profileWithServer("other", "https://other.example.test/mcp"),
      { adapter: other.adapter, interactive: true }
    );
    expect(await readFile(executorDesiredPath(otherPaths, "other"), "utf8")).toContain(
      '"profile": "other"'
    );
    expect(await readFile(executorManagedPath(paths, "personal"), "utf8")).toContain(
      '"integrations": {}'
    );
    expect(mutations).toEqual([
      "add:example",
      "connection:example",
      "update:example",
      "configure:example",
      "refresh:example",
      "remove:example"
    ]);
    await rm(root, { recursive: true, force: true });
  });

  it("fails noninteractive OAuth before mutating a missing integration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-oauth-"));
    const { adapter, mutations } = fakeAdapter();
    await expect(
      reconcileExecutor(
        createRuntimePaths({ root, home: root }),
        profileWithServer("personal", "https://oauth.example.test/mcp", { oauth: true }),
        { adapter, interactive: false }
      )
    ).rejects.toThrow(/OAuth authorization is required/);
    expect(mutations).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("blocks removal when an existing connection has durable OAuth state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-blocker-"));
    const { adapter, connections } = fakeAdapter();
    const paths = createRuntimePaths({ root, home: root });
    await reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
      adapter,
      interactive: true
    });
    const connection = connections.get("example")?.[0];
    if (!connection) throw new Error("fake connection was not created");
    connection.template = "oauth";

    await expect(
      reconcileExecutor(paths, emptyProfile("personal"), { adapter, interactive: true })
    ).rejects.toThrow(/durable connection state/);
    await rm(root, { recursive: true, force: true });
  });

  it("reports changed and removed integrations in dry-run without an adapter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-plan-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter } = fakeAdapter();
    await reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
      adapter,
      interactive: true
    });

    await expect(
      reconcileExecutor(paths, profileWithServer("personal", "https://changed.example.test/mcp"), {
        dryRun: true
      })
    ).resolves.toMatchObject({ updated: ["example"], added: [], removed: [] });
    await expect(
      reconcileExecutor(paths, emptyProfile("personal"), { dryRun: true })
    ).resolves.toMatchObject({ updated: [], added: [], removed: ["example"] });
    await rm(root, { recursive: true, force: true });
  });

  it("replaces unused authentication templates but blocks referenced ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-auth-templates-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, connections, mutations } = fakeAdapter();
    await reconcileExecutor(
      paths,
      profileWithServer("personal", "https://example.test/mcp", { oauth: true }),
      { adapter, interactive: true }
    );
    connections.delete("example");

    await expect(
      reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
        adapter,
        interactive: true
      })
    ).resolves.toMatchObject({ updated: ["example"] });
    expect(mutations).toContain("auth:example:replace");
    await rm(root, { recursive: true, force: true });
  });

  it("preserves an existing OAuth connection on repeated reconciliation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-oauth-reuse-"));
    const { adapter, mutations, connections } = fakeAdapter();
    const paths = createRuntimePaths({ root, home: root });
    const profile = profileWithServer("personal", "https://oauth.example.test/mcp", {
      oauth: true
    });

    await reconcileExecutor(paths, profile, { adapter, interactive: true });
    const existing = connections.get("example")?.[0];
    if (!existing) throw new Error("fake OAuth connection was not created");
    const identity = existing.oauthClient;
    await expect(
      reconcileExecutor(paths, profile, { adapter, interactive: true })
    ).resolves.toMatchObject({
      reused: ["example"]
    });
    expect(connections.get("example")?.[0]?.oauthClient).toBe(identity);
    expect(mutations).toEqual(["add:example", "oauth:example"]);
    await rm(root, { recursive: true, force: true });
  });

  it("blocks endpoint, resource, transport, and command changes before any mutation", async () => {
    const changes: Array<[string, unknown]> = [
      ["endpoint", "https://changed.example.test/mcp"],
      ["resource", "https://changed.example.test/resource"],
      ["remoteTransport", "sse"],
      ["command", ["different-command"]]
    ];

    for (const [field, value] of changes) {
      const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-dangerous-"));
      const paths = createRuntimePaths({ root, home: root });
      const { adapter, integrations, connections, mutations } = fakeAdapter();
      await reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
        adapter,
        interactive: true
      });
      const connection = connections.get("example")?.[0];
      if (!connection) throw new Error("fake connection was not created");
      connection.template = "oauth";
      const integration = integrations.get("example");
      if (!integration) throw new Error("fake integration was not created");
      integration.config[field] = value;
      const mutationCount = mutations.length;

      await expect(
        reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
          adapter,
          interactive: true
        })
      ).rejects.toThrow(/dangerous configuration changes/);
      expect(mutations).toHaveLength(mutationCount);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not trust a cached healthy connection when a fresh health check fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-stale-health-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, mutations } = fakeAdapter();
    const profile = profileWithServer("personal", "https://example.test/mcp");
    await reconcileExecutor(paths, profile, { adapter, interactive: true });
    const staleAdapter: ExecutorAdapter = {
      ...adapter,
      async checkHealth() {
        return { status: "unhealthy", checkedAt: Date.now() };
      }
    };

    await expect(
      reconcileExecutor(paths, profile, { adapter: staleAdapter, interactive: true })
    ).rejects.toThrow(/not healthy/);
    expect(mutations).toEqual(["add:example", "connection:example"]);
    await rm(root, { recursive: true, force: true });
  });
});
