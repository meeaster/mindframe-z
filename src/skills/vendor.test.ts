import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  checkVendoredSkill,
  digestSkillTree,
  promoteVendoredSkill,
  readCandidate,
  readLegacyGitSkills,
  revalidateCandidate,
  stageVendoredSkill,
  validateVendoredSkill,
  validateVendoredSkills
} from "./vendor.js";
import { skillSchema, vendoredSkillTargets, type SkillEntry } from "../core/manifests.js";
import { createRuntimePaths, skillCandidatesRoot } from "../core/paths.js";
import {
  digestSkillFiles,
  frame,
  inventory,
  sha256,
  staticFindings,
  type SkillFileRecord
} from "./tree.js";

type VariantTarget = (typeof vendoredSkillTargets)[number];

type VariantFiles = Record<VariantTarget, SkillFileRecord[]>;

function variantFiles(name: string, suffix: string): VariantFiles {
  const files: VariantFiles = {
    "claude-code": [
      {
        path: "SKILL.md",
        mode: "100644",
        bytes: Buffer.from(
          `---\nname: ${name}\ndescription: claude-code ${suffix}\n---\n\n# Claude\n`
        )
      }
    ],
    codex: [
      {
        path: "SKILL.md",
        mode: "100644",
        bytes: Buffer.from(`---\nname: ${name}\ndescription: codex ${suffix}\n---\n\n# Codex\n`)
      }
    ],
    opencode: [
      {
        path: "SKILL.md",
        mode: "100644",
        bytes: Buffer.from(
          `---\nname: ${name}\ndescription: opencode ${suffix}\n---\n\n# OpenCode\n`
        )
      }
    ]
  };

  return files;
}

function variantRecords(files: VariantFiles): SkillFileRecord[] {
  const records: SkillFileRecord[] = [];

  for (const target of vendoredSkillTargets) {
    for (const file of files[target]) records.push({ ...file, path: `${target}/${file.path}` });
  }

  return records;
}

function variantDigests(files: VariantFiles): Record<VariantTarget, string> {
  return {
    "claude-code": digestSkillFiles(files["claude-code"]),
    codex: digestSkillFiles(files.codex),
    opencode: digestSkillFiles(files["opencode"])
  };
}

function variantFindings(files: VariantFiles): ReturnType<typeof staticFindings> {
  const findings: ReturnType<typeof staticFindings> = [];

  for (const target of vendoredSkillTargets) {
    for (const finding of staticFindings(files[target])) {
      findings.push({ ...finding, path: `${target}/${finding.path}` });
    }
  }

  return findings;
}

function variantEntry(name: string) {
  const entry = skillSchema.parse({
    name,
    source: "vendored",
    repo: "https://example.invalid/skills.git",
    ref: "main",
    variants: {
      "claude-code": "dist/claude",
      codex: "dist/codex",
      opencode: "dist/opencode"
    }
  });

  if (entry.source !== "vendored" || !("variants" in entry)) {
    throw new Error("test fixture did not create a variant vendored entry");
  }

  return entry;
}

async function writeVariantTree(
  root: string,
  name: string,
  suffix = "same"
): Promise<{
  source: string;
  files: VariantFiles;
  digests: Record<VariantTarget, string>;
  digest: string;
}> {
  const source = path.join(root, "skills", "vendor", name);
  const files = variantFiles(name, suffix);

  for (const target of vendoredSkillTargets) {
    const directory = path.join(source, target);
    await mkdir(directory, { recursive: true });

    for (const file of files[target]) {
      await writeFile(path.join(directory, file.path), file.bytes, {
        mode: file.mode === "100755" ? 0o755 : 0o644
      });
    }
  }

  const digests = variantDigests(files);

  return { source, files, digests, digest: digestSkillFiles(variantRecords(files)) };
}

async function writeVariantLock(
  root: string,
  name: string,
  commit: string,
  digest: string,
  variants: Record<VariantTarget, string>
): Promise<void> {
  await mkdir(path.join(root, "skills"), { recursive: true });
  await writeFile(
    path.join(root, "skills", "vendor.lock.yml"),
    YAML.stringify({ skills: { [name]: { commit, digest, variants } } }),
    "utf8"
  );
}

