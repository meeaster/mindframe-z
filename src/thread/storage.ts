import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { jsonFileContent, pathExists, readTextFile, writeTextFile } from "../core/fs-util.js";
import type { RuntimePaths } from "../core/paths.js";
import { expandHome } from "../core/path-util.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  threadHarnessSchema,
  type ThreadDefaults,
  type ThreadStore,
  type ThreadHarness
} from "../core/manifests.js";
import {
  threadManifestSchema,
  threadRunsSchema,
  type ThreadManifest,
  type ThreadRunRecord,
  type ThreadRuns
} from "./schema.js";

export {
  threadSessionSchema,
  threadManifestSchema,
  threadDispatchRunSchema,
  threadRunRecordSchema,
  threadRunsSchema
} from "./schema.js";
export type { ThreadManifest, ThreadRuns, ThreadRunRecord, ThreadDispatchRun } from "./schema.js";

export interface ParsedModelId {
  harness: "claude-code" | "opencode";
  model: string;
  effort: string;
}

export interface ResolvedSynthesisDefaults {
  discover: ParsedModelId;
  gather: ParsedModelId;
  synthesize: ParsedModelId;
  digest: ParsedModelId;
  triage: ParsedModelId;
}

export type ResolvedThreadStore = ThreadStore & { root: string; path: string };

function resolvedStoreRoot(paths: RuntimePaths, store: ThreadStore): string {
  const root = expandHome(store.root, paths.home);
  if (!path.isAbsolute(root)) throw new Error(`Thread store root must be absolute: ${root}`);
  return path.resolve(root);
}

