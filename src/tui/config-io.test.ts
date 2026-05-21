import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import { writeLocalSkillOverrides } from "./config-io.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mindframe-z-config-io-"));
}

function paths(root: string): RuntimePaths {
  return {
    root,
    home: path.join(root, "home"),
    configsDir: path.join(root, "configs"),
    opencodeConfigDir: path.join(root, ".config", "opencode"),
    claudeDir: path.join(root, ".claude"),
    miseConfigDir: path.join(root, ".config", "mise"),
  };
}

describe("writeLocalSkillOverrides git exclusion", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  it("adds .opencode/opencode.jsonc to .git/info/exclude", async () => {
    await mkdir(path.join(root, ".git", "info"), { recursive: true });
    await writeFile(path.join(root, ".git", "info", "exclude"), "# git exclude\n", "utf8");

    await writeLocalSkillOverrides(paths(root), "opencode", { "test-skill": true });

    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".opencode/opencode.jsonc");
  });

  it("adds .claude/settings.local.json to .git/info/exclude", async () => {
    await mkdir(path.join(root, ".git", "info"), { recursive: true });
    await writeFile(path.join(root, ".git", "info", "exclude"), "# git exclude\n", "utf8");

    await writeLocalSkillOverrides(paths(root), "claude-code", { "test-skill": true });

    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".claude/settings.local.json");
  });

  it("does not duplicate entries on repeated calls", async () => {
    await mkdir(path.join(root, ".git", "info"), { recursive: true });
    await writeFile(path.join(root, ".git", "info", "exclude"), "# git exclude\n", "utf8");

    await writeLocalSkillOverrides(paths(root), "opencode", { "test-skill": true });
    await writeLocalSkillOverrides(paths(root), "opencode", { "test-skill": true });
    await writeLocalSkillOverrides(paths(root), "opencode", { "test-skill": false });

    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    const matches = exclude.match(/\.opencode\/opencode\.jsonc/g);
    expect(matches).toHaveLength(1);
  });

  it("does not throw when .git does not exist", async () => {
    await expect(
      writeLocalSkillOverrides(paths(root), "opencode", { "test-skill": true })
    ).resolves.toBeUndefined();
  });

  it("does not throw when .git exists but info/exclude does not", async () => {
    await mkdir(path.join(root, ".git"), { recursive: true });

    await expect(
      writeLocalSkillOverrides(paths(root), "opencode", { "test-skill": true })
    ).resolves.toBeUndefined();
  });
});
