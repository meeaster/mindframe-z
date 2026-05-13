import { describe, expect, it } from "vitest";
import { buildNpxSkillsCommand } from "./npx-skills.js";

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
        targets: ["opencode"],
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
        targets: ["opencode"],
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
