import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pathExists } from "../core/fs-util.js";
import { workBindingsPath, workUnitPath, type RuntimePaths } from "../core/paths.js";
import {
  sourceQualifiedSessionSchema,
  workBindingIndexSchema,
  workCheckpointSchema,
  workOrientationSchema,
  workPhaseSchema,
  workReceiptSchema,
  workSlugSchema,
  workUnitSchema,
  type DeliveryState,
  type SourceQualifiedSession,
  type WorkBindingIndex,
  type WorkCheckpoint,
  type WorkContextPointer,
  type WorkOrientation,
  type WorkPhase,
  type WorkScope,
  type WorkReceipt,
  type WorkUnit
} from "./schema.js";
import {
  contextMapFileName,
  checkpointsDirectoryName,
  hashAuthoredFile,
  orientationFileName,
  parseContextMap,
  parseCheckpoint,
  parseOrientation,
  renderCheckpoint,
  renderContextMap,
  renderOrientation
} from "./authoring.js";

export * from "./schema.js";

const manifestName = "manifest.json";
const checkpointsName = "checkpoints.jsonl";
const checkpointIndexName = "checkpoint-index.json";
const receiptsName = "receipts.jsonl";
const legacyWorkCheckpointSchema = workCheckpointSchema.omit({ id: true });
const checkpointIndexSchema = z.object({
  schema_version: z.literal(1),
  checkpoints: z.array(
    z.object({
      file: z.string().min(1),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      checkpoint: workCheckpointSchema
    })
  )
});

function now(): string {
  return new Date().toISOString();
}

export function sessionKey(session: SourceQualifiedSession): string {
  return `${session.source}:${session.id}`;
}