type CandidateBaseline =
  | { kind: "none" }
  | { kind: "single"; commit: string; digest: string }
  | {
      kind: "variants";
      commit: string;
      digest: string;
      variants: Record<VariantTarget, string>;
    };

function candidateIdentityForTest(
  kind: "single" | "variants",
  name: string,
  repository: string,
  ref: string,
  sourceRoot: string,
  targetValues: readonly string[],
  commit: string,
  digest: string,
  baseline: CandidateBaseline
): string {
  const hash = createHash("sha256");

  const values = [
    "candidate-v2",
    kind,
    name,
    repository,
    ref,
    sourceRoot,
    ...targetValues,
    commit,
    digest,
    "baseline",
    JSON.stringify(baseline)
  ];

  for (const value of values) hash.update(frame(Buffer.from(value, "utf8")));

  return hash.digest("hex");
}

async function writeVariantCandidate(
  paths: ReturnType<typeof createRuntimePaths>,
  root: string,
  name: string,
  files: VariantFiles,
  oldCommit: string,
  commit: string
): Promise<string> {
  const records = variantRecords(files);
  const digests = variantDigests(files);
  const digest = digestSkillFiles(records);
  const inventoryContent = YAML.stringify({ files: inventory(records) });
  const findingsContent = YAML.stringify({ findings: variantFindings(files) });
  const diff = "";
  const repository = "https://example.invalid/skills.git";

  const subtrees = {
    "claude-code": "dist/claude",
    codex: "dist/codex",
    opencode: "dist/opencode"
  } satisfies Record<VariantTarget, string>;

  const baseline = {
    kind: "variants" as const,
    commit: oldCommit,
    digest,
    variants: digests
  } satisfies CandidateBaseline;

  const id = candidateIdentityForTest(
    "variants",
    name,
    repository,
    "main",
    root,
    vendoredSkillTargets.flatMap((target) => [target, subtrees[target], digests[target]]),
    commit,
    digest,
    baseline
  );

  const digestContent = `${digest}\n`;

  const provenance = {
    candidateId: id,
    name,
    repository,
    ref: "main",
    variants: {
      "claude-code": { subtree: subtrees["claude-code"], digest: digests["claude-code"] },
      codex: { subtree: subtrees.codex, digest: digests.codex },
      opencode: { subtree: subtrees["opencode"], digest: digests["opencode"] }
    },
    commit,
    digest,
    sourceRoot: root,
    oldCommit,
    oldDigest: digest,
    oldVariants: digests,
    artifacts: {
      inventory: sha256(inventoryContent),
      findings: sha256(findingsContent),
      diff: sha256(diff),
      digest: sha256(digestContent)
    }
  };

  const candidatePath = path.join(skillCandidatesRoot(paths), id);
  await mkdir(path.join(candidatePath, "source"), { recursive: true });

  for (const target of vendoredSkillTargets) {
    for (const file of files[target]) {
      await mkdir(path.join(candidatePath, "source", target), { recursive: true });
      await writeFile(path.join(candidatePath, "source", target, file.path), file.bytes, {
        mode: file.mode === "100755" ? 0o755 : 0o644
      });
    }
  }

  await writeFile(path.join(candidatePath, "provenance.yml"), YAML.stringify(provenance), "utf8");
  await writeFile(path.join(candidatePath, "inventory.yml"), inventoryContent, "utf8");
  await writeFile(path.join(candidatePath, "findings.yml"), findingsContent, "utf8");
  await writeFile(path.join(candidatePath, "diff.patch"), diff, "utf8");
  await writeFile(path.join(candidatePath, "digest"), digestContent, "utf8");

  return id;
}

async function writeLegacyState(
  root: string,
  name: string,
  content: string,
  commit: string
): Promise<string> {
  const source = path.join(root, "skills", "vendor", name);
  await mkdir(source, { recursive: true });
  const bytes = Buffer.from(content);
  await writeFile(path.join(source, "SKILL.md"), bytes);
  const digest = digestSkillFiles([{ path: "SKILL.md", mode: "100644", bytes }]);
  await mkdir(path.join(root, "skills"), { recursive: true });
  await writeFile(
    path.join(root, "skills", "vendor.lock.yml"),
    YAML.stringify({ skills: { [name]: { commit, digest } } }),
    "utf8"
  );

  return digest;
}

