import { describe, expect, it } from "vitest";
import { profileSchema } from "../core/manifests.js";
import {
  buildExecutorDesiredState,
  executorConfigDigest,
  executorConnectionHasDurableState
} from "./model.js";
import type { ResolvedProfile } from "../core/profile.js";

function profileWithServer(server: ResolvedProfile["mcpServers"][number]): ResolvedProfile {
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
    mcpServers: [server],
    extraFolders: []
  };
}

describe("Executor desired state", () => {
  it("resolves omitted authentication to Executor's canonical no-auth main connection", () => {
    const profile = profileWithServer({
      name: "stdio",
      route: "executor",
      connections: {},
      server: {
        type: "local",
        description: "Local tool",
        command: ["tool"]
      }
    });
    const desired = buildExecutorDesiredState(profile);
    expect(desired.integrations[0]).toMatchObject({
      connections: { main: "none" },
      config: { authenticationTemplate: [{ slug: "none", kind: "none" }] }
    });
  });

  it("does not treat a no-auth provider as durable without credential bindings", () => {
    expect(executorConnectionHasDurableState({ template: "none", provider: "default" })).toBe(
      false
    );
    expect(
      executorConnectionHasDurableState({
        template: "none",
        provider: "default",
        credentialBindings: { token: "item" }
      })
    ).toBe(true);
    expect(executorConnectionHasDurableState({ template: "api-key", provider: "none" })).toBe(true);
  });

  it("keeps catalog slugs and excludes secret environment references", () => {
    const profile = profileWithServer({
      name: "context7",
      route: "executor",
      connections: {},
      server: {
        type: "remote",
        description: "Docs",
        url: "https://mcp.context7.com/mcp",
        transport: "http"
      }
    });
    const desired = buildExecutorDesiredState(profile);
    expect(desired.integrations[0]).toMatchObject({
      slug: "context7",
      config: { remoteTransport: "auto", endpoint: "https://mcp.context7.com/mcp" }
    });
    expect(JSON.stringify(desired)).not.toContain("Bearer");
    expect(executorConfigDigest(desired.integrations[0]!)).toHaveLength(64);
  });

  it("carries named connection method bindings into desired state and its digest", () => {
    const profile = profileWithServer({
      name: "datadog",
      route: "executor",
      connections: { publicsafety: "oauth", tylertech: "oauth" },
      server: {
        type: "remote",
        description: "Datadog",
        url: "https://example.test/mcp",
        transport: "http",
        executor: { authentication: [{ slug: "oauth", kind: "oauth2" }] }
      }
    });
    const desired = buildExecutorDesiredState(profile);
    expect(desired.integrations[0]?.connections).toEqual({
      publicsafety: "oauth",
      tylertech: "oauth"
    });
    expect(JSON.stringify(desired)).not.toContain("provider");
  });

  it("rejects an environment-derived URL before Executor mutation", () => {
    const profile = profileWithServer({
      name: "private",
      route: "executor",
      connections: {},
      server: {
        type: "remote",
        description: "Private",
        url: "https://example.invalid/{env:TOKEN}",
        transport: "http"
      }
    });
    expect(() => buildExecutorDesiredState(profile)).toThrow(/keep it direct/);
  });

  it.each([
    { headers: { Authorization: "Bearer literal-secret" } },
    { env: { API_KEY: "literal-secret" } }
  ])("rejects literal Executor credential input", (credentials) => {
    const profile = profileWithServer({
      name: "private",
      route: "executor",
      connections: {},
      server: {
        type: "remote",
        description: "Private",
        url: "https://example.invalid/mcp",
        transport: "http",
        ...credentials
      }
    });
    expect(() => buildExecutorDesiredState(profile)).toThrow(/keep it direct/);
  });

  it("expands local command paths using the active home", () => {
    const profile = profileWithServer({
      name: "local",
      route: "executor",
      connections: {},
      server: {
        type: "local",
        description: "Local",
        command: ["~/bin/tool", "~/config.json"]
      }
    });
    const desired = buildExecutorDesiredState(profile, "/tmp/mfz-home");
    expect(desired.integrations[0]?.config).toMatchObject({
      command: "/tmp/mfz-home/bin/tool",
      args: ["/tmp/mfz-home/config.json"]
    });
  });

  it("rejects transport and OAuth settings that do not match the catalog server type", () => {
    const remoteWithStdio = profileWithServer({
      name: "remote",
      route: "executor",
      connections: {},
      server: {
        type: "remote",
        description: "Remote",
        url: "https://example.invalid/mcp",
        transport: "stdio"
      }
    });
    expect(() => buildExecutorDesiredState(remoteWithStdio)).toThrow(/cannot use stdio/);

    const localWithOAuth = profileWithServer({
      name: "local",
      route: "executor",
      connections: {},
      server: {
        type: "local",
        description: "Local",
        command: ["tool"],
        executor: { authentication: [{ slug: "oauth", kind: "oauth2" }] }
      }
    });
    expect(() => buildExecutorDesiredState(localWithOAuth)).toThrow(/cannot use OAuth/);

    const localWithNoAuth = profileWithServer({
      name: "local-none",
      route: "executor",
      connections: { default: "none" },
      server: {
        type: "local",
        description: "Local",
        command: ["tool"],
        executor: { authentication: [{ slug: "none", kind: "none" }] }
      }
    });
    expect(buildExecutorDesiredState(localWithNoAuth).integrations[0]?.connections).toEqual({
      default: "none"
    });
  });
});
