import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import type { Archive, ThreadHarness } from "../core/manifests.js";
import { IRRELEVANT_DELTA_SENTINEL, THREAD_PERSONAS } from "./personas.js";
import {
  CONTAINER_ARCHIVE_CACHE,
  CONTAINER_SESSION_STORE,
  DockerAgentRunner,
  type AgentRunner
} from "./runner.js";
import { dispatch } from "./dispatch.js";
import { readPreviousDigest, regenerateViews, repoLocators } from "./regenerate.js";
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
import {
  classifyWatermark,
  locateClaudeTranscript,
  readWatermark,
  type Watermark,
  type WatermarkStatus
} from "./watermark.js";
import { cachedSessionPath, primaryRelPath } from "../sessions/archive.js";
import { hydrateSession } from "../sessions/hydrate.js";
import { pathExists } from "../core/fs-util.js";
import { dedupe } from "../core/paths.js";
import path from "node:path";
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

  const detected = await resolveRefreshSet(
    paths,
    manifest,
    sessionIds,
    profile.manifests.machine.archives
  );
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
      const revisable =
        strategy === "delta" && changedSet.has(key) && prior?.last_message_id !== undefined
          ? await readSessionFile(thread.dir, source, bare)
          : undefined;
      // A pre-Phases prior file also falls back to full: a delta gather only sees past
      // the cursor, so revising it could only backfill a silently partial `## Phases`
      // section. One full re-synthesis rewrites the file with complete phases; every
      // later refresh delta-revises as normal.
      const priorFile = revisable?.includes("## Phases") === true ? revisable : undefined;
      const cursor = priorFile !== undefined ? prior?.last_message_id : undefined;
      // Resolve the session's exact mounted path host-side and hand it to gather so it
      // reads a known file instead of rediscovering it — the discovery step is where a
      // weak gather model wandered into its own ~/.claude and declared the session
      // missing. A defined path also proves the session is host-readable (the guard
      // below). Present OpenCode sessions keep today's sqlite-discovery path (no
      // explicit path); only a hydrated cache copy gets one, for either harness.
      const transcriptPath = await resolveTranscriptPath(paths, source, bare);

      const gather = await dispatch(runner, paths, runId, `${id}-gather`, {
        role: "gather",
        harness: gatherModel.harness,
        model: gatherModel.model,
        effort: gatherModel.effort,
        persona: THREAD_PERSONAS.gather,
        skills: ["thread-sessions"],
        sessionSources: [source],
        prompt: gatherPrompt(bare, manifest.charter, cursor, transcriptPath)
      });
      // Capture the store's current tail once, host-side. It serves three readers below:
      // it confirms the session is present (refusal guard), lets an irrelevant-delta
      // short-circuit advance the ledger, and becomes this entry's watermark so a later
      // ingest can tell whether it has grown. Read before synthesize — which never
      // touches the store — so the guards see it; a store we can't read leaves it absent.
      const watermark = await readWatermark(paths, { source, id: bare });
      // Irrelevant-delta short-circuit (classifyGather threw on any fabricated dossier):
      // skip synthesize and the file write, advance the watermark to the current tail so
      // the same noise never re-triggers, and preserve the prior title/extracted_by
      // (recordSessions keeps the fields this entry omits). The gather spend was real,
      // so its dispatch and dossier are still recorded.
      if (
        classifyGather(gather.result.text, { cursor, watermark, transcriptPath, id, runId }) ===
        "short-circuit"
      ) {
        return {
          dossier: { source, id: bare, text: gather.result.text },
          entry: { id: bare, source, ...watermark },
          dispatches: [gather.dispatch],
          wrote: false
        };
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
      return {
        dossier: { source, id: bare, text: gather.result.text },
        entry: {
          id: bare,
          source,
          title: parseSessionTitle(synth.result.text),
          extracted_by: synthId,
          ...watermark
        },
        dispatches: [gather.dispatch, synth.dispatch],
        wrote: true
      };
    })
  );

  const dispatches: ThreadDispatchRun[] = perSession.flatMap((item) => item.dispatches);
  await recordSessions(
    thread.dir,
    perSession.map((item) => item.entry)
  );

  // The digest reads only the session files, so if every session short-circuited on the
  // sentinel — nothing actually drifted onto disk — regenerating it would be pure spend.
  // Run it exactly once when at least one file was written this run, as today.
  if (perSession.some((item) => item.wrote)) {
    await writeRunStatus(paths, { ...status, current_step: "digest" });
    const digestDispatch = await regenerateViews({
      runner,
      paths,
      runId,
      threadDir: thread.dir,
      slug: manifest.slug,
      charter: manifest.charter,
      digestModel: settings.digest,
      // `--all` is a clean rebuild — withhold the prior digest so accumulated form drift
      // flushes; every other run anchors to it to keep an unchanged thread's digest stable.
      previousDigest: req.all ? undefined : await readPreviousDigest(thread.dir),
      repos: repoLocators(profile)
    });
    dispatches.push(digestDispatch);
  }

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

