import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import { readOtherGlobalSkills } from "./global-inventory.js";

function runtimePaths(home: string): RuntimePaths {
  return {
    root: path.join(home, "root"),
    home,
    workRoot: path.join(home, ".mindframe-z", "work", "v1"),
    workUnitsRoot: path.join(home, ".mindframe-z", "work", "v1", "units"),
    configsDir: path.join(home, ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

function globalSkillPath(paths: RuntimePaths, target: "agents" | "claude-code" | "opencode") {
  return target === "agents"
    ? path.join(paths.home, ".agents", "skills")
    : target === "claude-code"
      ? path.join(paths.claudeDir, "skills")
      : path.join(paths.opencodeConfigDir, "skills");
}

async function writeSkill(directory: string, name: string, content?: string): Promise<void> {
  const skill = path.join(directory, name);
  await mkdir(skill, { recursive: true });

  if (content !== undefined) await writeFile(path.join(skill, "SKILL.md"), content, "utf8");
}

describe("readOtherGlobalSkills", () => {
  it("treats missing canonical global directories as empty", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-global-inventory-"));

    await expect(readOtherGlobalSkills(runtimePaths(home))).resolves.toEqual([]);
  });

  it("filters managed links and non-skills while aggregating external entries", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-global-inventory-"));
    const paths = runtimePaths(home);
    const agentsSkills = globalSkillPath(paths, "agents");
    const claudeSkills = globalSkillPath(paths, "claude-code");
    const opencodeSkills = globalSkillPath(paths, "opencode");
    const managedRoot = path.join(paths.configsDir, "personal", "skills");
    const externalRoot = path.join(home, "external-skills");

    await mkdir(agentsSkills, { recursive: true });
    await mkdir(claudeSkills, { recursive: true });
    await mkdir(opencodeSkills, { recursive: true });
    await mkdir(path.join(managedRoot, "managed-live"), { recursive: true });
    await mkdir(path.join(externalRoot, "external-link"), { recursive: true });
    await writeFile(
      path.join(externalRoot, "external-link", "SKILL.md"),
      "---\ndescription: External link\n---\n",
      "utf8"
    );

    await symlink(
      path.relative(agentsSkills, path.join(managedRoot, "managed-live")),
      path.join(agentsSkills, "managed-live")
    );
    await symlink(
      path.relative(agentsSkills, path.join(managedRoot, "managed-dangling")),
      path.join(agentsSkills, "managed-dangling")
    );
    await symlink(
      path.relative(claudeSkills, path.join(externalRoot, "external-link")),
      path.join(claudeSkills, "external-link")
    );
    await symlink(
      path.join(home, "external-skills", "gone"),
      path.join(claudeSkills, "external-dangling")
    );

    await writeSkill(agentsSkills, "ordinary", "---\ndescription: Ordinary skill\n---\n");
    await writeSkill(agentsSkills, "shared", "---\ndescription: Agents shared\n---\n");
    await writeSkill(claudeSkills, "shared", "---\ndescription: Claude shared\n---\n");
    await writeSkill(claudeSkills, "malformed", "---\ndescription: [unclosed\n---\n");
    await writeSkill(claudeSkills, "missing-description");
    await writeSkill(opencodeSkills, "shared");
    await writeSkill(opencodeSkills, ".hidden", "---\ndescription: hidden\n---\n");
    await writeFile(path.join(opencodeSkills, "not-a-skill"), "file\n", "utf8");

    await expect(readOtherGlobalSkills(paths, { verbose: true })).resolves.toEqual([
      { name: "external-dangling", targets: ["claude-code"] },
      { name: "external-link", targets: ["claude-code"], description: "External link" },
      { name: "malformed", targets: ["claude-code"] },
      { name: "missing-description", targets: ["claude-code"] },
      { name: "ordinary", targets: ["agents"], description: "Ordinary skill" },
      {
        name: "shared",
        targets: ["agents", "claude-code", "opencode"],
        description: "Agents shared"
      }
    ]);
  });

  it("propagates a failure when a canonical store is not a directory", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-global-inventory-"));
    const paths = runtimePaths(home);
    const claudeSkills = globalSkillPath(paths, "claude-code");

    await mkdir(path.dirname(claudeSkills), { recursive: true });
    await writeFile(claudeSkills, "not a directory\n", "utf8");

    await expect(readOtherGlobalSkills(paths)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
