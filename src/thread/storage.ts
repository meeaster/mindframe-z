import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { pathExists, threadDestinationRoot, threadPath, type RuntimePaths } from "../core/paths.js";
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

  const destinations = [...map.values()];
  const defaultName = destinations.findLast((destination) => destination.default)?.name;
  return destinations.map((destination) => ({
    ...destination,
    default: destination.name === defaultName,
    path: threadDestinationRoot(paths, destination.name)
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
    )
  };
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
  extracted_by: string;
}

// Upsert this run's session ledger entries in one read-modify-write: membership
// (source), plus the title and synthesizer provenance lifted from the run. TS owns
// every field. Batched so the parallel ingest fan-out cannot lose updates.
export async function recordSessions(
  dir: string,
  entries: readonly SessionLedgerEntry[]
): Promise<void> {
  const manifest = await readThreadManifest(dir);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const updated = manifest.sessions.map((session) => ({ ...session, ...byId.get(session.id) }));
  const added = entries.filter((entry) => !manifest.sessions.some((s) => s.id === entry.id));
  await writeThreadManifest(dir, { ...manifest, sessions: [...updated, ...added] });
}

export async function appendThreadRun(dir: string, record: ThreadRunRecord): Promise<void> {
  const runs = await readThreadRuns(dir);
  runs.runs.push(record);
  await writeThreadRuns(dir, runs);
}
