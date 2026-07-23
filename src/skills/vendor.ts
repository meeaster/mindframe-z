import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  skillsManifestSchema,
  skillSchema,
  vendorLockSchema,
  type SkillEntry,
  type VendorLock,
  type VendorLockEntry
} from "../core/manifests.js";
import {
  expandHome,
  skillCandidatesRoot,
  vendorLockPath,
  type RuntimePaths
} from "../core/paths.js";
import { pathExists } from "../core/fs-util.js";
import { fetchCommit, normalizedRepository, readGitSkillFiles, safeGitRevision } from "./git.js";
import { commitVendoredPromotion, recoverVendoredPromotion } from "./transaction.js";
import {
  comparePosixBytes,
  copySkillFiles,
  digestSkillFiles,
  frame,
  inventory,
  isBinary,
  assertNoSymlinkAncestors,
  readSkillFiles,
  sha256,
  staticFindings,
  validateSkillRecords,
  type SkillFinding,
  type SkillFileRecord,
  type SkillInventoryEntry
} from "./tree.js";

export { digestSkillFiles, digestSkillTree, readSkillFiles, validateSkillRecords } from "./tree.js";

const fullCommitPattern = /^[0-9a-f]{40}$/;

const candidateHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const candidateProvenanceSchema = z
  .object({
    candidateId: candidateHashSchema,
    name: z.string().min(1),
    repository: z.string().url(),
    ref: z.string().min(1).refine(safeGitRevision),
    subtree: z.string().min(1),
    commit: z.string().regex(fullCommitPattern),
    digest: candidateHashSchema,
    sourceRoot: z.string().min(1),
    oldCommit: z.string().regex(fullCommitPattern).optional(),
    oldDigest: candidateHashSchema.optional(),
    artifacts: z
      .object({
        inventory: candidateHashSchema,
        findings: candidateHashSchema,
        diff: candidateHashSchema,
        digest: candidateHashSchema
      })
      .strict()
  })
  .strict()
  .refine((value) => Boolean(value.oldCommit) === Boolean(value.oldDigest), {
    message: "oldCommit and oldDigest must be supplied together"
  });

const candidateInventorySchema = z
  .object({
    path: z.string().min(1),
    mode: z.enum(["100644", "100755"]),
    bytes: z.number().int().nonnegative(),
    sha256: candidateHashSchema
  })
  .strict();
const candidateFindingSchema = z
  .object({ path: z.string().min(1), kind: z.string().min(1), detail: z.string() })
  .strict();

interface CatalogEntryResolution {
  entry: Extract<SkillEntry, { source: "vendored" }>;
  migrated: boolean;
  document?: Record<string, unknown>;
}

interface PromotionTarget {
  root: string;
  catalog: CatalogEntryResolution;
  lock: VendorLock;
  oldFiles: SkillFileRecord[];
}

async function activeHomeRoots(
  root: string,
  machineHome: string,
  seen = new Set<string>()
): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  if (seen.has(resolvedRoot)) return [];
  seen.add(resolvedRoot);
  const roots = [resolvedRoot];
  try {
    const parsed = YAML.parse(await readFile(path.join(resolvedRoot, "mfz_home.yml"), "utf8")) as {
      extends?: { name?: string; repo?: string };
    };
    const extension = parsed.extends;
    if (!extension?.name || !extension.repo) return roots;
    const local =
      extension.repo.startsWith("/") ||
      extension.repo.startsWith(".") ||
      extension.repo.startsWith("~/");
    const upstream = local
      ? path.resolve(expandHome(extension.repo, machineHome))
      : path.join(machineHome, ".mindframe-z", "homes", extension.name);
    if (await pathExists(path.join(upstream, "mfz_home.yml"))) {
      roots.push(...(await activeHomeRoots(upstream, machineHome, seen)));
    }
  } catch {
    // The target catalog read below reports malformed or missing homes.
  }
  return roots;
}

export interface CandidateProvenance {
  candidateId: string;
  name: string;
  repository: string;
  ref: string;
  subtree: string;
  commit: string;
  digest: string;
  sourceRoot: string;
  oldCommit?: string;
  oldDigest?: string;
  artifacts?: {
    inventory: string;
    findings: string;
    diff: string;
    digest: string;
  };
}

