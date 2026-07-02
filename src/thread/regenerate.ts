import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expandHome, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { renderEventLog } from "./log.js";
import { THREAD_PERSONAS } from "./personas.js";
import { dispatch } from "./dispatch.js";
import { DockerAgentRunner, type AgentRunner } from "./runner.js";
import {
  appendThreadRun,
  commitThreadChanges,
  findThread,
  readSessionFiles,
  readThreadManifest,
  resolveSynthesisDefaults,
  type ParsedModelId
} from "./storage.js";
import { writeRunStatus, type ThreadRunStatus } from "./observability.js";
import type { ThreadDispatchRun } from "./schema.js";

export interface RegenerateViewsRequest {
  runner: AgentRunner;
  paths: RuntimePaths;
  runId: string;
  threadDir: string;
  slug: string;
  charter: string;
  digestModel: ParsedModelId;
  // The thread reconciles from its session files every run, so an unchanged thread still
  // re-derives free-form content (prose, the `## Design` diagram) from scratch and churns
  // cosmetically. Passing the prior digest anchors *form* — the digester reconciles facts
  // afresh but preserves layout and diagram where the sessions still support them. A
  // non-source, like the charter. Omit for a clean rebuild (`refresh --all`) to flush drift.
  previousDigest?: string | undefined;
  // The local repos the agent has on disk — reference clones and URL-bearing extra folders —
  // each mapped from its local path to its upstream URL. A session often cites one by its
  // local path (`~/references/opencode`, a work repo); this authoritative lookup lets the
  // digester resolve that path to its URL in `## Sources` so a future reader can reopen it.
  // A lookup, not a source — never a licence to invent a repo a session did not consult.
  repos?: RepoLocator[] | undefined;
}

// A local repo as the digester needs it: how a session names it (local path) mapped to how
// a reader reopens it (upstream URL).
export interface RepoLocator {
  name: string;
  localPath: string;
  url: string;
}

// The local repos the agent can cite: reference clones (at `<referencesDir>/<name>`) plus
// any extra folder that declares an upstream `url`. Both resolve deterministically from the
// profile, so the digester matches a session's local-path citation to its URL — no host
// access, no git remote lookup (the digest runs in a container without either).
export function repoLocators(profile: ResolvedProfile): RepoLocator[] {
  const references = profile.enabledReferences.map((ref) => ({
    name: ref.name,
    localPath: path.join(profile.referencesDir, ref.name),
    url: ref.url
  }));
  const extras = profile.extraFolders
    .filter((folder) => folder.url !== undefined)
    .map((folder) => ({
      name: path.basename(folder.path),
      localPath: expandHome(folder.path),
      url: folder.url!
    }));
  return [...references, ...extras];
}

