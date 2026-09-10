import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execa } from "execa";
import YAML from "yaml";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimePaths, skillCacheRoot } from "../../src/core/paths.js";
import { resolveProfile } from "../../src/core/profile.js";
import { operationChanged } from "../../src/core/operations.js";
import { syncSkillSnapshot } from "../../src/skills/snapshot.js";
import { sha256 } from "../../src/skills/tree.js";
import { runSkillsTui } from "../../src/tui/skills-tui.js";
import {
  cli,
  configsPath,
  makeTempDir,
  parseJson,
  setupIntegrationFixture,
  sink
} from "./support.js";

const Overrides = z.object({
  projects: z.record(
    z.string(),
    z.object({
      "claude-code": z.object({ skills: z.record(z.string(), z.boolean()) }).optional(),
      codex: z.object({ skills: z.record(z.string(), z.boolean()) }).optional()
    })
  )
});
const OpenCodePermission = z.object({ permission: z.object({ webfetch: z.string() }) });
const ClaudeSettings = z.object({ includeGitInstructions: z.boolean() });

async function seedGitCache(
  root: string,
  home: string,
  repository: string
): Promise<{ commit: string; newerCommit: string }> {
  const upstream = await makeTempDir();
  await execa("git", ["init", "-q"], { cwd: upstream });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: upstream });
  await execa("git", ["config", "user.name", "Mindframe Test"], { cwd: upstream });
  const source = path.join(upstream, "skills", "trusted");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: trusted\ndescription: pinned\n---\n\n# Pinned\n",
    "utf8"
  );
  await execa("git", ["add", "."], { cwd: upstream });
  await execa("git", ["commit", "-qm", "initial"], { cwd: upstream });
  const { stdout: commit } = await execa("git", ["rev-parse", "HEAD"], { cwd: upstream });
  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: trusted\ndescription: newer\n---\n\n# Newer\n",
    "utf8"
  );
  await execa("git", ["add", "."], { cwd: upstream });
  await execa("git", ["commit", "-qm", "newer"], { cwd: upstream });
  const { stdout: newerCommit } = await execa("git", ["rev-parse", "HEAD"], { cwd: upstream });

  const paths = createRuntimePaths({ root, home });
  const cache = path.join(skillCacheRoot(paths), sha256(repository));
  await mkdir(path.dirname(cache), { recursive: true });
  await execa("git", ["clone", "--bare", "-q", upstream, cache]);
  await execa("git", ["--git-dir", cache, "remote", "set-url", "origin", repository]);
  return { commit, newerCommit };
}

