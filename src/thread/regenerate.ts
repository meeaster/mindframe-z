import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
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
  synthModel: ParsedModelId;
}

// Rebuild the two derived views from the immutable session files on disk: log.md
// (deterministic, from the events) and digest.md (one digest dispatch over the
// session files). Shared by ingest — which calls it after new sessions land — and
// the regenerate command, which calls it alone with no re-gather/re-synthesize.
export async function regenerateViews(req: RegenerateViewsRequest): Promise<ThreadDispatchRun> {
  const { runner, paths, runId, threadDir, slug, charter, synthModel } = req;
  const sessions = await readSessionFiles(threadDir);
  await writeFile(path.join(threadDir, "log.md"), renderEventLog(sessions), "utf8");
  const digest = await dispatch(runner, paths, runId, "digest", {
    role: "digest",
    harness: synthModel.harness,
    model: synthModel.model,
    effort: synthModel.effort,
    persona: THREAD_PERSONAS.digest,
    skills: ["thread-contract"],
    prompt: `Thread: ${slug}\n\nThe charter is the thread's topic hint — what the thread is about. It is NOT a source of facts; never lift specifics from it. The session files below are your only source material.\n\nCharter (topic hint, not a source): ${charter}\n\nSession files (your only source):\n${sessions.join("\n")}`
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
    synthesize: req.synthesize
  });
  const runner = req.runner ?? new DockerAgentRunner(paths);
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
    synthModel: settings.synthesize
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
