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
  resolveSkillConfigPaths,
  resolveSkillToggleState,
  setLocalSkillState,
  writeChangedSkillOverrides,
  writeLocalSkillOverrides
} from "./config-io.js";
import { readOverrideStore } from "../core/override-store.js";

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
    agents,
    targets,
    toggleable: true,
    sourceRoot: "/tmp"
  };
}

function resolvedProfile(enabledSkills: ResolvedProfile["enabledSkills"]): ResolvedProfile {
  return {
    name: "test",
    agents: ["opencode-v2", "claude-code", "codex"],
    profile: {
      name: "test",
      description: "",
      agents: ["opencode-v2", "claude-code", "codex"],
      instructions: [],
      instruction_references: [],
      capability_groups: [],
      references: [],
      skills: {},
      mcp: {},
      opencode_v2: {
        config: {},
        dependencies: {},
        cli: {},
        plugins: [],
        plugin_options: {},
        tui_plugins: [],
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
    enabledOpenCodeV2Commands: [],
    enabledOpenCodeV2Agents: [],
    enabledOpenCodeV2Plugins: [],
    enabledOpenCodeV2TuiPlugins: [],
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

describe("skill config git exclusion", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await tmpDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  async function initGitRepo(dir: string): Promise<void> {
    await execa("git", ["init"], { cwd: dir });
  }

  it("does not write repo-local git exclude entries", async () => {
    await initGitRepo(root);
    process.chdir(root);

    await resolveSkillConfigPaths(paths(root));

    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain(".claude/settings.local.json");
    expect(exclude).not.toContain(".codex/config.toml");
  });
});

describe("skill config path resolution", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await tmpDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  async function initGitRepo(dir: string): Promise<void> {
    await execa("git", ["init"], { cwd: dir });
  }

  it("resolves repo-local paths from the git root", async () => {
    const nested = path.join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    await initGitRepo(root);
    process.chdir(nested);

    const resolved = await resolveSkillConfigPaths(paths(root));

    expect(resolved).toMatchObject({
      repoRoot: root,
      scope: "repo"
    });
  });

  it("resolves global paths outside a git repo", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);

    const resolved = await resolveSkillConfigPaths(runtimePaths);

    expect(resolved).toMatchObject({
      scope: "global",
      active: {
        "claude-code": path.join(runtimePaths.claudeDir, "settings.json"),
        codex: path.join(runtimePaths.codexDir, "config.toml")
      },
      global: {
        "claude-code": path.join(runtimePaths.claudeDir, "settings.json"),
        codex: path.join(runtimePaths.codexDir, "config.toml")
      }
    });
  });
});

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

describe("skill override precedence", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await tmpDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  async function initGitRepo(dir: string): Promise<void> {
    await execa("git", ["init"], { cwd: dir });
  }

  it("reads local overrides in a repo and global overrides outside a repo", async () => {
    await initGitRepo(root);
    process.chdir(root);
    const runtimePaths = paths(root);
    const profile = resolvedProfile([skill("local", { "claude-code": true }, ["claude-code"])]);
    await setLocalSkillState(runtimePaths, profile, "claude-code", "local", false);
    expect(await readLocalSkillOverrides(runtimePaths, "claude-code")).toEqual({ local: false });

    const outsideRepo = await tmpDir();
    process.chdir(outsideRepo);
    await writeLocalSkillOverrides(runtimePaths, "claude-code", { global: false });
    expect(await readLocalSkillOverrides(runtimePaths, "claude-code")).toEqual({ global: false });
  });

  it("resolves skill state with local overrides over global overrides over profile defaults", async () => {
    const runtimePaths = paths(root);
    const outsideRepo = await tmpDir();
    process.chdir(outsideRepo);
    await writeLocalSkillOverrides(runtimePaths, "claude-code", { global: false, both: false });

    await initGitRepo(root);
    process.chdir(root);
    const profile = resolvedProfile([
      skill("default", { "claude-code": true }, ["claude-code"]),
      skill("global", { "claude-code": true }, ["claude-code"]),
      skill("both", { "claude-code": false }, ["claude-code"])
    ]);
    await setLocalSkillState(runtimePaths, profile, "claude-code", "both", true);

    await expect(resolveSkillToggleState(runtimePaths, profile, "claude-code")).resolves.toEqual({
      default: true,
      global: false,
      both: true
    });
  });
});

describe("skill override delta writes", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await tmpDir();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  async function initGitRepo(dir: string): Promise<void> {
    await execa("git", ["init"], { cwd: dir });
  }

  it("writes only local deltas instead of materializing global overrides", async () => {
    const runtimePaths = paths(root);
    const outsideRepo = await tmpDir();
    process.chdir(outsideRepo);
    await writeLocalSkillOverrides(runtimePaths, "claude-code", { inherited: false });

    await initGitRepo(root);
    process.chdir(root);
    const profile = resolvedProfile([
      skill("inherited", { "claude-code": true }, ["claude-code"]),
      skill("changed", { "claude-code": true }, ["claude-code"])
    ]);

    await writeChangedSkillOverrides(runtimePaths, profile, "claude-code", {
      inherited: false,
      changed: false
    });

    const store = await readOverrideStore(runtimePaths.home);
    expect(store.projects?.[root]?.["claude-code"]?.skills).toEqual({ changed: false });
  });

  it("writes a single skill delta via setLocalSkillState", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const profile = resolvedProfile([
      skill("kept", { "claude-code": true }, ["claude-code"]),
      skill("changed", { "claude-code": true }, ["claude-code"])
    ]);

    await setLocalSkillState(runtimePaths, profile, "claude-code", "changed", false);

    const store = await readOverrideStore(runtimePaths.home);
    expect(store.projects?.[root]?.["claude-code"]?.skills).toEqual({ changed: false });
  });

  it("writes Codex skill toggles using resolved SKILL.md paths", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const skillPath = path.join(runtimePaths.home, ".agents", "skills", "changed", "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "# Changed\n", "utf8");
    const profile = resolvedProfile([skill("changed", { codex: true }, ["codex"])]);

    await setLocalSkillState(runtimePaths, profile, "codex", "changed", false);

    const store = await readOverrideStore(runtimePaths.home);
    expect(store.projects?.[root]?.codex?.payload?.argv?.join("\n")).toContain(
      JSON.stringify([{ path: skillPath, enabled: false }])
    );
  });

  it("renders deterministic Codex skill paths in payloads", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const profile = resolvedProfile([skill("missing", { codex: true }, ["codex"])]);

    await setLocalSkillState(runtimePaths, profile, "codex", "missing", false);
    const store = await readOverrideStore(runtimePaths.home);
    expect(store.projects?.[root]?.codex?.payload?.argv?.join("\n")).toContain(
      path.join(runtimePaths.home, ".agents", "skills", "missing", "SKILL.md")
    );
  });

  it("removes the local override when a skill returns to its base default", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const profile = resolvedProfile([skill("changed", { "claude-code": true }, ["claude-code"])]);

    await setLocalSkillState(runtimePaths, profile, "claude-code", "changed", false);
    expect(await readLocalSkillOverrides(runtimePaths, "claude-code")).toEqual({ changed: false });

    await setLocalSkillState(runtimePaths, profile, "claude-code", "changed", true);

    expect(await readLocalSkillOverrides(runtimePaths, "claude-code")).toEqual({});
    const store = await readOverrideStore(runtimePaths.home);
    expect(store.projects).toEqual({});
  });
});
