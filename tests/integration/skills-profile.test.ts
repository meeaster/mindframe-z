import { mkdir, writeFile } from "node:fs/promises";
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

  it("lists skills for declared agents", async () => {
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
    expect(result.stdout).toContain("local-skill\topencode\tLocal test skill.");
    expect(result.stdout).toContain("all-skill\topencode\tAll agents test skill.");
    expect(result.stdout).not.toContain("claude-code");
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
    expect(result.stdout).toContain("local-skill\tclaude-code\tLocal test skill.");
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