export interface SkillCandidate {
  path: string;
  sourcePath: string;
  provenance: CandidateProvenance;
  inventory: SkillInventoryEntry[];
  findings: SkillFinding[];
  diff: string;
}

export type LegacySkillEntry = Extract<SkillEntry, { source: "vendored" }> & {
  sourceRoot: string;
};

export async function validateVendoredSkill(
  root: string,
  entry: Extract<SkillEntry, { source: "vendored" }>,
  lock?: VendorLock
): Promise<void> {
  await recoverVendoredPromotion(root);
  const resolvedLock = lock ?? (await readVendorLock(root));
  const locked = resolvedLock.skills[entry.name];
  if (!locked) throw new Error(`Vendored skill ${entry.name} has no vendor lock entry`);
  const sourcePath = path.join(root, "skills", "vendor", entry.name);
  await assertNoSymlinkAncestors(root, sourcePath);
  const files = await readSkillFiles(sourcePath);
  validateSkillRecords(files);
  const digest = digestSkillFiles(files);
  if (digest !== locked.digest) {
    throw new Error(
      `Vendored skill ${entry.name} integrity mismatch: expected ${locked.digest}, got ${digest}`
    );
  }
}

export async function readVendorLock(root: string): Promise<VendorLock> {
  await recoverVendoredPromotion(root);
  return parseVendorLock(root);
}

async function parseVendorLock(root: string): Promise<VendorLock> {
  return vendorLockSchema.parse(YAML.parse(await readFile(vendorLockPath(root), "utf8")));
}

