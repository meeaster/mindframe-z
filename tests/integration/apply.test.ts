import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { parse } from "smol-toml";
import YAML from "yaml";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, configsPath, fixtureReferenceSource, setupIntegrationFixture } from "./support.js";
import { applyConfig } from "../../src/cli/apply.js";
import { operationChanged, type OperationOutcome } from "../../src/core/operations.js";
import {
  createRuntimePaths,
  providerSkillSnapshotDir,
  referenceStatePath
} from "../../src/core/paths.js";
import { ReferenceReconciliationError } from "../../src/ref-store/references.js";
import { providerVariantTargets, writeProviderVariantSkill } from "./support.js";

const JsonObject = z.object({}).passthrough();

const McpEntry = z
  .object({
    type: z.string().optional(),
    url: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional()
  })
  .passthrough();

const McpMap = z.record(z.string(), McpEntry);

const OpenCodeConfig = z
  .object({
    model: z.string().optional(),
    small_model: z.string().optional(),
    plugins: z.array(z.unknown()).optional(),
    skills: z.array(z.string()).optional(),
    mcp: McpMap.optional(),
    permissions: z
      .array(z.object({ action: z.string(), resource: z.string(), effect: z.string() }))
      .optional()
  })
  .passthrough();

const OpenCodeMcpConfig = OpenCodeConfig.extend({
  mcp: z.object({ servers: McpMap }).passthrough()
});

const OpenCodeFolderConfig = OpenCodeConfig.extend({
  permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.string() }))
});

const ClaudeSettings = z
  .object({
    model: z.string().optional(),
    includeGitInstructions: z.boolean().optional(),
    additionalDirectories: z.array(z.string()).optional(),
    permissions: z
      .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    env: z.record(z.string(), z.string()).optional()
  })
  .passthrough();

const ClaudeJson = z
  .object({
    installMethod: z.string().optional(),
    mcpServers: McpMap.optional(),
    projects: z.record(z.string(), JsonObject).optional()
  })
  .passthrough();

const CodexConfig = z
  .object({
    model: z.string().optional(),
    plugins: z.record(z.string(), JsonObject).optional(),
    mcp_servers: z.record(z.string(), JsonObject).optional(),
    default_permissions: z.string().optional(),
    permissions: JsonObject.optional(),
    skills: z
      .object({ config: z.array(z.object({ path: z.string(), enabled: z.boolean() })).optional() })
      .passthrough()
      .optional()
  })
  .passthrough();

const CodexSecuredConfig = CodexConfig.extend({
  mcp_servers: z.object({ secured: JsonObject }).passthrough()
});

const ClaudeSecuredMcp = z
  .object({ secured: z.object({ headers: z.record(z.string(), z.string()) }).passthrough() })
  .passthrough();

const PiSettings = z
  .object({
    theme: z.string().optional(),
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    subagents: JsonObject.optional()
  })
  .passthrough();

const SmokeCapture = z.object({
  argv: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  service: z.object({ port: z.number() })
});

function parseJson<T extends z.ZodType>(schema: T, source: string): z.infer<T> {
  return schema.parse(JSON.parse(source));
}

function parseToml<T extends z.ZodType>(schema: T, source: string): z.infer<T> {
  return schema.parse(parse(source));
}

