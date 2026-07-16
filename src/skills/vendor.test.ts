import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  digestSkillTree,
  promoteVendoredSkill,
  readLegacyGitSkills,
  stageVendoredSkill,
  validateVendoredSkill,
  validateVendoredSkills
} from "./vendor.js";
import { skillSchema } from "../core/manifests.js";
import { createRuntimePaths, skillCandidatesRoot } from "../core/paths.js";
import { digestSkillFiles, frame, inventory, staticFindings } from "./tree.js";

async function skillDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mfz-vendor-test-"));
  await writeFile(
    path.join(root, "SKILL.md"),
    ["---", "name: test-skill", "description: Test skill.", "---", "", "# Test", ""].join("\n"),
    "utf8"
  );
  return root;
}

describe("vendored skill contracts", () => {
  it("changes the digest for path, mode, and content changes", async () => {
    const root = await skillDir();
    const initial = await digestSkillTree(root);
    await writeFile(path.join(root, "other.md"), "other\n", "utf8");
    const withPath = await digestSkillTree(root);
    expect(withPath).not.toBe(initial);
    await chmod(path.join(root, "other.md"), 0o755);
    const withMode = await digestSkillTree(root);
    expect(withMode).not.toBe(withPath);
    await writeFile(path.join(root, "other.md"), "changed\n", "utf8");
    expect(await digestSkillTree(root)).not.toBe(withMode);
  });

  it("uses the same digest for the same files regardless of enumeration order", async () => {
    const files = [
      { path: "z.md", mode: "100644" as const, bytes: Buffer.from("z\n") },
      { path: "a.md", mode: "100755" as const, bytes: Buffer.from("a\n") }
    ];
    expect(digestSkillFiles(files)).toBe(digestSkillFiles([...files].reverse()));
  });

  it("rejects symlinks before integrity validation", async () => {
    const root = await skillDir();
    await symlink(path.join(root, "SKILL.md"), path.join(root, "linked.md"));
    await expect(digestSkillTree(root)).rejects.toThrow(/symbolic link/);
  });

  it("rejects symlinked managed ancestors", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-vendor-ancestor-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "mfz-vendor-external-"));
    const sourceRoot = await skillDir();
    await mkdir(path.join(external, "vendor", "test-skill"), { recursive: true });
    await writeFile(
      path.join(external, "vendor", "test-skill", "SKILL.md"),
      await readFile(path.join(sourceRoot, "SKILL.md"))
    );
    await symlink(external, path.join(home, "skills"));
    const digest = await digestSkillTree(path.join(external, "vendor", "test-skill"));
    const entry = skillSchema.parse({
      name: "test-skill",
      source: "vendored",
      repo: "https://example.invalid/skills.git",
      ref: "main",
      subtree: "skills/test-skill"
    });
    if (entry.source !== "vendored") throw new Error("test fixture did not create vendored entry");
    await writeFile(
      path.join(external, "vendor.lock.yml"),
      YAML.stringify({ skills: { "test-skill": { commit: "a".repeat(40), digest } } }),
      "utf8"
    );
    await expect(validateVendoredSkill(home, entry)).rejects.toThrow(/symbolic link/);
  });

  it("validates the committed subtree against its lock digest", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-vendor-home-"));
    const source = path.join(home, "skills", "vendor", "test-skill");
    await mkdir(source, { recursive: true });
    const sourceRoot = await skillDir();
    await writeFile(
      path.join(source, "SKILL.md"),
      await readFile(path.join(sourceRoot, "SKILL.md"))
    );
    const digest = await digestSkillTree(source);
    const entry = skillSchema.parse({
      name: "test-skill",
      source: "vendored",
      repo: "https://example.invalid/skills.git",
      ref: "main",
      subtree: "skills/test-skill"
    });
    if (entry.source !== "vendored") throw new Error("test fixture did not create vendored entry");
    await writeFile(
      path.join(home, "skills", "vendor.lock.yml"),
      YAML.stringify({ skills: { "test-skill": { commit: "a".repeat(40), digest } } }),
      "utf8"
    );
    await expect(validateVendoredSkill(home, entry)).resolves.toBeUndefined();
  });

  it("rejects an orphaned vendor lock entry", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-vendor-orphan-lock-"));
    await mkdir(path.join(home, "catalog"), { recursive: true });
    await writeFile(path.join(home, "catalog", "skills.yml"), "skills: []\n", "utf8");
    await mkdir(path.join(home, "skills"), { recursive: true });
    await writeFile(
      path.join(home, "skills", "vendor.lock.yml"),
      YAML.stringify({ skills: { orphan: { commit: "a".repeat(40), digest: "b".repeat(64) } } }),
      "utf8"
    );
    await expect(validateVendoredSkills(home)).resolves.toEqual([
      "orphan: vendor lock entry has no vendored catalog declaration"
    ]);
  });

  it("reads legacy Git declarations only as migration input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-skill-"));
    await mkdir(path.join(root, "catalog"), { recursive: true });
    await writeFile(
      path.join(root, "catalog", "skills.yml"),
      YAML.stringify({
        skills: [{ name: "old", source: "git", repo: "https://example.invalid/old" }]
      }),
      "utf8"
    );
    const legacy = await readLegacyGitSkills(root);
    expect(legacy[0]).toMatchObject({ source: "vendored", name: "old", ref: "main" });
  });

  it("discovers legacy declarations in an inherited home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-child-"));
    const upstream = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-upstream-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-machine-"));
    await writeFile(
      path.join(root, "mfz_home.yml"),
      YAML.stringify({ extends: { name: "upstream", repo: upstream } }),
      "utf8"
    );
    await writeFile(path.join(upstream, "mfz_home.yml"), "description: upstream\n", "utf8");
    await mkdir(path.join(upstream, "catalog"), { recursive: true });
    await writeFile(
      path.join(upstream, "catalog", "skills.yml"),
      YAML.stringify({
        skills: [{ name: "old", source: "git", repo: "https://example.invalid/old" }]
      }),
      "utf8"
    );
    const legacy = await readLegacyGitSkills(root, home);
    expect(legacy[0]).toMatchObject({ name: "old", sourceRoot: upstream });
  });

  it("rejects non-HTTPS sources before creating a Git cache", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-vendor-unsafe-"));
    const entry = {
      name: "unsafe",
      source: "vendored",
      repo: "file:///tmp/unsafe",
      ref: "main",
      subtree: "skills/unsafe",
      description: ""
    } as const;
    await expect(
      stageVendoredSkill(createRuntimePaths({ root: home, home }), entry, home)
    ).rejects.toThrow(/HTTPS/);
  });

  it("promotes the exact revalidated candidate without touching rendered state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-promote-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-promote-home-"));
    const name = "test-skill";
    const oldContent = "---\nname: test-skill\ndescription: old\n---\n";
    const newContent = "---\nname: test-skill\ndescription: new\n---\n";
    const source = path.join(root, "skills", "vendor", name);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(root, "mfz_home.yml"), "description: Test\n", "utf8");
    await mkdir(path.join(root, "catalog"), { recursive: true });
    await writeFile(
      path.join(root, "catalog", "skills.yml"),
      YAML.stringify({
        skills: [
          {
            name,
            source: "vendored",
            repo: "https://example.invalid/skills.git",
            ref: "main",
            subtree: "skills/test-skill",
            description: "Test"
          }
        ]
      }),
      "utf8"
    );
    await writeFile(path.join(source, "SKILL.md"), oldContent, "utf8");
    const oldDigest = digestSkillFiles([
      { path: "SKILL.md", mode: "100644", bytes: Buffer.from(oldContent) }
    ]);
    await writeFile(
      path.join(root, "skills", "vendor.lock.yml"),
      YAML.stringify({ skills: { [name]: { commit: "a".repeat(40), digest: oldDigest } } }),
      "utf8"
    );

    const files = [{ path: "SKILL.md", mode: "100644" as const, bytes: Buffer.from(newContent) }];
    const digest = digestSkillFiles(files);
    const candidateId = (() => {
      const hash = createHash("sha256");
      for (const value of [
        name,
        "https://example.invalid/skills.git",
        "skills/test-skill",
        "b".repeat(40),
        digest
      ]) {
        hash.update(frame(Buffer.from(value, "utf8")));
      }
      return hash.digest("hex");
    })();
    const candidatePath = path.join(
      skillCandidatesRoot(createRuntimePaths({ root, home })),
      candidateId
    );
    const candidateSource = path.join(candidatePath, "source");
    await mkdir(candidateSource, { recursive: true });
    await writeFile(path.join(candidateSource, "SKILL.md"), newContent, "utf8");
    const candidateInventory = inventory(files);
    const candidateFindings = staticFindings(files);
    const diff = [
      "--- old/SKILL.md",
      "+++ new/SKILL.md",
      ...oldContent.split("\n").map((line) => `-${line}`),
      ...newContent.split("\n").map((line) => `+${line}`),
      ""
    ].join("\n");
    const inventoryContent = YAML.stringify({ files: candidateInventory });
    const findingsContent = YAML.stringify({ findings: candidateFindings });
    const digestContent = `${digest}\n`;
    await writeFile(
      path.join(candidatePath, "provenance.yml"),
      YAML.stringify({
        candidateId,
        name,
        repository: "https://example.invalid/skills.git",
        ref: "main",
        subtree: "skills/test-skill",
        commit: "b".repeat(40),
        digest,
        sourceRoot: path.join(home, "not-the-active-home"),
        oldCommit: "a".repeat(40),
        oldDigest,
        artifacts: {
          inventory: createHash("sha256").update(inventoryContent).digest("hex"),
          findings: createHash("sha256").update(findingsContent).digest("hex"),
          diff: createHash("sha256").update(diff).digest("hex"),
          digest: createHash("sha256").update(digestContent).digest("hex")
        }
      }),
      "utf8"
    );
    await writeFile(path.join(candidatePath, "inventory.yml"), inventoryContent, "utf8");
    await writeFile(path.join(candidatePath, "findings.yml"), findingsContent, "utf8");
    await writeFile(path.join(candidatePath, "diff.patch"), diff, "utf8");
    await writeFile(path.join(candidatePath, "digest"), digestContent, "utf8");

    await promoteVendoredSkill(createRuntimePaths({ root, home }), candidateId, async () => true);

    await expect(readFile(path.join(source, "SKILL.md"), "utf8")).resolves.toBe(newContent);
    await expect(readFile(path.join(root, "skills", "vendor.lock.yml"), "utf8")).resolves.toContain(
      "b".repeat(40)
    );
    await expect(
      lstat(path.join(home, ".mindframe-z", "configs", "personal", "skills"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
