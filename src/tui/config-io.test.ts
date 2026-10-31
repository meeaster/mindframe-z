import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  readLocalSkillOverrides,
  resolveSkillToggleState,
  setLocalSkillState,
  writeChangedSkillOverrides,
  writeLocalSkillOverrides
} from "./config-io.js";

const codexConfigSchema = z.object({
  skills: z
    .object({ config: z.array(z.object({ path: z.string(), enabled: z.boolean() })).optional() })
    .optional()
});

function skill(
  name: string,
  agents: ResolvedProfile["enabledSkills"][number]["agents"],
  targets: ResolvedProfile["enabledSkills"][number]["targets"]
) {
  return {
    name,
    description: "",
    source: "local" as const,
    skill: `skills/${name}`,
    agents,
    targets,
    toggleable: true,
    sourceRoot: "/tmp"
  };
}

function resolvedProfile(enabledSkills: ResolvedProfile["enabledSkills"]): ResolvedProfile {
  return {
    name: "test",
    agents: ["opencode", "claude-code", "codex"],
    profile: {
      name: "test",
      description: "",
      agents: ["opencode", "claude-code", "codex"],
      instructions: [],
      instruction_references: [],
      capability_groups: [],
      references: [],
      skills: {},
      mcp: {},
      opencode: {
        config: {},
        permissions: [],
        dependencies: {},
        cli: {},
        plugins: [],
        plugin_options: {},
        commands: [],
        agents: []
      },
      claude: { settings: {} },
      codex: { config: {}, plugins: {} },
      pi: { settings: {}, subagent_config: {} },
      thread: { stores: [], defaults: {}, credentials: "subscription" },
      dotfiles: {},
      extra_folders: []
    },
    manifests: {
      homeManifest: {},
      root: "/tmp",
      aliasPath: [],
      references: [],
      skills: [],
      mcpServers: {},
      opencodePlugins: [],
      profiles: new Map(),
      miseFiles: new Map(),
      machine: {
        references_dir: "~/.mindframe-z/references",
        extra_folders: [],
        git: {},
        sandbox: {},
        thread: { stores: [] },
        work: {},
        archives: [],
        claude: {}
      }
    },
    sources: {
      references: new Map(),
      skills: new Map(),
      mcp: new Map(),
      instructions: new Map(),
      plugins: new Map(),
      commands: new Map(),
      agents: new Map()
    },
    instructionFiles: [],
    instructionReferences: [],
    referencesDir: "/tmp",
    enabledReferences: [],
    enabledSkills,
    enabledOpenCodeCommands: [],
    enabledOpenCodeAgents: [],
    enabledOpenCodePlugins: [],
    mcpServers: [],
    extraFolders: [],
    miseLayers: []
  };
}

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mindframe-z-config-io-"));
}

async function readCodexSkillsConfig(
  runtimePaths: RuntimePaths
): Promise<Array<{ path: string; enabled: boolean }> | undefined> {
  const data = codexConfigSchema.parse(
    parseToml(await readFile(path.join(runtimePaths.codexDir, "config.toml"), "utf8"))
  );

  return data.skills?.config;
}

async function writeInstalledSkill(runtimePaths: RuntimePaths, name: string): Promise<string> {
  const skillPath = path.join(runtimePaths.home, ".agents", "skills", name, "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, `# ${name}\n`, "utf8");

  return skillPath;
}

function paths(root: string): RuntimePaths {
  return {
    root,
    home: path.join(root, "home"),
    workRoot: path.join(root, "home", ".mindframe-z", "work", "v1"),
    workUnitsRoot: path.join(root, "home", ".mindframe-z", "work", "v1", "units"),
    configsDir: path.join(root, "home", ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(root, ".config", "opencode"),
    claudeDir: path.join(root, ".claude"),
    codexDir: path.join(root, ".codex"),
    piDir: path.join(root, ".pi", "agent"),
    miseConfigDir: path.join(root, ".config", "mise")
  };
}

describe("skill config global writes", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await tmpDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("writes claude toggles to user settings outside a repo", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);

    await writeLocalSkillOverrides(runtimePaths, "claude-code", { "test-skill": false });

    const settings = await readFile(path.join(runtimePaths.claudeDir, "settings.json"), "utf8");
    expect(settings).toContain('"test-skill": "off"');
    await expect(
      readFile(path.join(root, ".claude", "settings.local.json"), "utf8")
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("writes codex toggles against the installed SKILL.md under the home directory", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);
    const skillPath = await writeInstalledSkill(runtimePaths, "test-skill");

    await writeLocalSkillOverrides(runtimePaths, "codex", { "test-skill": false });

    expect(await readCodexSkillsConfig(runtimePaths)).toEqual([
      { path: skillPath, enabled: false }
    ]);
  });

  it("writes codex delta toggles against the installed SKILL.md outside a repo", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);
    const skillPath = await writeInstalledSkill(runtimePaths, "changed");
    const profile = resolvedProfile([skill("changed", { codex: true }, ["codex"])]);

    await setLocalSkillState(runtimePaths, profile, "codex", "changed", false);

    expect(await readCodexSkillsConfig(runtimePaths)).toEqual([
      { path: skillPath, enabled: false }
    ]);
  });

  it("refuses codex toggles when the skill has no installed SKILL.md", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);

    await expect(
      writeLocalSkillOverrides(runtimePaths, "codex", { "test-skill": false })
    ).rejects.toThrow("Cannot toggle test-skill for codex");

    await expect(
      readFile(path.join(runtimePaths.codexDir, "config.toml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("skill override state", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await tmpDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("writes toggles to user settings even inside a git repo", async () => {
    await execa("git", ["init"], { cwd: root });
    process.chdir(root);
    const runtimePaths = paths(root);
    const profile = resolvedProfile([skill("changed", { "claude-code": true }, ["claude-code"])]);

    await setLocalSkillState(runtimePaths, profile, "claude-code", "changed", false);

    const settings = await readFile(path.join(runtimePaths.claudeDir, "settings.json"), "utf8");
    expect(settings).toContain('"changed": "off"');
  });

  it("resolves skill state with global overrides over profile defaults", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);
    await writeLocalSkillOverrides(runtimePaths, "claude-code", { global: false });

    const profile = resolvedProfile([
      skill("default", { "claude-code": true }, ["claude-code"]),
      skill("global", { "claude-code": true }, ["claude-code"])
    ]);

    await expect(resolveSkillToggleState(runtimePaths, profile, "claude-code")).resolves.toEqual({
      default: true,
      global: false
    });
  });

  it("writes only skills that differ from profile defaults", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);

    const profile = resolvedProfile([
      skill("kept", { "claude-code": true }, ["claude-code"]),
      skill("changed", { "claude-code": true }, ["claude-code"])
    ]);

    await writeChangedSkillOverrides(runtimePaths, profile, "claude-code", {
      kept: true,
      changed: false
    });

    expect(await readLocalSkillOverrides(runtimePaths, "claude-code")).toEqual({ changed: false });
  });

  it("removes the override when a skill returns to its profile default", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);
    const profile = resolvedProfile([skill("changed", { "claude-code": true }, ["claude-code"])]);

    await setLocalSkillState(runtimePaths, profile, "claude-code", "changed", false);
    expect(await readLocalSkillOverrides(runtimePaths, "claude-code")).toEqual({ changed: false });

    await setLocalSkillState(runtimePaths, profile, "claude-code", "changed", true);

    expect(await readLocalSkillOverrides(runtimePaths, "claude-code")).toEqual({});
  });
});