function rootedStorePath(paths: RuntimePaths, store: ThreadStore): string {
  const resolvedRoot = resolvedStoreRoot(paths, store);
  const resolved = path.resolve(resolvedRoot, store.path);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Thread store path escapes configured root: ${store.name}`);
  }
  return resolved;
}

export function resolveThreadStores(
  paths: RuntimePaths,
  profile: ResolvedProfile
): ResolvedThreadStore[] {
  const map = new Map<string, ThreadStore>();
  for (const store of profile.profile.thread.stores) map.set(store.name, store);
  for (const store of profile.manifests?.machine.thread.stores ?? []) {
    map.set(store.name, store);
  }

  const stores = [...map.values()];
  const machineStores = profile.manifests?.machine.thread.stores ?? [];
  const defaultName =
    machineStores.findLast((store) => store.default)?.name ??
    profile.profile.thread.stores.findLast((store) => store.default)?.name;
  return stores.map((store) => ({
    ...store,
    root: resolvedStoreRoot(paths, store),
    path: rootedStorePath(paths, store),
    default: store.name === defaultName
  }));
}

export function defaultThreadStore(
  stores: readonly ResolvedThreadStore[]
): ResolvedThreadStore | undefined {
  return stores.find((store) => store.default) ?? stores[0];
}

export function findThreadStore(
  stores: readonly ResolvedThreadStore[],
  name: string
): ResolvedThreadStore {
  const store = stores.find((entry) => entry.name === name);
  if (!store) throw new Error(`Unknown thread store: ${name}`);
  return store;
}

export async function prepareThreadStore(
  paths: RuntimePaths,
  store: ResolvedThreadStore
): Promise<void> {
  void paths;
  if (!(await pathExists(store.root)))
    throw new Error(`Thread store repository does not exist: ${store.name} (${store.root})`);
  if (!(await pathExists(store.path)))
    throw new Error(`Thread store thread path does not exist: ${store.name} (${store.path})`);
}

export async function readThreadManifest(dir: string): Promise<ThreadManifest> {
  return threadManifestSchema.parse(
    JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"))
  );
}

export async function writeThreadManifest(dir: string, manifest: ThreadManifest): Promise<void> {
  await writeTextFile(path.join(dir, "manifest.json"), jsonFileContent(manifest));
}

export async function readThreadRuns(dir: string): Promise<ThreadRuns> {
  const content = await readTextFile(path.join(dir, "runs.json"));
  if (content === undefined) return { runs: [] };
  return threadRunsSchema.parse(JSON.parse(content));
}

export async function writeThreadRuns(dir: string, runs: ThreadRuns): Promise<void> {
  await writeTextFile(path.join(dir, "runs.json"), jsonFileContent(runs));
}

const FALLBACK_DISCOVER = "claude-code:sonnet@high";
const FALLBACK_GATHER = "claude-code:haiku@low";
const FALLBACK_TRIAGE = "claude-code:haiku@low";
const FALLBACK_SYNTHESIZE = "claude-code:sonnet@high";

export function parseModelId(id: string): ParsedModelId {
  const colon = id.indexOf(":");
  const at = id.lastIndexOf("@");
  if (colon === -1 || at === -1 || at <= colon) {
    throw new Error(`Invalid model ID: ${id} (expected harness:model@effort)`);
  }
  const harness = id.slice(0, colon);
  if (harness !== "claude-code" && harness !== "opencode") {
    throw new Error(`Unknown harness: ${harness}`);
  }
  return { harness, model: id.slice(colon + 1, at), effort: id.slice(at + 1) };
}

export function resolveSynthesisDefaults(
  profileDefaults: ThreadDefaults,
  manifest: {
    synthesis: {
      discover?: string | undefined;
      gather?: string | undefined;
      synthesize?: string | undefined;
      digest?: string | undefined;
    };
  },
  flags: {
    discover?: string | undefined;
    gather?: string | undefined;
    synthesize?: string | undefined;
    digest?: string | undefined;
    triage?: string | undefined;
  } = {}
): ResolvedSynthesisDefaults {
  // Resolve the synthesize id first so an unset digest can inherit it, preserving
  // the prior behavior where the digest dispatch reused the synthesize model.
  const synthesize =
    flags.synthesize ??
    manifest.synthesis.synthesize ??
    profileDefaults.synthesize ??
    FALLBACK_SYNTHESIZE;
  return {
    discover: parseModelId(
      flags.discover ?? manifest.synthesis.discover ?? profileDefaults.discover ?? FALLBACK_DISCOVER
    ),
    gather: parseModelId(
      flags.gather ?? manifest.synthesis.gather ?? profileDefaults.gather ?? FALLBACK_GATHER
    ),
    synthesize: parseModelId(synthesize),
    digest: parseModelId(
      flags.digest ?? manifest.synthesis.digest ?? profileDefaults.digest ?? synthesize
    ),
    triage: parseModelId(flags.triage ?? profileDefaults.triage ?? FALLBACK_TRIAGE)
  };
}

export function resolveTriageModel(
  profileDefaults: ThreadDefaults,
  flag?: string | undefined
): ParsedModelId {
  return parseModelId(flag ?? profileDefaults.triage ?? FALLBACK_TRIAGE);
}

const DEFAULT_SESSION_SOURCES: ThreadHarness[] = ["claude-code", "opencode"];

export function resolveSessionSources(
  profileDefaults: ThreadDefaults,
  flags?: readonly string[] | undefined
): ThreadHarness[] {
  if (flags) return assertSessionSources(flags);
  return profileDefaults.session_sources ?? DEFAULT_SESSION_SOURCES;
}

// `--sources` reaches the resolver as raw strings; reject unknown or empty input
// here rather than silently filtering it down to a no-skill discovery run.
function assertSessionSources(flags: readonly string[]): ThreadHarness[] {
  const out = flags.map((source) => threadHarnessSchema.parse(source));
  if (out.length === 0)
    throw new Error("--sources must list at least one of: claude-code, opencode");
  return out;
}

export async function hasRemote(dir: string): Promise<boolean> {
  const { stdout } = await execa("git", ["remote"], { cwd: dir });
  return stdout.trim().length > 0;
}

export async function syncThreadStore(store: ResolvedThreadStore): Promise<string[]> {
  const { stdout: dirty } = await execa("git", ["status", "--porcelain"], { cwd: store.root });
  if (dirty.trim()) throw new Error(`Cannot sync dirty thread store "${store.name}"`);
  if (!(await hasRemote(store.root))) return [];
  await execa("git", ["fetch", "origin"], { cwd: store.root });
  const { stdout: upstream } = await execa(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd: store.root }
  ).catch(() => ({ stdout: "" }));
  if (!upstream.trim()) return [];
  try {
    await execa("git", ["pull", "--ff-only"], { cwd: store.root });
  } catch (original) {
    throw new Error(
      `Failed to fast-forward thread store "${store.name}". Resolve divergence manually.`,
      { cause: original }
    );
  }

  const threads: string[] = [];
  for (const entry of await readdir(store.path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const hasManifest = await pathExists(path.join(store.path, entry.name, "manifest.json"));
    if (!hasManifest) continue;
    threads.push(entry.name);
  }

  return threads;
}

export interface ResolvedThread {
  dir: string;
  store: ResolvedThreadStore;
}

// Enumerate authoritative store checkouts. A slug may belong to exactly one.
export async function listThreads(
  paths: RuntimePaths,
  profile: ResolvedProfile
): Promise<ResolvedThread[]> {
  const threads = new Map<string, ResolvedThread>();
  for (const store of resolveThreadStores(paths, profile)) {
    let entries;
    try {
      entries = await readdir(store.path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Thread store path does not exist: ${store.name} (${store.path})`, {
          cause: error
        });
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(store.path, entry.name);
      if (!(await pathExists(path.join(dir, "manifest.json")))) continue;
      const manifest = await readThreadManifest(dir);
      if (manifest.slug !== entry.name) {
        throw new Error(
          `Thread manifest slug does not match its store directory: ${store.name}/${entry.name}`
        );
      }
      if (manifest.store !== store.name) {
        throw new Error(
          `Thread manifest store mismatch at ${store.name}/${entry.name}: recorded ${manifest.store}`
        );
      }
      const existing = threads.get(manifest.slug);
      if (existing) {
        throw new Error(
          `Thread slug "${manifest.slug}" exists in multiple stores: ${existing.store.name}, ${store.name}`
        );
      }
      threads.set(manifest.slug, { dir, store });
    }
  }
  return [...threads.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, thread]) => thread);
}

