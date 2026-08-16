import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa, ExecaError } from "execa";
import { z } from "zod";
import { jsonFileContent } from "../core/fs-util.js";
import type { RuntimePaths } from "../core/paths.js";
import {
  threadManifestSchema,
  threadRunRecordSchema,
  threadRunsSchema,
  type ThreadManifest,
  type ThreadRuns
} from "./schema.js";
import { resolveLegacyWatermark, type Watermark } from "./watermark.js";
import { writeThreadIndex } from "./index.js";

const legacySessionSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(["claude-code", "opencode"]),
    title: z.string().optional(),
    project: z.string().optional(),
    time_range: z.string().optional(),
    high_water: z.union([z.string(), z.number()]).optional(),
    message_count: z.number().int().nonnegative().optional(),
    last_message_id: z.string().min(1).optional(),
    last_activity_at: z.string().min(1).optional(),
    extracted_by: z.string().optional(),
    synthesizer: z.string().optional()
  })
  .strict();

const legacyExclusionSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(["claude-code", "opencode"]).optional(),
    title: z.string().optional(),
    project: z.string().optional(),
    reason: z.string().optional()
  })
  .strict();

const legacyRunSchema = z
  .object({
    at: z.string().min(1),
    mode: z.string().min(1),
    sessions: z.array(z.string()).default([]),
    model: z.string().optional(),
    duration_ms: z.number().nonnegative().optional(),
    num_turns: z.number().nonnegative().optional(),
    usage: z.record(z.string(), z.number()).optional(),
    cost_usd: z.number().nullable().optional()
  })
  .strict();

const legacyManifestSchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1).optional(),
    charter: z.string().min(1),
    destination: z.string().min(1).optional(),
    store: z.string().min(1).optional(),
    created_at: z.string().min(1),
    read_subagents: z.boolean().optional(),
    sessions: z.array(legacySessionSchema).default([]),
    excluded: z.array(z.union([z.string().min(1), legacyExclusionSchema])).default([]),
    runs: z.array(legacyRunSchema).default([]),
    synthesis: z
      .object({
        discover: z.string().optional(),
        gather: z.string().optional(),
        synthesize: z.string().optional(),
        digest: z.string().optional()
      })
      .strict()
      .default({})
  })
  .strict();

export interface MigrateThreadRequest {
  paths: RuntimePaths;
  sourceDir: string;
  targetDir?: string | undefined;
  storeName: string;
  storePath: string;
}

export interface MigratedThread {
  manifest: ThreadManifest;
  importedRuns: number;
  contentHashes: Record<string, string>;
}

export interface MigrateStoreRequest {
  paths: RuntimePaths;
  storeName: string;
  storePath: string;
  outputPath?: string | undefined;
  dryRun?: boolean | undefined;
  writeBack?: boolean | undefined;
}

export interface MigratedStore {
  storeName: string;
  threads: MigratedThread[];
  outputPath?: string | undefined;
}

