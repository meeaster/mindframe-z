import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { profileSchema, type ExecutorAuthenticationMethod } from "../core/manifests.js";
import { createRuntimePaths, executorDesiredPath, executorManagedPath } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { ExecutorAdapter, ExecutorConnection, ExecutorIntegration } from "./adapter.js";
import { executorConnectionAddress } from "./contract.js";
import { reconcileExecutor, readManagedState } from "./reconcile.js";

function profileWithServer(
  name: string,
  endpoint: string,
  description = "Example",
  authentication?: ExecutorAuthenticationMethod[],
  connections?: Record<string, string>
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
        connections:
          connections ??
          (authentication
            ? Object.fromEntries(authentication.map((method) => ["main", method.slug]))
            : {}),
        server: {
          type: "remote",
          description,
          url: endpoint,
          transport: "http",
          ...(authentication ? { executor: { authentication } } : {})
        }
      }
    ],
    extraFolders: []
  };
}

function emptyProfile(name: string): ResolvedProfile {
  return { ...profileWithServer(name, "https://example.test/mcp"), mcpServers: [] };
}

function durableConnection(name = "main", template = "api-key"): ExecutorConnection {
  return {
    owner: "user",
    name,
    integration: "example",
    template,
    provider: template === "none" ? "none" : "file",
    address: executorConnectionAddress("user", "example", name),
    identityLabel: null,
    expiresAt: null,
    oauthClient: null,
    oauthClientOwner: null,
    oauthScope: null,
    missingOAuthScopes: [],
    lastHealth: null
  };
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
  const adapter: ExecutorAdapter = {
    baseUrl: "http://fake",
    dataDir: "/tmp/fake-data",
    async getIntegration(slug) {
      return integrations.get(slug) ?? null;
    },
    async updateIntegration(slug, input) {
      const integration = integrations.get(slug);
      if (integration) integration.description = input.description ?? integration.description;
      mutations.push(`update:${slug}`);
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
    async configureAuth() {
      mutations.push("unexpected-auth");
    },
    async removeIntegration(slug) {
      integrations.delete(slug);
      connections.delete(slug);
      mutations.push(`remove:${slug}`);
    },
    async listConnections(integration) {
      return connections.get(integration) ?? [];
    },
    async createNoAuthConnection(integration, name, template = "none") {
      connections.set(integration, [
        ...(connections.get(integration) ?? []),
        {
          ...durableConnection(),
          name,
          integration,
          template,
          provider: template === "none" ? "none" : "file",
          oauthClient: null,
          oauthClientOwner: null,
          oauthScope: null
        }
      ]);
      mutations.push(`connection:${integration}`);
    },
    async refreshConnection() {
      mutations.push("unexpected-refresh");
      return [];
    },
    async checkHealth() {
      return { status: "healthy", checkedAt: Date.now() };
    },
    async authorizeOAuth(input) {
      mutations.push("unexpected-oauth");
      return durableConnection(input.name, input.template);
    },
    async cancelOAuth() {
      mutations.push("unexpected-cancel");
    },
    async startApiKeyHandoff() {
      mutations.push("unexpected-handoff");
    },
    async close() {}
  };
  return { adapter, mutations, integrations, connections };
}

describe("Executor reconciliation", () => {
  it("manages integration inventory and creates the implicit no-auth connection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, mutations } = fakeAdapter();
    const profile = profileWithServer("personal", "https://example.test/mcp");

    await expect(reconcileExecutor(paths, profile, { adapter })).resolves.toMatchObject({
      added: ["example"]
    });
    await expect(reconcileExecutor(paths, profile, { adapter })).resolves.toMatchObject({
      reused: ["example"]
    });
    await expect(
      reconcileExecutor(
        paths,
        profileWithServer("personal", "https://example.test/mcp", "Changed"),
        {
          adapter
        }
      )
    ).resolves.toMatchObject({ updated: ["example"] });
    expect(mutations).toEqual(["add:example", "connection:example", "update:example"]);
    expect(await readFile(executorDesiredPath(paths, "personal"), "utf8")).toContain(
      '"slug": "none"'
    );
    await rm(root, { recursive: true, force: true });
  });

  it("creates an explicitly declared no-auth connection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-none-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, mutations } = fakeAdapter();
    await expect(
      reconcileExecutor(
        paths,
        profileWithServer("personal", "https://example.test/mcp", "Example", [
          { slug: "none", kind: "none" }
        ]),
        { adapter }
      )
    ).resolves.toMatchObject({ added: ["example"] });
    expect(mutations).toEqual(["add:example", "connection:example"]);
    await rm(root, { recursive: true, force: true });
  });

  it("reuses Executor's automatic organization default for a stdio no-auth server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-stdio-default-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, integrations, connections, mutations } = fakeAdapter();
    const profile: ResolvedProfile = {
      ...profileWithServer("personal", "https://example.test/mcp"),
      mcpServers: [
        {
          name: "forge",
          route: "executor",
          connections: { default: "none" },
          server: {
            type: "local",
            description: "Forge",
            command: ["forge"]
          }
        }
      ]
    };
    integrations.set("forge", {
      slug: "forge",
      description: "Forge",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      config: {
        transport: "stdio",
        command: "forge",
        authenticationTemplate: [{ slug: "none", kind: "none" }]
      }
    });
    connections.set("forge", [
      {
        ...durableConnection("default", "none"),
        owner: "org",
        integration: "forge",
        address: executorConnectionAddress("org", "forge", "default")
      }
    ]);

    await expect(reconcileExecutor(paths, profile, { adapter })).resolves.toMatchObject({
      reused: ["forge"],
      reusedConnections: ["forge/default"]
    });
    expect(mutations).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("configures credentialed declarations but blocks cutover until connect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-auth-required-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, mutations } = fakeAdapter();
    await expect(
      reconcileExecutor(
        paths,
        profileWithServer("personal", "https://example.test/mcp", "Example", [
          { slug: "oauth", kind: "oauth2" }
        ]),
        { adapter }
      )
    ).rejects.toThrow("mfz executor connect example");
    expect(mutations).toEqual(["add:example"]);
    await rm(root, { recursive: true, force: true });
  });

  it("preserves UI-authored auth templates and connections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-auth-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, integrations, connections, mutations } = fakeAdapter();
    const profile = profileWithServer("personal", "https://example.test/mcp", "Example", [
      {
        slug: "api-key",
        kind: "apikey",
        placements: [{ carrier: "header", name: "X-API-Key", variable: "api_key" }]
      }
    ]);
    await reconcileExecutor(paths, profile, { adapter, allowMissingConnections: true });
    const integration = integrations.get("example");
    if (!integration) throw new Error("missing integration");
    integration.config.authenticationTemplate = [
      {
        slug: "api-key",
        type: "apiKey",
        headers: { "X-API-Key": [{ type: "variable", name: "api_key" }] }
      }
    ];
    connections.set("example", [durableConnection()]);

    await expect(reconcileExecutor(paths, profile, { adapter })).resolves.toMatchObject({
      reused: ["example"]
    });
    expect(mutations).toEqual(["add:example"]);
    await rm(root, { recursive: true, force: true });
  });

  it("does not treat assisted OAuth metadata as an Executor auth-template change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-assisted-oauth-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, integrations, connections, mutations } = fakeAdapter();
    const profile = profileWithServer("personal", "https://example.test/mcp", "Example", [
      {
        slug: "oauth",
        kind: "oauth2",
        discoveryUrl: "https://example.test/.well-known/oauth-authorization-server",
        registrationScopes: ["read"]
      }
    ]);
    integrations.set("example", {
      slug: "example",
      description: "Example",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      config: {
        transport: "remote",
        endpoint: "https://example.test/mcp",
        remoteTransport: "auto",
        authenticationTemplate: [{ slug: "oauth", kind: "oauth2" }]
      }
    });
    connections.set("example", [
      { ...durableConnection(), template: "oauth", provider: "default" }
    ]);

    await reconcileExecutor(paths, profile, { adapter });
    await expect(reconcileExecutor(paths, profile, { adapter })).resolves.toMatchObject({
      reused: ["example"]
    });
    expect(mutations).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("blocks endpoint changes and removal when a credential exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-durable-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, connections, mutations } = fakeAdapter();
    await reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
      adapter
    });
    connections.set("example", [durableConnection()]);

    await expect(
      reconcileExecutor(paths, profileWithServer("personal", "https://changed.example.test/mcp"), {
        adapter
      })
    ).rejects.toThrow(/changed metadata: endpoint/);
    await expect(reconcileExecutor(paths, emptyProfile("personal"), { adapter })).rejects.toThrow(
      /durable connection state/
    );
    expect(mutations).toEqual(["add:example", "connection:example"]);
    await rm(root, { recursive: true, force: true });
  });

  it("removes a legacy unauthenticated integration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-remove-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, connections, mutations } = fakeAdapter();
    await reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
      adapter
    });
    connections.set("example", [{ ...durableConnection(), template: "none", provider: "default" }]);

    await expect(
      reconcileExecutor(paths, emptyProfile("personal"), { adapter })
    ).resolves.toMatchObject({
      removed: ["example"]
    });
    expect(mutations).toEqual(["add:example", "connection:example", "remove:example"]);
    expect(await readFile(executorManagedPath(paths, "personal"), "utf8")).toContain(
      '"integrations": {}'
    );
    await rm(root, { recursive: true, force: true });
  });

  it("keeps shared live integrations while another profile snapshot owns them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-shared-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, mutations } = fakeAdapter();

    await reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
      adapter
    });
    await reconcileExecutor(paths, profileWithServer("work", "https://example.test/mcp"), {
      adapter
    });

    const removedPersonal = await reconcileExecutor(paths, emptyProfile("personal"), { adapter });
    expect(removedPersonal).toMatchObject({ retained: ["example"], removed: [] });
    expect(mutations).not.toContain("remove:example");
    expect(await readFile(executorManagedPath(paths, "personal"), "utf8")).toContain(
      '"integrations": {}'
    );
    expect(await readFile(executorManagedPath(paths, "work"), "utf8")).toContain('"example"');

    await expect(
      reconcileExecutor(paths, emptyProfile("work"), { adapter })
    ).resolves.toMatchObject({
      removed: ["example"]
    });
    expect(mutations).toContain("remove:example");
    await rm(root, { recursive: true, force: true });
  });

  it("requires every named credentialed connection before cutover", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-named-missing-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, integrations, connections, mutations } = fakeAdapter();
    const profile = profileWithServer(
      "personal",
      "https://example.test/mcp",
      "Example",
      [{ slug: "oauth", kind: "oauth2" }],
      { publicsafety: "oauth", tylertech: "oauth" }
    );
    integrations.set("example", {
      slug: "example",
      description: "Example",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      config: {
        transport: "remote",
        endpoint: "https://example.test/mcp",
        remoteTransport: "auto",
        authenticationTemplate: [{ slug: "oauth", kind: "oauth2" }]
      }
    });
    connections.set("example", [durableConnection("publicsafety", "oauth")]);

    await expect(reconcileExecutor(paths, profile, { adapter })).rejects.toThrow(
      "example/tylertech"
    );
    expect(mutations).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("uses the same missing-scope blocker in dry-run as real apply", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-scopes-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, integrations, connections } = fakeAdapter();
    const profile = profileWithServer("personal", "https://example.test/mcp", "Example", [
      { slug: "oauth", kind: "oauth2", registrationScopes: ["write"] }
    ]);
    integrations.set("example", {
      slug: "example",
      description: "Example",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      config: {
        transport: "remote",
        endpoint: "https://example.test/mcp",
        remoteTransport: "auto",
        authenticationTemplate: [{ slug: "oauth", kind: "oauth2" }]
      }
    });
    connections.set("example", [
      { ...durableConnection("main", "oauth"), missingOAuthScopes: ["write"] }
    ]);

    const dryRun = await reconcileExecutor(paths, profile, { adapter, dryRun: true });
    expect(dryRun?.blockers).toContain(
      "Executor connection example/main is missing OAuth scopes; run mfz executor connect example --connection main"
    );
    await expect(reconcileExecutor(paths, profile, { adapter })).rejects.toThrow(
      /missing OAuth scopes/
    );
    await rm(root, { recursive: true, force: true });
  });

  it("journals incomplete ownership before a failed external mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-journal-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter } = fakeAdapter();
    adapter.addServer = async () => {
      throw new Error("declaration failed");
    };

    await expect(
      reconcileExecutor(paths, profileWithServer("personal", "https://example.test/mcp"), {
        adapter
      })
    ).rejects.toThrow("declaration failed");

    await expect(readManagedState(paths, "personal")).resolves.toMatchObject({
      complete: false,
      operation: {
        status: "incomplete",
        desiredIntegrations: ["example"]
      }
    });
    await expect(readFile(executorDesiredPath(paths, "personal"), "utf8")).resolves.toContain(
      '"slug": "example"'
    );
    await rm(root, { recursive: true, force: true });
  });

  it("preserves sibling named connections independently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-named-siblings-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, integrations, connections, mutations } = fakeAdapter();
    const profile = profileWithServer(
      "personal",
      "https://example.test/mcp",
      "Example",
      [{ slug: "oauth", kind: "oauth2" }],
      { publicsafety: "oauth", tylertech: "oauth" }
    );
    integrations.set("example", {
      slug: "example",
      description: "Example",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      config: {
        transport: "remote",
        endpoint: "https://example.test/mcp",
        remoteTransport: "auto",
        authenticationTemplate: [{ slug: "oauth", kind: "oauth2" }]
      }
    });
    connections.set("example", [
      durableConnection("publicsafety", "oauth"),
      durableConnection("tylertech", "oauth")
    ]);

    await expect(reconcileExecutor(paths, profile, { adapter })).resolves.toMatchObject({
      reusedConnections: ["example/publicsafety", "example/tylertech"]
    });
    expect(connections.get("example")?.map((connection) => connection.name)).toEqual([
      "publicsafety",
      "tylertech"
    ]);
    expect(mutations).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("blocks an undeclared durable sibling with exact cleanup guidance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-reconcile-named-removal-"));
    const paths = createRuntimePaths({ root, home: root });
    const { adapter, integrations, connections, mutations } = fakeAdapter();
    const profile = profileWithServer(
      "personal",
      "https://example.test/mcp",
      "Example",
      [{ slug: "oauth", kind: "oauth2" }],
      { publicsafety: "oauth" }
    );
    integrations.set("example", {
      slug: "example",
      description: "Example",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      config: {
        transport: "remote",
        endpoint: "https://example.test/mcp",
        remoteTransport: "auto",
        authenticationTemplate: [{ slug: "oauth", kind: "oauth2" }]
      }
    });
    connections.set("example", [
      durableConnection("publicsafety", "oauth"),
      durableConnection("tylertech", "oauth")
    ]);

    await expect(reconcileExecutor(paths, profile, { adapter })).rejects.toThrow(
      "example/tylertech is durable but not declared"
    );
    expect(mutations).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