describe("apply integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  async function exists(file: string): Promise<boolean> {
    try {
      await access(file);

      return true;
    } catch {
      return false;
    }
  }

  async function git(directory: string, args: readonly string[]): Promise<string> {
    return (await execa("git", ["-C", directory, ...args])).stdout.trim();
  }

  it("returns a truthful no-change outcome set on repeat apply", async () => {
    await applyConfig({ root, home, agent: "all", target: "all", noLink: true });

    const repeated = await applyConfig({ root, home, agent: "all", target: "all", noLink: true });

    expect(
      repeated.filter(
        (outcome) => outcome.significance === "meaningful" && operationChanged(outcome)
      )
    ).toEqual([]);
  });

  it("applies provider variants to target-scoped snapshots under one skill name", async () => {
    const name = "provider-skill";
    const fixture = await writeProviderVariantSkill(root, name);
    const skillsPath = path.join(root, "catalog", "skills.yml");
    await writeFile(
      skillsPath,
      `${(await readFile(skillsPath, "utf8")).trimEnd()}\n  - name: ${name}\n    source: vendored\n    repo: https://example.invalid/skills.git\n    ref: main\n    variants:\n      claude-code: dist/claude\n      codex: dist/codex\n      opencode: dist/opencode\n`,
      "utf8"
    );
    await mkdir(path.join(root, "skills"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "vendor.lock.yml"),
      YAML.stringify({
        skills: {
          [name]: {
            commit: "a".repeat(40),
            digest: fixture.digest,
            variants: fixture.digests
          }
        }
      }),
      "utf8"
    );
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    const profile = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      profile
        .replace("agents: [opencode, claude-code]", "agents: [opencode, claude-code, codex]")
        .replace(
          "mcp:\n",
          `  ${name}:\n    agents: { opencode: true, claude-code: true, codex: true }\nmcp:\n`
        ),
      "utf8"
    );

    await applyConfig({ root, home, agent: "all", target: "all", noLink: true });

    const paths = createRuntimePaths({ root, home });

    for (const target of providerVariantTargets) {
      await expect(
        readFile(
          path.join(providerSkillSnapshotDir(paths, "personal", target), name, "SKILL.md"),
          "utf8"
        )
      ).resolves.toBe(fixture.contents[target]);
    }

    await expect(lstat(configsPath(home, "personal", "skills", name))).rejects.toMatchObject({
      code: "ENOENT"
    });

    const observeProviderSnapshot = async (target: (typeof providerVariantTargets)[number]) => {
      const snapshot = providerSkillSnapshotDir(paths, "personal", target);
      const manifestPath = path.join(snapshot, ".mfz-manifest.yml");
      const skillPath = path.join(snapshot, name, "SKILL.md");

      const [snapshotStat, manifestStat, skillStat] = await Promise.all([
        lstat(snapshot),
        lstat(manifestPath),
        lstat(skillPath)
      ]);

      return {
        snapshot: {
          dev: snapshotStat.dev,
          ino: snapshotStat.ino,
          mtimeMs: snapshotStat.mtimeMs
        },
        manifest: {
          dev: manifestStat.dev,
          ino: manifestStat.ino,
          mtimeMs: manifestStat.mtimeMs,
          bytes: await readFile(manifestPath)
        },
        skill: {
          dev: skillStat.dev,
          ino: skillStat.ino,
          mtimeMs: skillStat.mtimeMs,
          bytes: await readFile(skillPath)
        }
      };
    };

    const initialState = await Promise.all(
      providerVariantTargets.map(async (target) => ({
        target,
        state: await observeProviderSnapshot(target)
      }))
    );

    const repeated = await applyConfig({ root, home, agent: "all", target: "all", noLink: true });

    expect(
      repeated.filter(
        (outcome) => outcome.significance === "meaningful" && operationChanged(outcome)
      )
    ).toEqual([]);

    for (const { target, state } of initialState) {
      const snapshot = providerSkillSnapshotDir(paths, "personal", target);
      expect(repeated).toContainEqual(
        expect.objectContaining({
          category: "bookkeeping",
          action: "snapshot",
          status: "unchanged",
          significance: "internal",
          target: snapshot
        })
      );
      expect(
        repeated.filter(
          (outcome) =>
            outcome.category === "file" &&
            outcome.action === "remove" &&
            outcome.target.startsWith(`${snapshot}${path.sep}`)
        )
      ).toEqual([]);
      expect(await observeProviderSnapshot(target)).toEqual(state);
    }
  });

  it("keeps linked OpenCode files and links unchanged across repeat apply", async () => {
    const agentSource = path.join(root, "opencode", "agents", "test-agent.md");
    await mkdir(path.dirname(agentSource), { recursive: true });
    await writeFile(agentSource, "# Test agent\n", "utf8");
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    await writeFile(
      profilePath,
      (await readFile(profilePath, "utf8")).replace(
        "  commands:\n    - test-cmd",
        "  commands:\n    - test-cmd\n  agents:\n    - test-agent"
      ),
      "utf8"
    );
    const managedPlugins = configsPath(home, "personal", "opencode", "plugins");
    const plugin = path.join(managedPlugins, "config-marker.ts");
    const stalePlugin = path.join(managedPlugins, "stale.ts");
    await mkdir(managedPlugins, { recursive: true });
    await writeFile(stalePlugin, "export default {}\n", "utf8");

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await expect(access(stalePlugin)).rejects.toMatchObject({ code: "ENOENT" });

    const gitConfig = path.join(home, ".gitconfig");
    const commandLink = path.join(home, ".config", "opencode", "commands");
    const agentLink = path.join(home, ".config", "opencode", "agents");

    const fileState = async (file: string) => {
      const metadata = await stat(file);

      return {
        content: await readFile(file, "utf8"),
        inode: metadata.ino,
        mode: metadata.mode,
        size: metadata.size,
        modified: metadata.mtimeMs,
        changed: metadata.ctimeMs
      };
    };

    const linkState = async (link: string) => {
      const metadata = await lstat(link);

      return {
        destination: await readlink(link),
        inode: metadata.ino,
        modified: metadata.mtimeMs,
        changed: metadata.ctimeMs
      };
    };

    const firstGitConfig = await fileState(gitConfig);
    const firstPlugin = await fileState(plugin);
    const firstCommandLink = await linkState(commandLink);
    const firstAgentLink = await linkState(agentLink);

    const repeated = await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    expect(repeated.stdout).toContain("Result\tmfz apply complete — no changes");
    expect(repeated.stdout).not.toMatch(/^(?:created|updated|removed|linked|relinked)\t/mu);
    expect(await fileState(gitConfig)).toEqual(firstGitConfig);
    expect(await fileState(plugin)).toEqual(firstPlugin);
    expect(await linkState(commandLink)).toEqual(firstCommandLink);
    expect(await linkState(agentLink)).toEqual(firstAgentLink);

    const withoutLinks = await cli("mfz", root, home, [
      "apply",
      "--agent",
      "opencode",
      "--no-link"
    ]);

    expect(withoutLinks.stdout).toContain("Result\tmfz apply complete — no changes");
    expect(await fileState(plugin)).toEqual(firstPlugin);
    expect(await linkState(commandLink)).toEqual(firstCommandLink);
    expect(await linkState(agentLink)).toEqual(firstAgentLink);

    await writeFile(
      profilePath,
      (await readFile(profilePath, "utf8")).replace("  plugins:\n    - config-marker\n", ""),
      "utf8"
    );

    const deselected = await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    expect(deselected.stdout).toContain(`removed\tfile\t${plugin}`);
    await expect(access(plugin)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("prints default no-change and complete verbose apply receipts", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);

    const unchanged = await cli("mfz", root, home, ["apply", "--no-link"]);
    expect(unchanged.stdout).not.toContain("Changes\n");
    expect(unchanged.stdout).toContain("Result\tmfz apply complete — no changes");
    expect(unchanged.stdout).not.toContain(String.fromCharCode(27));
    expect(unchanged.stdout).not.toContain(String.fromCharCode(155));

    const verbose = await cli("mfz", root, home, ["apply", "--no-link", "--verbose"]);
    expect(verbose.stdout).toContain("working\treference\treconcile");
    expect(verbose.stdout).toContain("unchanged\tfile");
    expect(verbose.stdout).toContain("unchanged\tbookkeeping");
    expect(verbose.stdout).toContain("Result\tmfz apply complete — no changes");
  });

  it("reconciles references for full --agent and --no-link apply", async () => {
    const source = fixtureReferenceSource(root);
    const checkout = path.join(home, ".mindframe-z", "references", "local-ref");
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);
    const before = await git(checkout, ["rev-parse", "HEAD"]);
    await writeFile(path.join(source, "README.md"), "advanced fixture\n", "utf8");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "advance fixture"]);

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    expect(await git(checkout, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(
      await git(source, ["rev-parse", "HEAD"])
    );
  });

  it.each(["mise", "dotfiles"])(
    "keeps targeted %s apply scoped away from references",
    async (target) => {
      const referencesPath = path.join(root, "catalog", "references.yml");
      await writeFile(
        referencesPath,
        (await readFile(referencesPath, "utf8")).replace(
          fixtureReferenceSource(root),
          path.join(home, "missing-reference.git")
        ),
        "utf8"
      );

      await cli("mfz", root, home, ["apply", "--target", target, "--no-link"]);

      expect(await exists(path.join(home, ".mindframe-z", "references", "local-ref"))).toBe(false);
      expect(await exists(path.join(home, ".mindframe-z", "references.md"))).toBe(false);
    }
  );

  it("plans a missing reference checkout without creating reference paths", async () => {
    const paths = createRuntimePaths({ root, home });

    const outcomes = await applyConfig({
      root,
      home,
      agent: "opencode",
      target: "all",
      dryRun: true,
      noLink: true
    });

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        category: "reference",
        status: "planned",
        detail: "local-ref: checkout would be cloned"
      })
    );
    expect(await exists(path.join(home, ".mindframe-z", "references", "local-ref"))).toBe(false);
    expect(await exists(referenceStatePath(paths))).toBe(false);
    expect(await exists(path.join(home, ".mindframe-z", "references.md"))).toBe(false);

    const receipt = await cli("mfz", root, home, ["apply", "--dry-run", "--no-link"]);
    expect(receipt.stdout).toContain("planned\treference");
    expect(receipt.stdout).toContain("checkout would be cloned");
    expect(receipt.stdout).toContain("planned\tindex");
    expect(receipt.stdout).toContain("planned change");
  });

  it("plans reference and index work without checking upstream or writing reference state", async () => {
    await applyConfig({ root, home, agent: "opencode", target: "all", noLink: true });
    const paths = createRuntimePaths({ root, home });
    const checkout = path.join(home, ".mindframe-z", "references", "local-ref");
    const source = fixtureReferenceSource(root);
    const checkoutBefore = await git(checkout, ["rev-parse", "HEAD"]);
    const stateBefore = await readFile(referenceStatePath(paths), "utf8");
    const indexPath = path.join(home, ".mindframe-z", "references.md");
    await writeFile(indexPath, "stale index\n", "utf8");
    await writeFile(path.join(source, "README.md"), "unfetched upstream\n", "utf8");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "unfetched upstream"]);

    const outcomes = await applyConfig({
      root,
      home,
      agent: "opencode",
      target: "all",
      dryRun: true,
      noLink: true
    });

    expect(outcomes.find((outcome) => outcome.category === "reference")?.detail).toContain(
      "upstream state not checked"
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({ category: "index", target: indexPath, status: "planned" })
    );
    expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(checkoutBefore);
    expect(await readFile(referenceStatePath(paths), "utf8")).toBe(stateBefore);
    expect(await readFile(indexPath, "utf8")).toBe("stale index\n");
  });

  it("stops activation after a reference failure and retains completed reference effects", async () => {
    const referencesPath = path.join(root, "catalog", "references.yml");
    await writeFile(
      referencesPath,
      (await readFile(referencesPath, "utf8")).replace(
        "    description: Local test reference.\n",
        [
          "    description: Local test reference.",
          "  - name: broken-ref",
          `    url: ${path.join(home, "missing-reference.git")}`,
          "    description: Broken reference.",
          ""
        ].join("\n")
      ),
      "utf8"
    );
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    await writeFile(
      profilePath,
      (await readFile(profilePath, "utf8")).replace(
        "references:\n  - local-ref",
        "references:\n  - local-ref\n  - broken-ref"
      ),
      "utf8"
    );
    const completed: OperationOutcome[] = [];
    let renders = 0;

    await expect(
      applyConfig(
        {
          root,
          home,
          agent: "opencode",
          target: "all",
          noLink: true,
          onComplete: completed.push.bind(completed)
        },
        {
          renderTarget: async () => {
            renders += 1;

            return { files: [], links: [] };
          }
        }
      )
    ).rejects.toThrow();
    expect(renders).toBe(0);
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "reference", status: "created" }),
        expect.objectContaining({ category: "reference", status: "failed" })
      ])
    );
    expect(await exists(path.join(home, ".mindframe-z", "references", "local-ref"))).toBe(true);
    expect(await exists(path.join(home, ".mindframe-z", "references.md"))).toBe(false);
  });

  it("stops indexes and activation after reference state persistence fails", async () => {
    const completed: OperationOutcome[] = [];
    let renders = 0;
    const failureCause = new Error("state store unavailable");
    const failureDetail = "Could not record ownership for local-ref: state store unavailable";

    const referenceOutcome: OperationOutcome = {
      category: "reference",
      action: "reconcile",
      status: "created",
      target: path.join(home, ".mindframe-z", "references", "local-ref"),
      significance: "meaningful",
      detail: "local-ref"
    };

    const referenceFailure: OperationOutcome = {
      category: "reference",
      action: "reconcile",
      status: "failed",
      target: referenceOutcome.target,
      significance: "meaningful",
      detail: failureDetail
    };

    const bookkeepingFailure: OperationOutcome = {
      category: "bookkeeping",
      action: "write",
      status: "failed",
      target: referenceStatePath(createRuntimePaths({ root, home })),
      significance: "internal",
      detail: failureDetail
    };

    await expect(
      applyConfig(
        {
          root,
          home,
          agent: "opencode",
          target: "all",
          noLink: true,
          onComplete: completed.push.bind(completed)
        },
        {
          syncReferences: async (_paths, _profile, options) => {
            for (const outcome of [referenceOutcome, referenceFailure, bookkeepingFailure])
              options.onComplete?.(outcome);

            throw new ReferenceReconciliationError(
              failureDetail,
              [referenceOutcome, referenceFailure, bookkeepingFailure],
              failureCause
            );
          },
          renderTarget: async () => {
            renders += 1;

            return { files: [], links: [] };
          }
        }
      )
    ).rejects.toThrow("Could not record ownership");

    expect(renders).toBe(0);
    expect(completed).toEqual(
      expect.arrayContaining([referenceOutcome, referenceFailure, bookkeepingFailure])
    );
    await expect(readFile(path.join(home, ".mindframe-z", "references.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      readFile(path.join(home, ".mindframe-z", "configs", "personal", "opencode", "opencode.jsonc"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("prints known completed effects when apply fails partway through references", async () => {
    const referencesPath = path.join(root, "catalog", "references.yml");
    await writeFile(
      referencesPath,
      (await readFile(referencesPath, "utf8")).replace(
        "    description: Local test reference.\n",
        [
          "    description: Local test reference.",
          "  - name: broken-ref",
          `    url: ${path.join(home, "missing-reference.git")}`,
          "    description: Broken reference.",
          ""
        ].join("\n")
      ),
      "utf8"
    );
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    await writeFile(
      profilePath,
      (await readFile(profilePath, "utf8")).replace(
        "references:\n  - local-ref",
        "references:\n  - local-ref\n  - broken-ref"
      ),
      "utf8"
    );

    await expect(cli("mfz", root, home, ["apply", "--no-link"])).rejects.toMatchObject({
      stdout: expect.stringMatching(
        /created\treference[\s\S]+failed\treference[\s\S]+earlier changes were not rolled back/u
      ),
      stderr: expect.stringContaining("missing-reference.git")
    });
  });

  it("notifies completed outcomes before a later operation fails", async () => {
    const completed: OperationOutcome[] = [];
    let renders = 0;

    await expect(
      applyConfig(
        {
          root,
          home,
          agent: "all",
          target: "all",
          noLink: true,
          onComplete: completed.push.bind(completed)
        },
        {
          renderTarget: async () => {
            renders += 1;

            if (renders > 1) throw new Error("later render failed");

            return {
              files: [{ path: path.join(home, "first-completed.txt"), content: "done\n" }],
              links: []
            };
          }
        }
      )
    ).rejects.toThrow("later render failed");
    expect(completed).toContainEqual(
      expect.objectContaining({ target: path.join(home, "first-completed.txt"), status: "created" })
    );
  });

  it("renders and links OpenCode and Claude config into temporary homes", async () => {
    const managedPlugins = configsPath(home, "personal", "opencode", "plugins");
    const stalePlugin = path.join(managedPlugins, "stale.ts");
    await mkdir(managedPlugins, { recursive: true });
    await writeFile(stalePlugin, "export default {}\n", "utf8");

    const result = await cli("mfz", root, home, ["apply", "--target", "all"]);
    expect(result.stdout).toContain("created\tfile");

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );

    expect(opencode).toContain("https://opencode.ai/config.json");
    expect(opencode).toContain("context7");
    expect(await readFile(path.join(managedPlugins, "config-marker.ts"), "utf8")).toContain(
      "mindframe-z-plugin-loaded"
    );
    await expect(lstat(stalePlugin)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(configsPath(home, "personal", "opencode", "commands", "test-cmd.md"), "utf8")
    ).toContain("Run the test command.");

    const claude = await readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8");
    expect(claude).toContain("@" + configsPath(home, "personal", "AGENTS.md"));

    const claudeMcp = parseJson(
      McpMap,
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    );

    expect(claudeMcp).toMatchObject({
      context7: { type: "http", url: "https://mcp.context7.com/mcp" },
      "local-helper": { type: "stdio", command: "tool-helper", args: ["--serve"] }
    });

    await expect(realpath(path.join(home, ".config", "opencode", "opencode.jsonc"))).resolves.toBe(
      configsPath(home, "personal", "opencode", "opencode.jsonc")
    );
    await expect(realpath(path.join(home, ".config", "opencode", "commands"))).resolves.toBe(
      configsPath(home, "personal", "opencode", "commands")
    );
    await expect(realpath(path.join(home, ".claude", "CLAUDE.md"))).resolves.toBe(
      configsPath(home, "personal", "claude", "CLAUDE.md")
    );
    expect((await lstat(path.join(home, ".claude", "settings.json"))).isSymbolicLink()).toBe(false);

    const localClaudeJson = parseJson(
      ClaudeJson,
      await readFile(path.join(home, ".claude.json"), "utf8")
    );

    expect(localClaudeJson.mcpServers).toMatchObject(claudeMcp);
  });

  it("renders OpenCode independently with native config and skill paths", async () => {
    await writeFile(path.join(home, ".mindframe-z", "config.yml"), "profile: personal\n", "utf8");
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");

    const profile = (await readFile(profilePath, "utf8"))
      .replaceAll("agents: [opencode, claude-code]", "agents: [opencode]")
      .replace("    model: test/model", "    model: v2/test-model")
      .replace("  plugins:\n    - config-marker", "  plugins: []")
      .replace("  context7:\n    agents: [opencode]", "  context7:\n    agents: [opencode]")
      .replace("opencode:\n", "opencode:\n  cli:\n    theme: dark\n");

    await writeFile(profilePath, profile, "utf8");

    const result = await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    const configPath = configsPath(home, "personal", "opencode", "opencode.jsonc");
    const config = parseJson(OpenCodeMcpConfig, await readFile(configPath, "utf8"));
    const mcp = config.mcp;

    expect(result.stderr).not.toContain("OpenCode V1 plugins omitted from OpenCode render");
    expect(config.model).toBe("v2/test-model");
    expect(config.plugins).toBeUndefined();
    expect(mcp.servers.context7).toMatchObject({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      disabled: false
    });
    expect(config.skills).toEqual([configsPath(home, "personal", "opencode", "skills")]);
    expect(
      await readFile(configsPath(home, "personal", "opencode", "commands", "test-cmd.md"), "utf8")
    ).toContain("Run the test command.");
    await expect(realpath(path.join(home, ".config", "opencode", "opencode.jsonc"))).resolves.toBe(
      configPath
    );
    await expect(
      access(
        path.join(home, ".mindframe-z", "configs", "personal", "opencode-v2", "opencode.jsonc")
      )
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("renders compact capability awareness and detailed group files", async () => {
    const referencesPath = path.join(root, "catalog", "references.yml");
    await writeFile(
      referencesPath,
      (await readFile(referencesPath, "utf8")).replace(
        "    description: Local test reference.\n",
        [
          "    description: Local test reference with full routing detail.",
          "    group: agent-tooling",
          "    summary: Local reference",
          "    signals: [local reference]",
          ""
        ].join("\n")
      ),
      "utf8"
    );
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    await writeFile(
      profilePath,
      (await readFile(profilePath, "utf8"))
        .replace(
          "references:\n  - local-ref\n",
          [
            "capability_groups:",
            "  - name: agent-tooling",
            "    summary: Agent sources.",
            "references:",
            "  - local-ref",
            "extra_folders:",
            `  - path: ${root}`,
            "    group: agent-tooling",
            "    summary: Fixture repository",
            "    signals: [integration fixture]",
            "    description: Full fixture repository description.",
            ""
          ].join("\n")
        )
        .replace("opencode:\n", "opencode:\n  global_instructions: true\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const awareness = await readFile(
      path.join(home, ".mindframe-z", "capabilities", "index.md"),
      "utf8"
    );

    const details = await readFile(
      path.join(home, ".mindframe-z", "capabilities", "agent-tooling.md"),
      "utf8"
    );

    const agents = await readFile(configsPath(home, "personal", "AGENTS.md"), "utf8");
    expect(awareness).toContain("Includes: Local reference, Fixture repository");
    expect(awareness).not.toContain("full routing detail");
    expect(details).toContain("Local test reference with full routing detail.");
    expect(details).toContain("Permissions: read allow, edit allow");
    expect(agents).toContain("# Available Workspace Capabilities");
    expect(agents).not.toContain("# Enabled References");
    await expect(
      readFile(path.join(home, ".mindframe-z", "references.md"), "utf8")
    ).resolves.toContain("Local test reference with full routing detail.");
  });

  it("merges and removes only MFZ-owned OpenCode TUI plugins from CLI settings", async () => {
    await writeFile(path.join(home, ".mindframe-z", "config.yml"), "profile: personal\n", "utf8");
    await mkdir(path.join(root, "opencode", "plugins", "session-cost-tui", "tui"), {
      recursive: true
    });
    await writeFile(
      path.join(root, "opencode", "plugins", "session-cost-tui", "package.json"),
      '{"type":"module","exports":{"./tui":"./tui/index.tsx"}}\n',
      "utf8"
    );
    await writeFile(
      path.join(root, "opencode", "plugins", "session-cost-tui", "tui", "index.tsx"),
      'export default { id: "session-cost-tui", setup() {} }\n',
      "utf8"
    );
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");

    const profile = (await readFile(profilePath, "utf8"))
      .replaceAll("agents: [opencode, claude-code]", "agents: [opencode]")
      .replace("  context7:\n    agents: [opencode]", "  context7:\n    agents: [opencode]")
      .replace(
        "opencode:\n",
        [
          "opencode:",
          "  plugin_options:",
          "    session-cost-tui:",
          "      mode: compact",
          "  tui_plugins:",
          "    - session-cost-tui",
          ""
        ].join("\n")
      );

    await writeFile(profilePath, profile, "utf8");
    const cliPath = path.join(home, ".config", "opencode", "cli.json");
    await mkdir(path.dirname(cliPath), { recursive: true });
    const userPlugin = `file://${configsPath(home, "personal", "opencode", "plugins", "tui", "user-plugin")}`;
    await writeFile(
      cliPath,
      JSON.stringify({
        theme: "dark",
        plugins: ["npm:other", { path: "file:///user/plugin" }, userPlugin]
      }),
      "utf8"
    );

    const applied = await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    const managedPackage = `file://${configsPath(home, "personal", "opencode", "plugins", "tui", "session-cost-tui")}`;
    const managed = { package: managedPackage, options: { mode: "compact" } };
    expect(applied.stdout).toContain(`updated\tfile\t${cliPath}`);
    expect(JSON.parse(await readFile(cliPath, "utf8"))).toEqual({
      theme: "dark",
      plugins: ["npm:other", { path: "file:///user/plugin" }, userPlugin, managed]
    });
    expect(
      JSON.parse(
        await readFile(path.join(home, ".mindframe-z", "opencode-cli-plugins.json"), "utf8")
      )
    ).toEqual({ version: 1, entries: [managed] });
    expect((await lstat(cliPath)).isSymbolicLink()).toBe(false);

    await writeFile(profilePath, profile.replace("mode: compact", "mode: detailed"), "utf8");
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    expect(JSON.parse(await readFile(cliPath, "utf8"))).toEqual({
      theme: "dark",
      plugins: [
        "npm:other",
        { path: "file:///user/plugin" },
        userPlugin,
        { package: managedPackage, options: { mode: "detailed" } }
      ]
    });

    await writeFile(
      profilePath,
      profile.replace("  tui_plugins:\n    - session-cost-tui\n", ""),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    expect(JSON.parse(await readFile(cliPath, "utf8"))).toEqual({
      theme: "dark",
      plugins: ["npm:other", { path: "file:///user/plugin" }, userPlugin]
    });
  }, 15_000);

  it("smokes OpenCode with an isolated binary environment", async () => {
    const binDir = path.join(home, "bin");
    const capturePath = path.join(home, "opencode-smoke.json");
    const binaryPath = path.join(binDir, "opencode");
    const isolated = path.join(home, ".mindframe-z-opencode-smoke");
    const staleOwner = path.join(home, "user-owned-smoke-state");
    const stalePath = path.join(isolated, "stale.txt");
    const userServicePath = path.join(home, ".config", "opencode", "service.json");

    const userService =
      JSON.stringify({ port: 0xc0de, password: "user-owned-service-secret" }, null, 2) + "\n";

    await mkdir(binDir, { recursive: true });
    await mkdir(staleOwner, { recursive: true });
    await writeFile(path.join(staleOwner, "stale.txt"), "stale smoke state\n", "utf8");
    await symlink(staleOwner, isolated, "dir");
    await mkdir(path.dirname(userServicePath), { recursive: true });
    await writeFile(userServicePath, userService, "utf8");
    await writeFile(
      binaryPath,
      [
        "#!/usr/bin/env node",
        'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
        'const path = require("node:path");',
        "const events = existsSync(process.env.MFZ_SMOKE_CAPTURE) ? JSON.parse(readFileSync(process.env.MFZ_SMOKE_CAPTURE, 'utf8')) : [];",
        "const envKeys = ['HOME', 'OPENCODE_TEST_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PTY_HANDOFF', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DB', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];",
        "const env = Object.fromEntries(envKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));",
        "const service = JSON.parse(readFileSync(path.join(process.env.OPENCODE_CONFIG_DIR, 'service.json'), 'utf8'));",
        "events.push({ argv: process.argv.slice(2), cwd: process.cwd(), env, service });",
        "writeFileSync(process.env.MFZ_SMOKE_CAPTURE, JSON.stringify(events));",
        'console.log("resolved-config-secret");',
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(binaryPath, 0o755);

    const ambientDb = path.join(home, "v1", "opencode.db");

    const result = await cli("mfz", root, home, ["smoke-opencode"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MFZ_SMOKE_CAPTURE: capturePath,
      OPENCODE_DB: ambientDb,
      OPENCODE_CONFIG: path.join(home, "user-owned-config.json"),
      OPENCODE_CONFIG_CONTENT: '{"secret":"ambient-config-secret"}',
      OPENCODE_PTY_HANDOFF: "ambient-handoff",
      XDG_CONFIG_HOME: path.join(home, "v1", "config"),
      XDG_DATA_HOME: path.join(home, "v1", "data"),
      XDG_STATE_HOME: path.join(home, "v1", "state"),
      XDG_CACHE_HOME: path.join(home, "v1", "cache")
    });

    const captures = z.array(SmokeCapture).parse(JSON.parse(await readFile(capturePath, "utf8")));
    const capture = captures[0]!;
    expect(result.stdout).toContain("OpenCode config parsed successfully");
    expect(result.stdout).not.toContain("resolved-config-secret");
    expect(result.stdout).not.toContain("ambient-config-secret");
    expect(result.stderr).not.toContain("resolved-config-secret");
    expect(result.stderr).not.toContain("ambient-config-secret");
    expect(captures.map((event) => event.argv)).toEqual([
      ["debug", "config"],
      ["service", "stop"]
    ]);
    expect(capture.argv).toEqual(["debug", "config"]);
    expect(capture.cwd).toBe(home);
    expect(capture.env.OPENCODE_TEST_HOME).toBe(home);
    expect(capture.env.OPENCODE_CONFIG).toBeUndefined();
    expect(capture.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(capture.env.OPENCODE_PTY_HANDOFF).toBeUndefined();
    expect(capture.env.OPENCODE_CONFIG_DIR).toBe(path.join(isolated, "config", "opencode"));
    expect(captures[1]!.env.OPENCODE_CONFIG_DIR).toBe(capture.env.OPENCODE_CONFIG_DIR);
    expect(capture.service).toEqual({ port: expect.any(Number) });
    expect(
      JSON.parse(await readFile(path.join(isolated, "config", "opencode", "service.json"), "utf8"))
    ).toEqual(capture.service);
    expect(capture.env.OPENCODE_DB).toBe(path.join(isolated, "data", "opencode.db"));
    expect(capture.env.OPENCODE_DB).not.toBe(ambientDb);
    expect(capture.env.XDG_CONFIG_HOME).toBe(path.join(isolated, "config"));
    expect(capture.env.XDG_DATA_HOME).toBe(path.join(isolated, "data"));
    expect(capture.env.XDG_STATE_HOME).toBe(path.join(isolated, "state"));
    expect(capture.env.XDG_CACHE_HOME).toBe(path.join(isolated, "cache"));
    await expect(access(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(staleOwner, "stale.txt"))).resolves.toBeUndefined();
    await expect(readFile(userServicePath, "utf8")).resolves.toBe(userService);
  });

  it("skips the OpenCode smoke check when the stable executable is unavailable", async () => {
    const result = await cli("mfz", root, home, ["smoke-opencode"], {
      PATH: "/usr/bin:/bin"
    });

    expect(result.stdout).toContain("opencode not found; skipped smoke check");
  });

  it("renders, links, and removes merged OpenCode runtime dependencies", async () => {
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      [
        "name: base",
        "opencode:",
        "  dependencies:",
        "    '@acme/base': 1.2.3",
        "    shared: 1.0.0",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "opencode:",
        "  dependencies:",
        "    '@acme/personal': 2.3.4",
        "    shared: 2.0.0",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const manifestPath = configsPath(home, "personal", "opencode", "package.json");
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      dependencies: { "@acme/base": "1.2.3", "@acme/personal": "2.3.4", shared: "2.0.0" }
    });
    await expect(realpath(path.join(home, ".config", "opencode", "package.json"))).resolves.toBe(
      manifestPath
    );

    await writeFile(path.join(root, "profiles", "base", "profile.yml"), "name: base\n", "utf8");
    await mkdir(path.join(root, "profiles", "clean"), { recursive: true });
    await writeFile(
      path.join(root, "profiles", "clean", "profile.yml"),
      ["name: clean", "extends: base", "agents: [opencode]", ""].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["--profile", "clean", "apply", "--agent", "opencode"]);

    await expect(
      lstat(path.join(home, ".config", "opencode", "package.json"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "agents: [opencode]", ""].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    await expect(access(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(home, ".config", "opencode", "package.json"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("renders extra folders in OpenCode config", async () => {
    const workPath = path.join(home, "code", "work");
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        `  - path: ~/code/work`,
        `    description: Work code`,
        `  - path: ~/code/restricted`,
        `    read: deny`,
        `    edit: deny`,
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );

    const config = parseJson(OpenCodeFolderConfig, opencode);
    expect(config.permissions).toEqual(
      expect.arrayContaining([
        { action: "external_directory", resource: `${workPath}/*`, effect: "allow" },
        { action: "external_directory", resource: `${home}/code/restricted/*`, effect: "deny" },
        { action: "edit", resource: `${home}/code/restricted/*`, effect: "deny" }
      ])
    );
  });

  it("renders extra folders in Claude settings", async () => {
    const codePath = path.join(home, "code");
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        `  - path: ~/code`,
        `    description: All code`,
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code", "--no-link"]);

    const settings = parseJson(
      ClaudeSettings,
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
    );

    expect(settings).toHaveProperty("permissions");
    expect(settings).toHaveProperty("additionalDirectories");
    expect(settings.additionalDirectories).toContain(codePath);
    expect(settings.permissions?.allow).toContain(`Read(/${codePath}/**)`);
  });

  it("renders Codex config and guidance without writing local files in no-link mode", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [codex]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "references:",
        "  - local-ref",
        "mcp:",
        "  context7:",
        "    agents: [codex]",
        "  local-helper:",
        "    agents: { disabled: [codex] }",
        "codex:",
        "  config:",
        "    model: test/codex",
        "  plugins:",
        '    "github@openai-curated":',
        "      enabled: true",
        "      toggleable: false",
        '    "teams@openai-curated":',
        "      enabled: false",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(home, ".mindframe-z", "config.yml"),
      [
        "profile: personal",
        "references_dir: ~/references",
        "extra_folders:",
        "  - path: ~/work",
        "    description: Work code",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const config = parseToml(
      CodexConfig,
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    );

    expect(config.model).toBe("test/codex");
    expect(config.plugins).toEqual({
      "github@openai-curated": { enabled: true, toggleable: false },
      "teams@openai-curated": { enabled: false }
    });
    expect(config.default_permissions).toBe("mfz");
    expect(config.mcp_servers).toMatchObject({
      context7: { url: "https://mcp.context7.com/mcp", enabled: true },
      "local-helper": { command: "tool-helper", args: ["--serve"], enabled: false }
    });
    expect(config.permissions).toMatchObject({
      mfz: {
        filesystem: { [path.join(home, "references")]: "read", [path.join(home, "work")]: "write" }
      }
    });
    const codexAgents = await readFile(configsPath(home, "personal", "codex", "AGENTS.md"), "utf8");
    expect(codexAgents).toContain("# Test Agents");
    // Codex cannot follow @import directives, so its AGENTS.md inlines the
    // reference and extra-folder index contents alongside the instruction file.
    expect(codexAgents).toContain("# Enabled References");
    expect(codexAgents).toContain("# Extra Folders");
    expect(codexAgents).toContain("Work code");
    expect(await exists(path.join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("omits Codex plugins from rendered TOML when no plugins are declared", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const config = parseToml(
      CodexConfig,
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    );

    expect(config).not.toHaveProperty("plugins");
  });

  it("renders Pi settings and guidance without writing local files in no-link mode", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [pi]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "pi:",
        "  settings:",
        "    theme: dark",
        "    defaultProvider: openai-codex",
        "    defaultModel: gpt-5.5",
        "    subagents:",
        "      agentOverrides:",
        "        scout:",
        "          model: openai-codex/gpt-5.4-mini",
        "          thinking: low",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      path.join(home, ".pi", "agent", "settings.json"),
      '{"theme":"light"}\n',
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "pi", "--no-link"]);

    const snapshot = parseJson(
      PiSettings,
      await readFile(configsPath(home, "personal", "pi", "settings.json"), "utf8")
    );

    expect(snapshot).toMatchObject({
      theme: "dark",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.5",
      subagents: { agentOverrides: { scout: { thinking: "low" } } }
    });
    expect(await readFile(configsPath(home, "personal", "pi", "AGENTS.md"), "utf8")).toContain(
      "# Test Agents"
    );
    expect(await readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8")).toBe(
      '{"theme":"light"}\n'
    );
  });

  it("merges Pi settings and subagent config into local JSON files", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [pi]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "pi:",
        "  settings:",
        "    theme: dark",
        "    defaultModel: gpt-5.5",
        "    nested:",
        "      generated: true",
        "  subagent_config:",
        "    toolDescriptionMode: compact",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".pi", "agent", "extensions", "subagent"), { recursive: true });
    await writeFile(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ theme: "light", keep: true, nested: { local: true } }, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      path.join(home, ".pi", "agent", "extensions", "subagent", "config.json"),
      JSON.stringify({ keepLocal: true, toolDescriptionMode: "full" }, null, 2) + "\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "pi"]);

    expect(result.stdout).toContain(
      `updated\tfile\t${path.join(home, ".pi", "agent", "settings.json")}`
    );

    const localSettings = parseJson(
      PiSettings,
      await readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8")
    );

    expect(localSettings).toMatchObject({
      theme: "dark",
      keep: true,
      defaultModel: "gpt-5.5",
      nested: { local: true, generated: true }
    });
    expect(await readFile(path.join(home, ".pi", "agent", "AGENTS.md"), "utf8")).toContain(
      "# Test Agents"
    );

    const localSubagentConfig = parseJson(
      z.object({ keepLocal: z.boolean(), toolDescriptionMode: z.string() }),
      await readFile(
        path.join(home, ".pi", "agent", "extensions", "subagent", "config.json"),
        "utf8"
      )
    );

    expect(localSubagentConfig).toEqual({ keepLocal: true, toolDescriptionMode: "compact" });

    const snapshotSubagentConfig = parseJson(
      z.object({ toolDescriptionMode: z.string() }),
      await readFile(
        configsPath(home, "personal", "pi", "extensions", "subagent", "config.json"),
        "utf8"
      )
    );

    expect(snapshotSubagentConfig).toEqual({ toolDescriptionMode: "compact" });
  });

  it("merges Codex config into local TOML without replacing unrelated keys", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), 'user_key = "kept"\n', "utf8");

    await cli("mfz", root, home, ["apply", "--agent", "codex"]);

    const localConfig = parseToml(
      CodexConfig,
      await readFile(path.join(home, ".codex", "config.toml"), "utf8")
    );

    expect(localConfig.user_key).toBe("kept");
    expect(localConfig.model).toBe("test/codex");
    expect(await exists(path.join(home, ".codex", "AGENTS.override.md"))).toBe(false);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toContain(
      "# Test Agents"
    );
  });

  it("replaces local Codex plugins while preserving unrelated local keys", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        "  plugins:",
        '    "github@openai-curated":',
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      ['user_key = "kept"', "", '[plugins."slack@openai-curated"]', "enabled = true", ""].join(
        "\n"
      ),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex"]);

    const localConfig = parseToml(
      CodexConfig,
      await readFile(path.join(home, ".codex", "config.toml"), "utf8")
    );

    expect(localConfig.user_key).toBe("kept");
    expect(localConfig.model).toBe("test/codex");
    expect(localConfig.plugins).toEqual({ "github@openai-curated": { enabled: true } });
  });

  it("removes the local Codex plugins table when the declared set is empty", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      ['[plugins."slack@openai-curated"]', "enabled = true", ""].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "codex"]);

    const localConfig = parseToml(
      CodexConfig,
      await readFile(path.join(home, ".codex", "config.toml"), "utf8")
    );

    expect(localConfig).not.toHaveProperty("plugins");
  });

  it("sync promotes unmanaged Codex config keys and ignores generated tables", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  config:",
        "    model: test/codex",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const codexPath = configsPath(home, "personal", "codex", "config.toml");
    await writeFile(
      codexPath,
      [
        'model = "test/codex"',
        'model_verbosity = "low"',
        'default_permissions = "mfz"',
        "",
        "[mcp_servers.generated]",
        'url = "https://example.invalid/mcp"',
        "",
        "[permissions.mfz.filesystem]",
        `"${path.join(home, "references")}" = "read"`,
        ""
      ].join("\n"),
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain(
      "Updated personal/profile.yml: codex.config.model_verbosity"
    );

    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );

    expect(profileYaml).toContain("model_verbosity: low");
    expect(profileYaml).not.toContain("mcp_servers");
  });

  it("sync promotes undeclared enabled Codex plugins and ignores declared plugins", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [codex]",
        "codex:",
        "  plugins:",
        '    "github@openai-curated":',
        "      enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "codex", "--no-link"]);

    const codexDir = path.join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    const codexPath = path.join(codexDir, "config.toml");
    await writeFile(
      codexPath,
      [
        '[plugins."github@openai-curated"]',
        "enabled = true",
        "",
        '[plugins."teams@openai-curated"]',
        "enabled = true",
        "",
        '[plugins."slack@openai-curated"]',
        "enabled = false",
        ""
      ].join("\n"),
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain(
      "Updated personal/profile.yml: codex.plugins.teams@openai-curated"
    );
    expect(syncResult.stdout).not.toContain("github@openai-curated");
    expect(syncResult.stdout).not.toContain("slack@openai-curated");

    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );

    expect(profileYaml).toContain("teams@openai-curated");
    expect(profileYaml).toContain("enabled: true");
    expect(profileYaml).not.toContain("slack@openai-curated");
  });

  it("sync promotes unmanaged rendered OpenCode config keys to the chosen profile", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    const opencodePath = configsPath(home, "personal", "opencode", "opencode.jsonc");
    const opencode = parseJson(OpenCodeConfig, await readFile(opencodePath, "utf8"));
    opencode.small_model = "test/small-model";
    await writeFile(opencodePath, JSON.stringify(opencode, null, 2) + "\n", "utf8");

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).toContain(
      "Updated personal/profile.yml: opencode.config.small_model"
    );

    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );

    expect(profileYaml).toContain("small_model: test/small-model");

    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);
    const rerendered = parseJson(OpenCodeConfig, await readFile(opencodePath, "utf8"));
    expect(rerendered.small_model).toBe("test/small-model");
  });

  it("merges Claude settings into the machine-local file without linking", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, claude-code]",
        "claude:",
        "  model: sonnet",
        "  settings:",
        "    includeGitInstructions: true",
        "    permissions:",
        "      deny:",
        "        - Bash(curl *)",
        "    env:",
        '      CLAUDE_CODE_ENABLE_TELEMETRY: "1"',
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            AWS_PROFILE: "ClaudeCodeUnix",
            AWS_REGION: "us-west-2"
          },
          awsAuthRefresh: "/work/credential-process"
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    expect(result.stdout).toContain(
      `updated\tfile\t${path.join(home, ".claude", "settings.json")}`
    );
    expect((await lstat(path.join(home, ".claude", "settings.json"))).isSymbolicLink()).toBe(false);

    const localSettings = parseJson(
      ClaudeSettings,
      await readFile(path.join(home, ".claude", "settings.json"), "utf8")
    );

    expect(localSettings).toMatchObject({
      includeGitInstructions: true,
      model: "sonnet",
      awsAuthRefresh: "/work/credential-process",
      env: {
        AWS_PROFILE: "ClaudeCodeUnix",
        AWS_REGION: "us-west-2",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1"
      }
    });

    const snapshot = parseJson(
      ClaudeSettings,
      await readFile(configsPath(home, "personal", "claude", "settings.json"), "utf8")
    );

    expect(snapshot).toEqual({
      includeGitInstructions: true,
      permissions: {
        allow: [`Read(/${path.join(home, ".mindframe-z", "references")}/**)`],
        deny: ["Bash(curl *)", `Edit(/${path.join(home, ".mindframe-z", "references")}/**)`]
      },
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" },
      model: "sonnet"
    });
  });

  it("replaces an old Claude settings symlink with a machine-local file", async () => {
    const snapshotPath = configsPath(home, "personal", "claude", "settings.json");
    const settingsPath = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(snapshotPath, '{"awsAuthRefresh":"/work/credential-process"}\n', "utf8");
    await symlink(snapshotPath, settingsPath);

    await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toContain("/work/credential-process");
    expect(await readFile(settingsPath, "utf8")).toContain("includeGitInstructions");
  });

  it("does not write machine-local Claude settings with --no-link", async () => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), "{}\n", "utf8");
    await writeFile(path.join(home, ".claude.json"), '{"mcpServers":{}}\n', "utf8");

    const result = await cli("mfz", root, home, ["apply", "--agent", "claude-code", "--no-link"]);

    expect(result.stdout).not.toContain("wrote local");
    expect(await readFile(path.join(home, ".claude", "settings.json"), "utf8")).toBe("{}\n");
    expect(await readFile(path.join(home, ".claude.json"), "utf8")).toBe('{"mcpServers":{}}\n');
  });

  it("merges Claude MCP into top-level .claude.json and prunes non-targeted managed servers", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "mcp:",
        "  context7:",
        "    agents: [opencode]",
        "  local-helper:",
        "    agents: [claude-code]",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify(
        {
          installMethod: "native",
          mcpServers: {
            context7: { type: "http", url: "https://old.invalid" },
            executor: {
              type: "stdio",
              command: "executor",
              args: ["mcp", "--scope", "/tmp/mfz-generated-executor"],
              env: { EXECUTOR_DATA_DIR: "/tmp/mfz-generated-executor-data" }
            },
            manual: { type: "http", url: "https://manual.invalid" }
          },
          projects: {
            [path.join(home, "src")]: {
              disabledMcpServers: ["local-helper"]
            }
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    const localClaudeJson = parseJson(
      ClaudeJson,
      await readFile(path.join(home, ".claude.json"), "utf8")
    );

    expect(localClaudeJson.installMethod).toBe("native");
    expect(localClaudeJson.projects).toBeDefined();
    expect(localClaudeJson.mcpServers).toEqual({
      manual: { type: "http", url: "https://manual.invalid" },
      context7: { type: "http", url: "https://mcp.context7.com/mcp" },
      "local-helper": { type: "stdio", command: "tool-helper", args: ["--serve"] }
    });
  });

  it("preserves a user-owned all-direct Claude MCP entry named executor", async () => {
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          executor: { type: "stdio", command: "executor" },
          manual: { type: "http", url: "https://manual.invalid" }
        }
      }) + "\n",
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--agent", "claude-code"]);

    const localClaudeJson = parseJson(
      ClaudeJson,
      await readFile(path.join(home, ".claude.json"), "utf8")
    );

    expect(localClaudeJson.mcpServers).toMatchObject({
      executor: { type: "stdio", command: "executor" },
      manual: { type: "http", url: "https://manual.invalid" }
    });
  });

  it("does not render Claude config for an opencode-only profile", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "mcp:",
        "  context7:",
        "    agents: [opencode]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ).resolves.toContain("context7");
    await expect(
      readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renders MCP entries for declared agents", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "mcp:",
        "  context7:",
        "    agents: [opencode]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    const opencode = await readFile(
      configsPath(home, "personal", "opencode", "opencode.jsonc"),
      "utf8"
    );

    expect(opencode).toContain("context7");
  });

  it("transforms env-referenced MCP headers per target", async () => {
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  exa:",
        "    description: Search.",
        "    type: remote",
        "    transport: http",
        "    url: https://mcp.exa.ai/mcp",
        "    headers:",
        '      Authorization: "{env:EXA_API_KEY}"',
        "      X-Client: literal-value",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "agents: [opencode, claude-code, codex]",
        "mcp:",
        "  exa:",
        "    agents: [opencode, claude-code, codex]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    // OpenCode passes the {env:NAME} reference through untouched.
    const opencode = parseJson(
      OpenCodeConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    expect(opencode.mcp?.servers).toMatchObject({
      exa: { headers: { Authorization: "{env:EXA_API_KEY}", "X-Client": "literal-value" } }
    });

    // Claude rewrites the reference to shell-style ${NAME} interpolation.
    const claudeMcp = parseJson(
      McpMap,
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    );

    expect(claudeMcp).toMatchObject({
      exa: { headers: { Authorization: "${EXA_API_KEY}", "X-Client": "literal-value" } }
    });

    // Codex splits literal headers from env-referenced ones into distinct tables.
    const codex = parseToml(
      CodexConfig,
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    );

    expect(codex.mcp_servers).toMatchObject({
      exa: {
        env_http_headers: { Authorization: "EXA_API_KEY" },
        http_headers: { "X-Client": "literal-value" }
      }
    });
  });

  it("filters agent rendering with --agent", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode", "--no-link"]);

    await expect(
      readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    ).resolves.toContain("test/model");
    await expect(
      readFile(configsPath(home, "personal", "claude", "CLAUDE.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("translates {env:NAME} MCP header refs per agent without leaking literals", async () => {
    await writeFile(
      path.join(root, "catalog", "mcp.yml"),
      [
        "servers:",
        "  secured:",
        "    description: Secured remote.",
        "    type: remote",
        "    transport: http",
        "    url: https://secure.example.invalid/mcp",
        "    headers:",
        '      Authorization: "{env:SECURED_TOKEN}"',
        "      X-Client: literal-value",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      ["name: base", "mcp:", "  secured:", "    agents: [claude-code, codex]", ""].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [claude-code, codex]",
        "instructions:",
        "  - instructions/AGENTS.md",
        "mcp:",
        "  secured:",
        "    agents: [claude-code, codex]",
        ""
      ].join("\n"),
      "utf8"
    );

    await cli("mfz", root, home, ["apply", "--no-link"]);

    const codexConfig = parseToml(
      CodexSecuredConfig,
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    );

    // Codex keeps the env-ref name in env_http_headers and only literals in http_headers.
    expect(codexConfig.mcp_servers.secured.env_http_headers).toEqual({
      Authorization: "SECURED_TOKEN"
    });
    expect(codexConfig.mcp_servers.secured.http_headers).toEqual({ "X-Client": "literal-value" });

    const claudeMcp = parseJson(
      ClaudeSecuredMcp,
      await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8")
    );

    // Claude rewrites the env-ref into ${NAME} while passing literals through verbatim.
    expect(claudeMcp.secured.headers).toEqual({
      Authorization: "${SECURED_TOKEN}",
      "X-Client": "literal-value"
    });

    // The raw token literal must never reach either rendered config.
    const codexRaw = await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8");
    const claudeRaw = await readFile(configsPath(home, "personal", "claude", "mcp.json"), "utf8");
    expect(codexRaw).not.toContain("{env:SECURED_TOKEN}");
    expect(claudeRaw).not.toContain("{env:SECURED_TOKEN}");
  });

  it("links skills to the rendered snapshot and keeps source edits inactive until apply", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);

    const snapshotSkill = configsPath(
      home,
      "personal",
      "opencode",
      "skills",
      "local-skill",
      "SKILL.md"
    );

    const oldContent = await readFile(snapshotSkill, "utf8");
    const sourceSkill = path.join(root, "skills", "local-skill", "SKILL.md");
    await writeFile(
      sourceSkill,
      oldContent.replace("Local test skill.", "Changed test skill."),
      "utf8"
    );
    expect(await readFile(snapshotSkill, "utf8")).toBe(oldContent);

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await expect(
      realpath(path.join(home, ".config", "opencode", "skills", "local-skill"))
    ).resolves.toBe(snapshotSkill.replace(/\/SKILL\.md$/, ""));
    expect(await readFile(snapshotSkill, "utf8")).toContain("Changed test skill.");
  });

  it("keeps skill runtime state unchanged during apply dry-run", async () => {
    const result = await cli("mfz", root, home, ["apply", "--dry-run"]);
    expect(result.stdout).toContain("planned\tskill\tlocal-skill");
    await expect(
      readFile(
        path.join(
          home,
          ".mindframe-z",
          "engine-skills",
          "skills",
          "skill-update-review",
          "SKILL.md"
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(configsPath(home, "personal", "opencode", "skills", ".mfz-manifest.yml"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before replacing a snapshot when an unmanaged skill path conflicts", async () => {
    await cli("mfz", root, home, ["apply", "--no-link"]);

    const snapshotSkill = configsPath(
      home,
      "personal",
      "opencode",
      "skills",
      "local-skill",
      "SKILL.md"
    );

    const prior = await readFile(snapshotSkill, "utf8");
    await mkdir(path.join(home, ".config", "opencode", "skills", "local-skill"), {
      recursive: true
    });

    const result = await cli("mfz", root, home, ["apply", "--agent", "opencode"]).catch(
      (error) => error
    );

    expect(result.stderr).toContain("Unmanaged skill link conflict");
    expect(await readFile(snapshotSkill, "utf8")).toBe(prior);
  });

  it("removes stale owned links when a target has no remaining skills", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    const link = path.join(home, ".config", "opencode", "skills", "local-skill");
    await expect(realpath(link)).resolves.toBe(
      configsPath(home, "personal", "opencode", "skills", "local-skill")
    );

    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "agents: [opencode]", ""].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(configsPath(home, "personal", "opencode", "skills", "local-skill"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rewrite a matching snapshot", async () => {
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);

    const snapshotSkill = configsPath(
      home,
      "personal",
      "opencode",
      "skills",
      "local-skill",
      "SKILL.md"
    );

    const before = (await stat(snapshotSkill)).ino;
    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    expect((await stat(snapshotSkill)).ino).toBe(before);
  });

  it("renders explicit shared-directory runtime restrictions", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, codex]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true, codex: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "all"]);

    const opencode = parseJson(
      OpenCodeConfig,
      await readFile(configsPath(home, "personal", "opencode", "opencode.jsonc"), "utf8")
    );

    expect(opencode.skills).toEqual([configsPath(home, "personal", "opencode", "skills")]);

    const codex = parseToml(
      CodexConfig,
      await readFile(configsPath(home, "personal", "codex", "config.toml"), "utf8")
    );

    expect(codex.skills?.config).toContainEqual({
      path: path.join(home, ".agents", "skills", "local-skill", "SKILL.md"),
      enabled: true
    });
  });

  it("preserves the OpenCode/Codex physical skill union for targeted apply", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, codex]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true }",
        "  all-skill:",
        "    agents: { codex: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    await cli("mfz", root, home, ["apply", "--agent", "all"]);
    await expect(lstat(path.join(home, ".agents", "skills", "all-skill"))).resolves.toBeDefined();

    await cli("mfz", root, home, ["apply", "--agent", "opencode"]);
    await expect(lstat(path.join(home, ".agents", "skills", "all-skill"))).resolves.toBeDefined();
  });
});
