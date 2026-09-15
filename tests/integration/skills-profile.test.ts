import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, setupIntegrationFixture } from "./support.js";

describe("skills profile integration", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    ({ root, home } = await setupIntegrationFixture());
  });

  afterEach(() => {
    root = "";
    home = "";
  });

  it("lists skills and targets without descriptions by default", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true }",
        "  all-skill:",
        "    agents: { opencode: true }",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout.trim().split("\n")).toEqual([
      "# MFZ managed",
      "all-skill\topencode",
      "local-skill\topencode",
      "# Other global skills",
      "# (none)"
    ]);
    expect(result.stdout).not.toContain("Local test skill.");
    expect(result.stdout).not.toContain("All agents test skill.");
    expect(result.stdout).not.toContain("claude-code");
    expect(result.stdout).not.toContain(String.fromCharCode(27));
    expect(result.stdout).not.toContain(String.fromCharCode(155));
  });

  it("includes descriptions in verbose output", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true }",
        "  all-skill:",
        "    agents: { opencode: true }",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "list", "--verbose"]);
    expect(result.stdout.trim().split("\n")).toEqual([
      "# MFZ managed",
      "all-skill\topencode\tAll agents test skill.",
      "local-skill\topencode\tLocal test skill.",
      "# Other global skills",
      "# (none)"
    ]);
  });

  it("advertises verbose skill descriptions in help", async () => {
    const result = await cli("mfz", root, home, ["skills", "list", "--help"]);

    expect(result.stdout).toContain("--verbose");
    expect(result.stdout).toContain("show skill descriptions");
    expect(result.stdout).toContain("List profile-managed and other global skills");
  });

  it("lists managed and other global skills in separate deterministic sections", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode, claude-code, codex]",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: true, claude-code: true, codex: true }",
        "  claude-skill:",
        "    agents: { claude-code: true }",
        "  all-skill:",
        "    agents: { opencode: true, claude-code: true }",
        ""
      ].join("\n"),
      "utf8"
    );

    const agentsSkills = path.join(home, ".agents", "skills");
    const claudeSkills = path.join(home, ".claude", "skills");
    const opencodeSkills = path.join(home, ".config", "opencode", "skills");

    await mkdir(agentsSkills, { recursive: true });
    await mkdir(claudeSkills, { recursive: true });
    await mkdir(opencodeSkills, { recursive: true });

    const managedLink = path.join(agentsSkills, "local-skill");

    const managedTarget = path.join(
      home,
      ".mindframe-z",
      "configs",
      "personal",
      "skills",
      "local-skill"
    );

    await symlink(path.relative(path.dirname(managedLink), managedTarget), managedLink);

    await mkdir(path.join(claudeSkills, "local-skill"), { recursive: true });
    await writeFile(
      path.join(claudeSkills, "local-skill", "SKILL.md"),
      "---\ndescription: Independent local skill.\n---\n",
      "utf8"
    );
    await mkdir(path.join(agentsSkills, "global-only"), { recursive: true });
    await writeFile(
      path.join(agentsSkills, "global-only", "SKILL.md"),
      "---\ndescription: Global-only skill.\n---\n",
      "utf8"
    );

    for (const directory of [agentsSkills, claudeSkills, opencodeSkills]) {
      await mkdir(path.join(directory, "shared-global"), { recursive: true });
    }

    await writeFile(
      path.join(agentsSkills, "shared-global", "SKILL.md"),
      "---\ndescription: Shared global skill.\n---\n",
      "utf8"
    );
    await mkdir(path.join(claudeSkills, "missing-global"), { recursive: true });
    await mkdir(path.join(opencodeSkills, "malformed-global"), { recursive: true });
    await writeFile(
      path.join(opencodeSkills, "malformed-global", "SKILL.md"),
      "---\ndescription: [unclosed\n---\n",
      "utf8"
    );
    await mkdir(path.join(opencodeSkills, ".internal"), { recursive: true });
    await writeFile(path.join(agentsSkills, "not-a-skill"), "file\n", "utf8");

    await mkdir(path.join(home, ".codex", "skills", "ignored-codex"), { recursive: true });
    await mkdir(path.join(home, ".opencode", "skills", "ignored-opencode"), { recursive: true });
    await mkdir(path.join(home, ".mindframe-z", "configs", "personal", "skills", "snapshot-only"), {
      recursive: true
    });
    await mkdir(path.join(root, ".claude", "skills", "project-only"), { recursive: true });

    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout.trim().split("\n")).toEqual([
      "# MFZ managed",
      "all-skill\tclaude-code,opencode",
      "claude-skill\tclaude-code",
      "local-skill\tagents,claude-code,opencode",
      "# Other global skills",
      "global-only\tagents",
      "local-skill\tclaude-code",
      "malformed-global\topencode",
      "missing-global\tclaude-code",
      "shared-global\tagents,claude-code,opencode"
    ]);
    expect(result.stdout).not.toContain("ignored-codex");
    expect(result.stdout).not.toContain("ignored-opencode");
    expect(result.stdout).not.toContain("snapshot-only");
    expect(result.stdout).not.toContain("project-only");
    expect(result.stdout).not.toContain(String.fromCharCode(27));
    expect(result.stdout).not.toContain(String.fromCharCode(155));

    const verbose = await cli("mfz", root, home, ["skills", "list", "--verbose"]);
    expect(verbose.stdout.trim().split("\n")).toEqual([
      "# MFZ managed",
      "all-skill\tclaude-code,opencode\tAll agents test skill.",
      "claude-skill\tclaude-code\tClaude test skill.",
      "local-skill\tagents,claude-code,opencode\tLocal test skill.",
      "# Other global skills",
      "global-only\tagents\tGlobal-only skill.",
      "local-skill\tclaude-code\tIndependent local skill.",
      "malformed-global\topencode",
      "missing-global\tclaude-code",
      "shared-global\tagents,claude-code,opencode\tShared global skill."
    ]);
  });

  it("sync preserves unmanaged skill entries", async () => {
    await mkdir(path.join(home, ".agents", "skills", "extra-skill"), { recursive: true });
    await writeFile(
      path.join(home, ".agents", "skills", "extra-skill", "SKILL.md"),
      "# Extra\n",
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "sync", "--dry-run"]);
    expect(result.stdout).not.toContain("extra-skill");
    expect(result.stdout).toContain("would render skill");
  });

  it("replaces upgrade with lifecycle guidance", async () => {
    const result = await cli("mfz", root, home, ["skills", "upgrade"]).catch((error) => error);
    expect(result.stderr).toContain("mfz skills upgrade was removed");
    expect(result.stderr).toContain("mfz skills check");
  });

  it("deep merges inherited skill config", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "skills:",
        "  local-skill:",
        "    agents: { claude-code: true }",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "profiles", "base", "profile.yml"),
      [
        "name: base",
        "skills:",
        "  local-skill:",
        "    agents: { opencode: false, claude-code: false }",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["skills", "list"]);
    expect(result.stdout.split("\n")).toContain("local-skill\tclaude-code");
  });

  it("rejects legacy empty skill target arrays", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      ["name: personal", "extends: base", "skills:", "  local-skill: []", ""].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✗\tprofiles/personal/profile.yml");
  });

  it("rejects legacy null skill entries", async () => {
    await writeFile(
      path.join(root, "profiles", "personal", "profile.yml"),
      [
        "name: personal",
        "extends: base",
        "agents: [opencode]",
        "skills:",
        "  local-skill:",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await cli("mfz", root, home, ["doctor"]);
    expect(result.stdout).toContain("manifest:✗\tprofiles/personal/profile.yml");
  });
});
