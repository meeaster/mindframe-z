import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  homeManifestSchema,
  skillsManifestSchema,
  skillSchema,
  vendorLockSchema,
  vendorLockVariantDigestsSchema,
  vendoredSkillTargets,
  type VendoredSkillTarget,
  type SkillEntry,
  type VendorLock,
  type VendorLockEntry,
  type VendorLockVariantDigests
} from "../core/manifests.js";
import {
  expandHome,
  skillCandidatesRoot,
  vendorLockPath,
  type RuntimePaths
} from "../core/paths.js";
import { pathExists, readDirEntries } from "../core/fs-util.js";
import { fetchCommit, normalizedRepository, readGitSkillFiles } from "./git.js";
import { commitVendoredPromotion, recoverVendoredPromotion } from "./transaction.js";
import {
  comparePosixBytes,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
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

const candidateVariantSchema = z
  .object({ subtree: z.string().min(1), digest: candidateHashSchema })
  .strict();

const candidateVariantsSchema = z
  .object({
    "claude-code": candidateVariantSchema,
    codex: candidateVariantSchema,
    opencode: candidateVariantSchema
  })
  .strict();

const candidateOldVariantsSchema = vendorLockVariantDigestsSchema;

const candidateProvenanceFields = {
  candidateId: candidateHashSchema,
  name: z.string().min(1),
  repository: z.string().url(),
  ref: z.string().min(1).refine(safeGitRevision),
  commit: z.string().regex(fullCommitPattern),
  digest: candidateHashSchema,
  sourceRoot: z.string().min(1),
  oldCommit: z.string().regex(fullCommitPattern).optional(),
  oldDigest: candidateHashSchema.optional(),
  oldVariants: candidateOldVariantsSchema.optional(),
  artifacts: z
    .object({
      inventory: candidateHashSchema,
      findings: candidateHashSchema,
      diff: candidateHashSchema,
      digest: candidateHashSchema
    })
    .strict()
};

const candidateProvenanceSchema = z
  .union([
    z.object({ ...candidateProvenanceFields, subtree: z.string().min(1) }).strict(),
    z.object({ ...candidateProvenanceFields, variants: candidateVariantsSchema }).strict()
  ])
  .refine((value) => Boolean(value.oldCommit) === Boolean(value.oldDigest), {
    message: "oldCommit and oldDigest must be supplied together"
  })
  .refine((value) => value.oldVariants === undefined || value.oldCommit !== undefined, {
    message: "oldVariants requires oldCommit and oldDigest"
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

const legacyCatalogSchema = z.looseObject({ skills: z.array(z.unknown()) });

const legacySkillInputSchema = z.looseObject({
  name: z.string(),
  source: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  subtree: z.string().optional(),
  skill: z.string().optional(),
  description: z.string().optional()
});

type CatalogDocument = z.infer<typeof legacyCatalogSchema>;

type VendoredSkill = Extract<SkillEntry, { source: "vendored" }>;

type VendoredVariantSkill = Extract<VendoredSkill, { variants: object }>;

export type VendoredPayload =
  | { kind: "single"; files: SkillFileRecord[] }
  | { kind: "variants"; files: Record<VendoredSkillTarget, SkillFileRecord[]> };

interface CatalogEntryResolution {
  entry: VendoredSkill;
  migrated: boolean;
  document?: CatalogDocument;
}

interface PromotionTarget {
  root: string;
  catalog: CatalogEntryResolution;
  lock: VendorLock;
  oldFiles: SkillFileRecord[];
}

function safeGitRevision(value: string): boolean {
  return !value.startsWith("-") && [...value].every((character) => character.charCodeAt(0) > 32);
}

function errorCode(error: Error): string | undefined {
  // SAFETY: Node filesystem failures expose their stable errno code on Error objects.
  return (error as NodeJS.ErrnoException).code;
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
    const parsed = YAML.parse(await readFile(path.join(resolvedRoot, "mfz_home.yml"), "utf8"));
    const extension = homeManifestSchema.parse(parsed).extends;

    if (!extension) return roots;
    const upstream = path.resolve(expandHome(extension.path, machineHome));

    if (await pathExists(path.join(upstream, "mfz_home.yml"))) {
      roots.push(...(await activeHomeRoots(upstream, machineHome, seen)));
    }
  } catch {
    // The target catalog read below reports malformed or missing homes.
  }

  return roots;
}

interface CandidateProvenanceBase {
  candidateId: string;
  name: string;
  repository: string;
  ref: string;
  commit: string;
  digest: string;
  sourceRoot: string;
  oldCommit?: string;
  oldDigest?: string;
  oldVariants?: VendorLockVariantDigests;
  artifacts?: {
    inventory: string;
    findings: string;
    diff: string;
    digest: string;
  };
}

interface CandidateVariantProvenance {
  subtree: string;
  digest: string;
}

export type CandidateProvenance =
  | (Omit<CandidateProvenanceBase, "subtree"> & {
      subtree: string;
      variants?: never;
    })
  | (Omit<CandidateProvenanceBase, "subtree"> & {
      variants: Record<VendoredSkillTarget, CandidateVariantProvenance>;
      subtree?: never;
    });

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

function isVariantSkill(entry: VendoredSkill): entry is VendoredVariantSkill {
  return "variants" in entry;
}

export function vendoredSkillSourcePath(
  root: string,
  name: string,
  target?: VendoredSkillTarget
): string {
  const source = path.join(root, "skills", "vendor", name);

  return target === undefined ? source : path.join(source, target);
}

function payloadRecords(payload: VendoredPayload): SkillFileRecord[] {
  if (payload.kind === "single") return payload.files;

  return vendoredSkillTargets.flatMap((target) =>
    payload.files[target].map((file) => ({ ...file, path: `${target}/${file.path}` }))
  );
}

function payloadDigest(payload: VendoredPayload): string {
  return digestSkillFiles(payloadRecords(payload));
}

function payloadFindings(payload: VendoredPayload): SkillFinding[] {
  if (payload.kind === "single") return staticFindings(payload.files);

  return vendoredSkillTargets.flatMap((target) =>
    staticFindings(payload.files[target]).map((finding) => ({
      ...finding,
      path: `${target}/${finding.path}`
    }))
  );
}

function assertPayloadLimits(files: readonly SkillFileRecord[]): void {
  if (files.length > MAX_SKILL_FILES) throw new Error("Skill source exceeds the file-count limit");
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);

  if (totalBytes > MAX_SKILL_BYTES) throw new Error("Skill source exceeds the 32 MiB size limit");
}

function validatePayloadRecords(payload: VendoredPayload): void {
  assertPayloadLimits(payloadRecords(payload));

  if (payload.kind === "single") {
    validateSkillRecords(payload.files);

    return;
  }

  for (const target of vendoredSkillTargets) validateSkillRecords(payload.files[target]);
}

async function readVariantPayload(parent: string, name: string): Promise<VendoredPayload> {
  const parentStat = await lstat(parent);

  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`Vendored skill ${name} provider variants must be real directories`);
  }

  const entries = await readDirEntries(parent);
  const expected = new Set<string>(vendoredSkillTargets);

  for (const entry of entries) {
    if (!expected.has(entry.name)) {
      throw new Error(`Vendored skill ${name} has unknown provider variant: ${entry.name}`);
    }

    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Vendored skill ${name} provider variant ${entry.name} must be a directory`);
    }
  }

  for (const target of vendoredSkillTargets) {
    if (!entries.some((entry) => entry.name === target)) {
      throw new Error(`Vendored skill ${name} is missing provider variant: ${target}`);
    }
  }

  return {
    kind: "variants",
    files: {
      "claude-code": await readSkillFiles(path.join(parent, "claude-code")),
      codex: await readSkillFiles(path.join(parent, "codex")),
      opencode: await readSkillFiles(path.join(parent, "opencode"))
    }
  };
}

async function readStoredPayloadForKind(
  root: string,
  name: string,
  kind: VendoredPayload["kind"]
): Promise<VendoredPayload> {
  const source = vendoredSkillSourcePath(root, name);

  const payload =
    kind === "variants"
      ? await readVariantPayload(source, name)
      : { kind: "single" as const, files: await readSkillFiles(source) };

  validatePayloadRecords(payload);

  return payload;
}

async function readStoredPayload(root: string, entry: VendoredSkill): Promise<VendoredPayload> {
  return readStoredPayloadForKind(root, entry.name, isVariantSkill(entry) ? "variants" : "single");
}

async function readStoredPayloadForLock(
  root: string,
  name: string,
  lock: VendorLockEntry
): Promise<VendoredPayload> {
  return readStoredPayloadForKind(root, name, "variants" in lock ? "variants" : "single");
}

async function readCandidatePayload(candidate: SkillCandidate): Promise<VendoredPayload> {
  if (candidate.provenance.variants !== undefined) {
    return readVariantPayload(candidate.sourcePath, candidate.provenance.name);
  }

  return { kind: "single", files: await readSkillFiles(candidate.sourcePath) };
}

async function readUpstreamPayload(
  cache: string,
  commit: string,
  entry: VendoredSkill
): Promise<VendoredPayload> {
  const payload = isVariantSkill(entry)
    ? {
        kind: "variants" as const,
        files: {
          "claude-code": await readGitSkillFiles(cache, commit, entry.variants["claude-code"]),
          codex: await readGitSkillFiles(cache, commit, entry.variants.codex),
          opencode: await readGitSkillFiles(cache, commit, entry.variants["opencode"])
        }
      }
    : { kind: "single" as const, files: await readGitSkillFiles(cache, commit, entry.subtree) };

  assertPayloadLimits(payloadRecords(payload));

  return payload;
}

function variantDigests(
  payload: Extract<VendoredPayload, { kind: "variants" }>
): Record<VendoredSkillTarget, string> {
  return {
    "claude-code": digestSkillFiles(payload.files["claude-code"]),
    codex: digestSkillFiles(payload.files.codex),
    opencode: digestSkillFiles(payload.files["opencode"])
  };
}

function assertPayloadMatchesLock(
  name: string,
  payload: VendoredPayload,
  locked: VendorLockEntry
): void {
  const isVariantLock = "variants" in locked;

  if ((payload.kind === "variants") !== isVariantLock) {
    throw new Error(
      `Vendored skill ${name} lock entry ${isVariantLock ? "contains" : "is missing"} provider variants`
    );
  }

  const digest = payloadDigest(payload);

  if (digest !== locked.digest) {
    throw new Error(
      `Vendored skill ${name} integrity mismatch: expected ${locked.digest}, got ${digest}`
    );
  }

  if (payload.kind === "variants" && isVariantLock) {
    const actual = variantDigests(payload);

    for (const target of vendoredSkillTargets) {
      if (actual[target] !== locked.variants[target]) {
        throw new Error(
          `Vendored skill ${name} ${target} integrity mismatch: expected ${locked.variants[target]}, got ${actual[target]}`
        );
      }
    }
  }
}

function candidateVariantProvenance(
  entry: VendoredVariantSkill,
  payload: Extract<VendoredPayload, { kind: "variants" }>
): Record<VendoredSkillTarget, CandidateVariantProvenance> {
  const digests = variantDigests(payload);

  return {
    "claude-code": { subtree: entry.variants["claude-code"], digest: digests["claude-code"] },
    codex: { subtree: entry.variants.codex, digest: digests.codex },
    opencode: { subtree: entry.variants["opencode"], digest: digests["opencode"] }
  };
}

function sameVariantSubtrees(
  entry: VendoredVariantSkill,
  variants: Record<VendoredSkillTarget, CandidateVariantProvenance>
): boolean {
  return vendoredSkillTargets.every(
    (target) => entry.variants[target] === variants[target].subtree
  );
}

function requireVariantPayload(
  payload: VendoredPayload
): Extract<VendoredPayload, { kind: "variants" }> {
  if (payload.kind !== "variants") throw new Error("Provider variant payload is incomplete");

  return payload;
}

function candidateLockEntry(candidate: CandidateProvenance): VendorLockEntry {
  if (candidate.variants === undefined) {
    return { commit: candidate.commit, digest: candidate.digest };
  }

  return {
    commit: candidate.commit,
    digest: candidate.digest,
    variants: {
      "claude-code": candidate.variants["claude-code"].digest,
      codex: candidate.variants.codex.digest,
      opencode: candidate.variants["opencode"].digest
    }
  };
}

type CandidateBaseline =
  | { kind: "none" }
  | { kind: "single"; commit: string; digest: string }
  | {
      kind: "variants";
      commit: string;
      digest: string;
      variants: VendorLockVariantDigests;
    };

function baselineFromLock(lock: VendorLockEntry | undefined): CandidateBaseline {
  if (lock === undefined) return { kind: "none" };

  if ("variants" in lock) {
    return {
      kind: "variants",
      commit: lock.commit,
      digest: lock.digest,
      variants: {
        "claude-code": lock.variants["claude-code"],
        codex: lock.variants.codex,
        opencode: lock.variants["opencode"]
      }
    };
  }

  return { kind: "single", commit: lock.commit, digest: lock.digest };
}

function baselineFromCandidate(provenance: CandidateProvenance): CandidateBaseline {
  const oldCommit = provenance.oldCommit;
  const oldDigest = provenance.oldDigest;
  const oldVariants = provenance.oldVariants;

  if (oldCommit === undefined && oldDigest === undefined && oldVariants === undefined) {
    return { kind: "none" };
  }

  if (oldCommit === undefined || oldDigest === undefined) {
    throw new Error("Candidate baseline provenance is incomplete");
  }

  if (oldVariants === undefined) {
    return { kind: "single", commit: oldCommit, digest: oldDigest };
  }

  return {
    kind: "variants",
    commit: oldCommit,
    digest: oldDigest,
    variants: {
      "claude-code": oldVariants["claude-code"],
      codex: oldVariants.codex,
      opencode: oldVariants["opencode"]
    }
  };
}

function baselineKey(baseline: CandidateBaseline): string {
  return JSON.stringify(baseline);
}

function attachBaseline(
  provenance: CandidateProvenance,
  lock: VendorLockEntry | undefined
): CandidateProvenance {
  const baseline = baselineFromLock(lock);

  if (baseline.kind === "none") return provenance;

  if (baseline.kind === "single") {
    return { ...provenance, oldCommit: baseline.commit, oldDigest: baseline.digest };
  }

  return {
    ...provenance,
    oldCommit: baseline.commit,
    oldDigest: baseline.digest,
    oldVariants: baseline.variants
  };
}

async function copyPayload(payload: VendoredPayload, destination: string): Promise<void> {
  if (payload.kind === "single") {
    await copySkillFiles(payload.files, destination);

    return;
  }

  for (const target of vendoredSkillTargets) {
    await copySkillFiles(payload.files[target], path.join(destination, target));
  }
}

export async function validateVendoredSkill(
  root: string,
  entry: VendoredSkill,
  lock?: VendorLock
): Promise<void> {
  await recoverVendoredPromotion(root);
  const resolvedLock = lock ?? (await readVendorLock(root));
  const locked = resolvedLock.skills[entry.name];

  if (!locked) throw new Error(`Vendored skill ${entry.name} has no vendor lock entry`);
  const sourcePath = vendoredSkillSourcePath(root, entry.name);
  await assertNoSymlinkAncestors(root, sourcePath);
  const payload = await readStoredPayloadForLock(root, entry.name, locked);
  assertPayloadMatchesLock(entry.name, payload, locked);
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
      if (error instanceof Error && errorCode(error) === "ENOENT") return [];

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

function candidateIdentity(candidate: CandidateProvenance): string {
  const hash = createHash("sha256");

  const values =
    candidate.variants === undefined
      ? [
          "candidate-v2",
          "single",
          candidate.name,
          candidate.repository,
          candidate.ref,
          candidate.sourceRoot,
          candidate.subtree,
          candidate.commit,
          candidate.digest,
          "baseline",
          baselineKey(baselineFromCandidate(candidate))
        ]
      : [
          "candidate-v2",
          "variants",
          candidate.name,
          candidate.repository,
          candidate.ref,
          candidate.sourceRoot,
          ...vendoredSkillTargets.flatMap((target) => [
            target,
            candidate.variants[target].subtree,
            candidate.variants[target].digest
          ]),
          candidate.commit,
          candidate.digest,
          "baseline",
          baselineKey(baselineFromCandidate(candidate))
        ];

  for (const value of values) {
    hash.update(frame(Buffer.from(value, "utf8")));
  }

  return hash.digest("hex");
}

function candidateFile(root: string, name: string): string {
  return path.join(root, name);
}

async function writeCandidate(candidate: SkillCandidate, payload: VendoredPayload): Promise<void> {
  const parent = path.dirname(candidate.path);
  await assertNoSymlinkAncestors(parent, candidate.path);
  await mkdir(parent, { recursive: true });
  const temporary = `${candidate.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await rm(temporary, { recursive: true, force: true });
  await copyPayload(payload, path.join(temporary, "source"));
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
  rawEntry: VendoredSkill,
  sourceRoot: string,
  revision?: string
): Promise<SkillCandidate> {
  const parsedEntry = skillSchema.parse(
    isVariantSkill(rawEntry)
      ? {
          name: rawEntry.name,
          source: rawEntry.source,
          repo: rawEntry.repo,
          ref: rawEntry.ref,
          variants: rawEntry.variants,
          description: rawEntry.description
        }
      : {
          name: rawEntry.name,
          source: rawEntry.source,
          repo: rawEntry.repo,
          ref: rawEntry.ref,
          subtree: rawEntry.subtree,
          description: rawEntry.description
        }
  );

  if (parsedEntry.source !== "vendored") throw new Error("Skill staging requires a vendored entry");
  const entry = parsedEntry;
  const repository = normalizedRepository(entry.repo);
  const requestedRevision = revision ?? entry.ref;

  if (revision && !fullCommitPattern.test(revision)) {
    throw new Error(`Explicit skill revision must be a full commit SHA: ${revision}`);
  }

  const { cache, commit } = await fetchCommit(paths, repository, requestedRevision);
  const payload = await readUpstreamPayload(cache, commit, entry);
  const digest = payloadDigest(payload);
  let oldLock: VendorLockEntry | undefined;

  try {
    oldLock = (await readVendorLock(sourceRoot)).skills[entry.name];
  } catch (error) {
    if (!(error instanceof Error) || errorCode(error) !== "ENOENT") throw error;
    // The candidate still carries enough provenance to be reviewed before first promotion.
  }

  const oldPath = vendoredSkillSourcePath(sourceRoot, entry.name);
  await assertNoSymlinkAncestors(sourceRoot, oldPath);

  const oldPayload = (await pathExists(oldPath))
    ? oldLock
      ? await readStoredPayloadForLock(sourceRoot, entry.name, oldLock)
      : await readStoredPayload(sourceRoot, entry)
    : undefined;

  const oldFiles = oldPayload ? payloadRecords(oldPayload) : [];

  if (oldLock) {
    if (!oldPayload) {
      throw new Error(`Vendored skill ${entry.name} source does not match its vendor lock`);
    }

    assertPayloadMatchesLock(entry.name, oldPayload, oldLock);
  }

  const provenanceWithoutBaseline: CandidateProvenance = isVariantSkill(entry)
    ? {
        candidateId: "",
        name: entry.name,
        repository,
        ref: entry.ref,
        variants: candidateVariantProvenance(entry, requireVariantPayload(payload)),
        commit,
        digest,
        sourceRoot
      }
    : {
        candidateId: "",
        name: entry.name,
        repository,
        ref: entry.ref,
        subtree: entry.subtree,
        commit,
        digest,
        sourceRoot
      };

  const provenance = attachBaseline(provenanceWithoutBaseline, oldLock);
  provenance.candidateId = candidateIdentity(provenance);
  const files = payloadRecords(payload);

  const candidate: SkillCandidate = {
    path: candidateFile(skillCandidatesRoot(paths), provenance.candidateId),
    sourcePath: candidateFile(
      skillCandidatesRoot(paths),
      path.join(provenance.candidateId, "source")
    ),
    provenance,
    inventory: inventory(files),
    findings: payloadFindings(payload),
    diff: buildDiff(oldFiles, files)
  };

  await assertNoSymlinkAncestors(paths.home, candidate.path);

  try {
    await lstat(candidate.path);
    const existing = await readCandidate(paths, provenance.candidateId);
    await revalidateCandidate(paths, existing);

    return existing;
  } catch (error) {
    try {
      await lstat(candidate.path);
      throw error;
    } catch (existingError) {
      if (existingError === error) throw error;
    }

    await writeCandidate(candidate, payload);

    return candidate;
  }
}

function candidateProvenance(
  parsed: z.infer<typeof candidateProvenanceSchema>
): CandidateProvenance {
  const base = {
    candidateId: parsed.candidateId,
    name: parsed.name,
    repository: parsed.repository,
    ref: parsed.ref,
    commit: parsed.commit,
    digest: parsed.digest,
    sourceRoot: parsed.sourceRoot,
    artifacts: parsed.artifacts
  };

  const provenance: CandidateProvenance =
    "variants" in parsed
      ? { ...base, variants: parsed.variants }
      : { ...base, subtree: parsed.subtree };

  if (parsed.oldCommit !== undefined) provenance.oldCommit = parsed.oldCommit;

  if (parsed.oldDigest !== undefined) provenance.oldDigest = parsed.oldDigest;

  if (parsed.oldVariants !== undefined) provenance.oldVariants = parsed.oldVariants;

  return provenance;
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

  const provenance = candidateProvenance(
    candidateProvenanceSchema.parse(
      YAML.parse((await readEvidence("provenance.yml")).toString("utf8"))
    )
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
  const payload = await readCandidatePayload(candidate);
  validatePayloadRecords(payload);
  const files = payloadRecords(payload);
  const digest = payloadDigest(payload);

  if (digest !== candidate.provenance.digest) throw new Error("Candidate content digest changed");
  const actualInventory = inventory(files);

  if (JSON.stringify(actualInventory) !== JSON.stringify(candidate.inventory)) {
    throw new Error("Candidate inventory changed");
  }

  const actualFindings = payloadFindings(payload);

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

  const expected = candidateIdentity({
    ...candidate.provenance,
    repository: normalizedRepository(candidate.provenance.repository)
  });

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
  const raw = YAML.parse(await readFile(catalogPath, "utf8"));

  try {
    const manifests = skillsManifestSchema.parse(raw);

    const entry = manifests.skills.find(
      (skill): skill is Extract<SkillEntry, { source: "vendored" }> =>
        skill.name === candidate.name && skill.source === "vendored"
    );

    if (!entry) throw new Error(`Candidate skill is not a vendored declaration: ${candidate.name}`);

    return { entry, migrated: false };
  } catch (error) {
    const documentResult = legacyCatalogSchema.safeParse(raw);

    if (!documentResult.success) throw error;
    const document = documentResult.data;
    const skills = document.skills;
    const legacySkills = skills.map((skill) => legacySkillInputSchema.safeParse(skill));

    const matchingSkills = legacySkills.filter(
      (skill) => skill.success && skill.data.name === candidate.name
    );

    if (matchingSkills.length > 1) throw error;

    const index = legacySkills.findIndex(
      (skill) => skill.success && skill.data.name === candidate.name && skill.data.source === "git"
    );

    if (index < 0) {
      const existing = legacySkills.find(
        (skill) => skill.success && skill.data.name === candidate.name
      );

      if (!existing) throw error;
      const entry = skillSchema.parse(existing.data);

      if (entry.source !== "vendored") throw error;

      return { entry, migrated: false };
    }

    const legacy = legacySkills[index];

    if (!legacy?.success) throw error;

    if (candidate.variants !== undefined) throw error;

    const entry = skillSchema.parse({
      name: candidate.name,
      source: "vendored",
      repo: legacy.data.repo,
      ref: candidate.ref,
      subtree: candidate.subtree,
      description: legacy.data.description ?? ""
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
  const expectedBaseline = baselineFromCandidate(candidate);
  let baselineMismatch = false;

  for (const root of await activeHomeRoots(paths.root, paths.home)) {
    let catalog: CatalogEntryResolution;

    try {
      catalog = await resolveCatalogEntry(root, candidate);
    } catch {
      continue;
    }

    const entry = catalog.entry;

    if (normalizedRepository(entry.repo) !== candidate.repository || entry.ref !== candidate.ref)
      continue;

    if (candidate.variants !== undefined) {
      if (!isVariantSkill(entry) || !sameVariantSubtrees(entry, candidate.variants)) continue;
    } else if (isVariantSkill(entry) || entry.subtree !== candidate.subtree) {
      continue;
    }

    let lock: VendorLock;

    try {
      lock = await parseVendorLock(root);
    } catch (error) {
      if (!(error instanceof Error) || errorCode(error) !== "ENOENT") continue;
      lock = { skills: {} };
    }

    const current = lock.skills[entry.name];

    if (baselineKey(expectedBaseline) !== baselineKey(baselineFromLock(current))) {
      baselineMismatch = true;
      continue;
    }

    const source = vendoredSkillSourcePath(root, entry.name);
    await assertNoSymlinkAncestors(root, source);

    const oldPayload = (await pathExists(source))
      ? current
        ? await readStoredPayloadForLock(root, entry.name, current)
        : await readStoredPayload(root, entry)
      : undefined;

    if (current) {
      if (!oldPayload) {
        throw new Error(`Vendored skill ${entry.name} source does not match its vendor lock`);
      }

      assertPayloadMatchesLock(entry.name, oldPayload, current);
    }

    const oldFiles = oldPayload ? payloadRecords(oldPayload) : [];
    matches.push({ root, catalog, lock, oldFiles });
  }

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? baselineMismatch
          ? `Candidate baseline does not match the active vendor state: ${candidate.name}`
          : `Candidate does not match exactly one active home declaration: ${candidate.name}`
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
  let candidatePayload: VendoredPayload;
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
  candidatePayload = await readCandidatePayload(confirmedCandidate);
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
  await copyPayload(candidatePayload, tempSource);

  const nextLock: VendorLock = {
    skills: {
      ...lock.skills,
      [entry.name]: candidateLockEntry(candidate.provenance)
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
  entry: VendoredSkill,
  sourceRoot: string
): Promise<{ pinned: VendorLockEntry; observedCommit: string; changed: boolean }> {
  const lock = await readVendorLock(sourceRoot);
  const pinned = lock.skills[entry.name];

  if (!pinned) throw new Error(`Vendored skill ${entry.name} has no vendor lock entry`);
  const { cache, commit: observedCommit } = await fetchCommit(paths, entry.repo, entry.ref);
  const payload = await readUpstreamPayload(cache, observedCommit, entry);
  const digest = payloadDigest(payload);
  const payloadKindChanged = isVariantSkill(entry) !== "variants" in pinned;

  return { pinned, observedCommit, changed: payloadKindChanged || digest !== pinned.digest };
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
      const parsed = legacyCatalogSchema.safeParse(
        YAML.parse(await readFile(path.join(sourceRoot, "catalog", "skills.yml"), "utf8"))
      );

      if (!parsed.success) continue;

      for (const raw of parsed.data.skills) {
        const validSkill = skillSchema.safeParse(raw);

        if (validSkill.success && validSkill.data.source === "git") continue;
        const item = legacySkillInputSchema.safeParse(raw);

        if (!item.success || item.data.source !== "git") continue;
        entries.push({
          name: item.data.name,
          source: "vendored",
          repo: item.data.repo,
          ref: item.data.ref ?? "main",
          subtree: item.data.subtree ?? `skills/${item.data.skill ?? item.data.name}`,
          description: item.data.description ?? "",
          sourceRoot
        });
      }
    } catch {
      // Malformed legacy homes are reported by the normal manifest diagnostics.
    }
  }

  return entries;
}
