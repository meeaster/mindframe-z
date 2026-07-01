import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { ThreadHarness } from "../core/manifests.js";
import { THREAD_PERSONAS } from "./personas.js";
import { DockerAgentRunner, type AgentRunner } from "./runner.js";
import { dispatch } from "./dispatch.js";
import { regenerateViews } from "./regenerate.js";
import {
  appendThreadRun,
  commitThreadChanges,
  findThread,
  readSessionFile,
  readThreadManifest,
  recordSessions,
  resolveSynthesisDefaults,
  writeSessionFile,
  type ThreadDispatchRun
} from "./storage.js";
import { writeRunDossiers, writeRunStatus, type ThreadRunStatus } from "./observability.js";
import { classifyWatermark, readWatermark } from "./watermark.js";
import { dedupe } from "../core/paths.js";
import type { ThreadManifest } from "./schema.js";

export interface IngestRequest {
  paths: RuntimePaths;
  profile: ResolvedProfile;
  threadSlug: string;
  sessionIds: string[];
  // Entered as a refresh (no named sessions): an empty work set is a successful no-op
  // ("nothing drifted") rather than an error.
  refresh?: boolean | undefined;
  // Force a full re-gather + re-synthesis of every present session, ignoring watermarks —
  // `refresh --all`, for rebuilding after a charter or model change.
  all?: boolean | undefined;
  noPush: boolean;
  gather?: string | undefined;
  synthesize?: string | undefined;
  runner?: AgentRunner | undefined;
}

export interface IngestResult {
  slug: string;
  sessionCount: number;
  // Existing sessions that drifted since the last ingest and were folded into this run.
  refreshed: string[];
  // Existing sessions gone from the store or shrank below their watermark; left untouched.
  vanished: string[];
  runId: string;
  totalCostUsd: number | null;
}

