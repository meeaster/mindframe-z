import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { profileSchema } from "./manifests.js";
import { mergeProfiles, resolveProfile } from "./profile.js";
import { createRuntimePaths } from "./paths.js";

async function writeHome(root: string, options: { extends?: { name: string; repo: string } } = {}) {
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await mkdir(path.join(root, "instructions"), { recursive: true });
  await mkdir(path.join(root, "profiles", "base"), { recursive: true });
  await writeFile(
    path.join(root, "mfz_home.yml"),
    options.extends
      ? [`extends:`, `  name: ${options.extends.name}`, `  repo: ${options.extends.repo}`, ""].join(
          "\n"
        )
      : "description: Test home\n",
    "utf8"
  );
  await writeFile(path.join(root, "catalog", "references.yml"), "references: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "skills.yml"), "skills: []\n", "utf8");
  await writeFile(path.join(root, "catalog", "mcp.yml"), "servers: {}\n", "utf8");
  await writeFile(path.join(root, "instructions", "AGENTS.md"), "# Agents\n", "utf8");
}

async function commitAll(root: string) {
  await execa("git", ["init"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execa("git", ["config", "user.name", "Test User"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["commit", "-m", "initial"], { cwd: root });
}

describe("mergeProfiles thread defaults", () => {
  // Regression for the default-before-inheritance trap: `session_sources` used to
  // carry an auto-filled default on every parsed profile, so a child that omitted
  // it silently clobbered the parent's intentional value during the spread merge.
  it("inherits session_sources when the child omits it", () => {
    const base = profileSchema.parse({
      name: "base",
      thread: { defaults: { session_sources: ["claude-code"] } }
    });
    const child = profileSchema.parse({ name: "child", extends: "base" });

    expect(child.thread.defaults.session_sources).toBeUndefined();

    const merged = mergeProfiles(base, child);
    expect(merged.thread.defaults.session_sources).toEqual(["claude-code"]);
  });

  it("lets a child override session_sources when it sets its own", () => {
    const base = profileSchema.parse({
      name: "base",
      thread: { defaults: { session_sources: ["claude-code"] } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      thread: { defaults: { session_sources: ["opencode"] } }
    });

    expect(mergeProfiles(base, child).thread.defaults.session_sources).toEqual(["opencode"]);
  });

  // Same trap, one level up on the `thread` object: `update_strategy` must stay optional
  // (no parse-time default) or a child that omits it would clobber a parent's `delta`.
  it("inherits update_strategy when the child omits it", () => {
    const base = profileSchema.parse({ name: "base", thread: { update_strategy: "delta" } });
    const child = profileSchema.parse({ name: "child", extends: "base" });

    expect(child.thread.update_strategy).toBeUndefined();
    expect(mergeProfiles(base, child).thread.update_strategy).toBe("delta");
  });

  it("lets a child override update_strategy when it sets its own", () => {
    const base = profileSchema.parse({ name: "base", thread: { update_strategy: "delta" } });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      thread: { update_strategy: "full" }
    });

    expect(mergeProfiles(base, child).thread.update_strategy).toBe("full");
  });
});

describe("MCP route selection", () => {
  it("defaults concise and grouped direct entries and accepts the shared Executor branch", () => {
    const profile = profileSchema.parse({
      name: "routes",
      mcp: {
        concise: { agents: ["opencode"] },
        grouped: { route: "direct", agents: { enabled: ["claude-code"], disabled: ["codex"] } },
        shared: { route: "executor" }
      }
    });

    expect(profile.mcp.concise).toEqual({ route: "direct", agents: { opencode: true } });
    expect(profile.mcp.grouped).toEqual({
      route: "direct",
      agents: { "claude-code": true, codex: false }
    });
    expect(profile.mcp.shared).toEqual({ route: "executor" });
  });

  it("rejects boolean MCP agent maps", () => {
    expect(() =>
      profileSchema.parse({
        name: "routes",
        mcp: { legacy: { agents: { opencode: true } } }
      })
    ).toThrow();
  });

  it("rejects empty, overlapping, duplicate, and Claude-disabled direct selections", () => {
    for (const agents of [
      [],
      { enabled: [], disabled: [] },
      { enabled: ["opencode"], disabled: ["opencode"] },
      { enabled: ["opencode", "opencode"] },
      { enabled: ["opencode"], disabled: ["claude-code"] }
    ]) {
      expect(() => profileSchema.parse({ name: "routes", mcp: { direct: { agents } } })).toThrow();
    }
  });

  it("rejects an Executor entry with per-agent state", () => {
    expect(() =>
      profileSchema.parse({
        name: "routes",
        mcp: { shared: { route: "executor", agents: ["opencode"] } }
      })
    ).toThrow();
  });

  it("accepts named Executor connections and rejects empty or unsafe maps", () => {
    const profile = profileSchema.parse({
      name: "routes",
      mcp: {
        datadog: {
          route: "executor",
          connections: { publicsafety: "oauth", tylertech: "oauth" }
        }
      }
    });

    expect(profile.mcp.datadog).toEqual({
      route: "executor",
      connections: { publicsafety: "oauth", tylertech: "oauth" }
    });
    expect(() =>
      profileSchema.parse({
        name: "routes",
        mcp: { datadog: { route: "executor", connections: {} } }
      })
    ).toThrow();
    expect(() =>
      profileSchema.parse({
        name: "routes",
        mcp: { datadog: { route: "executor", connections: { "../secret": "oauth" } } }
      })
    ).toThrow();
    for (const name of ["PublicSafety", "public-safety", "public.safety", "public safety"]) {
      expect(() =>
        profileSchema.parse({
          name: "routes",
          mcp: { datadog: { route: "executor", connections: { [name]: "oauth" } } }
        })
      ).toThrow(/address-safe/);
    }
  });

  it("replaces inherited MCP configuration when the route changes", () => {
    const base = profileSchema.parse({
      name: "base",
      mcp: { docs: { agents: ["opencode"] } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      mcp: { docs: { route: "executor" } }
    });

    expect(mergeProfiles(base, child).mcp.docs).toEqual({ route: "executor" });
  });

  it("merges named Executor connections by exact profile name", () => {
    const base = profileSchema.parse({
      name: "base",
      mcp: {
        datadog: {
          route: "executor",
          connections: { publicsafety: "oauth", shared: "oauth" }
        }
      }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      mcp: {
        datadog: {
          route: "executor",
          connections: { tylertech: "oauth" }
        }
      }
    });

    expect(mergeProfiles(base, child).mcp.datadog).toEqual({
      route: "executor",
      connections: { publicsafety: "oauth", shared: "oauth", tylertech: "oauth" }
    });
  });

  it("overrides only named inherited direct harness states", () => {
    const base = profileSchema.parse({
      name: "base",
      mcp: { docs: { agents: ["opencode", "codex"] } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      mcp: { docs: { agents: { disabled: ["codex"] } } }
    });

    expect(mergeProfiles(base, child).mcp.docs).toEqual({
      route: "direct",
      agents: { opencode: true, codex: false }
    });
  });

  it("switches an inherited Executor entry to direct when agents are declared", () => {
    const base = profileSchema.parse({
      name: "base",
      mcp: { docs: { route: "executor" } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      mcp: { docs: { agents: ["opencode"] } }
    });

    expect(mergeProfiles(base, child).mcp.docs).toEqual({
      route: "direct",
      agents: { opencode: true }
    });
  });

  it("inherits profile-owned Executor settings", () => {
    const base = profileSchema.parse({
      name: "base",
      executor: { timeout_ms: 45_000 }
    });
    const child = profileSchema.parse({ name: "child", extends: "base" });

    expect(mergeProfiles(base, child).executor).toEqual({ timeout_ms: 45_000 });
  });

  it("resolves one omitted Executor connection to main", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-connection-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-connection-machine-"));
    await writeHome(root);
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  datadog:",
        "    type: remote",
        "    transport: http",
        "    url: https://example.invalid/mcp",
        "    executor:",
        "      authentication:",
        "        - slug: oauth",
        "          kind: oauth2",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      ["name: base", "mcp:", "  datadog:", "    route: executor", ""].join("\n"),
      "utf8"
    );

    const resolved = await resolveProfile(createRuntimePaths({ root, home }), "base");
    expect(resolved.mcpServers[0]).toMatchObject({
      name: "datadog",
      route: "executor",
      connections: { main: "oauth" }
    });
  });

  it("rejects omitted connections when catalog authentication is ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-ambiguous-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-ambiguous-machine-"));
    await writeHome(root);
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  example:",
        "    type: remote",
        "    transport: http",
        "    url: https://example.invalid/mcp",
        "    executor:",
        "      authentication:",
        "        - slug: oauth",
        "          kind: oauth2",
        "        - slug: key",
        "          kind: apikey",
        "          placements:",
        "            - carrier: header",
        "              name: X-API-Key",
        "              variable: api_key",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      ["name: base", "mcp:", "  example:", "    route: executor", ""].join("\n"),
      "utf8"
    );

    await expect(resolveProfile(createRuntimePaths({ root, home }), "base")).rejects.toThrow(
      /multiple authentication methods/
    );
  });

  it("reserves the generated Executor bridge name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-name-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-name-machine-"));
    await writeHome(root);
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  executor:",
        "    type: remote",
        "    transport: http",
        "    url: https://example.invalid/mcp",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      ["name: base", "mcp:", "  executor:", "    agents: [opencode]", ""].join("\n"),
      "utf8"
    );

    await expect(resolveProfile(createRuntimePaths({ root, home }), "base")).rejects.toThrow(
      /reserved for the generated Executor bridge/
    );
  });
});

