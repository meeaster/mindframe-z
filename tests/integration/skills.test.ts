import { chmod, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execa } from "execa";
import YAML from "yaml";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimePaths, providerSkillSnapshotDir } from "../../src/core/paths.js";
import { resolveProfile } from "../../src/core/profile.js";
import { operationChanged } from "../../src/core/operations.js";
import { syncSkillSnapshot } from "../../src/skills/snapshot.js";
import { runSkillsTui } from "../../src/tui/skills-tui.js";
import {
  cli,
  configsPath,
  makeTempDir,
  parseJson,
  providerVariantTargets,
  setupIntegrationFixture,
  sink,
  writeProviderVariantSkill
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

async function vendoredUpstream(name: string): Promise<{ root: string; commit: string }> {
  const root = await makeTempDir();
  await execa("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execa("git", ["config", "user.name", "Mindframe Test"], { cwd: root });
  const source = path.join(root, "skills", name);
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "SKILL.md"),
    `---\nname: ${name}\ndescription: New vendored skill.\n---\n\n# ${name}\n`,
    "utf8"
  );
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["commit", "-qm", "add skill"], { cwd: root });
  const { stdout: commit } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });

  return { root, commit };
}

async function gitFetchShim(remote: string): Promise<string> {
  const bin = await makeTempDir();
  const shim = path.join(bin, "git");
  await writeFile(
    shim,
    [
      "#!/usr/bin/env node",
      'import { spawnSync } from "node:child_process";',
      `const remote = ${JSON.stringify(remote)};`,
      'process.env.GIT_PROTOCOL_FROM_USER = "1";',
      "const args = process.argv.slice(2);",
      'const fetchIndex = args.indexOf("fetch");',
      "if (fetchIndex >= 0) {",
      '  const originIndex = args.indexOf("origin", fetchIndex + 1);',
      "  if (originIndex >= 0) {",
      "    args[originIndex] = remote;",
      "    for (let index = fetchIndex - 1; index >= 0; index -= 1) {",
      '      if (args[index] === "-c" && args[index + 1]?.startsWith("protocol.")) {',
      "        args.splice(index, 2);",
      "      }",
      "    }",
      "  }",
      "}",
      'const result = spawnSync("/usr/bin/git", args, { stdio: "inherit" });',
      "if (result.error) {",
      "  console.error(result.error);",
      "  process.exit(1);",
      "}",
      "process.exit(result.status ?? 1);",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(shim, 0o755);

  return bin;
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
    expect(result.stdout.trim().split("\n")).toEqual([
      "# MFZ managed",
      "all-skill\tclaude-code,opencode",
      "claude-skill\tclaude-code",
      "local-skill\tclaude-code,opencode",
      "# Other global skills",
      "# (none)"
    ]);
    expect(result.stdout).not.toContain("Local test skill.");
    expect(result.stdout).not.toContain("Claude test skill.");
    expect(result.stdout).not.toContain("All agents test skill.");
  });

  it("stages and promotes a new vendored declaration before activation", async () => {
    const name = "new-vendor";
    const repository = "https://example.invalid/skills.git";
    const upstream = await vendoredUpstream(name);
    const shim = await gitFetchShim(upstream.root);
    const skillsPath = path.join(root, "catalog", "skills.yml");
    const profilePath = path.join(root, "profiles", "personal", "profile.yml");
    await writeFile(
      skillsPath,
      `${(await readFile(skillsPath, "utf8")).trimEnd()}\n  - name: ${name}\n    source: vendored\n    repo: ${repository}\n    ref: main\n    subtree: skills/${name}\n`,
      "utf8"
    );
    await writeFile(
      profilePath,
      (await readFile(profilePath, "utf8")).replace(
        "mcp:\n",
        `  ${name}:\n    agents: { opencode: true }\nmcp:\n`
      ),
      "utf8"
    );

    const check = await cli("mfz", root, home, ["skills", "check", name]);
    expect(check.stdout).toContain(
      `unpromoted\t${name}\tpinned=none\tnext=mfz skills stage ${name}`
    );
    await expect(resolveProfile(createRuntimePaths({ root, home }), "personal")).rejects.toThrow(
      /vendor\.lock\.yml/
    );

    const stage = await cli(
      "mfz",
      root,
      home,
      ["skills", "stage", name, "--commit", upstream.commit],
      { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ""}` }
    );

    const candidate = /^candidate\t([0-9a-f]{64})$/mu.exec(stage.stdout)?.[1];

    if (!candidate) throw new Error("stage did not return a candidate identity");

    expect(stage.stdout).toContain(`provenance\tnone -> ${upstream.commit}`);
    expect(stage.stdout).not.toContain("migration");
    await expect(lstat(path.join(root, "skills", "vendor", name))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(lstat(path.join(root, "skills", "vendor.lock.yml"))).rejects.toMatchObject({
      code: "ENOENT"
    });

    await cli("mfz", root, home, ["skills", "promote", candidate]);

    await expect(
      readFile(path.join(root, "skills", "vendor", name, "SKILL.md"), "utf8")
    ).resolves.toContain("New vendored skill.");
    const lock = YAML.parse(await readFile(path.join(root, "skills", "vendor.lock.yml"), "utf8"));
    expect(lock.skills[name].commit).toBe(upstream.commit);
    await expect(resolveProfile(createRuntimePaths({ root, home }), "personal")).resolves.toEqual(
      expect.objectContaining({
        enabledSkills: expect.arrayContaining([
          expect.objectContaining({ name, source: "vendored" })
        ])
      })
    );
  });

  it("sync renders the managed snapshot and links", async () => {
    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);
    expect(result.stdout).toContain("would render skill\tlocal-skill");
    expect(result.stdout).toContain("would render skill\tmindframe-z");
    expect(result.stdout).not.toContain("skill-update-review");
    expect(result.stdout).toContain("would link skill");
    expect(result.stdout).not.toContain("skills add");
  });

  it("renders each provider variant under the logical skill name", async () => {
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

    const paths = createRuntimePaths({ root, home });
    await cli("mfz", root, home, ["skills", "sync"]);

    for (const target of providerVariantTargets) {
      const snapshot = providerSkillSnapshotDir(paths, "personal", target);
      await expect(readFile(path.join(snapshot, name, "SKILL.md"), "utf8")).resolves.toBe(
        fixture.contents[target]
      );
      const manifest = YAML.parse(await readFile(path.join(snapshot, ".mfz-manifest.yml"), "utf8"));
      expect(manifest.skills.find((skill: { name: string }) => skill.name === name)).toMatchObject({
        name,
        source: "vendored",
        variant: target,
        targets: [target]
      });
    }

    await expect(lstat(configsPath(home, "personal", "skills", name))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(lstat(path.join(paths.claudeDir, "skills", name))).resolves.toBeTruthy();
    await expect(lstat(path.join(home, ".agents", "skills", name))).resolves.toBeTruthy();
    await expect(lstat(path.join(paths.opencodeConfigDir, "skills", name))).resolves.toBeTruthy();

    const observeProviderSnapshot = async (target: (typeof providerVariantTargets)[number]) => {
      const snapshot = providerSkillSnapshotDir(paths, "personal", target);
      const manifestPath = path.join(snapshot, ".mfz-manifest.yml");
      const skillPath = path.join(snapshot, name, "SKILL.md");

      const linkPath =
        target === "claude-code"
          ? path.join(paths.claudeDir, "skills", name)
          : target === "codex"
            ? path.join(home, ".agents", "skills", name)
            : path.join(paths.opencodeConfigDir, "skills", name);

      const [snapshotStat, manifestStat, skillStat, linkStat] = await Promise.all([
        lstat(snapshot),
        lstat(manifestPath),
        lstat(skillPath),
        lstat(linkPath)
      ]);

      return {
        snapshot: { dev: snapshotStat.dev, ino: snapshotStat.ino },
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
        },
        link: {
          dev: linkStat.dev,
          ino: linkStat.ino,
          mtimeMs: linkStat.mtimeMs,
          content: await readFile(path.join(linkPath, "SKILL.md")),
          destination: await readlink(linkPath)
        }
      };
    };

    const initialState = await Promise.all(
      providerVariantTargets.map(async (target) => ({
        target,
        state: await observeProviderSnapshot(target)
      }))
    );

    const resolved = await resolveProfile(paths, "personal");

    const repeated = await syncSkillSnapshot(paths, resolved, {
      selectedTargets: providerVariantTargets,
      link: true
    });

    expect(repeated.length).toBeGreaterThan(0);
    expect(repeated.every((outcome) => outcome.status === "unchanged")).toBe(true);

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
      expect(await observeProviderSnapshot(target)).toEqual(state);
    }

    const skillsSource = await readFile(skillsPath, "utf8");
    await writeFile(skillsPath, skillsSource.replace("    ref: main", "    ref: stable"), "utf8");
    const provenanceProfile = await resolveProfile(paths, "personal");

    const provenanceChanged = await syncSkillSnapshot(paths, provenanceProfile, {
      selectedTargets: providerVariantTargets,
      link: true
    });

    expect(provenanceChanged.length).toBeGreaterThan(0);

    for (const target of providerVariantTargets) {
      const snapshot = providerSkillSnapshotDir(paths, "personal", target);
      expect(provenanceChanged).toContainEqual(
        expect.objectContaining({
          category: "bookkeeping",
          action: "snapshot",
          status: "updated",
          significance: "internal",
          target: snapshot
        })
      );
      const manifest = YAML.parse(await readFile(path.join(snapshot, ".mfz-manifest.yml"), "utf8"));
      expect(manifest.skills.find((skill: { name: string }) => skill.name === name)).toMatchObject({
        name,
        ref: "stable",
        digest: fixture.digests[target]
      });

      expect(await readFile(path.join(snapshot, name, "SKILL.md"), "utf8")).toBe(
        fixture.contents[target]
      );
    }

    const provenanceState = await Promise.all(
      providerVariantTargets.map(async (target) => ({
        target,
        state: await observeProviderSnapshot(target)
      }))
    );

    const provenanceRepeated = await syncSkillSnapshot(paths, provenanceProfile, {
      selectedTargets: providerVariantTargets,
      link: true
    });

    expect(provenanceRepeated.length).toBeGreaterThan(0);
    expect(provenanceRepeated.every((outcome) => outcome.status === "unchanged")).toBe(true);

    for (const { target, state } of provenanceState) {
      expect(provenanceRepeated).toContainEqual(
        expect.objectContaining({
          category: "bookkeeping",
          action: "snapshot",
          status: "unchanged",
          significance: "internal",
          target: providerSkillSnapshotDir(paths, "personal", target)
        })
      );
      expect(await observeProviderSnapshot(target)).toEqual(state);
    }
  });

  it("reports skill digest changes without labeling the complete snapshot as changed", async () => {
    const paths = createRuntimePaths({ root, home });
    const profile = await resolveProfile(paths, "personal");
    await syncSkillSnapshot(paths, profile, { selectedTargets: ["opencode"], link: false });
    const skillPath = path.join(root, "skills", "local-skill", "SKILL.md");
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}\nChanged.\n`, "utf8");

    const changed = await syncSkillSnapshot(paths, profile, {
      selectedTargets: ["opencode"],
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
      selectedTargets: ["opencode"],
      link: false
    });

    expect(repeated.every((outcome) => outcome.status === "unchanged")).toBe(true);
  });

  it("reports and repairs installed skill content, missing-file, and mode drift", async () => {
    const paths = createRuntimePaths({ root, home });
    const profile = await resolveProfile(paths, "personal");
    await syncSkillSnapshot(paths, profile, { selectedTargets: ["opencode"], link: false });
    const sourcePath = path.join(root, "skills", "local-skill", "SKILL.md");

    const installedPath = path.join(
      configsPath(home, "personal", "opencode", "skills"),
      "local-skill",
      "SKILL.md"
    );

    const manifestPath = path.join(
      configsPath(home, "personal", "opencode", "skills"),
      ".mfz-manifest.yml"
    );

    const expectedBytes = await readFile(sourcePath);
    const unchangedManifest = await readFile(manifestPath);

    const assertRepair = async (): Promise<void> => {
      const outcomes = await syncSkillSnapshot(paths, profile, {
        selectedTargets: ["opencode"],
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

  it("sync renders skills disabled by runtime override", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, claude-code]",
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

  it("rejects OpenCode skill toggles", async () => {
    const outsideRepo = await makeTempDir();
    await expect(
      cli(
        "mfz",
        root,
        home,
        ["skills", "disable", "local-skill", "--target", "opencode"],
        {},
        undefined,
        outsideRepo
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenCode skill toggles are not supported")
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
        "agents: [opencode, claude-code]",
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
        "agents: [opencode, claude-code]",
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