// Classify one session, attempting hydration when it's genuinely absent (`vanished`,
// not merely `shrank`) before writing it off — the archive is consulted only for this
// case, never for `shrank` (present, just below its stored cursor). A successful
// hydration is re-classified against the now-cached copy: it may turn out `changed`
// (recoverable, folded into the refresh) or `unchanged` (recovered, nothing new) — or
// still fail the count check (`shrank`), the "stale-recover" edge where the last
// archived backup predates the ledger cursor, which is accepted as-is and warned once.
async function classifySession(
  paths: RuntimePaths,
  session: ThreadManifest["sessions"][number],
  archives: readonly Archive[],
  hydrate: typeof hydrateSession
): Promise<WatermarkStatus> {
  const current = await readWatermark(paths, { source: session.source, id: session.id });
  const status = classifyWatermark(session, current);
  if (status !== "vanished" || archives.length === 0) return status;

  const hydrated = await hydrate(paths, archives, session.source, session.id);
  if (!hydrated) return status;

  const rehydrated = await readWatermark(paths, { source: session.source, id: session.id });
  const rehydratedStatus = classifyWatermark(session, rehydrated);
  if (rehydratedStatus === "shrank") {
    console.warn(
      `session ${session.source}:${session.id} hydrated from archive, but its tail predates the ledger cursor (stale-recover) — left untouched`
    );
  }
  return rehydratedStatus;
}

// Free, dispatch-free staleness detection: recompute each existing session's watermark
// host-side and partition, then merge the drifted set with the explicitly-named ids (both
// normalized to canonical `source:id`), de-duplicated. `vanished` sessions are reported
// but never refreshed. Promise.all preserves manifest order, so the sets are deterministic.
export async function resolveRefreshSet(
  paths: RuntimePaths,
  manifest: ThreadManifest,
  sessionIds: string[],
  archives: readonly Archive[] = [],
  hydrate: typeof hydrateSession = hydrateSession
): Promise<RefreshSet> {
  const statuses = await Promise.all(
    manifest.sessions.map(async (session) => ({
      key: `${session.source}:${session.id}`,
      status: await classifySession(paths, session, archives, hydrate)
    }))
  );
  const refreshed = statuses.filter((s) => s.status === "changed").map((s) => s.key);
  const vanished = statuses
    .filter((s) => s.status === "vanished" || s.status === "shrank")
    .map((s) => s.key);
  const named = sessionIds.map((id) => {
    const { source, bare } = parseSessionId(id);
    return `${source}:${bare}`;
  });
  return { workSet: dedupe([...named, ...refreshed]), refreshed, vanished };
}

// The explicit-path seam, generalized across harnesses: a live Claude transcript is
// preferred; otherwise, a hydrated archive-cache copy is used for either harness
// (present OpenCode sessions have no live-store equivalent path — they keep today's
// sqlite-discovery route, per the thread-sessions OpenCode branch).
async function resolveTranscriptPath(
  paths: RuntimePaths,
  source: ThreadHarness,
  id: string
): Promise<string | undefined> {
  if (source === "claude-code") {
    const local = await locateClaudeTranscript(paths, id);
    if (local !== undefined) return path.posix.join(CONTAINER_SESSION_STORE, local);
  }
  if (await pathExists(cachedSessionPath(paths, source, id))) {
    return path.posix.join(CONTAINER_ARCHIVE_CACHE, source, primaryRelPath(source, id));
  }
  return undefined;
}

// Gather prompt. With a cursor (delta), read only messages after it; otherwise the whole
// session. The cursor message is already summarized, so it is excluded.
function gatherPrompt(
  bare: string,
  charter: string,
  cursor: string | undefined,
  transcriptPath: string | undefined
): string {
  // Name the exact transcript file when we resolved it, so gather reads it directly
  // instead of searching the store (where a weak model can pick the wrong root).
  const at = transcriptPath !== undefined ? ` Its transcript is the file ${transcriptPath}.` : "";
  return cursor !== undefined
    ? `Read session ${bare}, but only the messages after message id ${cursor} — everything up to and including that message is already summarized.${at} If nothing in that range is charter-relevant, output exactly ${IRRELEVANT_DELTA_SENTINEL} and nothing else. Charter: ${charter}`
    : `Read session ${bare}.${at} Charter: ${charter}`;
}