async function writeGitSkillCatalog(
  root: string,
  repository: string,
  commit: string
): Promise<void> {
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await writeFile(
    path.join(root, "catalog", "skills.yml"),
    [
      "skills:",
      "  - name: trusted",
      "    source: git",
      `    repo: ${repository}`,
      `    commit: ${commit}`,
      "    subtree: skills/trusted",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeGitSkillProfile(
  root: string,
  repository: string,
  commit: string
): Promise<void> {
  await writeGitSkillCatalog(root, repository, commit);
  await writeFile(
    path.join(root, "profiles", "personal", "profile.yml"),
    [
      "name: personal",
      "extends: base",
      "agents: [opencode-v2]",
      "skills:",
      "  trusted:",
      "    agents: { opencode: true }",
      ""
    ].join("\n"),
    "utf8"
  );
}

describe("skill CLI integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    delete process.env.MFZ_ROOT;
    delete process.env.MFZ_HOME;
  });

  it("sync ignores external installer lock state", async () => {
    await mkdir(path.join(home, ".agents", "skills", "remote-skill"), { recursive: true });
    await writeFile(
      path.join(home, ".agents", ".skill-lock.json"),
      JSON.stringify(
        {
          version: 3,
          skills: {
            "remote-skill": {
              source: "example/skills",
              sourceType: "github",
              sourceUrl: "https://github.com/example/skills.git",
              skillPath: "skills/remote-skill/SKILL.md"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(home, ".agents", "skills", "remote-skill", "SKILL.md"),
      ["---", "description: Remote test skill.", "---", "", "# Remote Skill", ""].join("\n"),
      "utf8"
    );

    const syncResult = await cli("mfz", root, home, ["sync"], {}, "personal\n");
    expect(syncResult.stdout).not.toContain("remote-skill");
    expect(syncResult.stdout).not.toContain("Updated catalog/skills.yml");
  });

  it("lists resolved skill targets from the profile", async () => {
    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout).toContain("local-skill\topencode,claude-code\tLocal test skill.");
    expect(result.stdout).toContain("claude-skill\tclaude-code\tClaude test skill.");
    expect(result.stdout).toContain("all-skill\topencode,claude-code\tAll agents test skill.");
  });

  it("sync renders the managed snapshot and links", async () => {
    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);
    expect(result.stdout).toContain("would render skill\tlocal-skill");
    expect(result.stdout).toContain("would render skill\tmindframe-z");
    expect(result.stdout).toContain("would render skill\tskill-update-review");
    expect(result.stdout).toContain("would link skill");
    expect(result.stdout).not.toContain("skills add");
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
  });

  it("reports skill digest changes without labeling the complete snapshot as changed", async () => {
    const paths = createRuntimePaths({ root, home });
    const profile = await resolveProfile(paths, "personal");
    await syncSkillSnapshot(paths, profile, { selectedTargets: ["opencode-v2"], link: false });
    const skillPath = path.join(root, "skills", "local-skill", "SKILL.md");
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}\nChanged.\n`, "utf8");

    const changed = await syncSkillSnapshot(paths, profile, {
      selectedTargets: ["opencode-v2"],
      link: false
    });
    expect(
      changed.filter((outcome) => outcome.category === "skill" && outcome.status !== "unchanged")
    ).toMatchObject([{ target: "local-skill", status: "updated" }]);
    expect(changed).toContainEqual(
      expect.objectContaining({
        category: "bookkeeping",
        action: "snapshot",
        significance: "internal",
        status: "updated"
      })
    );

    const repeated = await syncSkillSnapshot(paths, profile, {
      selectedTargets: ["opencode-v2"],
      link: false
    });
    expect(repeated.every((outcome) => outcome.status === "unchanged")).toBe(true);
  });

  it("reports and repairs installed skill content, missing-file, and mode drift", async () => {
    const paths = createRuntimePaths({ root, home });
    const profile = await resolveProfile(paths, "personal");
    await syncSkillSnapshot(paths, profile, { selectedTargets: ["opencode-v2"], link: false });
    const sourcePath = path.join(root, "skills", "local-skill", "SKILL.md");
    const installedPath = path.join(
      configsPath(home, "personal", "opencode-v2", "skills"),
      "local-skill",
      "SKILL.md"
    );
    const manifestPath = path.join(
      configsPath(home, "personal", "opencode-v2", "skills"),
      ".mfz-manifest.yml"
    );
    const expectedBytes = await readFile(sourcePath);
    const unchangedManifest = await readFile(manifestPath);

    const assertRepair = async (): Promise<void> => {
      const outcomes = await syncSkillSnapshot(paths, profile, {
        selectedTargets: ["opencode-v2"],
        link: false
      });
      expect(
        outcomes.filter((outcome) => outcome.category === "skill" && outcome.status !== "unchanged")
      ).toMatchObject([{ target: "local-skill", status: "updated" }]);
      expect(outcomes.some(operationChanged)).toBe(true);
      expect(await readFile(installedPath)).toEqual(expectedBytes);
      expect((await lstat(installedPath)).mode & 0o777).toBe(0o644);
      expect(await readFile(manifestPath)).toEqual(unchangedManifest);
    };

    await writeFile(installedPath, "drifted\n", "utf8");
    await assertRepair();

    await rm(installedPath);
    await assertRepair();

    await chmod(installedPath, 0o755);
    await assertRepair();
  });

  it("renders the exact pinned Git commit and records provenance", async () => {
    const repository = "https://127.0.0.1:1/trusted.git";
    const { commit, newerCommit } = await seedGitCache(root, home, repository);
    await writeGitSkillProfile(root, repository, commit);

    await cli("mfz", root, home, ["skills", "sync"]);

    const snapshot = configsPath(home, "personal", "opencode-v2", "skills");
    const manifest = YAML.parse(await readFile(path.join(snapshot, ".mfz-manifest.yml"), "utf8"));
    const trusted = manifest.skills.find((skill: { name: string }) => skill.name === "trusted");
    expect(trusted).toMatchObject({
      source: "git",
      repository,
      subtree: "skills/trusted",
      commit
    });
    expect(trusted.commit).not.toBe(newerCommit);
    expect(trusted.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(path.join(snapshot, "trusted", "SKILL.md"), "utf8")).toContain(
      "description: pinned"
    );
  });

  it("does not acquire or write state for a Git cache miss during dry-run", async () => {
    const repository = "https://example.invalid/missing.git";
    const commit = "a".repeat(40);
    await writeGitSkillProfile(root, repository, commit);

    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);

    expect(result.stdout).toContain(`would acquire git commit\ttrusted\t${commit}`);
    await expect(lstat(skillCacheRoot(createRuntimePaths({ root, home })))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      lstat(configsPath(home, "personal", "opencode-v2", "skills", ".mfz-manifest.yml"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sync renders skills disabled by runtime override", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode-v2, claude-code]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, ".mindframe-z", "skill-overrides"), { recursive: true });
    await writeFile(
      path.join(home, ".mindframe-z", "skill-overrides", "opencode.json"),
      JSON.stringify({ "local-skill": false }),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);
    expect(result.stdout).toContain("would render skill\tlocal-skill");
  });

  it("toggles project skill state in the override store", async () => {
    await execa("git", ["init"], { cwd: root });
    await mkdir(path.join(root, ".opencode"), { recursive: true });
    await writeFile(
      path.join(root, ".opencode", "opencode.jsonc"),
      JSON.stringify({ permission: { webfetch: "allow" } }, null, 2) + "\n",
      "utf8"
    );
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.local.json"),
      JSON.stringify({ includeGitInstructions: true }, null, 2) + "\n",
      "utf8"
    );

    const disable = await cli(
      "mfz",
      root,
      home,
      ["skills", "disable", "local-skill", "--target", "claude-code"],
      {},
      undefined,
      root
    );
    expect(disable.stdout).toContain("Disabled local-skill for claude-code");

    const enable = await cli(
      "mfz",
      root,
      home,
      ["skills", "enable", "claude-skill", "--target", "claude-code"],
      {},
      undefined,
      root
    );
    expect(enable.stdout).toContain("Enabled claude-skill for claude-code");

    const overrides = parseJson(
      Overrides,
      await readFile(path.join(home, ".mindframe-z", "overrides.json"), "utf8")
    );
    expect(overrides.projects?.[root]?.["claude-code"]?.skills?.["local-skill"]).toBe(false);
    expect(overrides.projects?.[root]?.["claude-code"]?.skills?.["claude-skill"]).toBeUndefined();

    const opencode = parseJson(
      OpenCodePermission,
      await readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    );
    expect(opencode.permission).toEqual({ webfetch: "allow" });

    const claude = parseJson(
      ClaudeSettings,
      await readFile(path.join(root, ".claude", "settings.local.json"), "utf8")
    );
    expect(claude).toEqual({ includeGitInstructions: true });
  });

  it("rejects OpenCode V2 skill toggles", async () => {
    const outsideRepo = await makeTempDir();
    await expect(
      cli(
        "mfz",
        root,
        home,
        ["skills", "disable", "local-skill", "--target", "opencode-v2"],
        {},
        undefined,
        outsideRepo
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenCode V2 skill toggles are not supported")
    });
  });

  it("TUI saves profile-default skill state to local config files", async () => {
    const originalCwd = process.cwd();
    await execa("git", ["init"], { cwd: root });
    process.chdir(root);
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode-v2, claude-code]",
        "skills:",
        "  local-skill:",
        "    agents: { claude-code: true }",
        "  claude-skill:",
        "    agents: { claude-code: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    const paths = createRuntimePaths({ root, home });
    const profile = await resolveProfile(paths, "personal");
    const input = new PassThrough();
    const promise = runSkillsTui(paths, profile, { input, output: sink() });

    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write(" \r");
    input.end();
    try {
      await promise;
    } finally {
      process.chdir(originalCwd);
    }

    const overrides = parseJson(
      Overrides,
      await readFile(path.join(home, ".mindframe-z", "overrides.json"), "utf8")
    );
    expect(overrides.projects?.[root]?.["claude-code"]?.skills?.["claude-skill"]).toBe(false);
    await expect(
      readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      readFile(path.join(root, ".claude", "settings.local.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects enable/disable on non-toggleable skill", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode-v2, claude-code]",
        "skills:",
        "  local-skill:",
        "    agents: { claude-code: true }",
        "    toggleable: false",
        ""
      ].join("\n"),
      "utf8"
    );

    const enableErr = await cli("mfz", root, home, ["skills", "enable", "local-skill"]).catch(
      (e) => e
    );
    expect(enableErr.stderr).toContain('Skill "local-skill" is not toggleable');

    const disableErr = await cli("mfz", root, home, ["skills", "disable", "local-skill"]).catch(
      (e) => e
    );
    expect(disableErr.stderr).toContain('Skill "local-skill" is not toggleable');
  });
});
