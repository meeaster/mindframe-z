import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyConfig } from "../../src/cli/apply.js";
import { createRuntimePaths, executorManagedPath } from "../../src/core/paths.js";
import { resolveProfile } from "../../src/core/profile.js";
import { renderTarget } from "../../src/core/render.js";
import { cli, configsPath, setupIntegrationFixture } from "./support.js";

describe("Executor apply integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  it("renders a shared Executor bridge during a dry-run without starting Executor", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "mcp:",
        "  context7:",
        "    route: executor",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "opencode", "--dry-run"]);
    expect(result.stdout).toContain("executor\tadd context7");
    const rendered = await renderTarget(
      createRuntimePaths({ root, home }),
      await resolveProfile(createRuntimePaths({ root, home }), "personal"),
      "opencode"
    );
    const config =
      rendered.files.find((file) => file.path.endsWith("opencode.jsonc"))?.content ?? "";
    expect(config).toContain('"executor"');
    expect(config).not.toContain('"context7"');
    expect(config).not.toContain("EXECUTOR_DATA_DIR");
    expect(config).not.toContain("EXECUTOR_SCOPE_DIR");
    expect(config).not.toContain("--scope");
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
    expect(result.stdout).toContain("executor\tremove context7");
    expect(result.stdout).toContain("live state unavailable");
    await expect(access(path.join(home, ".executor"))).rejects.toMatchObject({
      code: "ENOENT"
    });
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
        "    route: executor",
        "  local-helper:",
        "    agents: [opencode, claude-code, codex]",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "all", "--dry-run"]);
    expect(result.stdout).toContain("executor\tadd context7");
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

  it("keeps the direct harness configuration when Executor startup fails", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);
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
        "    route: executor",
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
        "    route: executor",
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
        "    route: executor",
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
