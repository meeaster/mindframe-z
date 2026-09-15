import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyConfig } from "../../src/cli/apply.js";
import { createRuntimePaths, executorManagedPath } from "../../src/core/paths.js";
import { resolveProfile } from "../../src/core/profile.js";
import { renderTarget } from "../../src/core/render.js";
import { createExecutorAdapter, type ExecutorAdapter } from "../../src/executor/adapter.js";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

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

const adapters: ExecutorAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

describe("Executor apply integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
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

        const manifest = z
          .object({ scopeDir: z.string().nullable().optional() })
          .parse(
            JSON.parse(
              await readFile(path.join(first.dataDir, "server-control", "server.json"), "utf8")
            )
          );

        expect(manifest.scopeDir).toBeNull();
        await Promise.all([first.close(), second.close(), other.close()]);
      });
      await rm(root, { recursive: true, force: true });
    },
    30_000
  );

  it("renders a shared Executor bridge during a dry-run without starting Executor", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "mcp:",
        "  context7:",
        "    executor:",
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "opencode", "--dry-run"]);
    expect(result.stdout).toContain("planned\tadd\texecutor\tcontext7");

    await expect(access(path.join(home, ".executor"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(path.join(home, ".mindframe-z", "executor"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("reports prior Executor state during a direct-only dry-run", async () => {
    const paths = createRuntimePaths({ root, home });
    const managedPath = executorManagedPath(paths, "personal");
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(
      managedPath,
      JSON.stringify(
        {
          version: 1,
          profile: "personal",
          complete: true,
          integrations: {
            context7: { digest: "digest", lastReconciledAt: new Date().toISOString() }
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, [
      "apply",
      "--agent",
      "opencode",
      "--dry-run",
      "--no-link"
    ]);

    expect(result.stdout).toContain("planned\tremove\texecutor\tcontext7");
    expect(result.stdout).toContain("live Executor metadata unavailable");
    await expect(access(path.join(home, ".executor"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("distinguishes planned Executor additions, updates, and removals", async () => {
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  context7:",
        "    description: Updated docs.",
        "    type: remote",
        "    transport: http",
        "    url: https://mcp.context7.com/mcp",
        "  search:",
        "    description: Search.",
        "    type: remote",
        "    transport: http",
        "    url: https://search.example.test/mcp",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [opencode]",
        "mcp:",
        "  context7:",
        "    executor: { enabled: true }",
        "  search:",
        "    executor: { enabled: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    const managedPath = executorManagedPath(createRuntimePaths({ root, home }), "personal");
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(
      managedPath,
      JSON.stringify(
        {
          version: 1,
          profile: "personal",
          complete: true,
          integrations: {
            context7: { digest: "outdated", lastReconciledAt: new Date().toISOString() },
            retired: { digest: "retired", lastReconciledAt: new Date().toISOString() }
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--dry-run", "--no-link"]);

    expect(result.stdout).toContain("planned\tadd\texecutor\tsearch");
    expect(result.stdout).toContain("planned\tupdate\texecutor\tcontext7");
    expect(result.stdout).toContain("planned\tremove\texecutor\tretired");
  });

  it("renders one shared bridge alongside direct MCP entries for every supported harness", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, claude-code, codex]",
        "mcp:",
        "  context7:",
        "    executor:",
        "      enabled: true",
        "  local-helper:",
        "    agents: [opencode, claude-code, codex]",
        ""
      ].join("\n"),
      "utf8"
    );

    const outcomes = await applyConfig({ root, home, agent: "all", target: "all", dryRun: true });
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        category: "executor",
        status: "planned",
        target: "context7",
        plannedEffect: "add"
      })
    );

    for (const target of ["opencode", "claude-code", "codex"] as const) {
      const rendered = await renderTarget(
        createRuntimePaths({ root, home }),
        await resolveProfile(createRuntimePaths({ root, home }), "personal"),
        target
      );

      const mcpFile = rendered.files.find((file) => file.path.endsWith("mcp.json"))?.content;
      const config = rendered.files.find((file) => file.path.endsWith("opencode.jsonc"))?.content;
      const codexConfig = rendered.files.find((file) => file.path.endsWith("config.toml"))?.content;
      const content = mcpFile ?? config ?? codexConfig ?? "";
      expect(content).toContain("executor");
      expect(content).toContain("local-helper");
      expect(content).not.toContain('"context7"');

      if (target === "codex") {
        expect(codexConfig).toContain("startup_timeout_sec");
        expect(codexConfig).toContain("tool_timeout_sec");
      }
    }

    await expect(access(path.join(home, ".executor"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("applies direct and Executor configuration without rendering the bridge", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, claude-code, codex]",
        "executor:",
        "  bridge: false",
        "mcp:",
        "  context7:",
        "    agents: [opencode, claude-code, codex]",
        "    executor:",
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    let reconciled = false;
    await applyConfig(
      { root, home, agent: "all", target: "all", noLink: true },
      {
        reconcileExecutor: async () => {
          reconciled = true;

          return undefined;
        }
      }
    );

    expect(reconciled).toBe(true);

    const opencodeConfig = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );

    const claudeConfig = await readFile(
      configsPath(home, "personal", "claude", "mcp.json"),
      "utf8"
    );

    const codexConfig = await readFile(
      configsPath(home, "personal", "codex", "config.toml"),
      "utf8"
    );

    for (const config of [opencodeConfig, claudeConfig, codexConfig]) {
      expect(config).toContain("context7");
      expect(config).not.toContain('"executor"');
    }
  });

  it("keeps the direct harness configuration when Executor startup fails", async () => {
    await applyConfig({ root, home, agent: "opencode", target: "all", noLink: true });
    const configPath = configsPath(home, "personal", "opencode", "opencode.jsonc");
    const directConfig = await readFile(configPath, "utf8");

    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "mcp:",
        "  context7:",
        "    executor:",
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(
      cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"], {
        PATH: "/definitely-missing"
      })
    ).rejects.toMatchObject({ exitCode: 1 });
    await expect(readFile(configPath, "utf8")).resolves.toBe(directConfig);
  });

  it("keeps direct configuration when a later render fails after reconciliation", async () => {
    await applyConfig({ root, home, agent: "opencode", target: "all", noLink: true });
    const configPath = configsPath(home, "personal", "opencode", "opencode.jsonc");
    const directConfig = await readFile(configPath, "utf8");
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "mcp:",
        "  context7:",
        "    executor:",
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    let reconciled = false;
    await expect(
      applyConfig(
        { root, home, agent: "opencode", target: "all", noLink: true },
        {
          reconcileExecutor: async () => {
            reconciled = true;

            return undefined;
          },
          renderTarget: async () => {
            throw new Error("simulated render failure");
          }
        }
      )
    ).rejects.toThrow("simulated render failure");
    expect(reconciled).toBe(true);
    await expect(readFile(configPath, "utf8")).resolves.toBe(directConfig);
  });

  it("does not reconcile Executor when only the unsupported Pi target is selected", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [pi]",
        "mcp:",
        "  context7:",
        "    executor:",
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, [
      "apply",
      "--agent",
      "pi",
      "--target",
      "mise",
      "--dry-run"
    ]);

    expect(result.stdout).not.toContain("executor\t");
    await expect(access(path.join(home, ".executor"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
