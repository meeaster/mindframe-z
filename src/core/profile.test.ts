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
      ["name: work", "mcp:", "  aws-knowledge:", "    agents: { opencode: true }", ""].join("\n"),
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
      [
        "skills:",
        "  - name: common-skill",
        "    source: git",
        "    repo: https://github.com/example/skills",
        "    skill: common-skill",
        ""
      ].join("\n"),
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
      [
        "skills:",
        "  - name: selective-skill",
        "    source: git",
        "    repo: https://github.com/example/skills",
        "    skill: selective-skill",
        ""
      ].join("\n"),
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