// Locate a thread in its authoritative store checkout.
export async function findThread(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  slug: string
): Promise<ResolvedThread> {
  const thread = (await listThreads(paths, profile)).find(
    (entry) => path.basename(entry.dir) === slug
  );
  if (!thread) throw new Error(`Unknown thread: ${slug}`);
  return thread;
}

// Direct stores are mutated in place. Pull-request stores receive a disposable
// copy, so their canonical checkout stays an untouched read source.
export async function withThreadMutation<T>(
  thread: ResolvedThread,
  fn: (thread: ResolvedThread) => Promise<T>
): Promise<T> {
  if (thread.store.publication === "direct") return fn(thread);
  const workspace = await mkdtemp(path.join(tmpdir(), "mfz-thread-run-"));
  const dir = path.join(workspace, path.basename(thread.dir));
  try {
    await cp(thread.dir, dir, { recursive: true });
    return await fn({ ...thread, dir });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

// One synthesized session file per id, written under the thread's `sessions/`.
// Provenance lives in the manifest ledger, never in the file body.
export async function writeSessionFile(
  dir: string,
  source: ThreadHarness,
  bareId: string,
  text: string
): Promise<void> {
  const sessionsDir = path.join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(sessionsDir, `${source}-${bareId}.md`), text + "\n", "utf8");
}

// The prior synthesized file for one session, or undefined if none exists yet. The
// delta refresh path revises this file instead of regenerating it from scratch.
// Only a missing file means "no prior summary"; the readTextFile seam still lets a
// permission or I/O fault reach the operator instead of reading as a full refresh.
export async function readSessionFile(
  dir: string,
  source: ThreadHarness,
  bareId: string
): Promise<string | undefined> {
  return await readTextFile(path.join(dir, "sessions", `${source}-${bareId}.md`));
}

// Raw session-file contents in id order. Feeds the deterministic `log.md` render
// and the digest dispatch (which reads the full files, never the derived log).
export async function readSessionFiles(dir: string): Promise<string[]> {
  const sessionsDir = path.join(dir, "sessions");
  try {
    const files = (await readdir(sessionsDir)).filter((file) => file.endsWith(".md")).sort();
    return await Promise.all(files.map((file) => readFile(path.join(sessionsDir, file), "utf8")));
  } catch {
    return [];
  }
}

export interface SessionLedgerEntry {
  id: string;
  source: ThreadHarness;
  title?: string | undefined;
  project?: string | undefined;
  time_range?: string | undefined;
  // Required on a real synthesis; omitted by an irrelevant-delta short-circuit, which
  // writes no file and preserves the prior provenance via the merge below.
  synthesizer?: string | undefined;
  // Tail signature of the host store, captured at gather time on this session's last
  // ingest run. Absent on entries written before watermarks existed, and on any run
  // where the store could not be read; the read-modify-write below leaves prior
  // watermark fields intact.
  message_count?: number | undefined;
  last_message_id?: string | undefined;
  last_activity_at?: string | undefined;
}

// Upsert this run's session ledger entries in one read-modify-write: membership
// (source), plus the title and synthesizer provenance lifted from the run. TS owns
// every field. Batched so the parallel ingest fan-out cannot lose updates.
export async function recordSessions(
  dir: string,
  entries: readonly SessionLedgerEntry[]
): Promise<void> {
  const manifest = await readThreadManifest(dir);
  // Key on canonical `source:id` — the identity used for session files and refresh sets —
  // so a claude and an opencode session that share a native id never overwrite each other.
  const key = (s: { source: ThreadHarness; id: string }): string => `${s.source}:${s.id}`;
  const byKey = new Map(entries.map((entry) => [key(entry), entry]));
  const updated = manifest.sessions.map((session) => ({ ...session, ...byKey.get(key(session)) }));
  const added = entries.filter((entry) => !manifest.sessions.some((s) => key(s) === key(entry)));
  await writeThreadManifest(dir, { ...manifest, sessions: [...updated, ...added] });
}

export async function appendThreadRun(
  dir: string,
  record: Omit<Extract<ThreadRunRecord, { kind: "native" }>, "kind"> | ThreadRunRecord
): Promise<void> {
  const runs = await readThreadRuns(dir);
  runs.runs.push("kind" in record ? record : { kind: "native", ...record });
  await writeThreadRuns(dir, runs);
}