// The one gate between gather and synthesize: classify the dossier as an irrelevant-delta
// short-circuit or a real dossier to proceed with, throwing on the three fabrications a
// weak gather produces — an exact sentinel outside delta, an empty dossier, and a
// missing-session refusal the host contradicts. Pure, so each branch is testable and the
// per-session closure stays a straight gather → classify → branch pipeline.
function classifyGather(
  dossier: string,
  ctx: {
    cursor: string | undefined;
    watermark: Watermark | undefined;
    transcriptPath: string | undefined;
    id: string;
    runId: string;
  }
): "short-circuit" | "proceed" {
  const { cursor, watermark, transcriptPath, id, runId } = ctx;
  // The sentinel is recognized only on a whole-output exact match — a dossier that merely
  // mentions the token still synthesizes — and checked before the empty-dossier guard.
  if (dossier.trim() === IRRELEVANT_DELTA_SENTINEL) {
    if (cursor !== undefined) return "short-circuit";
    // On a full gather the persona forbids the sentinel — the whole session cannot be
    // "nothing new". Synthesizing it would write a garbage file and watermark it — the
    // same freeze the refusal guard prevents — so abort as a contract violation.
    throw new Error(
      `Gather returned the ${IRRELEVANT_DELTA_SENTINEL} sentinel for ${id} on a full (non-delta) gather (see run ${runId} trace) — a contract violation, not a real dossier. Aborting before synthesis.`
    );
  }
  // An empty dossier means gather never read the session (e.g. a denied read
  // it failed to recover from). Synthesis would then have only the charter to
  // work from and would launder it into invented session facts, so fail loudly
  // here instead of writing a confident-but-fabricated session file.
  if (dossier.trim() === "") {
    throw new Error(
      `Gather produced an empty dossier for ${id} — the session was not read (see run ${runId} trace). Aborting before synthesis to avoid fabricating from the charter.`
    );
  }
  // The host confirms this session exists — a transcript path was resolved, or its
  // watermark is readable from the store (covers a present OpenCode session via the
  // sqlite route) — yet gather reported it missing: the agent read the wrong store
  // rather than the file we named. Abort before synthesis so a fabricated "session
  // does not exist" refusal is never written, watermarked, or pushed (it would then
  // read as "unchanged" and never self-heal on a plain refresh).
  if ((transcriptPath !== undefined || watermark !== undefined) && dossierReportsMissing(dossier)) {
    throw new Error(
      `Gather reported ${id} missing though the host confirms it exists${
        transcriptPath !== undefined ? ` (transcript at ${transcriptPath})` : ""
      } (see run ${runId} trace) — it read the wrong store. Aborting before synthesis.`
    );
  }
  return "proceed";
}

// A refusal is a short apology, never a substantive extraction: both fabricated refusals
// observed live were ~1.0–1.1 KB, while genuine dossiers run several KB. 2000 chars sits
// ~2× above the largest observed refusal and ~½ below the smallest observed valid
// dossier, so both misreads have margin.
const REFUSAL_MAX_CHARS = 2000;

// Markers of a gather that failed to read the session and reported it absent rather
// than summarizing it. Paired with a host-confirmed transcript, these mean the agent
// read the wrong store — a fabricated refusal, not a real dossier. Recognition is
// shape-based, not marker-only: a genuine dossier may legitimately *quote* a marker
// phrase (observed live: a 4.2 KB charter-relevant dossier quoting a commit message
// containing "does not exist" was discarded by the marker-only check), so the markers
// count only in refusal-sized output.
function dossierReportsMissing(dossier: string): boolean {
  return (
    dossier.trim().length < REFUSAL_MAX_CHARS &&
    /does not exist|could not be (located|retrieved|found)|unable to locate|no source material|no transcript for|not found in the (local )?store/i.test(
      dossier
    )
  );
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
    ? `Session: ${bare}\n\nRevise the existing session summary below by folding in the new activity from the delta dossier. Keep everything still accurate; do not regenerate from scratch or drop prior detail. The charter is a topic hint, not a source of facts; never lift specifics from it. For the \`## Phases\` section, fold the delta's phases in: when the delta's first phase continues the same work as the file's last phase, extend that last phase's end timestamp and range instead of adding a line; otherwise append the delta's phases as new lines. Never rewrite or remove a phase already in the file.\n\nCharter (topic hint, not a source): ${charter}\n\nExisting session summary (revise this):\n${priorFile}\n\nDelta dossier (new activity since the last summary — your only new source):\n${dossier}`
    : `Session: ${bare}\n\nThe charter is the thread's topic hint — what to look for. It is NOT a source of facts; never lift specifics from it. The dossier below is your only source material.\n\nCharter (topic hint, not a source): ${charter}\n\nDossier (your only source):\n${dossier}`;
}

// Session identity: qualified `source:id` or bare id.
//
// `source` from the required prefix, `bare` is the store-native identifier.
interface SessionId {
  source: ThreadHarness;
  bare: string;
}

// Session ids must be source-qualified as `claude-code:<id>` or `opencode:<id>` —
// the form `discover` emits and the manifest keys on. Requiring it keeps a mistyped
// or ambiguous id a loud error instead of a silent guess at the wrong store.
function parseSessionId(id: string): SessionId {
  const colon = id.indexOf(":");
  const source = colon === -1 ? "" : id.slice(0, colon);
  const bare = colon === -1 ? "" : id.slice(colon + 1);
  if ((source === "claude-code" || source === "opencode") && bare !== "") return { source, bare };
  throw new Error(
    `Session id "${id}" must be source-qualified — pass claude-code:<id> or opencode:<id>.`
  );
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
