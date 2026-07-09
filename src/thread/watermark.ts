import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { openSqlite, type SqliteDatabase } from "../core/sqlite-compat.js";
import type { RuntimePaths } from "../core/paths.js";
import { opencodeDbPath, pathExists } from "../core/paths.js";
import type { ThreadHarness } from "../core/manifests.js";
import { cachedSessionPath } from "../sessions/archive.js";

// A tail signature of a host session store as of a point in time. TS computes it
// deterministically, host-side, without dispatching an agent — cheap enough to
// evaluate for every thread session before deciding what to refresh.
export interface Watermark {
  message_count: number;
  last_message_id: string;
  last_activity_at: string;
}

// The comparison outcome between a stored watermark and the current store state.
// `vanished` is absent from both the live store and the archive-cache — hydration
// should be attempted for it. `shrank` is present (live or cached) but below its
// stored count — an unmatchable cursor, so it is left untouched exactly like
// `vanished` (a session hydrated from a stale backup — the "stale-recover" case —
// also lands here once its cached tail is compared). Neither is ever refreshed.
export type WatermarkStatus = "changed" | "unchanged" | "vanished" | "shrank";

// Read the current tail signature for a session, or undefined when the session is
// absent from its host store. Reads the same bytes the sandboxed gather agent sees,
// so detection never drifts from what a refresh would gather.
export async function readWatermark(
  paths: RuntimePaths,
  session: { source: ThreadHarness; id: string }
): Promise<Watermark | undefined> {
  return session.source === "claude-code"
    ? readClaudeWatermark(paths, session.id)
    : readOpencodeWatermark(paths, session.id);
}

// Claude transcripts live at ~/.claude/projects/<encoded-project>/<id>.jsonl. The
// project directory is not derivable from the id (lossy encoding), so scan projects/
// for the file and return its store-relative subpath, or undefined when absent.
// Ingest reuses this to hand gather the exact path instead of making it rediscover
// the file — a weak model that has to search sometimes reads the wrong store.
export async function locateClaudeTranscript(
  paths: RuntimePaths,
  id: string
): Promise<string | undefined> {
  const projectsDir = path.join(paths.claudeDir, "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (await pathExists(path.join(projectsDir, entry, `${id}.jsonl`)))
      return path.posix.join("projects", entry, `${id}.jsonl`);
  }
  return undefined;
}

async function readClaudeWatermark(
  paths: RuntimePaths,
  id: string
): Promise<Watermark | undefined> {
  const sub = await locateClaudeTranscript(paths, id);
  if (sub !== undefined) {
    return tailSignatureFromJsonl(await readFile(path.join(paths.claudeDir, sub), "utf8"));
  }
  // Absent from the live store — fall back to a hydrated archive-cache copy, if one
  // exists. The only behavioral change hydration makes to readWatermark.
  const cached = cachedSessionPath(paths, "claude-code", id);
  if (await pathExists(cached)) {
    return tailSignatureFromJsonl(await readFile(cached, "utf8"));
  }
  return undefined;
}

// A transcript line is a message turn when its `type` is user or assistant; other
// lines (queue ops, titles, attachments) are not counted. The turn's `uuid` is the
// message id and `timestamp` its activity time — mirrors the thread-sessions Claude branch.
function tailSignatureFromJsonl(content: string): Watermark | undefined {
  let count = 0;
  let last: { uuid?: string; timestamp?: string } | undefined;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let record: { type?: string; uuid?: string; timestamp?: string };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    count += 1;
    last = record;
  }
  if (count === 0 || last?.uuid === undefined || last.timestamp === undefined) return undefined;
  return { message_count: count, last_message_id: last.uuid, last_activity_at: last.timestamp };
}

// An archived `opencode export` artifact — `{ info, messages }` JSON, produced by
// the vendor CLI rather than read from opencode.db — mirrors tailSignatureFromJsonl
// for the OpenCode archived form. Each message's `info.id`/`info.time.created` are
// the same fields the db-backed reader uses (message.id / message.time_created).
export function tailSignatureFromExport(content: string): Watermark | undefined {
  let parsed: { messages?: Array<{ info?: { id?: string; time?: { created?: number } } }> };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return undefined;
  }
  const messages = parsed.messages ?? [];
  if (messages.length === 0) return undefined;
  const last = messages[messages.length - 1]?.info;
  if (last?.id === undefined || last.time?.created === undefined) return undefined;
  return {
    message_count: messages.length,
    last_message_id: last.id,
    last_activity_at: new Date(last.time.created).toISOString()
  };
}

// OpenCode stores messages in a SQLite `message` table keyed by `session_id`, with
// `time_created` in epoch milliseconds. Read-only so a running opencode is untouched.
async function readOpencodeWatermark(
  paths: RuntimePaths,
  id: string
): Promise<Watermark | undefined> {
  const fromDb = await readOpencodeWatermarkFromDb(paths, id);
  if (fromDb !== undefined) return fromDb;
  // Absent from the live db (or no db at all) — fall back to a hydrated archive-cache
  // copy (an `opencode export` artifact), if one exists.
  const cached = cachedSessionPath(paths, "opencode", id);
  if (await pathExists(cached)) {
    return tailSignatureFromExport(await readFile(cached, "utf8"));
  }
  return undefined;
}

async function readOpencodeWatermarkFromDb(
  paths: RuntimePaths,
  id: string
): Promise<Watermark | undefined> {
  const dbPath = opencodeDbPath(paths);
  if (!(await pathExists(dbPath))) return undefined;
  let db: SqliteDatabase;
  try {
    db = openSqlite(dbPath, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count,
           (SELECT id FROM message WHERE session_id = $id ORDER BY time_created DESC, id DESC LIMIT 1) AS last_id,
           (SELECT MAX(time_created) FROM message WHERE session_id = $id) AS last_ms
         FROM message WHERE session_id = $id`
      )
      .get({ id }) as { count: number; last_id: string | null; last_ms: number | null };
    if (row.count === 0 || row.last_id === null || row.last_ms === null) return undefined;
    return {
      message_count: row.count,
      last_message_id: row.last_id,
      last_activity_at: new Date(row.last_ms).toISOString()
    };
  } catch {
    // The opencode message table's shape changes between versions (the thread-sessions
    // OpenCode branch warns to verify columns live). A schema mismatch means we can't read a
    // watermark this run, not that ingest should crash — treat it as absent.
    return undefined;
  } finally {
    db.close();
  }
}

// Classify a session against its stored watermark. A missing baseline (an entry
// written before watermarks existed) is treated as unchanged so a first ingest does
// not blanket-refresh untracked sessions; such a session is watermarked the next
// time it is explicitly ingested. A strict count/last-id difference is `changed`; a
// session absent from both the live store and the archive-cache is `vanished`
// (hydration should be attempted); one that's present (live or cached) but shrank
// below its stored count is `shrank` (an unmatchable cursor — never hydrated, since
// it isn't absent).
export function classifyWatermark(
  stored: { message_count?: number | undefined; last_message_id?: string | undefined },
  current: Watermark | undefined
): WatermarkStatus {
  if (stored.message_count === undefined || stored.last_message_id === undefined) {
    return "unchanged";
  }
  if (current === undefined) return "vanished";
  if (current.message_count < stored.message_count) return "shrank";
  if (
    current.message_count !== stored.message_count ||
    current.last_message_id !== stored.last_message_id
  ) {
    return "changed";
  }
  return "unchanged";
}
