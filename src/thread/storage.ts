import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { pathExists } from "../core/fs-util.js";
import { threadDestinationRoot, threadPath, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  threadHarnessSchema,
  type ThreadDefaults,
  type ThreadDestination,
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

export type ResolvedThreadDestination = ThreadDestination & { path: string };

export function resolveThreadDestinations(
  paths: RuntimePaths,
  profile: ResolvedProfile
): ResolvedThreadDestination[] {
  const map = new Map<string, ThreadDestination>();
  for (const destination of profile.profile.thread.destinations)
    map.set(destination.name, destination);
  for (const destination of profile.manifests.machine.thread.destinations) {
    map.set(destination.name, destination);
  }

  if (!map.has("home")) {
    map.set("home", { name: "home", path: "threads", no_push: false, default: false });
  }
  const destinations = [...map.values()];
  const defaultName = destinations.findLast((destination) => destination.default)?.name ?? "home";
  return destinations.map((destination) => ({
    ...destination,
    default: destination.name === defaultName,
    path: destination.path
      ? path.join(paths.root, destination.path)
      : threadDestinationRoot(paths, destination.name)
  }));
}

export function defaultThreadDestination(
  destinations: readonly ResolvedThreadDestination[]
): ResolvedThreadDestination | undefined {
  return destinations.find((destination) => destination.default) ?? destinations[0];
}

export function findThreadDestination(
  destinations: readonly ResolvedThreadDestination[],
  name: string
): ResolvedThreadDestination {
  const destination = destinations.find((entry) => entry.name === name);
  if (!destination) throw new Error(`Unknown thread destination: ${name}`);
  return destination;
}

export async function prepareThreadDestination(
  paths: RuntimePaths,
  destination: ResolvedThreadDestination
): Promise<void> {
  if (await pathExists(destination.path)) return;

  await mkdir(path.dirname(destination.path), { recursive: true });

  if (destination.remote) {
    await execa("git", ["clone", destination.remote, destination.path]);
    return;
  }

  await mkdir(destination.path, { recursive: true });
  await execa("git", ["init"], { cwd: destination.path });
}

export async function readThreadManifest(dir: string): Promise<ThreadManifest> {
  return threadManifestSchema.parse(
    JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"))
  );
}

export async function writeThreadManifest(dir: string, manifest: ThreadManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export async function readThreadRuns(dir: string): Promise<ThreadRuns> {
  const file = path.join(dir, "runs.json");
  if (!(await pathExists(file))) return { runs: [] };
  return threadRunsSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function writeThreadRuns(dir: string, runs: ThreadRuns): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "runs.json"), JSON.stringify(runs, null, 2) + "\n");
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

async function pushIfRemote(destination: ResolvedThreadDestination): Promise<void> {
  if (!(await hasRemote(destination.path))) {
    console.warn(`No git remote for ${destination.name} — skipping push`);
    return;
  }
  await execa("git", ["push"], { cwd: destination.path });
}

export async function commitThreadChanges(
  destination: ResolvedThreadDestination,
  slug: string,
  threadDir: string,
  message: string,
  push: boolean
): Promise<void> {
  const destDir = path.join(destination.path, slug);
  await cp(threadDir, destDir, { recursive: true, force: true });
  await execa("git", ["add", "."], { cwd: destination.path });
  await execa("git", ["commit", "-m", message], { cwd: destination.path });
  if (!push) return;
  await pushIfRemote(destination);
}

export async function deleteThreadFromDestination(
  destination: ResolvedThreadDestination,
  slug: string,
  push: boolean
): Promise<void> {
  const destDir = path.join(destination.path, slug);
  const existed = await pathExists(destDir);
  if (!existed) return;

  await rm(destDir, { recursive: true, force: true });
  await execa("git", ["add", "."], { cwd: destination.path });
  await execa("git", ["commit", "-m", `chore(thread): delete ${slug}`], { cwd: destination.path });
  if (!push) return;
  await pushIfRemote(destination);
}

export async function syncThreadDestination(
  destination: ResolvedThreadDestination,
  storeRoot: string
): Promise<string[]> {
  if (!(await hasRemote(destination.path))) return [];

  await execa("git", ["fetch", "origin"], { cwd: destination.path });

  // If the remote has no branches yet (empty repo) there's nothing to pull.
  const { stdout: remoteBranches } = await execa("git", ["branch", "-r"], {
    cwd: destination.path
  });
  if (!remoteBranches.trim()) return [];

  try {
    await execa("git", ["pull", "--rebase", "--autostash"], { cwd: destination.path });
  } catch (original) {
    throw new Error(
      `Failed to sync destination "${destination.name}". ` +
        "Resolve any conflicts manually, or run `git rebase --abort` to cancel.",
      { cause: original }
    );
  }

  const updated: string[] = [];
  for (const entry of await readdir(destination.path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const destDir = path.join(destination.path, entry.name);
    const hasManifest = await pathExists(path.join(destDir, "manifest.json"));
    if (!hasManifest) continue;
    const storeDir = path.join(storeRoot, entry.name);
    await cp(destDir, storeDir, { recursive: true, force: true });
    updated.push(entry.name);
  }

  return updated;
}

export interface ResolvedThread {
  dir: string;
  destination: ResolvedThreadDestination;
}

// Locate a thread's store directory and its resolved destination from the slug.
export async function findThread(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  slug: string
): Promise<ResolvedThread> {
  const dir = threadPath(paths, slug);
  const manifest = await readThreadManifest(dir);
  const destination = findThreadDestination(
    resolveThreadDestinations(paths, profile),
    manifest.destination
  );
  return { dir, destination };
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
export async function readSessionFile(
  dir: string,
  source: ThreadHarness,
  bareId: string
): Promise<string | undefined> {
  try {
    return await readFile(path.join(dir, "sessions", `${source}-${bareId}.md`), "utf8");
  } catch (error) {
    // Only a missing file means "no prior summary"; a permission or I/O fault is a real
    // problem the operator should see, not silently a full-refresh fallback.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  // Required on a real synthesis; omitted by an irrelevant-delta short-circuit, which
  // writes no file and preserves the prior provenance via the merge below.
  extracted_by?: string | undefined;
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

export async function appendThreadRun(dir: string, record: ThreadRunRecord): Promise<void> {
  const runs = await readThreadRuns(dir);
  runs.runs.push(record);
  await writeThreadRuns(dir, runs);
}
