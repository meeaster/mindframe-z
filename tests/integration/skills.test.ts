import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimePaths } from "../../src/core/paths.js";
import { resolveProfile } from "../../src/core/profile.js";
import { runSkillsTui } from "../../src/tui/skills-tui.js";
import { cli, makeTempDir, setupIntegrationFixture, sink } from "./support.js";

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

  it("sync renders skills disabled by runtime override", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
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
      ["skills", "disable", "local-skill", "--target", "opencode"],
      {},
      undefined,
      root
    );
    expect(disable.stdout).toContain("Disabled local-skill for opencode");

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

    const overrides = JSON.parse(
      await readFile(path.join(home, ".mindframe-z", "overrides.json"), "utf8")
    ) as {
      projects?: Record<
        string,
        {
          opencode?: { skills?: Record<string, boolean> };
          "claude-code"?: { skills?: Record<string, boolean> };
        }
      >;
    };
    expect(overrides.projects?.[root]?.opencode?.skills?.["local-skill"]).toBe(false);
    expect(overrides.projects?.[root]?.["claude-code"]?.skills?.["claude-skill"]).toBeUndefined();

    const opencode = JSON.parse(
      await readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    ) as {
      permission?: Record<string, unknown>;
    };
    expect(opencode.permission).toEqual({ webfetch: "allow" });

    const claude = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.local.json"), "utf8")
    ) as Record<string, unknown>;
    expect(claude).toEqual({ includeGitInstructions: true });
  });

  it("preserves global OpenCode skill toggles across apply", async () => {
    const outsideRepo = await makeTempDir();
    await cli(
      "mfz",
      root,
      home,
      ["skills", "disable", "local-skill", "--target", "opencode"],
      {},
      undefined,
      outsideRepo
    );

    await cli("mfz", root, home, ["apply", "--target", "opencode"]);
    const globalConfigPath = path.join(home, ".config", "opencode", "opencode.jsonc");
    const updated = JSON.parse(await readFile(globalConfigPath, "utf8")) as {
      permission?: { skill?: Record<string, string> };
    };
    expect(updated.permission?.skill?.["local-skill"]).toBe("deny");
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
        "    agents: { opencode: true }",
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

    input.write(" \r");
    input.end();
    try {
      await promise;
    } finally {
      process.chdir(originalCwd);
    }

    const overrides = JSON.parse(
      await readFile(path.join(home, ".mindframe-z", "overrides.json"), "utf8")
    ) as { projects?: Record<string, { opencode?: { skills?: Record<string, boolean> } }> };
    expect(overrides.projects?.[root]?.opencode?.skills?.["local-skill"]).toBe(false);
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
        "agents: [opencode]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true }",
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
