import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { profileSchema } from "../core/manifests.js";
import { createRuntimePaths, executorDataDir, executorManagedPath } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { executorDiagnosticLines, inspectExecutor } from "./diagnostic.js";

function profile(): ResolvedProfile {
  return {
    name: "personal",
    agents: ["opencode"],
    profile: profileSchema.parse({
      name: "personal",
      mcp: { example: { route: "executor" } }
    }),
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
        connections: {},
        server: {
          type: "remote",
          description: "Example",
          url: "https://example.test/mcp",
          transport: "http"
        }
      }
    ],
    extraFolders: []
  };
}

describe("Executor diagnostics", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports missing runtime without creating it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-diagnostic-"));
    const paths = createRuntimePaths({ root, home: root });
    vi.stubEnv("EXECUTOR_DATA_DIR", path.join(root, ".executor"));
    const diagnostic = await inspectExecutor(paths, profile(), { binary: process.execPath });

    expect(diagnostic.runtime).toBe("absent");
    expect(diagnostic.managed).toBe("absent");
    expect(diagnostic.blockers).toContain(
      "Executor runtime is not attachable without starting a daemon"
    );
    await expect(readFile(executorManagedPath(paths, "personal"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await rm(root, { recursive: true, force: true });
  });

  it("attaches read-only and reports cached metadata without a health mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-diagnostic-live-"));
    const paths = createRuntimePaths({ root, home: root });
    vi.stubEnv("EXECUTOR_DATA_DIR", path.join(root, ".executor"));
    const dataDir = executorDataDir();
    await mkdir(path.join(dataDir, "server-control"), { recursive: true });
    await writeFile(
      path.join(dataDir, "server-control", "server.json"),
      JSON.stringify({ connection: { origin: "http://127.0.0.1:1234" } }),
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "server-control", "auth.json"),
      JSON.stringify({ token: "not-output" }),
      "utf8"
    );
    await mkdir(path.dirname(executorManagedPath(paths, "personal")), { recursive: true });
    await writeFile(
      executorManagedPath(paths, "personal"),
      JSON.stringify({
        version: 1,
        profile: "personal",
        complete: true,
        integrations: {
          example: { digest: "digest", lastReconciledAt: new Date().toISOString() }
        }
      }),
      "utf8"
    );
    const calls: string[] = [];
    const diagnostic = await inspectExecutor(paths, profile(), {
      binary: process.execPath,
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/integrations")) return new Response("{}", { status: 200 });
        if (url.endsWith("/api/mcp/servers/example")) {
          return new Response(
            JSON.stringify({
              slug: "example",
              description: "Example",
              kind: "mcp",
              canRemove: true,
              canRefresh: true,
              config: {
                transport: "remote",
                endpoint: "https://example.test/mcp",
                remoteTransport: "auto",
                authenticationTemplate: [{ slug: "none", kind: "none" }]
              }
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify([
            {
              owner: "user",
              name: "main",
              integration: "example",
              template: "none",
              provider: "none",
              address: "tools.example.user.main",
              identityLabel: null,
              expiresAt: null,
              oauthClient: null,
              oauthClientOwner: null,
              oauthScope: null,
              missingOAuthScopes: [],
              lastHealth: { status: "healthy", checkedAt: Date.now() }
            }
          ]),
          { status: 200 }
        );
      }
    });

    expect(diagnostic.runtime).toBe("attachable");
    expect(diagnostic.managed).toBe("complete");
    expect(diagnostic.connections).toEqual([
      {
        integration: "example",
        name: "main",
        authentication: "none",
        health: "healthy",
        missingOAuthScopes: []
      }
    ]);
    expect(calls.some((url) => url.includes("/health"))).toBe(false);
    expect(executorDiagnosticLines(diagnostic).join("\n")).not.toContain("not-output");
    await rm(root, { recursive: true, force: true });
  });
});