describe("mergeProfiles codex plugins", () => {
  it("merges child plugins with base plugins", () => {
    const base = profileSchema.parse({
      name: "base",
      codex: { plugins: { "github@openai-curated": { enabled: true } } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      codex: { plugins: { "teams@openai-curated": { enabled: true } } }
    });

    expect(mergeProfiles(base, child).codex.plugins).toEqual({
      "github@openai-curated": { enabled: true },
      "teams@openai-curated": { enabled: true }
    });
  });

  it("lets a child override a base plugin", () => {
    const base = profileSchema.parse({
      name: "base",
      codex: { plugins: { "github@openai-curated": { enabled: true } } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      codex: { plugins: { "github@openai-curated": { enabled: false } } }
    });

    expect(mergeProfiles(base, child).codex.plugins["github@openai-curated"]?.enabled).toBe(false);
  });
});

describe("mergeProfiles OpenCode TUI", () => {
  it("merges TUI configuration and deduplicates TUI plugins", () => {
    const base = profileSchema.parse({
      name: "base",
      opencode: {
        tui: { leader_timeout: 1000, attention: { enabled: true } },
        tui_plugins: ["context", "todo"]
      }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      opencode: { tui: { attention: { sound: false } }, tui_plugins: ["todo", "advisor"] }
    });

    expect(mergeProfiles(base, child).opencode).toMatchObject({
      tui: { leader_timeout: 1000, attention: { enabled: true, sound: false } },
      tui_plugins: ["context", "todo", "advisor"]
    });
  });
});

describe("mergeProfiles OpenCode dependencies", () => {
  it("merges dependencies with child versions taking precedence", () => {
    const base = profileSchema.parse({
      name: "base",
      opencode: { dependencies: { "@acme/base": "1.2.3", shared: "1.0.0" } }
    });
    const child = profileSchema.parse({
      name: "child",
      extends: "base",
      opencode: { dependencies: { "@acme/child": "2.3.4", shared: "2.0.0" } }
    });

    expect(mergeProfiles(base, child).opencode.dependencies).toEqual({
      "@acme/base": "1.2.3",
      "@acme/child": "2.3.4",
      shared: "2.0.0"
    });
  });

  it("rejects dependency ranges and tags", () => {
    for (const version of ["^1.2.3", "latest"]) {
      expect(() =>
        profileSchema.parse({ name: "personal", opencode: { dependencies: { example: version } } })
      ).toThrow("must be an exact semantic version");
    }
  });
});

describe("Delegate General model catalog", () => {
  it("accepts exact model IDs with their required reasoning levels", () => {
    const profile = profileSchema.parse({
      name: "personal",
      opencode: {
        delegate_general: {
          models: [
            {
              id: "openai/gpt-5.6-sol",
              variants: ["none", "low", "medium", "high", "xhigh"],
              description: "Larger model for difficult reasoning."
            }
          ]
        }
      }
    });

    expect(profile.opencode.delegate_general).toEqual({
      models: [
        {
          id: "openai/gpt-5.6-sol",
          variants: ["none", "low", "medium", "high", "xhigh"],
          description: "Larger model for difficult reasoning."
        }
      ]
    });
  });
});

describe("home inheritance", () => {
  it("resolves a qualified upstream profile and catalog entries", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "mfz-parent-home-"));
    const child = await mkdtemp(path.join(os.tmpdir(), "mfz-child-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-machine-home-"));
    await writeHome(parent);
    await writeFile(
      path.join(parent, "catalog", "references.yml"),
      [
        "references:",
        "  - name: upstream-ref",
        "    url: https://example.invalid/upstream.git",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(parent, "profiles", "base", "profile.yml"),
      ["name: base", "references:", "  - upstream-ref", ""].join("\n"),
      "utf8"
    );

    await writeHome(child, { extends: { name: "personal", repo: parent } });
    await mkdir(path.join(child, "profiles", "work"), { recursive: true });
    await writeFile(
      path.join(child, "profiles", "work", "profile.yml"),
      ["name: work", "extends: personal/base", "references:", "  - personal/upstream-ref", ""].join(
        "\n"
      ),
      "utf8"
    );

    const resolved = await resolveProfile(createRuntimePaths({ root: child, home }), "work");

    expect(resolved.enabledReferences.map((entry) => entry.name)).toEqual(["upstream-ref"]);
    expect(resolved.sources.references.get("upstream-ref")?.root).toBe(parent);
  });

  it("rejects unqualified names that only exist upstream with a qualified suggestion", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "mfz-parent-home-"));
    const child = await mkdtemp(path.join(os.tmpdir(), "mfz-child-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-machine-home-"));
    await writeHome(parent);
    await writeFile(
      path.join(parent, "catalog", "mcp.yml"),
      [
        "servers:",
        "  aws-knowledge:",
        "    description: AWS docs",
        "    type: remote",
        "    transport: http",
        "    url: https://example.invalid/mcp",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeHome(child, { extends: { name: "personal", repo: parent } });
    await mkdir(path.join(child, "profiles", "work"), { recursive: true });
    await writeFile(
      path.join(child, "profiles", "work", "profile.yml"),
      ["name: work", "mcp:", "  aws-knowledge:", "    agents: [opencode]", ""].join("\n"),
      "utf8"
    );

    await expect(resolveProfile(createRuntimePaths({ root: child, home }), "work")).rejects.toThrow(
      "personal/aws-knowledge"
    );
  });

  it("rejects active same-terminal-name collisions from different homes", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "mfz-parent-home-"));
    const child = await mkdtemp(path.join(os.tmpdir(), "mfz-child-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-machine-home-"));
    await writeHome(parent);
    await writeFile(
      path.join(parent, "catalog", "references.yml"),
      [
        "references:",
        "  - name: shared-ref",
        "    url: https://example.invalid/upstream.git",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeHome(child, { extends: { name: "personal", repo: parent } });
    await writeFile(
      path.join(child, "catalog", "references.yml"),
      [
        "references:",
        "  - name: shared-ref",
        "    url: https://example.invalid/local.git",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(child, "profiles", "work"), { recursive: true });
    await writeFile(
      path.join(child, "profiles", "work", "profile.yml"),
      ["name: work", "references:", "  - shared-ref", "  - personal/shared-ref", ""].join("\n"),
      "utf8"
    );

    await expect(resolveProfile(createRuntimePaths({ root: child, home }), "work")).rejects.toThrow(
      "Active reference collision for shared-ref"
    );
  });

  it("resolves transitive qualified paths", async () => {
    const common = await mkdtemp(path.join(os.tmpdir(), "mfz-common-home-"));
    const parent = await mkdtemp(path.join(os.tmpdir(), "mfz-parent-home-"));
    const child = await mkdtemp(path.join(os.tmpdir(), "mfz-child-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-machine-home-"));
    await writeHome(common);
    await writeFile(
      path.join(common, "catalog", "skills.yml"),
      ["skills:", "  - name: common-skill", "    source: local", ""].join("\n"),
      "utf8"
    );
    await writeHome(parent, { extends: { name: "common", repo: common } });
    await writeHome(child, { extends: { name: "personal", repo: parent } });
    await mkdir(path.join(child, "profiles", "work"), { recursive: true });
    await writeFile(
      path.join(child, "profiles", "work", "profile.yml"),
      [
        "name: work",
        "skills:",
        "  personal/common/common-skill:",
        "    agents: { opencode: true }",
        ""
      ].join("\n"),
      "utf8"
    );

    const resolved = await resolveProfile(createRuntimePaths({ root: child, home }), "work");

    expect(resolved.enabledSkills.map((entry) => entry.name)).toEqual(["common-skill"]);
    expect(resolved.sources.skills.get("common-skill")?.root).toBe(common);
  });

  it("only enables skills for agents explicitly set to true", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-skill-targets-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-skill-targets-machine-"));
    await writeHome(root);
    await writeFile(
      path.join(root, "catalog", "skills.yml"),
      ["skills:", "  - name: selective-skill", "    source: local", ""].join("\n"),
      "utf8"
    );
    await mkdir(path.join(root, "profiles", "work"), { recursive: true });
    await writeFile(
      path.join(root, "profiles", "work", "profile.yml"),
      [
        "name: work",
        "agents: [opencode, claude-code, codex]",
        "skills:",
        "  selective-skill:",
        "    agents: { opencode: true, claude-code: false, codex: false }",
        ""
      ].join("\n"),
      "utf8"
    );

    const resolved = await resolveProfile(createRuntimePaths({ root, home }), "work");

    expect(resolved.enabledSkills[0]?.targets).toEqual(["opencode"]);
  });

  it("clones git upstream homes under the machine-local homes directory", async () => {
    const upstreamSource = await mkdtemp(path.join(os.tmpdir(), "mfz-upstream-source-"));
    const child = await mkdtemp(path.join(os.tmpdir(), "mfz-child-home-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-machine-home-"));
    await writeHome(upstreamSource);
    await writeFile(
      path.join(upstreamSource, "profiles", "base", "profile.yml"),
      "name: base\n",
      "utf8"
    );
    await commitAll(upstreamSource);
    await writeHome(child, { extends: { name: "personal", repo: `file://${upstreamSource}` } });
    await mkdir(path.join(child, "profiles", "work"), { recursive: true });
    await writeFile(
      path.join(child, "profiles", "work", "profile.yml"),
      "name: work\nextends: personal/base\n",
      "utf8"
    );

    const resolved = await resolveProfile(createRuntimePaths({ root: child, home }), "work");
    const cloneRoot = path.join(home, ".mindframe-z", "homes", "personal");

    expect(resolved.manifests.upstream?.root).toBe(cloneRoot);
    expect(resolved.extraFolders).toContainEqual(
      expect.objectContaining({ path: cloneRoot, read: "allow", edit: "allow" })
    );
  });
});