export async function ingestThread(req: IngestRequest): Promise<IngestResult> {
  const { paths, profile, sessionIds } = req;

  const thread = await findThread(paths, profile, req.threadSlug);
  const manifest = await readThreadManifest(thread.dir);

  const detected = await resolveRefreshSet(paths, manifest, sessionIds);
  const { refreshed, vanished } = detected;
  // `--all` forces every present session (skipping only those vanished from the store);
  // otherwise the work set is the named ids plus the sessions that drifted.
  const workSet = req.all
    ? manifest.sessions
        .map((session) => `${session.source}:${session.id}`)
        .filter((key) => !vanished.includes(key))
    : detected.workSet;
  const changedSet = new Set(refreshed);
  if (workSet.length === 0) {
    // A refresh (or --all) with nothing to do is a successful no-op; a plain ingest that
    // named no session is a misuse.
    if (req.refresh || req.all)
      return {
        slug: manifest.slug,
        sessionCount: 0,
        refreshed,
        vanished,
        runId: "",
        totalCostUsd: null
      };
    throw new Error("Provide at least one session id to ingest.");
  }

  const settings = resolveSynthesisDefaults(profile.profile.thread.defaults, manifest, {
    gather: req.gather,
    synthesize: req.synthesize
  });
  const gatherModel = settings.gather;
  const synthModel = settings.synthesize;
  const synthId = `${synthModel.harness}:${synthModel.model}@${synthModel.effort}`;
  // `--all` rebuilds from scratch, so it is always a full re-synthesis. Otherwise `full`
  // (default) re-reads and re-synthesizes the whole session, while `delta` reads only
  // messages past the stored cursor and revises the prior file. Resolved once here (the
  // field is optional so inheritance works; "full" is the default), applied per session
  // below — delta only engages for a changed existing session that has both a stored
  // `last_message_id` and a prior file to revise, else it falls back to full.
  const strategy = req.all ? "full" : (profile.profile.thread.update_strategy ?? "full");
  const priorBySession = new Map(manifest.sessions.map((s) => [`${s.source}:${s.id}`, s]));
  const runner = req.runner ?? new DockerAgentRunner(paths, profile.profile.thread.credentials);
  const mode = req.all ? "refresh --all" : req.refresh ? "refresh" : "ingest";
  const runId = `run-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const status: ThreadRunStatus = {
    id: runId,
    thread: manifest.slug,
    mode,
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
    workSet.map(async (id) => {
      const { source, bare } = parseSessionId(id);
      const key = `${source}:${bare}`;
      const prior = priorBySession.get(key);
      // Delta engages only for a session that genuinely grew (is in the changed set),
      // has a stored cursor, and has a prior file to revise. A named-but-unchanged
      // session has no messages past the cursor, so a delta gather would return an empty
      // dossier and trip the abort guard below — those fall back to a full re-synthesis.
      const priorFile =
        strategy === "delta" && changedSet.has(key) && prior?.last_message_id !== undefined
          ? await readSessionFile(thread.dir, source, bare)
          : undefined;
      const cursor = priorFile !== undefined ? prior?.last_message_id : undefined;

      const gather = await dispatch(runner, paths, runId, `${id}-gather`, {
        role: "gather",
        harness: gatherModel.harness,
        model: gatherModel.model,
        effort: gatherModel.effort,
        persona: THREAD_PERSONAS.gather,
        skills: [`${source}-sessions`],
        prompt: gatherPrompt(bare, manifest.charter, cursor)
      });
      // An empty dossier means gather never read the session (e.g. a denied read
      // it failed to recover from). Synthesis would then have only the charter to
      // work from and would launder it into invented session facts, so fail loudly
      // here instead of writing a confident-but-fabricated session file.
      if (gather.result.text.trim() === "") {
        throw new Error(
          `Gather produced an empty dossier for ${id} — the session was not read (see run ${runId} trace). Aborting before synthesis to avoid fabricating from the charter.`
        );
      }
      const synth = await dispatch(runner, paths, runId, `${id}-synthesize`, {
        role: "synthesize",
        harness: synthModel.harness,
        model: synthModel.model,
        effort: synthModel.effort,
        persona: THREAD_PERSONAS.synthesize,
        skills: ["thread-contract"],
        prompt: synthesizePrompt(bare, manifest.charter, gather.result.text, priorFile)
      });
      await writeSessionFile(thread.dir, source, bare, synth.result.text);
      // Capture the store's tail signature now that this session is synthesized, so a
      // later ingest can tell whether it has grown. A store we can't read leaves the
      // watermark absent rather than failing the synthesis we already paid for.
      const watermark = await readWatermark(paths, { source, id: bare });
      return {
        dossier: { source, id: bare, text: gather.result.text },
        entry: {
          id: bare,
          source,
          title: parseSessionTitle(synth.result.text),
          extracted_by: synthId,
          ...watermark
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

  await writeRunStatus(paths, { ...status, current_step: "digest" });
  const digestDispatch = await regenerateViews({
    runner,
    paths,
    runId,
    threadDir: thread.dir,
    slug: manifest.slug,
    charter: manifest.charter,
    digestModel: settings.digest
  });
  dispatches.push(digestDispatch);

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
    sessions: workSet,
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
    `chore(thread): ${mode} ${manifest.slug}`,
    !req.noPush && !thread.destination.no_push
  );

  return {
    slug: manifest.slug,
    sessionCount: workSet.length,
    refreshed,
    vanished,
    runId,
    totalCostUsd: total
  };
}

export interface RefreshSet {
  // Canonical `source:id` keys to (re)synthesize this run: named ids + drifted sessions.
  workSet: string[];
  // Existing sessions that drifted since their watermark and were folded into the run.
  refreshed: string[];
  // Existing sessions gone from the store or shrank below their watermark; left untouched.
  vanished: string[];
}

// Free, dispatch-free staleness detection: recompute each existing session's watermark
// host-side and partition, then merge the drifted set with the explicitly-named ids (both
// normalized to canonical `source:id`), de-duplicated. `vanished` sessions are reported
// but never refreshed. Promise.all preserves manifest order, so the sets are deterministic.
export async function resolveRefreshSet(
  paths: RuntimePaths,
  manifest: ThreadManifest,
  sessionIds: string[]
): Promise<RefreshSet> {
  const statuses = await Promise.all(
    manifest.sessions.map(async (session) => ({
      key: `${session.source}:${session.id}`,
      status: classifyWatermark(
        session,
        await readWatermark(paths, { source: session.source, id: session.id })
      )
    }))
  );
  const refreshed = statuses.filter((s) => s.status === "changed").map((s) => s.key);
  const vanished = statuses.filter((s) => s.status === "vanished").map((s) => s.key);
  const named = sessionIds.map((id) => {
    const { source, bare } = parseSessionId(id);
    return `${source}:${bare}`;
  });
  return { workSet: dedupe([...named, ...refreshed]), refreshed, vanished };
}

// Gather prompt. With a cursor (delta), read only messages after it; otherwise the whole
// session. The cursor message is already summarized, so it is excluded.
function gatherPrompt(bare: string, charter: string, cursor: string | undefined): string {
  return cursor !== undefined
    ? `Read session ${bare}, but only the messages after message id ${cursor} — everything up to and including that message is already summarized. Charter: ${charter}`
    : `Read session ${bare}. Charter: ${charter}`;
}

// Synthesize prompt. With a prior file (delta), revise it in place by folding in the delta
// dossier; otherwise synthesize the whole session from the dossier. The charter is a topic
// hint in both, never a source of facts.
function synthesizePrompt(
  bare: string,
  charter: string,
  dossier: string,
  priorFile: string | undefined
): string {
  return priorFile !== undefined
    ? `Session: ${bare}\n\nRevise the existing session summary below by folding in the new activity from the delta dossier. Keep everything still accurate; do not regenerate from scratch or drop prior detail. The charter is a topic hint, not a source of facts; never lift specifics from it.\n\nCharter (topic hint, not a source): ${charter}\n\nExisting session summary (revise this):\n${priorFile}\n\nDelta dossier (new activity since the last summary — your only new source):\n${dossier}`
    : `Session: ${bare}\n\nThe charter is the thread's topic hint — what to look for. It is NOT a source of facts; never lift specifics from it. The dossier below is your only source material.\n\nCharter (topic hint, not a source): ${charter}\n\nDossier (your only source):\n${dossier}`;
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
