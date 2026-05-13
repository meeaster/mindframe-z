import { describe, expect, it } from "vitest";
import { buildNpxSkillsCommand } from "./npx-skills.js";

describe("buildNpxSkillsCommand", () => {
  it("builds local skill install commands", () => {
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
        name: "impeccable",
        source: "local",
        path: "~/skills/impeccable",
        description: "",
        targets: ["opencode", "claude-code"],
        installer: "npx-skills"
      },
      "opencode"
    );

    expect(command).toEqual([
      "npx",
      "skills",
      "add",
      "/home/tester/skills/impeccable",
      "-a",
      "opencode",
      "-g",
      "-y"
    ]);
  });

  it("builds local parent directory commands with a selected skill", () => {
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
        path: "~/code/mindframe-z/skills",
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
      "/home/tester/code/mindframe-z/skills",
      "--skill",
      "mise",
      "-a",
      "opencode",
      "-g",
      "-y"
    ]);
  });
});