export async function migrateThreadDirectory(
  request: MigrateThreadRequest
): Promise<MigratedThread> {
  const raw = JSON.parse(await readFile(path.join(request.sourceDir, "manifest.json"), "utf8"));
  const legacy = legacyManifestSchema.parse(raw);
  const recordedStore = legacy.store ?? legacy.destination;
  if (recordedStore !== undefined && recordedStore !== request.storeName) {
    throw new Error(
      `Thread ${legacy.slug} records store ${recordedStore}, expected ${request.storeName}`
    );
  }
  const relative = path.relative(request.storePath, request.sourceDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Thread ${legacy.slug} is outside configured store ${request.storeName}`);
  }

  const sessions = [];
  for (const session of legacy.sessions) {
    const watermark = await legacyWatermark(request.paths, session);
    const converted: z.infer<typeof threadManifestSchema>["sessions"][number] = {
      id: session.id,
      source: session.source
    };
    if (session.title !== undefined) converted.title = session.title;
    if (session.project !== undefined) converted.project = session.project;
    if (session.time_range !== undefined) converted.time_range = session.time_range;
    const synthesizer = session.synthesizer ?? session.extracted_by;
    if (synthesizer) converted.synthesizer = synthesizer;
    if (watermark !== undefined) Object.assign(converted, watermark);
    sessions.push(converted);
  }

  const manifestInput: z.infer<typeof threadManifestSchema> = {
    slug: legacy.slug,
    charter: legacy.charter,
    store: request.storeName,
    created_at: legacy.created_at,
    sessions,
    excluded: legacy.excluded.map<z.infer<typeof threadManifestSchema>["excluded"][number]>(
      (entry) => {
        const id = z.string().safeParse(entry);
        return id.success ? { id: id.data } : legacyExclusionSchema.parse(entry);
      }
    ),
    synthesis: legacy.synthesis
  };
  if (legacy.title !== undefined) manifestInput.title = legacy.title;
  if (legacy.read_subagents !== undefined) manifestInput.read_subagents = legacy.read_subagents;
  const manifest = threadManifestSchema.parse(manifestInput);

  const targetDir = request.targetDir ?? request.sourceDir;
  if (targetDir !== request.sourceDir) await cp(request.sourceDir, targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "manifest.json"), jsonFileContent(manifest), "utf8");

  const runs = await migrateRuns(request.sourceDir, manifest.slug, legacy.runs);
  if (runs.runs.length > 0 || (await fileExists(path.join(request.sourceDir, "runs.json")))) {
    await writeFile(path.join(targetDir, "runs.json"), jsonFileContent(runs), "utf8");
  }
  return {
    manifest,
    importedRuns: legacy.runs.length,
    contentHashes: await contentHashes(targetDir)
  };
}

export async function migrateStore(request: MigrateStoreRequest): Promise<MigratedStore> {
  const threadDirs = [];
  for (const entry of await readdir(request.storePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (await fileExists(path.join(request.storePath, entry.name, "manifest.json"))) {
      threadDirs.push(path.join(request.storePath, entry.name));
    }
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "mfz-thread-migration-"));
  try {
    const preparedStore = path.join(temporary, "store");
    await cp(request.storePath, preparedStore, { recursive: true });
    const threads: MigratedThread[] = [];
    for (const sourceDir of threadDirs) {
      const targetDir = path.join(preparedStore, path.basename(sourceDir));
      threads.push(
        await migrateThreadDirectory({
          paths: request.paths,
          sourceDir,
          targetDir,
          storeName: request.storeName,
          storePath: request.storePath
        })
      );
    }
    if (!request.dryRun && request.writeBack) {
      await copyDirectoryContents(preparedStore, request.outputPath ?? request.storePath);
    }
    const result: MigratedStore = {
      storeName: request.storeName,
      threads
    };
    if (request.outputPath !== undefined) result.outputPath = request.outputPath;
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface PublishedStoreMigration {
  storeName: string;
  branch: string;
  commit: string;
  url?: string | undefined;
}

export async function publishStoreMigration(args: {
  paths: RuntimePaths;
  storeName: string;
  storeRoot: string;
  storePath: string;
  base: string;
}): Promise<PublishedStoreMigration> {
  const relativeStore = path.relative(args.storeRoot, args.storePath);
  if (!relativeStore || relativeStore.startsWith("..") || path.isAbsolute(relativeStore)) {
    throw new Error(`Thread store path escapes repository root: ${args.storeName}`);
  }
  await execa("git", ["fetch", "origin", args.base], { cwd: args.storeRoot });
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mfz-thread-store-migration-"));
  const checkout = path.join(workspace, "checkout");
  const branch = `automation/thread-store-migration-${args.storeName}-${Date.now()}`;
  let worktreeAdded = false;
  try {
    await execa(
      "git",
      ["worktree", "add", "--quiet", "--detach", checkout, `origin/${args.base}`],
      {
        cwd: args.storeRoot
      }
    );
    worktreeAdded = true;
    const checkoutStorePath = path.join(checkout, relativeStore);
    await migrateStore({
      paths: args.paths,
      storeName: args.storeName,
      storePath: checkoutStorePath,
      writeBack: true
    });
    await writeThreadIndex(checkoutStorePath);
    await execa("git", ["add", "-A", "--", relativeStore], { cwd: checkout });
    const staged = await execa("git", ["diff", "--cached", "--quiet"], { cwd: checkout }).then(
      () => false,
      (error) => error instanceof ExecaError && error.exitCode === 1
    );
    if (!staged) throw new Error(`Store ${args.storeName} migration produced no changes`);
    await execa("git", ["commit", "-m", `chore(thread): migrate ${args.storeName} store`], {
      cwd: checkout
    });
    const { stdout: commit } = await execa("git", ["rev-parse", "HEAD"], { cwd: checkout });
    await execa("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: checkout });
    const { stdout: url } = await execa(
      "gh",
      [
        "pr",
        "create",
        "--base",
        args.base,
        "--head",
        branch,
        "--title",
        `chore(thread): migrate ${args.storeName} store`,
        "--body",
        `Lossless migration of the ${args.storeName} thread store to strict MFZ manifests and run ledgers.`
      ],
      { cwd: checkout }
    );
    return { storeName: args.storeName, branch, commit: commit.trim(), url: url.trim() };
  } finally {
    if (worktreeAdded) {
      await execa("git", ["worktree", "remove", "--force", checkout], {
        cwd: args.storeRoot
      }).catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
    await execa("git", ["worktree", "prune"], { cwd: args.storeRoot }).catch(() => undefined);
  }
}

async function legacyWatermark(
  paths: RuntimePaths,
  session: z.infer<typeof legacySessionSchema>
): Promise<Watermark | undefined> {
  const canonical = [session.message_count, session.last_message_id, session.last_activity_at];
  if (canonical.every((field) => field !== undefined)) {
    return {
      message_count: session.message_count!,
      last_message_id: session.last_message_id!,
      last_activity_at: session.last_activity_at!
    };
  }
  if (canonical.some((field) => field !== undefined)) {
    throw new Error(`Session ${session.source}:${session.id} has a partial canonical watermark`);
  }
  if (session.high_water === undefined) return undefined;
  const watermark = await resolveLegacyWatermark(
    paths,
    { source: session.source, id: session.id },
    session.high_water
  );
  if (watermark === undefined) {
    throw new Error(
      `Unable to resolve ${session.source}:${session.id} legacy cursor ${JSON.stringify(session.high_water)}`
    );
  }
  return watermark;
}

async function migrateRuns(
  sourceDir: string,
  slug: string,
  embedded: z.infer<typeof legacyRunSchema>[]
): Promise<ThreadRuns> {
  const file = path.join(sourceDir, "runs.json");
  const existing = (await fileExists(file))
    ? JSON.parse(await readFile(file, "utf8"))
    : { runs: [] };
  const existingRuns = z
    .object({ runs: z.array(z.union([legacyRunSchema, threadRunRecordSchema])) })
    .parse(existing)
    .runs.map((run) => ("kind" in run ? run : { kind: "native", ...run }));
  const imported = embedded.map((run, index) => {
    const importedRun: Extract<ThreadRuns["runs"][number], { kind: "imported" }> = {
      kind: "imported",
      id: `imported-${slug}-${index + 1}-${createHash("sha256").update(JSON.stringify(run)).digest("hex").slice(0, 12)}`,
      thread: slug,
      at: run.at,
      mode: run.mode,
      sessions: run.sessions
    };
    if (run.model !== undefined) importedRun.model = run.model;
    if (run.duration_ms !== undefined) importedRun.duration_ms = run.duration_ms;
    if (run.num_turns !== undefined) importedRun.num_turns = run.num_turns;
    if (run.usage !== undefined) importedRun.usage = run.usage;
    if (run.cost_usd !== undefined) importedRun.cost_usd = run.cost_usd;
    return importedRun;
  });
  return threadRunsSchema.parse({ runs: [...existingRuns, ...imported] });
}

async function contentHashes(dir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "manifest.json" || entry.name === "runs.json") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, digest] of Object.entries(await contentHashes(full))) {
        hashes[path.join(entry.name, name)] = digest;
      }
    } else if (entry.isFile()) {
      hashes[entry.name] = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
    }
  }
  return hashes;
}

async function copyDirectoryContents(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      force: true
    });
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