async function writeVendoredCatalog(root: string, entry: SkillEntry): Promise<void> {
  await writeFile(path.join(root, "mfz_home.yml"), "description: Test home\n", "utf8");
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await writeFile(
    path.join(root, "catalog", "skills.yml"),
    YAML.stringify({ skills: [entry] }),
    "utf8"
  );
}

function singleEntry(name: string) {
  const entry = skillSchema.parse({
    name,
    source: "vendored",
    repo: "https://example.invalid/skills.git",
    ref: "main",
    subtree: "dist/legacy"
  });

  if (entry.source !== "vendored" || "variants" in entry) {
    throw new Error("test fixture did not create a single-subtree vendored entry");
  }

  return entry;
}

async function gitRepository(
  files: Record<string, string>
): Promise<{ root: string; commit: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mfz-vendor-upstream-"));
  await execa("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execa("git", ["config", "user.name", "Mindframe Test"], { cwd: root });

  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }

  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["commit", "-qm", "fixture"], { cwd: root });
  const { stdout: commit } = await execa("git", ["rev-parse", "HEAD"], { cwd: root });

  return { root, commit };
}

async function withLocalGitFetch<T>(remote: string, action: () => Promise<T>): Promise<T> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "mfz-git-shim-"));
  const shim = path.join(bin, "git");
  await writeFile(
    shim,
    [
      "#!/usr/bin/env node",
      'import { spawnSync } from "node:child_process";',
      `const remote = ${JSON.stringify(remote)};`,
      'process.env.GIT_PROTOCOL_FROM_USER = "1";',
      "const args = process.argv.slice(2);",
      'const fetchIndex = args.indexOf("fetch");',
      "if (fetchIndex >= 0) {",
      '  const originIndex = args.indexOf("origin", fetchIndex + 1);',
      "  if (originIndex >= 0) {",
      "    args[originIndex] = remote;",
      "    for (let index = fetchIndex - 1; index >= 0; index -= 1) {",
      '      if (args[index] === "-c" && args[index + 1]?.startsWith("protocol.")) {',
      "        args.splice(index, 2);",
      "      }",
      "    }",
      "  }",
      "}",
      'const result = spawnSync("/usr/bin/git", args, { stdio: "inherit" });',
      "if (result.error) {",
      "  console.error(result.error);",
      "  process.exit(1);",
      "}",
      "process.exit(result.status ?? 1);",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;

  try {
    return await action();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

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

  it("validates all provider variant trees and their individual lock digests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-vendor-home-"));
    const name = "variant-skill";
    const fixture = await writeVariantTree(root, name);
    await writeVariantLock(root, name, "a".repeat(40), fixture.digest, fixture.digests);

    await expect(validateVendoredSkill(root, variantEntry(name))).resolves.toBeUndefined();

    await writeVariantLock(root, name, "a".repeat(40), fixture.digest, {
      ...fixture.digests,
      codex: "b".repeat(64)
    });
    await expect(validateVendoredSkill(root, variantEntry(name))).rejects.toThrow(
      /codex integrity mismatch/
    );
  });

  it("rejects missing, unexpected, and colliding provider variant entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-layout-home-"));
    const name = "variant-skill";
    const fixture = await writeVariantTree(root, name);
    await writeVariantLock(root, name, "a".repeat(40), fixture.digest, fixture.digests);
    await rm(path.join(fixture.source, "codex"), { recursive: true, force: true });

    await expect(validateVendoredSkill(root, variantEntry(name))).rejects.toThrow(
      "missing provider variant: codex"
    );

    await mkdir(path.join(fixture.source, "codex"), { recursive: true });
    await mkdir(path.join(fixture.source, "extra"), { recursive: true });
    await expect(validateVendoredSkill(root, variantEntry(name))).rejects.toThrow(
      "unknown provider variant: extra"
    );

    await rm(path.join(fixture.source, "extra"), { recursive: true, force: true });
    await writeFile(path.join(fixture.source, "claude-code", "skill.md"), "duplicate\n", "utf8");
    await expect(validateVendoredSkill(root, variantEntry(name))).rejects.toThrow(
      /colliding paths/
    );
  });

  it("rejects a tampered provider variant payload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-tamper-home-"));
    const name = "variant-skill";
    const fixture = await writeVariantTree(root, name);
    await writeVariantLock(root, name, "a".repeat(40), fixture.digest, fixture.digests);
    await writeFile(
      path.join(fixture.source, "opencode", "SKILL.md"),
      `---\nname: ${name}\ndescription: tampered\n---\n`,
      "utf8"
    );

    await expect(validateVendoredSkill(root, variantEntry(name))).rejects.toThrow(
      /integrity mismatch/
    );
  });

  it("stages and promotes variants over a promoted single-subtree state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-migration-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-migration-home-"));
    const name = "variant-migration";
    const entry = variantEntry(name);
    const oldCommit = "a".repeat(40);
    const oldContent = `---\nname: ${name}\ndescription: old\n---\n\n# Old\n`;
    const oldDigest = await writeLegacyState(root, name, oldContent, oldCommit);
    await writeVendoredCatalog(root, entry);

    const upstream = await gitRepository({
      "dist/claude/SKILL.md": `---\nname: ${name}\ndescription: claude\n---\n\n# Claude\n`,
      "dist/codex/SKILL.md": `---\nname: ${name}\ndescription: codex\n---\n\n# Codex\n`,
      "dist/opencode/SKILL.md": `---\nname: ${name}\ndescription: opencode\n---\n\n# OpenCode\n`
    });

    const paths = createRuntimePaths({ root, home });

    await expect(validateVendoredSkill(root, entry)).resolves.toBeUndefined();
    await expect(validateVendoredSkills(root)).resolves.toEqual([]);

    const checked = await withLocalGitFetch(upstream.root, () =>
      checkVendoredSkill(paths, entry, root)
    );

    expect(checked).toMatchObject({
      pinned: { commit: oldCommit, digest: oldDigest },
      observedCommit: upstream.commit,
      changed: true
    });

    const candidate = await withLocalGitFetch(upstream.root, () =>
      stageVendoredSkill(paths, entry, root, upstream.commit)
    );

    if (candidate.provenance.variants === undefined) {
      throw new Error("test fixture did not create a variant candidate");
    }

    expect(candidate.provenance).toMatchObject({
      oldCommit,
      oldDigest,
      commit: upstream.commit,
      variants: {
        "claude-code": { subtree: "dist/claude" },
        codex: { subtree: "dist/codex" },
        opencode: { subtree: "dist/opencode" }
      }
    });
    expect(candidate.provenance.oldVariants).toBeUndefined();
    expect(candidate.diff).toContain("--- old/SKILL.md");
    expect(candidate.diff).toContain("+++ new/claude-code/SKILL.md");

    const oldPath = path.join(root, "skills", "vendor", name, "SKILL.md");
    await writeFile(oldPath, `${oldContent}tampered\n`, "utf8");
    await expect(promoteVendoredSkill(paths, candidate.provenance.candidateId)).rejects.toThrow(
      /integrity mismatch/
    );
    await writeFile(oldPath, oldContent, "utf8");

    await promoteVendoredSkill(paths, candidate.provenance.candidateId);

    await expect(readFile(oldPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    for (const target of vendoredSkillTargets) {
      await expect(
        readFile(path.join(root, "skills", "vendor", name, target, "SKILL.md"), "utf8")
      ).resolves.toContain(
        target === "opencode" ? "OpenCode" : target === "claude-code" ? "Claude" : "Codex"
      );
    }

    await expect(validateVendoredSkill(root, entry)).resolves.toBeUndefined();
    const lock = YAML.parse(await readFile(path.join(root, "skills", "vendor.lock.yml"), "utf8"));
    expect(lock.skills[name]).toEqual({
      commit: upstream.commit,
      digest: candidate.provenance.digest,
      variants: {
        "claude-code": candidate.provenance.variants["claude-code"].digest,
        codex: candidate.provenance.variants.codex.digest,
        opencode: candidate.provenance.variants["opencode"].digest
      }
    });
  });

  it("stages and promotes a single subtree over a promoted variant state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-single-migration-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-single-migration-home-"));
    const name = "single-migration";
    const entry = singleEntry(name);
    const oldCommit = "a".repeat(40);
    const oldFixture = await writeVariantTree(root, name);
    await writeVariantLock(root, name, oldCommit, oldFixture.digest, oldFixture.digests);
    await writeVendoredCatalog(root, entry);

    const upstream = await gitRepository({
      "dist/legacy/SKILL.md": `---\nname: ${name}\ndescription: new\n---\n\n# New\n`
    });

    const paths = createRuntimePaths({ root, home });

    await expect(validateVendoredSkill(root, entry)).resolves.toBeUndefined();

    const candidate = await withLocalGitFetch(upstream.root, () =>
      stageVendoredSkill(paths, entry, root, upstream.commit)
    );

    expect(candidate.provenance).toMatchObject({
      oldCommit,
      oldDigest: oldFixture.digest,
      commit: upstream.commit,
      subtree: "dist/legacy"
    });
    expect(candidate.provenance.oldVariants).toEqual(oldFixture.digests);

    await writeVariantLock(root, name, oldCommit, oldFixture.digest, {
      ...oldFixture.digests,
      codex: "b".repeat(64)
    });
    await expect(promoteVendoredSkill(paths, candidate.provenance.candidateId)).rejects.toThrow(
      "Candidate baseline does not match the active vendor state"
    );
    await writeVariantLock(root, name, oldCommit, oldFixture.digest, oldFixture.digests);

    await promoteVendoredSkill(paths, candidate.provenance.candidateId);

    await expect(
      readFile(path.join(root, "skills", "vendor", name, "SKILL.md"), "utf8")
    ).resolves.toContain("description: new");

    for (const target of vendoredSkillTargets) {
      await expect(lstat(path.join(root, "skills", "vendor", name, target))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }

    await expect(validateVendoredSkill(root, entry)).resolves.toBeUndefined();
    const lock = YAML.parse(await readFile(path.join(root, "skills", "vendor.lock.yml"), "utf8"));
    expect(lock.skills[name]).toEqual({
      commit: upstream.commit,
      digest: candidate.provenance.digest
    });
  });

  it("binds candidate identity and reuse to the complete trusted baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-baseline-bound-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-baseline-bound-home-"));
    const name = "baseline-bound";
    const entry = singleEntry(name);
    await writeVendoredCatalog(root, entry);

    const upstream = await gitRepository({
      "dist/legacy/SKILL.md": `---\nname: ${name}\ndescription: new\n---\n\n# New\n`
    });

    const paths = createRuntimePaths({ root, home });

    const withoutBaseline = await withLocalGitFetch(upstream.root, () =>
      stageVendoredSkill(paths, entry, root, upstream.commit)
    );

    expect(withoutBaseline.provenance.oldCommit).toBeUndefined();

    const originalProvenance = await readFile(
      path.join(withoutBaseline.path, "provenance.yml"),
      "utf8"
    );

    const oldCommit = "a".repeat(40);

    const oldDigest = await writeLegacyState(
      root,
      name,
      `---\nname: ${name}\ndescription: old\n---\n\n# Old\n`,
      oldCommit
    );

    const withBaseline = await withLocalGitFetch(upstream.root, () =>
      stageVendoredSkill(paths, entry, root, upstream.commit)
    );

    expect(withBaseline.provenance.candidateId).not.toBe(withoutBaseline.provenance.candidateId);
    expect(withBaseline.provenance).toMatchObject({ oldCommit, oldDigest });
    expect(await readFile(path.join(withoutBaseline.path, "provenance.yml"), "utf8")).toBe(
      originalProvenance
    );
    const preserved = await readCandidate(paths, withoutBaseline.provenance.candidateId);
    expect(preserved.provenance.oldCommit).toBeUndefined();
    expect(preserved.provenance.oldDigest).toBeUndefined();

    const repeated = await withLocalGitFetch(upstream.root, () =>
      stageVendoredSkill(paths, entry, root, upstream.commit)
    );

    expect(repeated.provenance.candidateId).toBe(withBaseline.provenance.candidateId);
  });

  it("rejects promotion after the trusted baseline changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-stale-baseline-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-stale-baseline-home-"));
    const name = "stale-baseline";
    const entry = singleEntry(name);
    await writeVendoredCatalog(root, entry);
    const firstCommit = "a".repeat(40);

    const firstDigest = await writeLegacyState(
      root,
      name,
      `---\nname: ${name}\ndescription: first\n---\n\n# First\n`,
      firstCommit
    );

    const upstream = await gitRepository({
      "dist/legacy/SKILL.md": `---\nname: ${name}\ndescription: new\n---\n\n# New\n`
    });

    const paths = createRuntimePaths({ root, home });

    const candidate = await withLocalGitFetch(upstream.root, () =>
      stageVendoredSkill(paths, entry, root, upstream.commit)
    );

    const secondCommit = "b".repeat(40);

    const secondDigest = await writeLegacyState(
      root,
      name,
      `---\nname: ${name}\ndescription: second\n---\n\n# Second\n`,
      secondCommit
    );

    await expect(promoteVendoredSkill(paths, candidate.provenance.candidateId)).rejects.toThrow(
      "Candidate baseline does not match the active vendor state"
    );
    expect(candidate.provenance).toMatchObject({ oldCommit: firstCommit, oldDigest: firstDigest });
    expect(await readFile(path.join(root, "skills", "vendor", name, "SKILL.md"), "utf8")).toContain(
      "description: second"
    );
    const lock = YAML.parse(await readFile(path.join(root, "skills", "vendor.lock.yml"), "utf8"));
    expect(lock.skills[name]).toEqual({ commit: secondCommit, digest: secondDigest });
  });

  it("rejects a shape transition when the promoted payload has drifted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-transition-drift-root-"));
    const name = "transition-drift";
    const entry = variantEntry(name);
    const oldContent = `---\nname: ${name}\ndescription: old\n---\n\n# Old\n`;
    const oldDigest = await writeLegacyState(root, name, oldContent, "a".repeat(40));
    await writeVendoredCatalog(root, entry);
    await writeFile(
      path.join(root, "skills", "vendor", name, "SKILL.md"),
      `${oldContent}changed\n`,
      "utf8"
    );

    await expect(validateVendoredSkill(root, entry)).rejects.toThrow(/integrity mismatch/);
    await expect(validateVendoredSkills(root)).resolves.toEqual([
      expect.stringContaining(`expected ${oldDigest}`)
    ]);
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

  it("does not reinterpret a valid pinned Git declaration as migration input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-pinned-not-legacy-"));
    await mkdir(path.join(root, "catalog"), { recursive: true });
    await writeFile(
      path.join(root, "catalog", "skills.yml"),
      YAML.stringify({
        skills: [
          {
            name: "trusted",
            source: "git",
            repo: "https://example.invalid/skills",
            commit: "a".repeat(40),
            subtree: "skills/trusted"
          },
          { name: "old", source: "git", repo: "https://example.invalid/old" }
        ]
      }),
      "utf8"
    );

    const legacy = await readLegacyGitSkills(root);

    expect(legacy.map((entry) => entry.name)).toEqual(["old"]);
  });

  it("discovers legacy declarations in an inherited home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-child-"));
    const upstream = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-upstream-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-machine-"));
    await writeFile(
      path.join(root, "mfz_home.yml"),
      YAML.stringify({ extends: { name: "upstream", repo: upstream, path: upstream } }),
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

  it("reads a remote-declared upstream home from its configured path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-remote-child-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-legacy-remote-machine-"));
    const configured = path.join(home, "workspace", "repos", "shared-home");
    await writeFile(
      path.join(root, "mfz_home.yml"),
      YAML.stringify({
        extends: { name: "shared", repo: "https://example.invalid/shared.git", path: configured }
      }),
      "utf8"
    );
    const managedFallback = path.join(home, ".mindframe-z", "homes", "shared");
    await mkdir(path.join(configured, "catalog"), { recursive: true });
    await writeFile(path.join(configured, "mfz_home.yml"), "description: shared\n", "utf8");
    await writeFile(
      path.join(configured, "catalog", "skills.yml"),
      YAML.stringify({
        skills: [{ name: "shared-skill", source: "git", repo: "https://example.invalid/shared" }]
      }),
      "utf8"
    );
    await mkdir(path.join(managedFallback, "catalog"), { recursive: true });
    await writeFile(path.join(managedFallback, "mfz_home.yml"), "description: managed\n", "utf8");
    await writeFile(
      path.join(managedFallback, "catalog", "skills.yml"),
      YAML.stringify({
        skills: [{ name: "managed-skill", source: "git", repo: "https://example.invalid/managed" }]
      }),
      "utf8"
    );

    const legacy = await readLegacyGitSkills(root, home);

    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ name: "shared-skill", sourceRoot: configured });
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

    const candidateId = candidateIdentityForTest(
      "single",
      name,
      "https://example.invalid/skills.git",
      "main",
      path.join(home, "not-the-active-home"),
      ["skills/test-skill"],
      "b".repeat(40),
      digest,
      { kind: "single", commit: "a".repeat(40), digest: oldDigest }
    );

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

    await promoteVendoredSkill(createRuntimePaths({ root, home }), candidateId);

    await expect(readFile(path.join(source, "SKILL.md"), "utf8")).resolves.toBe(newContent);
    await expect(readFile(path.join(root, "skills", "vendor.lock.yml"), "utf8")).resolves.toContain(
      "b".repeat(40)
    );
    await expect(
      lstat(path.join(home, ".mindframe-z", "configs", "personal", "skills"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes one logical provider-variant skill and preserves per-target provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-promote-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-promote-home-"));
    const name = "variant-skill";
    const oldCommit = "a".repeat(40);
    const newCommit = "b".repeat(40);
    const repository = "https://example.invalid/skills.git";
    await writeFile(path.join(root, "mfz_home.yml"), "description: Test\n", "utf8");
    await mkdir(path.join(root, "catalog"), { recursive: true });
    await writeFile(
      path.join(root, "catalog", "skills.yml"),
      YAML.stringify({
        skills: [
          {
            name,
            source: "vendored",
            repo: repository,
            ref: "main",
            variants: {
              "claude-code": "dist/claude",
              codex: "dist/codex",
              opencode: "dist/opencode"
            }
          }
        ]
      }),
      "utf8"
    );
    const fixture = await writeVariantTree(root, name);
    await writeVariantLock(root, name, oldCommit, fixture.digest, fixture.digests);
    const paths = createRuntimePaths({ root, home });

    const candidateId = await writeVariantCandidate(
      paths,
      root,
      name,
      fixture.files,
      oldCommit,
      newCommit
    );

    await promoteVendoredSkill(paths, candidateId);

    const lock = YAML.parse(await readFile(path.join(root, "skills", "vendor.lock.yml"), "utf8"));
    expect(lock.skills[name]).toEqual({
      commit: newCommit,
      digest: fixture.digest,
      variants: fixture.digests
    });

    for (const target of vendoredSkillTargets) {
      await expect(
        readFile(path.join(root, "skills", "vendor", name, target, "SKILL.md"), "utf8")
      ).resolves.toContain(target);
    }
  });

  it("rejects a provider-variant candidate after its source is tampered", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-candidate-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-variant-candidate-home-"));
    const name = "variant-skill";
    const fixture = await writeVariantTree(root, name);
    const paths = createRuntimePaths({ root, home });

    const candidateId = await writeVariantCandidate(
      paths,
      root,
      name,
      fixture.files,
      "a".repeat(40),
      "b".repeat(40)
    );

    await writeFile(
      path.join(skillCandidatesRoot(paths), candidateId, "source", "codex", "SKILL.md"),
      `---\nname: ${name}\ndescription: tampered\n---\n`,
      "utf8"
    );

    await expect(
      revalidateCandidate(paths, await readCandidate(paths, candidateId))
    ).rejects.toThrow("Candidate content digest changed");
  });
});
