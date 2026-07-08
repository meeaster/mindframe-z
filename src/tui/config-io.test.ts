import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { globalSkillStatePath, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  findGitRoot,
  readLocalSkillOverrides,
  resolveSkillConfigPaths,
  resolveSkillToggleState,
  setLocalSkillState,
  writeChangedSkillOverrides,
  writeLocalSkillOverrides
} from "./config-io.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mindframe-z-config-io-"));
}

function paths(root: string): RuntimePaths {
  return {
    root,
    home: path.join(root, "home"),
    configsDir: path.join(root, "home", ".mindframe-z", "configs"),
    opencodeConfigDir: path.join(root, ".config", "opencode"),
    claudeDir: path.join(root, ".claude"),
    codexDir: path.join(root, ".codex"),
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
    expect(exclude).not.toContain(".opencode/opencode.jsonc");
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
        opencode: path.join(runtimePaths.opencodeConfigDir, "opencode.jsonc"),
        "claude-code": path.join(runtimePaths.claudeDir, "settings.json"),
        codex: path.join(runtimePaths.codexDir, "config.toml")
      },
      global: {
        opencode: path.join(runtimePaths.opencodeConfigDir, "opencode.jsonc"),
        "claude-code": path.join(runtimePaths.claudeDir, "settings.json"),
        codex: path.join(runtimePaths.codexDir, "config.toml")
      }
    });
  });

  it("returns undefined for findGitRoot outside a repo", async () => {
    await expect(findGitRoot(root)).resolves.toBeUndefined();
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

  it("writes opencode toggles to the global config outside a repo", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);

    await writeLocalSkillOverrides(runtimePaths, "opencode", { "test-skill": false });

    const globalConfig = await readFile(
      path.join(runtimePaths.opencodeConfigDir, "opencode.jsonc"),
      "utf8"
    );
    expect(globalConfig).toContain('"test-skill": "deny"');
    await expect(
      readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8")
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
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

  it("preserves existing global opencode config when writing skill toggles", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);
    await mkdir(runtimePaths.opencodeConfigDir, { recursive: true });
    await writeFile(
      path.join(runtimePaths.opencodeConfigDir, "opencode.jsonc"),
      JSON.stringify(
        {
          instructions: ["/tmp/AGENTS.md"],
          permission: { bash: { "*": "ask" }, skill: { existing: "allow" } }
        },
        null,
        2
      ),
      "utf8"
    );

    await writeLocalSkillOverrides(runtimePaths, "opencode", { "test-skill": false });

    const globalConfig = await readFile(
      path.join(runtimePaths.opencodeConfigDir, "opencode.jsonc"),
      "utf8"
    );
    expect(globalConfig).toContain('"/tmp/AGENTS.md"');
    expect(globalConfig).toContain('"*": "ask"');
    expect(globalConfig).toContain('"existing": "allow"');
    expect(globalConfig).toContain('"test-skill": "deny"');
  });

  it("merges partial global writes into the preserved skill state", async () => {
    process.chdir(root);
    const runtimePaths = paths(root);

    await writeLocalSkillOverrides(runtimePaths, "opencode", { first: false });
    await writeLocalSkillOverrides(runtimePaths, "opencode", { second: true });

    const state = JSON.parse(
      await readFile(globalSkillStatePath(runtimePaths, "opencode"), "utf8")
    ) as Record<string, boolean>;
    expect(state).toEqual({ first: false, second: true });
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
    const profile = {
      enabledSkills: [{ name: "local", agents: { opencode: true }, targets: ["opencode"] }]
    } as unknown as ResolvedProfile;
    await setLocalSkillState(runtimePaths, profile, "opencode", "local", false);
    expect(await readLocalSkillOverrides(runtimePaths, "opencode")).toEqual({ local: false });

    const outsideRepo = await tmpDir();
    process.chdir(outsideRepo);
    await writeLocalSkillOverrides(runtimePaths, "opencode", { global: false });
    expect(await readLocalSkillOverrides(runtimePaths, "opencode")).toEqual({ global: false });
  });

  it("resolves skill state with local overrides over global overrides over profile defaults", async () => {
    const runtimePaths = paths(root);
    const outsideRepo = await tmpDir();
    process.chdir(outsideRepo);
    await writeLocalSkillOverrides(runtimePaths, "opencode", { global: false, both: false });

    await initGitRepo(root);
    process.chdir(root);
    const profile = {
      enabledSkills: [
        { name: "default", agents: { opencode: true }, targets: ["opencode"] },
        { name: "global", agents: { opencode: true }, targets: ["opencode"] },
        { name: "both", agents: { opencode: false }, targets: ["opencode"] }
      ]
    } as unknown as ResolvedProfile;
    await setLocalSkillState(runtimePaths, profile, "opencode", "both", true);

    await expect(resolveSkillToggleState(runtimePaths, profile, "opencode")).resolves.toEqual({
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
    await writeLocalSkillOverrides(runtimePaths, "opencode", { inherited: false });

    await initGitRepo(root);
    process.chdir(root);
    const profile = {
      enabledSkills: [
        { name: "inherited", agents: { opencode: true }, targets: ["opencode"] },
        { name: "changed", agents: { opencode: true }, targets: ["opencode"] }
      ]
    } as unknown as ResolvedProfile;

    await writeChangedSkillOverrides(runtimePaths, profile, "opencode", {
      inherited: false,
      changed: false
    });

    const store = JSON.parse(
      await readFile(path.join(runtimePaths.home, ".mindframe-z", "overrides.json"), "utf8")
    ) as { projects?: Record<string, { opencode?: { skills?: Record<string, boolean> } }> };
    expect(store.projects?.[root]?.opencode?.skills).toEqual({ changed: false });
  });

  it("writes a single skill delta via setLocalSkillState", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const profile = {
      enabledSkills: [
        { name: "kept", agents: { opencode: true }, targets: ["opencode"] },
        { name: "changed", agents: { opencode: true }, targets: ["opencode"] }
      ]
    } as unknown as ResolvedProfile;

    await setLocalSkillState(runtimePaths, profile, "opencode", "changed", false);

    const store = JSON.parse(
      await readFile(path.join(runtimePaths.home, ".mindframe-z", "overrides.json"), "utf8")
    ) as { projects?: Record<string, { opencode?: { skills?: Record<string, boolean> } }> };
    expect(store.projects?.[root]?.opencode?.skills).toEqual({ changed: false });
  });

  it("writes Codex skill toggles using resolved SKILL.md paths", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const skillPath = path.join(runtimePaths.home, ".agents", "skills", "changed", "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "# Changed\n", "utf8");
    const profile = {
      enabledSkills: [{ name: "changed", agents: { codex: true }, targets: ["codex"] }]
    } as unknown as ResolvedProfile;

    await setLocalSkillState(runtimePaths, profile, "codex", "changed", false);

    const store = JSON.parse(
      await readFile(path.join(runtimePaths.home, ".mindframe-z", "overrides.json"), "utf8")
    ) as { projects?: Record<string, { codex?: { payload?: { argv?: string[] } } }> };
    expect(store.projects?.[root]?.codex?.payload?.argv?.join("\n")).toContain(
      JSON.stringify([{ path: skillPath, enabled: false }])
    );
  });

  it("renders deterministic Codex skill paths in payloads", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const profile = {
      enabledSkills: [{ name: "missing", agents: { codex: true }, targets: ["codex"] }]
    } as unknown as ResolvedProfile;

    await setLocalSkillState(runtimePaths, profile, "codex", "missing", false);
    const store = JSON.parse(
      await readFile(path.join(runtimePaths.home, ".mindframe-z", "overrides.json"), "utf8")
    ) as { projects?: Record<string, { codex?: { payload?: { argv?: string[] } } }> };
    expect(store.projects?.[root]?.codex?.payload?.argv?.join("\n")).toContain(
      path.join(runtimePaths.home, ".agents", "skills", "missing", "SKILL.md")
    );
  });

  it("removes the local override when a skill returns to its base default", async () => {
    const runtimePaths = paths(root);
    await initGitRepo(root);
    process.chdir(root);
    const profile = {
      enabledSkills: [{ name: "changed", agents: { opencode: true }, targets: ["opencode"] }]
    } as unknown as ResolvedProfile;

    await setLocalSkillState(runtimePaths, profile, "opencode", "changed", false);
    expect(await readLocalSkillOverrides(runtimePaths, "opencode")).toEqual({ changed: false });

    await setLocalSkillState(runtimePaths, profile, "opencode", "changed", true);

    expect(await readLocalSkillOverrides(runtimePaths, "opencode")).toEqual({});
    const store = JSON.parse(
      await readFile(path.join(runtimePaths.home, ".mindframe-z", "overrides.json"), "utf8")
    ) as { projects?: Record<string, unknown> };
    expect(store.projects).toEqual({});
  });
});
