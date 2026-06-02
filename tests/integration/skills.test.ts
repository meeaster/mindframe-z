import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimePaths } from "../../src/core/paths.js";
import { resolveProfile } from "../../src/core/profile.js";
import { runSkillsTui } from "../../src/tui/skills-tui.js";
import { cli, makeTempDir, sink, writeFixture } from "./support.js";

describe("skill CLI integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await makeTempDir();
    home = await makeTempDir();
    await writeFixture(root, home);
  });

  afterEach(() => {
    delete process.env.MFZ_ROOT;
    delete process.env.MFZ_HOME;
  });

  it("sync detects unmanaged git skills and promotes them to the chosen profile", async () => {
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
    expect(syncResult.stdout).toContain(
      "Unmanaged skill: remote-skill (https://github.com/example/skills)"
    );
    expect(syncResult.stdout).toContain("Updated shared/skills.yml");
    expect(syncResult.stdout).toContain("Updated personal/profile.yml: skills.remote-skill");

    const skillsYaml = await readFile(path.join(root, "shared", "skills.yml"), "utf8");
    expect(skillsYaml).toContain("name: remote-skill");
    expect(skillsYaml).toContain("repo: https://github.com/example/skills");
    expect(skillsYaml).toContain("skill: remote-skill");
    expect(skillsYaml).toContain("description: Remote test skill.");
    expect(skillsYaml).not.toContain("targets:");
    expect(skillsYaml).toContain("installer: skills");

    const profileYaml = await readFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      "utf8"
    );
    expect(profileYaml).toContain("local-skill:");
    expect(profileYaml).toContain("remote-skill:");
    expect(profileYaml).toContain("- opencode");
  });

  it("lists resolved skill targets from the profile", async () => {
    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout).toContain("local-skill\topencode,claude-code\tLocal test skill.");
    expect(result.stdout).toContain("claude-skill\tclaude-code\tClaude test skill.");
    expect(result.stdout).toContain("all-skill\topencode,claude-code\tAll agents test skill.");
  });

  it("sync installs missing skills and removes extra skills", async () => {
    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);
    const addLines = result.stdout.split("\n").filter((line) => line.includes("skills add"));
    expect(addLines).toHaveLength(5);
    expect(addLines.filter((line) => line.includes("-a opencode -g -y"))).toHaveLength(2);
    expect(addLines.filter((line) => line.includes("-a claude-code -g -y"))).toHaveLength(3);
  });

  it("sync installs disabled profile skills", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "skills:",
        "  local-skill:",
        "    enabled: false",
        "    targets: [opencode]",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);
    expect(result.stdout).toContain("skills add");
    expect(result.stdout).toContain("-a opencode -g -y");
  });

  it("toggles skill state in local OpenCode and Claude Code config", async () => {
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

    const opencode = JSON.parse(
      await readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    ) as { permission?: Record<string, unknown> };
    expect(opencode.permission).toMatchObject({
      webfetch: "allow",
      skill: { "local-skill": "deny" }
    });

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
        "    enabled: false",
        "  claude-skill:",
        "    enabled: true",
        "    targets: [claude-code]",
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

    const opencode = JSON.parse(
      await readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    ) as { permission?: { skill?: Record<string, string> } };
    expect(opencode.permission?.skill?.["local-skill"]).toBe("allow");

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
        "    enabled: true",
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
