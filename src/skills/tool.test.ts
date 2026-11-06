import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { z } from "zod";
import { skillSchema } from "../core/manifests.js";
import { createRuntimePaths, toolSkillPoolDir, type RuntimePaths } from "../core/paths.js";
import type { ResolvedSkill } from "../core/profile.js";
import {
  expandToolSkillSets,
  refreshToolSkills,
  toolSkillDiagnostics,
  toolSkillSourcePath,
  type ToolSkillHost,
  type ToolSkillProfile
} from "./tool.js";
import type { SkillFileRecord } from "./tree.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function runtimePaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mfz-tool-skill-test-"));

  temporaryRoots.push(root);

  return createRuntimePaths({ root, home: root });
}

function enabledSkill(entry: z.input<typeof skillSchema>): ResolvedSkill {
  const skill = skillSchema.parse(entry);

  if (skill.source === "external") throw new Error("external skills are not rendered");

  return {
    ...skill,
    agents: { opencode: true },
    toggleable: false,
    targets: ["opencode"],
    sourceRoot: "/home-root"
  };
}

function profileOf(...skills: ResolvedSkill[]): ToolSkillProfile {
  return {
    name: "test",
    enabledSkills: skills.filter((skill) => !("generate" in skill)),
    toolSkillSets: skills.filter((skill) => "generate" in skill)
  };
}

