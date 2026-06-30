import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// After a Claude Code dispatch, its on-disk transcript is the only faithful
// source of per-inference LLM/tool/agent spans: the stream-json the runner
// captures carries token usage but no timestamps, and lapdog's
// /claude/hooks/backfill_session skips any entry without a parseable timestamp.
// The transcript, by contrast, has real timestamps, message.usage, tool_use /
// tool_result pairs, and subagent files — exactly the shape that endpoint was
// built to convert. So we mount a writable host dir at the container's
// ~/.claude/projects, let Claude write its transcript there, then replay it
// through backfill once the dispatch ends. This keeps capture beside the model
// path (no proxy, Bedrock-agnostic) while still yielding the full span tree.

interface SubagentPayload {
  agent_id: string;
  entries: unknown[];
}

interface BackfillBody {
  session_id: string;
  cwd: string;
  entries: unknown[];
  subagents: SubagentPayload[];
}

async function readJsonl(file: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return entries;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Partial flush at teardown can leave a truncated final line; skip it.
    }
  }
  return entries;
}

function resolveCwd(entries: unknown[]): string {
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null) {
      const cwd = (entry as Record<string, unknown>).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    }
  }
  return "";
}

// Claude stores a session's subagent transcripts under
// <session-dir>/<session-id>/subagents/agent-*.jsonl. Bundling them into the
// parent's payload lets backfill nest them under the launching Task span
// instead of treating each as a standalone session.
async function readSubagents(sessionDir: string, sessionId: string): Promise<SubagentPayload[]> {
  const subDir = path.join(sessionDir, sessionId, "subagents");
  let names: string[];
  try {
    names = await readdir(subDir);
  } catch {
    return [];
  }
  const subagents: SubagentPayload[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const entries = await readJsonl(path.join(subDir, name));
    if (entries.length > 0) {
      subagents.push({ agent_id: path.basename(name, ".jsonl"), entries });
    }
  }
  return subagents;
}

// Locate the dispatch's transcript inside the mounted projects dir. Claude
// writes it to projects/<encoded-cwd>/<session-id>.jsonl; the encoded-cwd
// segment is opaque to us, so find the file by session id across all of them.
async function findTranscript(
  projectsDir: string,
  sessionId: string
): Promise<{ file: string; sessionDir: string } | undefined> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return undefined;
  }
  const target = `${sessionId}.jsonl`;
  for (const dir of projectDirs) {
    const sessionDir = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(sessionDir);
    } catch {
      continue;
    }
    if (files.includes(target)) {
      return { file: path.join(sessionDir, target), sessionDir };
    }
  }
  return undefined;
}

export async function buildBackfillBody(
  projectsDir: string,
  sessionId: string
): Promise<BackfillBody | undefined> {
  const located = await findTranscript(projectsDir, sessionId);
  if (!located) return undefined;
  const entries = await readJsonl(located.file);
  if (entries.length === 0) return undefined;
  return {
    session_id: sessionId,
    cwd: resolveCwd(entries),
    entries,
    subagents: await readSubagents(located.sessionDir, sessionId)
  };
}

export const buildBackfillBodyForTest = buildBackfillBody;

// Replay a finished dispatch's transcript through lapdog's backfill endpoint so
// its LLM/tool/agent spans appear under the dispatch's real session id. The
// endpoint is idempotent per session (it skips an already-backfilled id), so a
// retried dispatch won't duplicate spans. Fail-open: capture must never affect
// a dispatch.
export async function backfillClaudeTranscript(
  lapdogUrl: string,
  projectsDir: string,
  sessionId: string
): Promise<void> {
  try {
    const body = await buildBackfillBody(projectsDir, sessionId);
    if (!body) return;
    await fetch(`${lapdogUrl}/claude/hooks/backfill_session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    // fail-open: a missing/slow lapdog or unreadable transcript must not break ingest.
  }
}