export function parseSession(value: string): SourceQualifiedSession {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid source-qualified session: ${value}`);
  }
  return sourceQualifiedSessionSchema.parse({
    source: value.slice(0, separator),
    id: value.slice(separator + 1)
  });
}

function unitDir(paths: RuntimePaths, slug: string): string {
  return workUnitPath(paths, workSlugSchema.parse(slug));
}

function manifestPath(paths: RuntimePaths, slug: string): string {
  return path.join(unitDir(paths, slug), manifestName);
}

function checkpointsPath(paths: RuntimePaths, slug: string): string {
  return path.join(unitDir(paths, slug), checkpointsName);
}

function checkpointIndexPath(paths: RuntimePaths, slug: string): string {
  return path.join(unitDir(paths, slug), checkpointIndexName);
}

function receiptsPath(paths: RuntimePaths, slug: string): string {
  return path.join(unitDir(paths, slug), receiptsName);
}

export function workAuthoringPaths(
  paths: RuntimePaths,
  slug: string
): { orientation: string; context_map: string; checkpoints: string } {
  const dir = unitDir(paths, slug);
  return {
    orientation: path.join(dir, orientationFileName),
    context_map: path.join(dir, contextMapFileName),
    checkpoints: path.join(dir, checkpointsDirectoryName)
  };
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function appendJsonl(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonl<T>(file: string, schema: { parse(value: unknown): T }): Promise<T[]> {
  try {
    const content = await readFile(file, "utf8");
    return content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => schema.parse(JSON.parse(line)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readBindingIndex(paths: RuntimePaths): Promise<WorkBindingIndex> {
  try {
    return workBindingIndexSchema.parse(
      JSON.parse(await readFile(workBindingsPath(paths), "utf8"))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schema_version: 1, bindings: {} };
    throw new Error(
      `Failed to read work binding index: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function writeBindingIndex(paths: RuntimePaths, index: WorkBindingIndex): Promise<void> {
  await writeAtomic(workBindingsPath(paths), index);
}

async function withBindingLock<T>(paths: RuntimePaths, action: () => Promise<T>): Promise<T> {
  const lock = `${workBindingsPath(paths)}.lock`;
  const deadline = Date.now() + 5_000;
  await mkdir(path.dirname(lock), { recursive: true });
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`Failed to acquire work binding lock: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await action();
  } finally {
    await rmdir(lock);
  }
}

export async function createWorkUnit(
  paths: RuntimePaths,
  input: {
    slug: string;
    title: string;
    objective: string;
    scope?: WorkScope;
    project?: string | undefined;
    phase?: WorkPhase;
    repositories?: WorkContextPointer[];
    context?: WorkContextPointer[];
    thread?: string | undefined;
    orientation?: Omit<WorkOrientation, "revision">;
  }
): Promise<WorkUnit> {
  const slug = workSlugSchema.parse(input.slug);
  const file = manifestPath(paths, slug);
  if (await pathExists(file)) throw new Error(`Work unit already exists: ${slug}`);
  const timestamp = now();
  const phase = input.phase ?? "explore";
  const unit = workUnitSchema.parse({
    schema_version: 1,
    domain: "personal",
    scope: input.scope ?? "global",
    ...(input.project ? { project: workSlugSchema.parse(input.project) } : {}),
    slug,
    title: input.title,
    objective: input.objective,
    phase,
    phase_history: [{ phase, at: timestamp }],
    repositories: input.repositories ?? [],
    context: input.context ?? [],
    ...(input.thread ? { thread: input.thread } : {}),
    orientation: {
      revision: 1,
      outcome: input.objective,
      direction: "",
      constraints: [],
      questions: [],
      next_action: "",
      ...input.orientation
    },
    checkpoint_hashes: {},
    created_at: timestamp,
    updated_at: timestamp
  });
  await writeAtomic(file, unit);
  const authored = workAuthoringPaths(paths, slug);
  await mkdir(authored.checkpoints, { recursive: true });
  await Promise.all([
    writeFile(authored.orientation, renderOrientation(input.orientation), "utf8"),
    writeFile(
      authored.context_map,
      renderContextMap({ repositories: input.repositories ?? [], context: input.context ?? [] }),
      "utf8"
    )
  ]);
  return unit;
}

export async function readWorkUnit(paths: RuntimePaths, slug: string): Promise<WorkUnit> {
  return workUnitSchema.parse(JSON.parse(await readFile(manifestPath(paths, slug), "utf8")));
}

export async function listWorkUnits(paths: RuntimePaths): Promise<WorkUnit[]> {
  const unitsRoot = paths.workUnitsRoot;
  try {
    const entries = await readdir(unitsRoot, { withFileTypes: true });
    const slugs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return await Promise.all(slugs.map((slug) => readWorkUnit(paths, slug)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeUnit(paths: RuntimePaths, unit: WorkUnit): Promise<WorkUnit> {
  const next = workUnitSchema.parse({ ...unit, updated_at: now() });
  await writeAtomic(manifestPath(paths, unit.slug), next);
  return next;
}

export async function setWorkPhase(
  paths: RuntimePaths,
  slug: string,
  phase: WorkPhase
): Promise<WorkUnit> {
  const unit = await readWorkUnit(paths, slug);
  const nextPhase = workPhaseSchema.parse(phase);
  return writeUnit(paths, {
    ...unit,
    phase: nextPhase,
    phase_history: [...unit.phase_history, { phase: nextPhase, at: now() }]
  });
}

export type WorkAuthoringStatus = {
  unit: WorkUnit;
  valid: boolean;
  synchronized: boolean;
  issues: string[];
  files: { orientation: string; context_map: string; checkpoints: string };
  orientation: { state: "current" | "changed" | "unvalidated" | "invalid"; hash: string | null };
  context_map: { state: "current" | "changed" | "unvalidated" | "invalid"; hash: string | null };
  checkpoints: {
    state: "current" | "unvalidated" | "migration-needed" | "invalid";
    count: number;
    validated: number;
  };
};

type AuthoredCheckpoint = { file: string; hash: string; checkpoint: WorkCheckpoint };

function checkpointIdentity(checkpoint: WorkCheckpoint): string {
  return checkpoint.id;
}

function legacyCheckpointIdentity(checkpoint: Omit<WorkCheckpoint, "id">): string {
  return `${sessionKey(checkpoint.session)}\0${checkpoint.boundary}\0${checkpoint.created_at}`;
}

function sameLegacyCheckpoint(
  checkpoint: WorkCheckpoint,
  legacy: Omit<WorkCheckpoint, "id">
): boolean {
  const { id: _id, ...withoutId } = checkpoint;
  return JSON.stringify(withoutId) === JSON.stringify(legacy);
}

async function readAuthoredCheckpoints(
  directory: string,
  slug: string
): Promise<{ checkpoints: AuthoredCheckpoint[]; issues: string[] }> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { checkpoints: [], issues: [] };
    throw error;
  }
  const checkpoints: AuthoredCheckpoint[] = [];
  const issues: string[] = [];
  const identities = new Map<string, string>();
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const content = await readFile(path.join(directory, entry.name), "utf8");
      const checkpoint = parseCheckpoint(content, slug);
      const identity = checkpointIdentity(checkpoint);
      const duplicate = identities.get(identity);
      if (duplicate) throw new Error(`duplicates checkpoint identity from ${duplicate}`);
      identities.set(identity, entry.name);
      checkpoints.push({ file: entry.name, hash: hashAuthoredFile(content), checkpoint });
    } catch (error) {
      issues.push(
        `checkpoints/${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { checkpoints, issues };
}

async function migrateLegacyCheckpoints(paths: RuntimePaths, slug: string): Promise<boolean> {
  const legacy = await readJsonl(checkpointsPath(paths, slug), legacyWorkCheckpointSchema);
  if (legacy.length === 0) return false;
  const directory = workAuthoringPaths(paths, slug).checkpoints;
  await mkdir(directory, { recursive: true });
  const authored = await readAuthoredCheckpoints(directory, slug);
  if (authored.issues.length > 0) return false;
  const byIdentity = new Map(
    authored.checkpoints.map((item) => [legacyCheckpointIdentity(item.checkpoint), item.checkpoint])
  );
  for (const [index, checkpoint] of legacy.entries()) {
    const identity = legacyCheckpointIdentity(checkpoint);
    const existing = byIdentity.get(identity);
    if (existing) {
      if (!sameLegacyCheckpoint(existing, checkpoint)) {
        throw new Error(
          `Legacy checkpoint conflicts with authored checkpoint identity ${identity}`
        );
      }
      continue;
    }
    const id = `legacy-${String(index + 1).padStart(4, "0")}-${checkpoint.boundary}`;
    const migrated = { ...checkpoint, id };
    const file = `${id}.md`;
    await writeFile(path.join(directory, file), renderCheckpoint(migrated), {
      encoding: "utf8",
      flag: "wx"
    });
    byIdentity.set(identity, migrated);
  }
  return true;
}

async function authoredStatus(paths: RuntimePaths, slug: string): Promise<WorkAuthoringStatus> {
  const unit = await readWorkUnit(paths, slug);
  const files = workAuthoringPaths(paths, slug);
  const issues: string[] = [];
  let orientationHash: string | null = null;
  let contextHash: string | null = null;
  try {
    const content = await readFile(files.orientation, "utf8");
    parseOrientation(content);
    orientationHash = hashAuthoredFile(content);
  } catch (error) {
    issues.push(`orientation.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  const authoredCheckpoints = await readAuthoredCheckpoints(files.checkpoints, slug);
  issues.push(...authoredCheckpoints.issues);
  const checkpointFiles = new Set(authoredCheckpoints.checkpoints.map((item) => item.file));
  for (const file of Object.keys(unit.checkpoint_hashes)) {
    if (!checkpointFiles.has(file))
      issues.push(`checkpoints/${file}: validated checkpoint was removed`);
  }
  for (const item of authoredCheckpoints.checkpoints) {
    const stored = unit.checkpoint_hashes[item.file];
    if (stored !== undefined && stored !== item.hash) {
      issues.push(`checkpoints/${item.file}: validated checkpoint was modified`);
    }
  }
  const legacyCount = (await readJsonl(checkpointsPath(paths, slug), legacyWorkCheckpointSchema))
    .length;
  const checkpointInvalid = issues.some((issue) => issue.startsWith("checkpoints/"));
  const validatedCheckpoints = authoredCheckpoints.checkpoints.filter(
    (item) => unit.checkpoint_hashes[item.file] === item.hash
  ).length;
  const checkpointState = checkpointInvalid
    ? "invalid"
    : authoredCheckpoints.checkpoints.length === 0 && legacyCount > 0
      ? "migration-needed"
      : validatedCheckpoints === authoredCheckpoints.checkpoints.length
        ? "current"
        : "unvalidated";
  try {
    const content = await readFile(files.context_map, "utf8");
    parseContextMap(content);
    contextHash = hashAuthoredFile(content);
  } catch (error) {
    issues.push(`context-map.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  const state = (hash: string | null, stored: string | undefined) =>
    hash === null
      ? "invalid"
      : stored === undefined
        ? "unvalidated"
        : hash === stored
          ? "current"
          : "changed";
  const orientationState = state(orientationHash, unit.orientation_hash);
  const contextState = state(contextHash, unit.context_hash);
  return {
    unit,
    valid: issues.length === 0,
    synchronized:
      issues.length === 0 &&
      orientationState === "current" &&
      contextState === "current" &&
      checkpointState === "current",
    issues,
    files,
    orientation: { state: orientationState, hash: orientationHash },
    context_map: { state: contextState, hash: contextHash },
    checkpoints: {
      state: checkpointState,
      count: authoredCheckpoints.checkpoints.length || legacyCount,
      validated: validatedCheckpoints
    }
  };
}

export async function readWorkAuthoringStatus(
  paths: RuntimePaths,
  slug: string
): Promise<WorkAuthoringStatus> {
  return authoredStatus(paths, slug);
}

export async function validateWorkUnit(
  paths: RuntimePaths,
  slug: string
): Promise<WorkAuthoringStatus> {
  const migratedLegacy = await migrateLegacyCheckpoints(paths, slug);
  const status = await authoredStatus(paths, slug);
  if (!status.valid || !status.orientation.hash || !status.context_map.hash) {
    throw new Error(`Work unit ${slug} is invalid:\n${status.issues.join("\n")}`);
  }
  const [orientationContent, contextContent] = await Promise.all([
    readFile(status.files.orientation, "utf8"),
    readFile(status.files.context_map, "utf8")
  ]);
  if (
    hashAuthoredFile(orientationContent) !== status.orientation.hash ||
    hashAuthoredFile(contextContent) !== status.context_map.hash
  ) {
    throw new Error(`Work unit ${slug} changed during validation; retry validation`);
  }
  const parsedOrientation = parseOrientation(orientationContent);
  const parsedContext = parseContextMap(contextContent);
  const authoredCheckpoints = await readAuthoredCheckpoints(status.files.checkpoints, slug);
  if (authoredCheckpoints.issues.length > 0) {
    throw new Error(`Work unit ${slug} is invalid:\n${authoredCheckpoints.issues.join("\n")}`);
  }
  for (const item of authoredCheckpoints.checkpoints) {
    if (
      hashAuthoredFile(await readFile(path.join(status.files.checkpoints, item.file), "utf8")) !==
      item.hash
    ) {
      throw new Error(`Work unit ${slug} changed during validation; retry validation`);
    }
  }
  const orientationChanged =
    status.unit.orientation_hash !== undefined && status.orientation.state === "changed";
  const revision = orientationChanged
    ? status.unit.orientation.revision + 1
    : status.unit.orientation.revision;
  await writeAtomic(checkpointIndexPath(paths, slug), {
    schema_version: 1,
    checkpoints: authoredCheckpoints.checkpoints
  });
  const next = await writeUnit(paths, {
    ...status.unit,
    objective: parsedOrientation.outcome,
    repositories: parsedContext.repositories,
    context: parsedContext.context,
    orientation: workOrientationSchema.parse({ ...parsedOrientation, revision }),
    orientation_hash: status.orientation.hash,
    context_hash: status.context_map.hash,
    checkpoint_hashes: Object.fromEntries(
      authoredCheckpoints.checkpoints.map((item) => [item.file, item.hash])
    )
  });
  if (migratedLegacy) {
    try {
      await unlink(checkpointsPath(paths, slug));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (orientationChanged) {
    await withBindingLock(paths, async () => {
      const index = await readBindingIndex(paths);
      const updatedAt = now();
      for (const [key, binding] of Object.entries(index.bindings)) {
        if (binding.unit !== slug) continue;
        index.bindings[key] = {
          ...binding,
          delivery: {
            state: "stale",
            orientation_revision: binding.delivery.orientation_revision,
            boundary: "orientation-revision",
            updated_at: updatedAt
          }
        };
      }
      await writeBindingIndex(paths, index);
    });
  }
  return {
    ...(await authoredStatus(paths, slug)),
    unit: next
  };
}

async function requireValidatedWorkUnit(paths: RuntimePaths, slug: string): Promise<WorkUnit> {
  const status = await authoredStatus(paths, slug);
  if (
    !status.valid ||
    status.orientation.state !== "current" ||
    status.context_map.state !== "current" ||
    status.checkpoints.state !== "current"
  ) {
    throw new Error(
      `Work unit ${slug} has unvalidated authored files; run mfz work validate ${slug}`
    );
  }
  return status.unit;
}

export async function attachWorkSession(
  paths: RuntimePaths,
  slug: string,
  session: SourceQualifiedSession
): Promise<void> {
  const unit = await requireValidatedWorkUnit(paths, slug);
  await withBindingLock(paths, async () => {
    const index = await readBindingIndex(paths);
    const key = sessionKey(session);
    if (index.bindings[key]) {
      throw new Error(
        `Session ${key} is already bound to ${index.bindings[key].unit}; use work switch explicitly`
      );
    }
    const timestamp = now();
    index.bindings[key] = {
      session,
      unit: workSlugSchema.parse(slug),
      attached_at: timestamp,
      delivery: {
        state: "pending",
        orientation_revision: unit.orientation.revision,
        boundary: "attachment",
        updated_at: timestamp
      }
    };
    await writeBindingIndex(paths, index);
  });
}

export async function switchWorkSession(
  paths: RuntimePaths,
  slug: string,
  session: SourceQualifiedSession
): Promise<void> {
  const unit = await requireValidatedWorkUnit(paths, slug);
  await withBindingLock(paths, async () => {
    const index = await readBindingIndex(paths);
    const key = sessionKey(session);
    const previous = index.bindings[key];
    if (!previous)
      throw new Error(`Session ${key} is not bound to a work unit; use work attach instead`);
    const timestamp = now();
    index.bindings[key] = {
      session,
      unit: workSlugSchema.parse(slug),
      attached_at: timestamp,
      delivery: {
        state: "pending",
        orientation_revision: unit.orientation.revision,
        boundary: "switch",
        updated_at: timestamp
      }
    };
    await writeBindingIndex(paths, index);
  });
}

export async function detachWorkSession(
  paths: RuntimePaths,
  session: SourceQualifiedSession
): Promise<void> {
  await withBindingLock(paths, async () => {
    const index = await readBindingIndex(paths);
    const key = sessionKey(session);
    if (!index.bindings[key]) throw new Error(`Session ${key} is not bound to a work unit`);
    delete index.bindings[key];
    await writeBindingIndex(paths, index);
  });
}

export async function reloadWorkOrientation(
  paths: RuntimePaths,
  session: SourceQualifiedSession,
  boundary = "reload"
): Promise<void> {
  await withBindingLock(paths, async () => {
    const index = await readBindingIndex(paths);
    const key = sessionKey(session);
    const binding = index.bindings[key];
    if (!binding) throw new Error(`Session ${key} is not bound to a work unit`);
    const unit = await readWorkUnit(paths, binding.unit);
    index.bindings[key] = {
      ...binding,
      delivery: {
        state: "pending",
        orientation_revision: unit.orientation.revision,
        boundary,
        updated_at: now()
      }
    };
    await writeBindingIndex(paths, index);
  });
}

export async function readWorkCheckpoints(
  paths: RuntimePaths,
  slug: string
): Promise<WorkCheckpoint[]> {
  const unit = await readWorkUnit(paths, slug);
  if (Object.keys(unit.checkpoint_hashes).length === 0) return [];
  const index = checkpointIndexSchema.parse(
    JSON.parse(await readFile(checkpointIndexPath(paths, slug), "utf8"))
  );
  const byFile = new Map(index.checkpoints.map((item) => [item.file, item]));
  const checkpoints = Object.entries(unit.checkpoint_hashes).map(([file, expectedHash]) => {
    const item = byFile.get(file);
    if (!item || item.hash !== expectedHash) {
      throw new Error(`Checkpoint index is not synchronized for ${file}`);
    }
    return item.checkpoint;
  });
  return checkpoints.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function appendWorkReceipt(
  paths: RuntimePaths,
  session: SourceQualifiedSession,
  input: {
    boundary: string;
    orientation_revision: number;
    reminder: string;
    orientation: string | null;
    outcome: "delivered" | "failed";
    error: string | null;
  }
): Promise<WorkReceipt> {
  return withBindingLock(paths, async () => {
    const index = await readBindingIndex(paths);
    const key = sessionKey(session);
    const binding = index.bindings[key];
    if (!binding) throw new Error(`Session ${key} is not bound to a work unit`);
    const unit = await readWorkUnit(paths, binding.unit);
    if (input.orientation_revision !== unit.orientation.revision) {
      throw new Error(
        `Orientation revision ${input.orientation_revision} is not current for ${unit.slug}`
      );
    }
    const receipt = workReceiptSchema.parse({
      unit: unit.slug,
      session,
      ...input,
      created_at: now()
    });
    await appendJsonl(receiptsPath(paths, unit.slug), receipt);
    let delivery: DeliveryState;
    if (input.outcome === "failed") {
      delivery = {
        state: "failed",
        orientation_revision: input.orientation_revision,
        boundary: input.boundary,
        updated_at: now(),
        error: input.error ?? "Context delivery failed"
      };
    } else if (input.orientation === null) {
      delivery = binding.delivery;
    } else {
      delivery = {
        state: "delivered",
        orientation_revision: input.orientation_revision,
        boundary: input.boundary,
        updated_at: now()
      };
    }
    index.bindings[key] = { ...binding, delivery };
    await writeBindingIndex(paths, index);
    return receipt;
  });
}

export async function readWorkReceipts(paths: RuntimePaths, slug: string): Promise<WorkReceipt[]> {
  await readWorkUnit(paths, slug);
  return readJsonl(receiptsPath(paths, slug), workReceiptSchema);
}

export async function resolveWorkContext(
  paths: RuntimePaths,
  session: SourceQualifiedSession
): Promise<
  | { session: SourceQualifiedSession; bound: false; reminder: string }
  | {
      session: SourceQualifiedSession;
      bound: true;
      unit: WorkUnit;
      freshness: DeliveryState["state"];
      reminder: string;
      pending_orientation: WorkOrientation | null;
      delivery: DeliveryState;
    }
> {
  const binding = (await readBindingIndex(paths)).bindings[sessionKey(session)];
  if (!binding) {
    return {
      session,
      bound: false,
      reminder:
        "Work tracking is optional. Durable work may justify a human-confirmed work-unit attachment."
    };
  }
  const unit = await readWorkUnit(paths, binding.unit);
  const freshness =
    binding.delivery.orientation_revision === unit.orientation.revision
      ? binding.delivery.state
      : "stale";
  return {
    session,
    bound: true,
    unit,
    freshness,
    reminder: `Active work unit ${unit.slug} (${unit.phase}). Keep work aligned and flag apparent scope drift.`,
    pending_orientation: freshness === "delivered" ? null : unit.orientation,
    delivery: binding.delivery
  };
}