function skillFiles(name: string, description: string): SkillFileRecord[] {
  return [
    {
      path: "SKILL.md",
      mode: "100644",
      bytes: Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n`)
    }
  ];
}

interface FakeHost extends ToolSkillHost {
  versions: Map<string, string>;
  revisions: string[];
}

function fakeHost(
  environment: Record<string, string> = {},
  tags: ReadonlySet<string> = new Set()
): FakeHost {
  const versions = new Map<string, string>();
  const revisions: string[] = [];

  return {
    versions,
    revisions,
    toolVersion: async (tool) => versions.get(tool),
    toolEnvironment: async () => environment,
    async fetchRepository(_repository, revision) {
      revisions.push(revision);

      if (!tags.has(revision)) throw new Error(`missing ${revision}`);

      return { commit: "a".repeat(40), files: skillFiles("repo-skill", revision) };
    }
  };
}

async function readSkill(paths: RuntimePaths, ...location: string[]): Promise<string> {
  return readFile(path.join(toolSkillPoolDir(paths), ...location, "SKILL.md"), "utf8");
}

// Writes each requested skill, all of them by default, like a CLI installing from its catalog.
const writeSkills = [
  'echo run >> "$MFZ_TEST_COUNTER"',
  "for skill in ${MFZ_SKILLS:-alpha beta}; do",
  "  mkdir -p .agents/skills/$skill",
  `  printf '%s\\n' --- "name: $skill" "description: v$MFZ_TOOL_VERSION" --- > .agents/skills/$skill/SKILL.md`,
  "done"
].join("\n");

interface SetOptions {
  tool?: string;
  run?: string;
  select?: string[];
}

function generatedSet(name: string, options: SetOptions = {}): ResolvedSkill {
  const skill = enabledSkill({
    name,
    source: "tool",
    tool: options.tool ?? "npm:gen",
    generate: { run: options.run ?? writeSkills, collect: ".agents/skills" }
  });

  if (options.select !== undefined) skill.select = options.select;

  return skill;
}

async function runCount(counter: string): Promise<number> {
  return (await readFile(counter, "utf8")).trim().split("\n").length;
}

describe("tool skill refresh", () => {
  it("runs a set's generator once and installs every skill it writes", async () => {
    const paths = await runtimePaths();
    const counter = path.join(paths.home, "runs");
    const host = fakeHost({ MFZ_TEST_COUNTER: counter });
    const profile = profileOf(generatedSet("gen"));

    host.versions.set("npm:gen", "1.0.0");

    const first = await refreshToolSkills(paths, profile, { host });

    expect(first.map((outcome) => outcome.status)).toEqual(["created"]);
    expect(await readSkill(paths, "gen", "alpha")).toContain("description: v1.0.0");
    expect(await readSkill(paths, "gen", "beta")).toContain("description: v1.0.0");
    expect(await runCount(counter)).toBe(1);

    const second = await refreshToolSkills(paths, profile, { host });

    expect(second.map((outcome) => outcome.status)).toEqual(["unchanged"]);
    expect(await runCount(counter)).toBe(1);

    host.versions.set("npm:gen", "1.1.0");

    const upgraded = await refreshToolSkills(paths, profile, { host });

    expect(upgraded.map((outcome) => [outcome.status, outcome.before, outcome.after])).toEqual([
      ["updated", "1.0.0", "1.1.0"]
    ]);
    expect(await readSkill(paths, "gen", "alpha")).toContain("description: v1.1.0");
  });

  it("asks the generator for the profile's selection and keeps only those skills", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({ MFZ_TEST_COUNTER: path.join(paths.home, "runs") });
    const set = generatedSet("gen", { select: ["beta"] });

    host.versions.set("npm:gen", "1.0.0");
    await refreshToolSkills(paths, profileOf(set), { host });

    expect(await readSkill(paths, "gen", "beta")).toContain("name: beta");
    await expect(readSkill(paths, "gen", "alpha")).rejects.toThrow();

    const [missing] = await refreshToolSkills(
      paths,
      profileOf(generatedSet("gen", { select: ["beta"], run: "mkdir -p .agents/skills" })),
      { host }
    );

    expect(missing?.status).toBe("failed");
    expect(missing?.detail).toContain("Generator did not produce selected skills: beta");
  });

  it("keeps every record when tool-narrowed refreshes run concurrently", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({ MFZ_TEST_COUNTER: path.join(paths.home, "runs") });

    const profile = profileOf(
      generatedSet("first", { tool: "npm:first" }),
      generatedSet("second", { tool: "npm:second" })
    );

    host.versions.set("npm:first", "1.0.0");
    host.versions.set("npm:second", "1.0.0");

    // Mirrors mise running two tools' postinstall hooks in parallel.
    await Promise.all([
      refreshToolSkills(paths, profile, { host, tool: "npm:first" }),
      refreshToolSkills(paths, profile, { host, tool: "npm:second" })
    ]);

    const diagnostics = await toolSkillDiagnostics(paths, profile, host);

    expect(diagnostics.filter((line) => !line.startsWith("tool-skill:ok"))).toEqual([]);
  });

  it("gives generators an isolated home and collects from it with ~/", async () => {
    const paths = await runtimePaths();
    const host = fakeHost();

    host.versions.set("npm:homey", "2.0.0");

    const skill = enabledSkill({
      name: "homey-set",
      source: "tool",
      tool: "npm:homey",
      generate: {
        run: [
          'mkdir -p "$HOME/.claude/skills/homey"',
          `printf '%s\\n' --- "name: homey" "description: $HOME" --- > "$HOME/.claude/skills/homey/SKILL.md"`
        ].join("\n"),
        collect: "~/.claude/skills"
      }
    });

    const [result] = await refreshToolSkills(paths, profileOf(skill), { host });

    expect(result?.status).toBe("created");

    const description = (await readSkill(paths, "homey-set", "homey")).split("\n")[2] ?? "";

    expect(description).toMatch(/^description: .*mfz-tool-skill-.*home$/u);
    expect(description).not.toContain(os.homedir());
  });

  it("fetches the repository tag matching the installed version", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({}, new Set(["refs/tags/3.1.0"]));

    host.versions.set("cargo:repo-tool", "3.1.0");

    const skill = enabledSkill({
      name: "repo-skill",
      source: "tool",
      tool: "cargo:repo-tool",
      repo: "https://example.com/repo.git",
      subtree: "skills/repo-skill"
    });

    const [result] = await refreshToolSkills(paths, profileOf(skill), { host });

    expect(result?.status).toBe("created");
    expect(host.revisions).toEqual(["refs/tags/v3.1.0", "refs/tags/3.1.0"]);

    const manifest = YAML.parse(
      await readFile(path.join(toolSkillPoolDir(paths), ".mfz-skills.yml"), "utf8")
    );

    expect(manifest.skills["repo-skill"]).toMatchObject({
      tool: "cargo:repo-tool",
      version: "3.1.0",
      commit: "a".repeat(40)
    });
  });

  it("keeps the previous copy when a refresh fails", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({}, new Set(["refs/tags/release-1"]));

    const skill = enabledSkill({
      name: "repo-skill",
      source: "tool",
      tool: "cargo:repo-tool",
      repo: "https://example.com/repo.git",
      tag: "release-{version}",
      subtree: "skills/repo-skill"
    });

    host.versions.set("cargo:repo-tool", "1");
    await refreshToolSkills(paths, profileOf(skill), { host });
    host.versions.set("cargo:repo-tool", "2");

    const [result] = await refreshToolSkills(paths, profileOf(skill), { host });

    expect(result?.status).toBe("failed");
    expect(result?.detail).toContain("release-2");
    expect(await readSkill(paths, "repo-skill")).toContain("refs/tags/release-1");
  });

  it("removes sets whose tool is gone or that the profile no longer enables", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({ MFZ_TEST_COUNTER: path.join(paths.home, "runs") });

    host.versions.set("npm:gen", "1.0.0");
    host.versions.set("npm:other", "1.0.0");
    await refreshToolSkills(
      paths,
      profileOf(generatedSet("gen"), generatedSet("other", { tool: "npm:other" })),
      { host }
    );

    const narrowed = await refreshToolSkills(paths, profileOf(generatedSet("gen")), { host });

    expect(narrowed.map((outcome) => [outcome.status, path.basename(outcome.target)])).toEqual([
      ["unchanged", "gen"],
      ["removed", "other"]
    ]);

    host.versions.delete("npm:gen");

    const uninstalled = await refreshToolSkills(paths, profileOf(generatedSet("gen")), { host });

    expect(uninstalled.map((outcome) => outcome.status)).toEqual(["removed"]);
    await expect(readSkill(paths, "gen", "alpha")).rejects.toThrow();
  });

  it("rejects a named refresh of a skill the profile does not enable", async () => {
    const paths = await runtimePaths();

    await expect(
      refreshToolSkills(paths, profileOf(), { host: fakeHost(), names: ["nope"] })
    ).rejects.toThrow("Not a tool skill enabled in profile test: nope");
  });
});

describe("tool skill catalog entries", () => {
  const base = { name: "tooled", source: "tool", tool: "npm:tooled" };

  it("accepts generator paths inside the isolated home", () => {
    expect(
      skillSchema.safeParse({
        ...base,
        generate: { run: "tooled skills install", collect: "~/.claude/skills" }
      }).success
    ).toBe(true);
  });

  it("rejects generator paths that leave the sandbox", () => {
    expect(
      skillSchema.safeParse({ ...base, generate: { run: "x", collect: "../outside" } }).success
    ).toBe(false);
    expect(
      skillSchema.safeParse({ ...base, generate: { run: "x", collect: "/abs" } }).success
    ).toBe(false);
  });

  it("requires the version placeholder in a tag template", () => {
    const repo = { ...base, repo: "https://example.com/r.git", subtree: "skills/tooled" };

    expect(skillSchema.safeParse({ ...repo, tag: "v{version}" }).success).toBe(true);
    expect(skillSchema.safeParse({ ...repo, tag: "latest" }).success).toBe(false);
  });
});

describe("tool skill sets in a resolved profile", () => {
  it("expands a refreshed set into its selected member skills", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({ MFZ_TEST_COUNTER: path.join(paths.home, "runs") });
    const set = generatedSet("gen");

    host.versions.set("npm:gen", "1.0.0");
    expect(await expandToolSkillSets(paths, [set])).toEqual([]);
    await refreshToolSkills(paths, profileOf(set), { host });

    const members = await expandToolSkillSets(paths, [generatedSet("gen", { select: ["beta"] })]);

    expect(members.map((skill) => [skill.name, skill.toolSet, skill.description])).toEqual([
      ["beta", "gen", "v1.0.0"]
    ]);
    expect(toolSkillSourcePath(paths, members[0]!)).toBe(
      path.join(toolSkillPoolDir(paths), "gen", "beta")
    );
  });

  it("rejects a member whose name another enabled skill already uses", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({ MFZ_TEST_COUNTER: path.join(paths.home, "runs") });
    const set = generatedSet("gen");
    const local = enabledSkill({ name: "alpha", source: "local", skill: "skills/alpha" });

    host.versions.set("npm:gen", "1.0.0");
    await refreshToolSkills(paths, profileOf(set), { host });

    await expect(expandToolSkillSets(paths, [local, set])).rejects.toThrow(
      "Skill alpha from tool skill set gen conflicts with alpha from the catalog"
    );
  });
});

describe("tool skill diagnostics", () => {
  it("reports stale, modified, and unrecorded pool entries", async () => {
    const paths = await runtimePaths();
    const host = fakeHost({ MFZ_TEST_COUNTER: path.join(paths.home, "runs") });
    const profile = profileOf(generatedSet("gen"), generatedSet("other", { tool: "npm:other" }));

    host.versions.set("npm:gen", "1.0.0");
    host.versions.set("npm:other", "1.0.0");
    await refreshToolSkills(paths, profile, { host });
    await writeFile(path.join(toolSkillPoolDir(paths), "other", "beta", "extra.md"), "edited\n");
    await mkdir(path.join(toolSkillPoolDir(paths), "stray"));

    expect(await toolSkillDiagnostics(paths, profile, host)).toEqual([
      "tool-skill:ok\tgen\tnpm:gen@1.0.0\talpha, beta",
      "tool-skill:modified\tother\tfiles differ from the recorded digest; the next refresh replaces them",
      `tool-skill:unmanaged\t${path.join(toolSkillPoolDir(paths), "stray")}\tnot recorded by mfz`
    ]);

    host.versions.set("npm:gen", "1.2.0");

    expect((await toolSkillDiagnostics(paths, profile, host))[0]).toBe(
      "tool-skill:stale\tgen\t1.0.0 -> 1.2.0\trun mfz skills refresh"
    );
  });
});
