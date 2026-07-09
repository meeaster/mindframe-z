import { readdir } from "node:fs/promises";
import path from "node:path";
import { listClaudeItems } from "../sessions/claude-source.js";
import { listOpencodeItems } from "../sessions/opencode-source.js";
import type { ThreadHarness } from "../core/manifests.js";
import { threadStoreRoot, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { dispatch } from "./dispatch.js";
import { THREAD_PERSONAS } from "./personas.js";
import type { AgentRunner } from "./runner.js";
import { DockerAgentRunner } from "./runner.js";
import { writeRunStatus } from "./observability.js";
import { readThreadManifest, resolveTriageModel } from "./storage.js";
import { classifyWatermark, readWatermark, type Watermark } from "./watermark.js";
import {
  hashCharter,
  isVerdictStanding,
  parseSourceQualifiedId,
  readSweepState,
  readVerdictLedger,
  sourceQualifiedId,
  upsertVerdicts,
  verdictKey,
  writeSweepState,
  writeVerdictLedger,
  type VerdictRow
} from "./verdicts.js";

// A session write can land while sweep is reading stores and dispatching triage. The
// margin treats near-simultaneous source activity as fresh enough to rejudge once.
const SWEEP_FRESHNESS_MARGIN_MS = 5 * 60_000;

export interface SweepSessionSignal {
  id: string;
  source: ThreadHarness;
  bareId: string;
  sourceMs: number;
}

interface SweepThread {
  slug: string;
  charter: string;
  charterHash: string;
  members: Set<string>;
  memberWatermarks: Map<string, Partial<Watermark>>;
}

export interface SweepReport {
  baseline_staked: boolean;
  baseline_at: string;
  last_sweep_at?: string | undefined;
  counts_since_last_sweep: {
    sessions: number;
    proposals: number;
    drifted_members: number;
    deferred: number;
    malformed: number;
  };
  proposals: Array<{ id: string; thread: string; reason: string }>;
  drifted: Array<{ thread: string; id: string }>;
  deferred: Array<{ id: string; reason: string }>;
  malformed: Array<{ id: string; line: string }>;
  triage_dispatches: number;
}

export interface PendingProposal {
  id: string;
  thread: string;
  reason: string;
  stale: boolean;
}

export async function enumerateSweepSessions(paths: RuntimePaths): Promise<SweepSessionSignal[]> {
  const claude = (await listClaudeItems(paths))
    .filter((item) => !item.relPath.includes("/subagents/"))
    .map((item) => {
      const bareId = path.basename(item.relPath, ".jsonl");
      return {
        id: sourceQualifiedId("claude-code", bareId),
        source: "claude-code" as const,
        bareId,
        sourceMs: item.sourceMs
      };
    });
  const opencode = (await listOpencodeItems(paths, { includeChildren: false })).map((item) => {
    const bareId = path.basename(item.relPath, ".json");
    return {
      id: sourceQualifiedId("opencode", bareId),
      source: "opencode" as const,
      bareId,
      sourceMs: item.sourceMs
    };
  });
  return [...claude, ...opencode].sort((a, b) => a.id.localeCompare(b.id));
}

export async function runSweep(args: {
  paths: RuntimePaths;
  profile: ResolvedProfile;
  includeHot?: boolean | undefined;
  triageModel?: string | undefined;
  runner?: AgentRunner | undefined;
}): Promise<SweepReport> {
  const startedAt = new Date();
  const state = await readSweepState(args.paths);
  const baselineStaked = state.baseline_at === undefined;
  const baselineAt = state.baseline_at ?? startedAt.toISOString();
  if (baselineStaked) await writeSweepState(args.paths, { ...state, baseline_at: baselineAt });

  const [threads, signals, initialLedger] = await Promise.all([
    loadThreads(args.paths),
    enumerateSweepSessions(args.paths),
    readVerdictLedger(args.paths)
  ]);
  let ledger = initialLedger;
  const rowsByKey = new Map(ledger.verdicts.map((row) => [verdictKey(row), row]));
  const report: SweepReport = {
    baseline_staked: baselineStaked,
    baseline_at: baselineAt,
    last_sweep_at: state.last_sweep_at,
    counts_since_last_sweep: {
      sessions: state.last_sweep_at
        ? signals.filter((signal) => signal.sourceMs > Date.parse(state.last_sweep_at!)).length
        : signals.length,
      proposals: 0,
      drifted_members: 0,
      deferred: 0,
      malformed: 0
    },
    proposals: [],
    drifted: [],
    deferred: [],
    malformed: [],
    triage_dispatches: 0
  };
  const quietWindowMs = (args.profile.profile.thread.defaults.quiescence_minutes ?? 30) * 60_000;
  const isHot = (signal: SweepSessionSignal): boolean =>
    !args.includeHot && quietWindowMs > 0 && signal.sourceMs > startedAt.getTime() - quietWindowMs;
  const activeSignals = signals.filter((signal) => !isHot(signal));
  report.deferred = signals
    .filter(isHot)
    .map((signal) => ({ id: signal.id, reason: "recent activity" }));

  // A session can belong to several threads and reappear in the candidate loop below,
  // yet a watermark is a full transcript read — memoize it per session for the sweep.
  const watermarkCache = new Map<string, Watermark | undefined>();
  const readCachedWatermark = async (
    signal: SweepSessionSignal
  ): Promise<Watermark | undefined> => {
    if (!watermarkCache.has(signal.id)) {
      watermarkCache.set(
        signal.id,
        await readWatermark(args.paths, { source: signal.source, id: signal.bareId })
      );
    }
    return watermarkCache.get(signal.id);
  };

  for (const signal of activeSignals) {
    for (const thread of threads) {
      const member = thread.memberWatermarks.get(signal.id);
      if (!member) continue;
      // The cheap source signal gates the read: an unpinned member (no last_activity_at)
      // classifies as unchanged anyway, and a pinned member whose source has not moved
      // past its watermark cannot have drifted — skip the transcript read in both cases.
      if (member.last_activity_at === undefined) continue;
      if (signal.sourceMs <= Date.parse(member.last_activity_at) - SWEEP_FRESHNESS_MARGIN_MS)
        continue;
      const current = await readCachedWatermark(signal);
      if (classifyWatermark(member, current) === "changed") {
        report.drifted.push({ thread: thread.slug, id: signal.id });
      }
    }
  }

  const baselineMs = Date.parse(baselineAt);
  const runner =
    args.runner ?? new DockerAgentRunner(args.paths, args.profile.profile.thread.credentials);
  const model = resolveTriageModel(args.profile.profile.thread.defaults, args.triageModel);

  for (const signal of activeSignals) {
    if (signal.sourceMs < baselineMs) continue;
    const candidateThreads = threads.filter((thread) => {
      if (thread.members.has(signal.id)) return false;
      const existing = rowsByKey.get(verdictKey({ id: signal.id, thread: thread.slug }));
      if (!existing) return true;
      if (existing.verdict === "reject") return false;
      return (
        existing.charter_hash !== thread.charterHash ||
        signal.sourceMs > Date.parse(existing.judged_at) - SWEEP_FRESHNESS_MARGIN_MS
      );
    });
    if (candidateThreads.length === 0) continue;
    const watermark = await readCachedWatermark(signal);
    if (watermark === undefined) continue;
    const standingThreads = candidateThreads.filter((thread) => {
      const existing = rowsByKey.get(verdictKey({ id: signal.id, thread: thread.slug }));
      return !existing || !isVerdictStanding(existing, watermark, thread.charterHash);
    });
    if (standingThreads.length === 0) continue;
    const runId = `run-${Date.now()}-${report.triage_dispatches}`;
    await writeRunStatus(args.paths, {
      id: runId,
      mode: "triage",
      pid: process.pid,
      current_step: "triage",
      started_at: startedAt.toISOString(),
      cost_usd: null
    });
    const { result } = await dispatch(runner, args.paths, runId, "triage", {
      role: "triage",
      harness: model.harness,
      model: model.model,
      effort: model.effort,
      persona: THREAD_PERSONAS.triage,
      skills: ["thread-sessions"],
      sessionSources: [signal.source],
      prompt: triagePrompt(signal, standingThreads)
    });
    report.triage_dispatches += 1;
    const sessionRows: VerdictRow[] = [];
    for (const parsed of parseTriageOutput(signal.id, result.text, standingThreads)) {
      if ("line" in parsed) {
        report.malformed.push({ id: signal.id, line: parsed.line });
        continue;
      }
      const thread = standingThreads.find((entry) => entry.slug === parsed.thread);
      if (!thread) continue;
      const row: VerdictRow = {
        id: signal.id,
        source: signal.source,
        bare_id: signal.bareId,
        thread: parsed.thread,
        verdict: parsed.verdict,
        reason: parsed.reason,
        judged_at: new Date().toISOString(),
        watermark,
        charter_hash: thread.charterHash
      };
      sessionRows.push(row);
      if (row.verdict === "fits")
        report.proposals.push({ id: row.id, thread: row.thread, reason: row.reason });
    }
    ledger = upsertVerdicts(ledger, sessionRows);
    for (const row of sessionRows) rowsByKey.set(verdictKey(row), row);
    await writeVerdictLedger(args.paths, ledger);
    await writeRunStatus(args.paths, {
      id: runId,
      mode: "triage",
      pid: process.pid,
      current_step: "complete",
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      cost_usd: result.usage.cost_usd
    });
  }

  await writeSweepState(args.paths, {
    ...state,
    baseline_at: baselineAt,
    last_sweep_at: new Date().toISOString()
  });
  report.counts_since_last_sweep.proposals = report.proposals.length;
  report.counts_since_last_sweep.drifted_members = report.drifted.length;
  report.counts_since_last_sweep.deferred = report.deferred.length;
  report.counts_since_last_sweep.malformed = report.malformed.length;
  return report;
}

export async function listPending(paths: RuntimePaths): Promise<PendingProposal[]> {
  const [threads, signals, ledger] = await Promise.all([
    loadThreads(paths),
    enumerateSweepSessions(paths),
    readVerdictLedger(paths)
  ]);
  const signalMs = new Map(signals.map((signal) => [signal.id, signal.sourceMs]));
  const proposals: PendingProposal[] = [];
  for (const row of ledger.verdicts) {
    if (row.verdict !== "fits") continue;
    const thread = threads.find((entry) => entry.slug === row.thread);
    if (!thread || thread.members.has(row.id)) continue;
    proposals.push({
      id: row.id,
      thread: row.thread,
      reason: row.reason,
      stale:
        row.charter_hash !== thread.charterHash ||
        (signalMs.get(row.id) ?? 0) > Date.parse(row.judged_at)
    });
  }
  return proposals.sort((a, b) => `${a.thread}\t${a.id}`.localeCompare(`${b.thread}\t${b.id}`));
}

export async function rejectPending(
  paths: RuntimePaths,
  id: string,
  thread: string
): Promise<void> {
  const { source, bareId } = parseSourceQualifiedId(id);
  if (!(await loadThreads(paths)).some((entry) => entry.slug === thread)) {
    throw new Error(`Unknown thread: ${thread}`);
  }
  const ledger = await readVerdictLedger(paths);
  const watermark = (await readWatermark(paths, { source, id: bareId })) ?? {
    message_count: 0,
    last_message_id: "unknown",
    last_activity_at: new Date().toISOString()
  };
  await writeVerdictLedger(
    paths,
    upsertVerdicts(ledger, [
      {
        id,
        source,
        bare_id: bareId,
        thread,
        verdict: "reject",
        reason: "human rejected",
        judged_at: new Date().toISOString(),
        watermark,
        charter_hash: "human-reject"
      }
    ])
  );
}

export async function concludePending(paths: RuntimePaths): Promise<number> {
  const [threads, pending, ledger, state] = await Promise.all([
    loadThreads(paths),
    listPending(paths),
    readVerdictLedger(paths),
    readSweepState(paths)
  ]);
  const rows: VerdictRow[] = [];
  for (const proposal of pending) {
    const { source, bareId } = parseSourceQualifiedId(proposal.id);
    const thread = threads.find((entry) => entry.slug === proposal.thread);
    const watermark = await readWatermark(paths, { source, id: bareId });
    if (!thread || !watermark) continue;
    rows.push({
      id: proposal.id,
      source,
      bare_id: bareId,
      thread: proposal.thread,
      verdict: "pass",
      reason: "human passed during review",
      judged_at: new Date().toISOString(),
      watermark,
      charter_hash: thread.charterHash
    });
  }
  await writeVerdictLedger(paths, upsertVerdicts(ledger, rows));
  await writeSweepState(paths, { ...state, last_review_at: new Date().toISOString() });
  return rows.length;
}

async function loadThreads(paths: RuntimePaths): Promise<SweepThread[]> {
  const threads: SweepThread[] = [];
  try {
    for (const entry of await readdir(threadStoreRoot(paths), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "runs") continue;
      try {
        const manifest = await readThreadManifest(path.join(threadStoreRoot(paths), entry.name));
        threads.push({
          slug: manifest.slug,
          charter: manifest.charter,
          charterHash: hashCharter(manifest.charter),
          members: new Set(
            manifest.sessions.map((session) => sourceQualifiedId(session.source, session.id))
          ),
          memberWatermarks: new Map(
            manifest.sessions.map((session) => [
              sourceQualifiedId(session.source, session.id),
              watermarkFromManifestSession(session)
            ])
          )
        });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return threads.sort((a, b) => a.slug.localeCompare(b.slug));
}

function watermarkFromManifestSession(session: {
  message_count?: number | undefined;
  last_message_id?: string | undefined;
  last_activity_at?: string | undefined;
}): Partial<Watermark> {
  return {
    ...(session.message_count !== undefined ? { message_count: session.message_count } : {}),
    ...(session.last_message_id !== undefined ? { last_message_id: session.last_message_id } : {}),
    ...(session.last_activity_at !== undefined
      ? { last_activity_at: session.last_activity_at }
      : {})
  };
}

function triagePrompt(signal: SweepSessionSignal, threads: readonly SweepThread[]): string {
  return `Session: ${signal.id}\n\nJudge this session against these thread charters. Output one verdict line per thread.\n\n${threads
    .map((thread) => `Thread: ${thread.slug}\nCharter: ${thread.charter}`)
    .join("\n\n")}`;
}

function parseTriageOutput(
  id: string,
  text: string,
  threads: readonly SweepThread[]
): Array<{ thread: string; verdict: "fits" | "no_fit"; reason: string } | { line: string }> {
  const slugs = new Set(threads.map((thread) => thread.slug));
  const seen = new Set<string>();
  const parsed: Array<
    { thread: string; verdict: "fits" | "no_fit"; reason: string } | { line: string }
  > = [];
  for (const line of text
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const match = /^(\S+)\s+(fits|no_fit)\s+(.+)$/.exec(line);
    if (!match || !slugs.has(match[1]!)) {
      parsed.push({ line: `${id}: ${line}` });
      continue;
    }
    const thread = match[1]!;
    if (seen.has(thread)) {
      parsed.push({ line: `${id}: duplicate verdict for ${thread}: ${line}` });
      continue;
    }
    seen.add(thread);
    parsed.push({ thread, verdict: match[2]! as "fits" | "no_fit", reason: match[3]! });
  }
  for (const slug of slugs) {
    if (!seen.has(slug)) parsed.push({ line: `${id}: missing verdict for ${slug}` });
  }
  return parsed;
}
