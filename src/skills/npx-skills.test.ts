import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import {
  buildNpxSkillsCommand,
  buildNpxSkillsRemoveCommand,
  buildNpxSkillsUpdateCommand,
  listInstalledSkills
} from "./npx-skills.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildNpxSkillsCommand", () => {
  it("builds local skill commands from repo skills directory", () => {
    const command = buildNpxSkillsCommand(
      {
        root: "/repo",
        home: "/home/tester",
        configsDir: "/repo/configs",
        opencodeConfigDir: "/home/tester/.config/opencode",
        claudeDir: "/home/tester/.claude",
        miseConfigDir: "/home/tester/.config/mise"
      },
      {
        name: "mise",
        source: "local",
        skill: "mise",
        description: "",
        installer: "npx-skills"
      },
      "opencode"
    );

    expect(command).toEqual([
      "npx",
      "skills",
      "add",
      "/repo/skills",
      "--skill",
      "mise",
      "-a",
      "opencode",
      "-g",
      "-y"
    ]);
  });

  it("builds git skill install commands", () => {
    const command = buildNpxSkillsCommand(
      {
        root: "/repo",
        home: "/home/tester",
        configsDir: "/repo/configs",
        opencodeConfigDir: "/home/tester/.config/opencode",
        claudeDir: "/home/tester/.claude",
        miseConfigDir: "/home/tester/.config/mise"
      },
      {
        name: "skill-writer",
        source: "git",
        repo: "https://github.com/getsentry/skills",
        skill: "skill-writer",
        description: "",
        installer: "npx-skills"
      },
      "opencode"
    );

    expect(command).toEqual([
      "npx",
      "skills",
      "add",
      "https://github.com/getsentry/skills",
      "--skill",
      "skill-writer",
      "-a",
      "opencode",
      "-g",
      "-y"
    ]);
  });
});

describe("buildNpxSkillsUpdateCommand", () => {
  it("returns null for local skills", () => {
    const command = buildNpxSkillsUpdateCommand({
      name: "mise",
      source: "local",
      skill: "mise",
      description: "",
      installer: "npx-skills"
    });

    expect(command).toBeNull();
  });

  it("builds git skill update commands", () => {
    const command = buildNpxSkillsUpdateCommand({
      name: "skill-writer",
      source: "git",
      repo: "https://github.com/getsentry/skills",
      skill: "skill-writer",
      description: "",
      installer: "npx-skills"
    });

    expect(command).toEqual(["npx", "skills", "update", "skill-writer", "-g", "-y"]);
  });
});

describe("buildNpxSkillsRemoveCommand", () => {
  it("builds global remove command for a named skill", () => {
    const command = buildNpxSkillsRemoveCommand({
      name: "mise",
      source: "local",
      skill: "mise",
      description: "",
      installer: "npx-skills"
    });

    expect(command).toEqual(["npx", "skills", "remove", "mise", "-g", "-y"]);
  });

  it("builds remove command for git skill", () => {
    const command = buildNpxSkillsRemoveCommand({
      name: "skill-writer",
      source: "git",
      repo: "https://github.com/getsentry/skills",
      skill: "skill-writer",
      description: "",
      installer: "npx-skills"
    });

    expect(command).toEqual(["npx", "skills", "remove", "skill-writer", "-g", "-y"]);
  });

  it("builds target-specific remove command for Claude Code", () => {
    const command = buildNpxSkillsRemoveCommand(
      {
        name: "skill-writer",
        source: "git",
        repo: "https://github.com/getsentry/skills",
        skill: "skill-writer",
        description: "",
        installer: "npx-skills"
      },
      "claude-code"
    );

    expect(command).toEqual([
      "npx",
      "skills",
      "remove",
      "skill-writer",
      "-g",
      "-a",
      "claude-code",
      "-y"
    ]);
  });
});

describe("listInstalledSkills", () => {
  it("treats canonical .agents skills as installed for OpenCode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-skills-"));
    const opencodeSkillDir = path.join(home, ".agents", "skills", "jira-writer");
    await mkdir(opencodeSkillDir, { recursive: true });
    await writeFile(path.join(opencodeSkillDir, "SKILL.md"), "# Jira Writer\n", "utf8");

    const installed = await listInstalledSkills(
      {
        root: "/repo",
        home,
        configsDir: "/repo/configs",
        opencodeConfigDir: path.join(home, ".config", "opencode"),
        claudeDir: path.join(home, ".claude"),
        miseConfigDir: path.join(home, ".config", "mise")
      },
      "opencode"
    );

    expect(installed.has("jira-writer")).toBe(true);
  });

  it("uses Claude directory and CLI agent attribution for Claude Code", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-skills-"));
    const claudeSkillDir = path.join(home, ".claude", "skills", "context7-mcp");
    await mkdir(claudeSkillDir, { recursive: true });
    await writeFile(path.join(claudeSkillDir, "SKILL.md"), "# Context7\n", "utf8");
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify([
        { name: "pr-writer", agents: ["Claude Code"] },
        { name: "jira-writer", agents: ["OpenCode"] }
      ])
    } as Awaited<ReturnType<typeof execa>>);

    const installed = await listInstalledSkills(
      {
        root: "/repo",
        home,
        configsDir: "/repo/configs",
        opencodeConfigDir: path.join(home, ".config", "opencode"),
        claudeDir: path.join(home, ".claude"),
        miseConfigDir: path.join(home, ".config", "mise")
      },
      "claude-code"
    );

    expect(installed.has("context7-mcp")).toBe(true);
    expect(installed.has("pr-writer")).toBe(true);
    expect(installed.has("jira-writer")).toBe(false);
  });
});
