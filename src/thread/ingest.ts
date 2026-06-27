import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { ThreadHarness } from "../core/manifests.js";
import { renderEventLog } from "./log.js";
import { THREAD_PERSONAS } from "./personas.js";
import { DockerAgentRunner, type AgentRunner } from "./runner.js";
import { dispatch } from "./dispatch.js";
import {
  appendThreadRun,
  commitThreadChanges,
  findThread,
  readSessionFiles,
  readThreadManifest,
  recordSessions,
  resolveSynthesisDefaults,
  writeSessionFile,
  type ThreadDispatchRun
} from "./storage.js";
import { writeRunDossiers, writeRunStatus, type ThreadRunStatus } from "./observability.js";

export interface IngestRequest {
  paths: RuntimePaths;
  profile: ResolvedProfile;
  threadSlug: string;
  sessionIds: string[];
  noPush: boolean;
  gather?: string | undefined;
  synthesize?: string | undefined;
  runner?: AgentRunner | undefined;
}

export interface IngestResult {
  slug: string;
  sessionCount: number;
  runId: string;
  totalCostUsd: number | null;
}

export async function ingestThread(req: IngestRequest): Promise<IngestResult> {
  const { paths, profile, sessionIds } = req;
  if (sessionIds.length === 0) throw new Error("Provide at least one session id to ingest");

  const thread = await findThread(paths, profile, req.threadSlug);
  const manifest = await readThreadManifest(thread.dir);
  const settings = resolveSynthesisDefaults(profile.profile.thread.defaults, manifest, {
    gather: req.gather,
    synthesize: req.synthesize
  });
  const gatherModel = settings.gather;
  const synthModel = settings.synthesize;
  const synthId = `${synthModel.harness}:${synthModel.model}@${synthModel.effort}`;
  const runner = req.runner ?? new DockerAgentRunner(paths);
  const runId = `run-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const status: ThreadRunStatus = {
    id: runId,
    thread: manifest.slug,
    mode: "ingest",
    pid: process.pid,
    current_step: "gather-synthesize",
    started_at: startedAt,
    cost_usd: null
  };
  await writeRunStatus(paths, status);

  // Each session fans out into its own gather → synthesize pair and returns its
  // own dispatches, so the shared ledger is assembled deterministically after the
  // parallel work rather than mutated concurrently.
  const perSession = await Promise.all(
    sessionIds.map(async (id) => {
      const { source, bare } = parseSessionId(id);
      const gather = await dispatch(runner, paths, runId, `${id}-gather`, {
        role: "gather",
        harness: gatherModel.harness,
        model: gatherModel.model,
        effort: gatherModel.effort,
        persona: THREAD_PERSONAS.gather,
        skills: [`${source}-sessions`],
        prompt: `Read session ${bare}. Charter: ${manifest.charter}`
      });
      const synth = await dispatch(runner, paths, runId, `${id}-synthesize`, {
        role: "synthesize",
        harness: synthModel.harness,
        model: synthModel.model,
        effort: synthModel.effort,
        persona: THREAD_PERSONAS.synthesize,
        skills: ["thread-contract"],
        prompt: `Session: ${bare}\nCharter: ${manifest.charter}\n\nDossier:\n${gather.result.text}`
      });
      await writeSessionFile(thread.dir, source, bare, synth.result.text);
      return {
        dossier: { source, id: bare, text: gather.result.text },
        entry: {
          id: bare,
          source,
          title: parseSessionTitle(synth.result.text),
          extracted_by: synthId
        },
        dispatches: [gather.dispatch, synth.dispatch]
      };
    })
  );

  const dispatches: ThreadDispatchRun[] = perSession.flatMap((item) => item.dispatches);
  await recordSessions(
    thread.dir,
    perSession.map((item) => item.entry)
  );
  await writeFile(
    path.join(thread.dir, "log.md"),
    renderEventLog(await readSessionFiles(thread.dir)),
    "utf8"
  );

  await writeRunStatus(paths, { ...status, current_step: "digest" });
  const digest = await dispatch(runner, paths, runId, "digest", {
    role: "digest",
    harness: synthModel.harness,
    model: synthModel.model,
    effort: synthModel.effort,
    persona: THREAD_PERSONAS.digest,
    skills: ["thread-contract"],
    prompt: `Thread: ${manifest.slug}\nCharter: ${manifest.charter}\n\nSession files:\n${(await readSessionFiles(thread.dir)).join("\n")}`
  });
  dispatches.push(digest.dispatch);
  await writeFile(path.join(thread.dir, "digest.md"), digest.result.text + "\n", "utf8");

  await writeRunDossiers(
    paths,
    runId,
    perSession.map((item) => item.dossier)
  );

  const finishedAt = new Date().toISOString();
  const total = totalCost(dispatches);
  await appendThreadRun(thread.dir, {
    id: runId,
    thread: manifest.slug,
    started_at: startedAt,
    finished_at: finishedAt,
    sessions: sessionIds,
    dispatches,
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
    `chore(thread): ingest ${manifest.slug}`,
    !req.noPush && !thread.destination.no_push
  );

  return { slug: manifest.slug, sessionCount: sessionIds.length, runId, totalCostUsd: total };
}

// Session identity: qualified `source:id` or bare id.
//
// Qualified   — `source` from the prefix, `bare` is the store-native identifier.
// Unqualified — `source` from the `ses_` heuristic, `bare` is the raw id.
interface SessionId {
  source: ThreadHarness;
  bare: string;
}

function parseSessionId(id: string): SessionId {
  const colon = id.indexOf(":");
  if (colon !== -1) {
    const source = id.slice(0, colon);
    if (source === "claude-code" || source === "opencode")
      return { source, bare: id.slice(colon + 1) };
  }
  return { source: id.startsWith("ses_") ? "opencode" : "claude-code", bare: id };
}

// The session file's title lives only in its H1 (`# Session <id> — <title>`),
// which TS lifts into the ledger. Tolerant of em-dash, hyphen, or colon.
function parseSessionTitle(sessionFile: string): string | undefined {
  return /^#\s+Session\s+\S+\s*[—:-]\s*(.+?)\s*$/m.exec(sessionFile)?.[1];
}

function totalCost(dispatches: readonly ThreadDispatchRun[]): number | null {
  const costs = dispatches
    .map((dispatch) => dispatch.cost_usd)
    .filter((cost): cost is number => cost !== null);
  return costs.length > 0 ? costs.reduce((total, cost) => total + cost, 0) : null;
}