export async function validateVendoredSkills(root: string): Promise<string[]> {
  let entries: SkillEntry[];
  try {
    entries = skillsManifestSchema.parse(
      YAML.parse(await readFile(path.join(root, "catalog", "skills.yml"), "utf8"))
    ).skills;
  } catch {
    return [];
  }
  const vendored = entries.filter(
    (entry): entry is Extract<SkillEntry, { source: "vendored" }> => entry.source === "vendored"
  );
  if (vendored.length === 0) {
    try {
      const lock = await readVendorLock(root);
      return Object.keys(lock.skills).map(
        (name) => `${name}: vendor lock entry has no vendored catalog declaration`
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [`${vendorLockPath(root)}: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  const failures: string[] = [];
  let lock: VendorLock;
  try {
    lock = await readVendorLock(root);
  } catch (error) {
    return [`${vendorLockPath(root)}: ${error instanceof Error ? error.message : String(error)}`];
  }
  for (const entry of vendored) {
    try {
      await validateVendoredSkill(root, entry, lock);
    } catch (error) {
      failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const declaredNames = new Set(vendored.map((entry) => entry.name));
  for (const name of Object.keys(lock.skills)) {
    if (!declaredNames.has(name)) {
      failures.push(`${name}: vendor lock entry has no vendored catalog declaration`);
    }
  }
  return failures;
}

function lineDiff(
  oldFile: SkillFileRecord | undefined,
  newFile: SkillFileRecord | undefined,
  file: string
): string {
  const lines = [`--- old/${file}`, `+++ new/${file}`];
  if (oldFile?.mode !== newFile?.mode) {
    if (oldFile) lines.push(`old mode ${oldFile.mode}`);
    if (newFile) lines.push(`new mode ${newFile.mode}`);
  }
  if (oldFile && newFile && (isBinary(oldFile.bytes) || isBinary(newFile.bytes))) {
    lines.push("Binary files differ");
    return `${lines.join("\n")}\n`;
  }
  const oldLines = (oldFile?.bytes.toString("utf8") ?? "").split("\n");
  const newLines = (newFile?.bytes.toString("utf8") ?? "").split("\n");
  for (const line of oldLines) lines.push(`-${line}`);
  for (const line of newLines) lines.push(`+${line}`);
  return `${lines.join("\n")}\n`;
}

function buildDiff(
  oldFiles: readonly SkillFileRecord[],
  newFiles: readonly SkillFileRecord[]
): string {
  const oldByPath = new Map(oldFiles.map((file) => [file.path, file]));
  const newByPath = new Map(newFiles.map((file) => [file.path, file]));
  const changed = [...new Set([...oldByPath.keys(), ...newByPath.keys()])]
    .sort(comparePosixBytes)
    .filter((file) => {
      const oldFile = oldByPath.get(file);
      const newFile = newByPath.get(file);
      return (
        !oldFile ||
        !newFile ||
        oldFile.mode !== newFile.mode ||
        !oldFile.bytes.equals(newFile.bytes)
      );
    });
  return changed.map((file) => lineDiff(oldByPath.get(file), newByPath.get(file), file)).join("\n");
}

function candidateIdentity(
  name: string,
  repository: string,
  subtree: string,
  commit: string,
  digest: string
): string {
  const hash = createHash("sha256");
  for (const value of [name, repository, subtree, commit, digest]) {
    hash.update(frame(Buffer.from(value, "utf8")));
  }
  return hash.digest("hex");
}

function candidateFile(root: string, name: string): string {
  return path.join(root, name);
}

async function writeCandidate(
  candidate: SkillCandidate,
  files: readonly SkillFileRecord[]
): Promise<void> {
  const parent = path.dirname(candidate.path);
  await assertNoSymlinkAncestors(parent, candidate.path);
  await mkdir(parent, { recursive: true });
  const temporary = `${candidate.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await rm(temporary, { recursive: true, force: true });
  await copySkillFiles(files, path.join(temporary, "source"));
  const inventoryContent = YAML.stringify({ files: candidate.inventory });
  const findingsContent = YAML.stringify({ findings: candidate.findings });
  const digestContent = `${candidate.provenance.digest}\n`;
  const provenance = {
    ...candidate.provenance,
    artifacts: {
      inventory: sha256(inventoryContent),
      findings: sha256(findingsContent),
      diff: sha256(candidate.diff),
      digest: sha256(digestContent)
    }
  } satisfies CandidateProvenance;
  candidate.provenance = provenance;
  await writeFile(path.join(temporary, "provenance.yml"), YAML.stringify(provenance), "utf8");
  await writeFile(path.join(temporary, "inventory.yml"), inventoryContent, "utf8");
  await writeFile(path.join(temporary, "findings.yml"), findingsContent, "utf8");
  await writeFile(path.join(temporary, "diff.patch"), candidate.diff, "utf8");
  await writeFile(path.join(temporary, "digest"), digestContent, "utf8");
  await rename(temporary, candidate.path);
}

export async function stageVendoredSkill(
  paths: RuntimePaths,
  rawEntry: Extract<SkillEntry, { source: "vendored" }>,
  sourceRoot: string,
  revision?: string
): Promise<SkillCandidate> {
  const parsedEntry = skillSchema.parse({
    name: rawEntry.name,
    source: rawEntry.source,
    repo: rawEntry.repo,
    ref: rawEntry.ref,
    subtree: rawEntry.subtree,
    description: rawEntry.description
  });
  if (parsedEntry.source !== "vendored") throw new Error("Skill staging requires a vendored entry");
  const entry = parsedEntry;
  const repository = normalizedRepository(entry.repo);
  const requestedRevision = revision ?? entry.ref;
  if (revision && !fullCommitPattern.test(revision)) {
    throw new Error(`Explicit skill revision must be a full commit SHA: ${revision}`);
  }
  const { cache, commit } = await fetchCommit(paths, repository, requestedRevision);
  const files = await readGitSkillFiles(cache, commit, entry.subtree);
  const digest = digestSkillFiles(files);
  const oldPath = path.join(sourceRoot, "skills", "vendor", entry.name);
  await assertNoSymlinkAncestors(sourceRoot, oldPath);
  let oldFiles: SkillFileRecord[] = [];
  try {
    oldFiles = await readSkillFiles(oldPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A first import has no old subtree to diff.
  }
  let oldLock: VendorLockEntry | undefined;
  try {
    oldLock = (await readVendorLock(sourceRoot)).skills[entry.name];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // The candidate still carries enough provenance to be reviewed before first promotion.
  }
  if (oldLock && digestSkillFiles(oldFiles) !== oldLock.digest) {
    throw new Error(`Vendored skill ${entry.name} source does not match its vendor lock`);
  }
  const id = candidateIdentity(entry.name, repository, entry.subtree, commit, digest);
  const provenance: CandidateProvenance = {
    candidateId: id,
    name: entry.name,
    repository,
    ref: entry.ref,
    subtree: entry.subtree,
    commit,
    digest,
    sourceRoot,
    ...(oldLock ? { oldCommit: oldLock.commit, oldDigest: oldLock.digest } : {})
  };
  const candidate: SkillCandidate = {
    path: candidateFile(skillCandidatesRoot(paths), id),
    sourcePath: candidateFile(skillCandidatesRoot(paths), path.join(id, "source")),
    provenance,
    inventory: inventory(files),
    findings: staticFindings(files),
    diff: buildDiff(oldFiles, files)
  };
  await assertNoSymlinkAncestors(paths.home, candidate.path);
  try {
    await lstat(candidate.path);
    const existing = await readCandidate(paths, id);
    await revalidateCandidate(paths, existing);
    return existing;
  } catch (error) {
    try {
      await lstat(candidate.path);
      throw error;
    } catch (existingError) {
      if (existingError === error) throw error;
    }
    await writeCandidate(candidate, files);
    return candidate;
  }
}

function parseCandidateProvenance(value: unknown): CandidateProvenance {
  return candidateProvenanceSchema.parse(value) as CandidateProvenance;
}

export async function readCandidate(paths: RuntimePaths, id: string): Promise<SkillCandidate> {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`Invalid candidate identity: ${id}`);
  const candidatePath = candidateFile(skillCandidatesRoot(paths), id);
  await assertNoSymlinkAncestors(skillCandidatesRoot(paths), candidatePath);
  const readEvidence = async (name: string): Promise<Buffer> => {
    const file = path.join(candidatePath, name);
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Candidate evidence is not a regular file: ${file}`);
    }
    return readFile(file);
  };
  const provenance = parseCandidateProvenance(
    YAML.parse((await readEvidence("provenance.yml")).toString("utf8"))
  );
  if (provenance.candidateId !== id)
    throw new Error("Candidate identity does not match provenance");
  const inventoryDoc = z
    .object({ files: z.array(candidateInventorySchema) })
    .strict()
    .parse(YAML.parse((await readEvidence("inventory.yml")).toString("utf8")));
  const findingsDoc = z
    .object({ findings: z.array(candidateFindingSchema) })
    .strict()
    .parse(YAML.parse((await readEvidence("findings.yml")).toString("utf8")));
  return {
    path: candidatePath,
    sourcePath: path.join(candidatePath, "source"),
    provenance,
    inventory: inventoryDoc.files,
    findings: findingsDoc.findings,
    diff: (await readEvidence("diff.patch")).toString("utf8")
  };
}

export async function revalidateCandidate(
  paths: RuntimePaths,
  candidate: SkillCandidate
): Promise<SkillFileRecord[]> {
  const expectedPath = candidateFile(skillCandidatesRoot(paths), candidate.provenance.candidateId);
  if (
    path.resolve(candidate.path) !== path.resolve(expectedPath) ||
    path.resolve(candidate.sourcePath) !== path.resolve(path.join(expectedPath, "source"))
  ) {
    throw new Error("Candidate path changed");
  }
  await assertNoSymlinkAncestors(skillCandidatesRoot(paths), expectedPath);
  await assertNoSymlinkAncestors(skillCandidatesRoot(paths), candidate.sourcePath);
  const files = await readSkillFiles(candidate.sourcePath);
  validateSkillRecords(files);
  const digest = digestSkillFiles(files);
  if (digest !== candidate.provenance.digest) throw new Error("Candidate content digest changed");
  const actualInventory = inventory(files);
  if (JSON.stringify(actualInventory) !== JSON.stringify(candidate.inventory)) {
    throw new Error("Candidate inventory changed");
  }
  const actualFindings = staticFindings(files);
  if (JSON.stringify(actualFindings) !== JSON.stringify(candidate.findings)) {
    throw new Error("Candidate deterministic findings changed");
  }
  const artifactFiles = await Promise.all([
    readCandidateEvidence(candidate.path, "inventory.yml"),
    readCandidateEvidence(candidate.path, "findings.yml"),
    readCandidateEvidence(candidate.path, "diff.patch"),
    readCandidateEvidence(candidate.path, "digest")
  ]);
  const artifacts = candidate.provenance.artifacts;
  if (
    !artifacts ||
    artifacts.inventory !== sha256(artifactFiles[0]) ||
    artifacts.findings !== sha256(artifactFiles[1]) ||
    artifacts.diff !== sha256(artifactFiles[2]) ||
    artifacts.digest !== sha256(artifactFiles[3])
  ) {
    throw new Error("Candidate review evidence changed");
  }
  if (artifactFiles[3].toString("utf8") !== `${candidate.provenance.digest}\n`) {
    throw new Error("Candidate digest evidence changed");
  }
  const expected = candidateIdentity(
    candidate.provenance.name,
    normalizedRepository(candidate.provenance.repository),
    candidate.provenance.subtree,
    candidate.provenance.commit,
    candidate.provenance.digest
  );
  if (expected !== candidate.provenance.candidateId) throw new Error("Candidate identity changed");
  void paths;
  return files;
}

async function readCandidateEvidence(candidatePath: string, name: string): Promise<Buffer> {
  const file = path.join(candidatePath, name);
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Candidate evidence is not a regular file: ${file}`);
  }
  return readFile(file);
}

async function resolveCatalogEntry(
  root: string,
  candidate: CandidateProvenance
): Promise<CatalogEntryResolution> {
  const catalogPath = path.join(root, "catalog", "skills.yml");
  const raw = YAML.parse(await readFile(catalogPath, "utf8")) as unknown;
  try {
    const manifests = skillsManifestSchema.parse(raw);
    const entry = manifests.skills.find(
      (skill): skill is Extract<SkillEntry, { source: "vendored" }> =>
        skill.name === candidate.name && skill.source === "vendored"
    );
    if (!entry) throw new Error(`Candidate skill is not a vendored declaration: ${candidate.name}`);
    return { entry, migrated: false };
  } catch (error) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw error;
    const document = raw as Record<string, unknown>;
    const skills = document.skills;
    if (!Array.isArray(skills)) throw error;
    const index = skills.findIndex(
      (skill) =>
        skill &&
        typeof skill === "object" &&
        !Array.isArray(skill) &&
        (skill as Record<string, unknown>).name === candidate.name &&
        (skill as Record<string, unknown>).source === "git"
    );
    if (index < 0) {
      const existing = skills.find(
        (skill) =>
          skill &&
          typeof skill === "object" &&
          !Array.isArray(skill) &&
          (skill as Record<string, unknown>).name === candidate.name
      );
      if (!existing) throw error;
      const entry = skillSchema.parse(existing);
      if (entry.source !== "vendored") throw error;
      return { entry, migrated: false };
    }
    const legacy = skills[index] as Record<string, unknown>;
    const entry = skillSchema.parse({
      name: candidate.name,
      source: "vendored",
      repo: legacy.repo,
      ref: candidate.ref,
      subtree: candidate.subtree,
      description: typeof legacy.description === "string" ? legacy.description : ""
    });
    if (entry.source !== "vendored")
      throw new Error("Legacy migration produced a non-vendored entry");
    const migratedSkills = [...skills];
    migratedSkills[index] = entry;
    return { entry, migrated: true, document: { ...document, skills: migratedSkills } };
  }
}

async function locatePromotionTarget(
  paths: RuntimePaths,
  candidate: CandidateProvenance
): Promise<PromotionTarget> {
  const matches: PromotionTarget[] = [];
  for (const root of await activeHomeRoots(paths.root, paths.home)) {
    let catalog: CatalogEntryResolution;
    try {
      catalog = await resolveCatalogEntry(root, candidate);
    } catch {
      continue;
    }
    const entry = catalog.entry;
    if (
      normalizedRepository(entry.repo) !== candidate.repository ||
      entry.subtree !== candidate.subtree ||
      entry.ref !== candidate.ref
    ) {
      continue;
    }
    let lock: VendorLock;
    try {
      lock = await parseVendorLock(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      lock = { skills: {} };
    }
    const current = lock.skills[entry.name];
    if (current) {
      if (
        !candidate.oldCommit ||
        current.commit !== candidate.oldCommit ||
        current.digest !== candidate.oldDigest
      ) {
        continue;
      }
    } else if (candidate.oldCommit) {
      continue;
    }
    const source = path.join(root, "skills", "vendor", entry.name);
    await assertNoSymlinkAncestors(root, source);
    let oldFiles: SkillFileRecord[] = [];
    try {
      oldFiles = await readSkillFiles(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current && digestSkillFiles(oldFiles) !== current.digest) {
      throw new Error(`Vendored skill ${entry.name} source does not match its vendor lock`);
    }
    matches.push({ root, catalog, lock, oldFiles });
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Candidate does not match exactly one active home declaration: ${candidate.name}`
        : `Candidate matches multiple active home declarations: ${candidate.name}`
    );
  }
  return matches[0]!;
}

export async function promoteVendoredSkill(
  paths: RuntimePaths,
  candidateId: string
): Promise<SkillCandidate> {
  const candidate = await readCandidate(paths, candidateId);
  let candidateFiles = await revalidateCandidate(paths, candidate);
  let target = await locatePromotionTarget(paths, candidate.provenance);
  let targetRoot = target.root;
  let catalog = target.catalog;
  const entry = catalog.entry;
  if (buildDiff(target.oldFiles, candidateFiles) !== candidate.diff) {
    throw new Error("Candidate diff evidence changed");
  }

  const confirmedCandidate = await readCandidate(paths, candidateId);
  if (
    JSON.stringify(confirmedCandidate.provenance) !== JSON.stringify(candidate.provenance) ||
    JSON.stringify(confirmedCandidate.inventory) !== JSON.stringify(candidate.inventory) ||
    JSON.stringify(confirmedCandidate.findings) !== JSON.stringify(candidate.findings) ||
    confirmedCandidate.diff !== candidate.diff
  ) {
    throw new Error("Candidate review evidence changed after confirmation");
  }
  candidateFiles = await revalidateCandidate(paths, confirmedCandidate);
  target = await locatePromotionTarget(paths, confirmedCandidate.provenance);
  if (target.root !== targetRoot || buildDiff(target.oldFiles, candidateFiles) !== candidate.diff) {
    throw new Error("Active home state changed after confirmation");
  }
  catalog = target.catalog;
  targetRoot = target.root;
  const lock = target.lock;

  const vendorRoot = path.join(targetRoot, "skills", "vendor");
  await assertNoSymlinkAncestors(targetRoot, vendorRoot);
  const destination = path.join(vendorRoot, entry.name);
  const tempSource = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const backupSource = `${destination}.bak-${process.pid}`;
  const lockPath = vendorLockPath(targetRoot);
  const tempLock = `${lockPath}.tmp-${process.pid}`;
  const backupLock = `${lockPath}.bak-${process.pid}`;
  const catalogPath = path.join(targetRoot, "catalog", "skills.yml");
  const tempCatalog = `${catalogPath}.tmp-${process.pid}`;
  const backupCatalog = `${catalogPath}.bak-${process.pid}`;
  if (catalog.migrated) await assertNoSymlinkAncestors(targetRoot, catalogPath);
  await mkdir(vendorRoot, { recursive: true });
  await rm(tempSource, { recursive: true, force: true });
  await rm(backupSource, { recursive: true, force: true });
  await rm(backupLock, { force: true });
  await rm(tempCatalog, { force: true });
  await rm(backupCatalog, { force: true });
  await copySkillFiles(candidateFiles, tempSource);
  const nextLock: VendorLock = {
    skills: {
      ...lock.skills,
      [entry.name]: { commit: candidate.provenance.commit, digest: candidate.provenance.digest }
    }
  };
  await writeFile(tempLock, YAML.stringify(nextLock), "utf8");
  const items: Array<{
    destination: string;
    temporary: string;
    backup: string;
    recursive: boolean;
  }> = [
    { destination, temporary: tempSource, backup: backupSource, recursive: true },
    { destination: lockPath, temporary: tempLock, backup: backupLock, recursive: false }
  ];
  if (catalog.migrated && catalog.document) {
    await writeFile(tempCatalog, YAML.stringify(catalog.document), "utf8");
    items.push({
      destination: catalogPath,
      temporary: tempCatalog,
      backup: backupCatalog,
      recursive: false
    });
  }
  await commitVendoredPromotion(targetRoot, items, async () => {
    const latestCandidate = await readCandidate(paths, candidateId);
    if (
      JSON.stringify(latestCandidate.provenance) !==
        JSON.stringify(confirmedCandidate.provenance) ||
      JSON.stringify(latestCandidate.inventory) !== JSON.stringify(confirmedCandidate.inventory) ||
      JSON.stringify(latestCandidate.findings) !== JSON.stringify(confirmedCandidate.findings) ||
      latestCandidate.diff !== confirmedCandidate.diff
    ) {
      throw new Error("Candidate review evidence changed before replacement");
    }
    await revalidateCandidate(paths, latestCandidate);
    const latestTarget = await locatePromotionTarget(paths, latestCandidate.provenance);
    if (
      latestTarget.root !== targetRoot ||
      JSON.stringify(latestTarget.lock) !== JSON.stringify(lock) ||
      JSON.stringify(latestTarget.catalog.entry) !== JSON.stringify(catalog.entry) ||
      latestTarget.catalog.migrated !== catalog.migrated ||
      JSON.stringify(latestTarget.catalog.document) !== JSON.stringify(catalog.document) ||
      buildDiff(latestTarget.oldFiles, candidateFiles) !== candidate.diff
    ) {
      throw new Error("Active home state changed before replacement");
    }
  });
  return candidate;
}

export async function checkVendoredSkill(
  paths: RuntimePaths,
  entry: Extract<SkillEntry, { source: "vendored" }>,
  sourceRoot: string
): Promise<{ pinned: VendorLockEntry; observedCommit: string; changed: boolean }> {
  const lock = await readVendorLock(sourceRoot);
  const pinned = lock.skills[entry.name];
  if (!pinned) throw new Error(`Vendored skill ${entry.name} has no vendor lock entry`);
  const { cache, commit: observedCommit } = await fetchCommit(paths, entry.repo, entry.ref);
  const digest = digestSkillFiles(await readGitSkillFiles(cache, observedCommit, entry.subtree));
  return { pinned, observedCommit, changed: digest !== pinned.digest };
}

export function candidateReviewInvocation(candidateId: string): string {
  return `/skill-update-review ${candidateId}`;
}

export function migrationMessage(name: string): string {
  return (
    `Legacy Git skill ${name} is untrusted migration input. Select an HTTPS ref, run ` +
    `mfz skills stage ${name}, review the candidate with /skill-update-review, then run ` +
    `mfz skills promote <candidate-id>; promotion rewrites the declaration to source: vendored, ` +
    `and it is not active until mfz apply.`
  );
}

export async function readLegacyGitSkills(
  root: string,
  machineHome = process.env.HOME ?? root
): Promise<LegacySkillEntry[]> {
  const entries: LegacySkillEntry[] = [];
  for (const sourceRoot of await activeHomeRoots(root, machineHome)) {
    try {
      const parsed = YAML.parse(
        await readFile(path.join(sourceRoot, "catalog", "skills.yml"), "utf8")
      ) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const skills = (parsed as Record<string, unknown>).skills;
      if (!Array.isArray(skills)) continue;
      for (const raw of skills) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        if (item.source !== "git" || typeof item.name !== "string" || typeof item.repo !== "string")
          continue;
        entries.push({
          name: item.name,
          source: "vendored",
          repo: item.repo,
          ref: typeof item.ref === "string" ? item.ref : "main",
          subtree:
            typeof item.subtree === "string" ? item.subtree : `skills/${item.skill ?? item.name}`,
          description: typeof item.description === "string" ? item.description : "",
          sourceRoot
        });
      }
    } catch {
      // Malformed legacy homes are reported by the normal manifest diagnostics.
    }
  }
  return entries;
}