// Rebuild the two derived views from the immutable session files on disk: log.md
// (deterministic, from the events) and digest.md (one digest dispatch over the
// session files). Shared by ingest — which calls it after new sessions land — and
// the regenerate command, which calls it alone with no re-gather/re-synthesize.
export async function regenerateViews(req: RegenerateViewsRequest): Promise<ThreadDispatchRun> {
  const { runner, paths, runId, threadDir, slug, charter, digestModel, previousDigest } = req;
  const sessions = await readSessionFiles(threadDir);
  await writeFile(path.join(threadDir, "log.md"), renderEventLog(sessions), "utf8");
  const anchor =
    previousDigest !== undefined
      ? `\n\nPrevious digest (a prior rendering — NOT a source of facts; the session files above are your only source). Reconcile the sessions from scratch as instructed, then use this only to hold form steady: keep its wording, section prose, bullet order, and its \`## Design\` ASCII diagram wherever the sessions still support them, so an unchanged thread yields an unchanged digest. Where newer sessions add, overturn, or invalidate content, revise or drop it — never carry forward a fact the sessions no longer support. The diagram is not sacred: when newer sessions introduce structure a different diagram would capture better, redraw it.\n\n${previousDigest}`
      : "";
  const repos =
    req.repos && req.repos.length > 0
      ? `\n\nLocal repos (a lookup, NOT a source). When a source in the session files is one of these repos — cited by its name or by any path ending in that name, since sessions may mount it at a different path than the one below — record its upstream URL in \`## Sources\` so a reader can reopen it. Resolve only a repo a session actually consulted; never add one it did not.\n${req.repos
          .map((repo) => `- ${repo.name} — ${repo.localPath} → ${repo.url}`)
          .join("\n")}`
      : "";
  const digest = await dispatch(runner, paths, runId, "digest", {
    role: "digest",
    harness: digestModel.harness,
    model: digestModel.model,
    effort: digestModel.effort,
    persona: THREAD_PERSONAS.digest,
    skills: ["thread-contract"],
    prompt: `Thread: ${slug}\n\nThe charter is the thread's topic hint — what the thread is about. It is NOT a source of facts; never lift specifics from it. The session files below are your only source material.\n\nCharter (topic hint, not a source): ${charter}\n\nSession files (your only source):\n${sessions.join("\n")}${anchor}${repos}`
  });
  await writeFile(path.join(threadDir, "digest.md"), digest.result.text + "\n", "utf8");
  return digest.dispatch;
}

export interface RegenerateRequest {
  paths: RuntimePaths;
  profile: ResolvedProfile;
  threadSlug: string;
  noPush: boolean;
  synthesize?: string | undefined;
  digest?: string | undefined;
  runner?: AgentRunner | undefined;
}

export interface RegenerateResult {
  slug: string;
  runId: string;
  totalCostUsd: number | null;
}

// Regenerate a thread's views from its existing session files — no re-gather, no
// re-synthesize. The cheap path for picking up an artifact-contract change without
// re-paying extraction: only the single digest dispatch is billed.
export async function regenerateThread(req: RegenerateRequest): Promise<RegenerateResult> {
  const { paths, profile } = req;
  const thread = await findThread(paths, profile, req.threadSlug);
  const manifest = await readThreadManifest(thread.dir);
  const settings = resolveSynthesisDefaults(profile.profile.thread.defaults, manifest, {
    synthesize: req.synthesize,
    digest: req.digest
  });
  const runner = req.runner ?? new DockerAgentRunner(paths, profile.profile.thread.credentials);
  const runId = `run-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const status: ThreadRunStatus = {
    id: runId,
    thread: manifest.slug,
    mode: "regenerate",
    pid: process.pid,
    current_step: "digest",
    started_at: startedAt,
    cost_usd: null
  };
  await writeRunStatus(paths, status);

  const digestDispatch = await regenerateViews({
    runner,
    paths,
    runId,
    threadDir: thread.dir,
    slug: manifest.slug,
    charter: manifest.charter,
    digestModel: settings.digest,
    previousDigest: await readPreviousDigest(thread.dir),
    repos: repoLocators(profile)
  });

  const finishedAt = new Date().toISOString();
  const total = digestDispatch.cost_usd;
  await appendThreadRun(thread.dir, {
    id: runId,
    thread: manifest.slug,
    started_at: startedAt,
    finished_at: finishedAt,
    sessions: [],
    dispatches: [digestDispatch],
    total_cost_usd: total
  });
  await writeRunStatus(paths, {
    ...status,
    current_step: "complete",
    finished_at: finishedAt,
    cost_usd: total
  });
  await commitThreadChanges(
    thread.destination,
    manifest.slug,
    thread.dir,
    `chore(thread): regenerate ${manifest.slug}`,
    !req.noPush && !thread.destination.no_push
  );

  return { slug: manifest.slug, runId, totalCostUsd: total };
}

// The prior digest anchors the next render's form. Absent on a thread's first digest,
// so a missing file reads as "no anchor" rather than an error.
export async function readPreviousDigest(threadDir: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(threadDir, "digest.md"), "utf8");
  } catch {
    return undefined;
  }
}
