import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { RuntimePaths } from "../core/paths.js";
import { pathExists } from "../core/paths.js";
import type { ThreadHarness } from "../core/manifests.js";

// A tail signature of a host session store as of a point in time. TS computes it
// deterministically, host-side, without dispatching an agent — cheap enough to
// evaluate for every thread session before deciding what to refresh.
export interface Watermark {
  message_count: number;
  last_message_id: string;
  last_activity_at: string;
}

// The comparison outcome between a stored watermark and the current store state.
// `vanished` covers both a session that left the store and one that shrank below
// its stored count (an unmatchable cursor) — both are left untouched, not refreshed.
export type WatermarkStatus = "changed" | "unchanged" | "vanished";

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
// project directory is not derivable from the id, so scan projects/ for the file.
async function readClaudeWatermark(
  paths: RuntimePaths,
  id: string
): Promise<Watermark | undefined> {
  const projectsDir = path.join(paths.claudeDir, "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const file = path.join(projectsDir, entry, `${id}.jsonl`);
    if (await pathExists(file)) return tailSignatureFromJsonl(await readFile(file, "utf8"));
  }
  return undefined;
}

// A transcript line is a message turn when its `type` is user or assistant; other
// lines (queue ops, titles, attachments) are not counted. The turn's `uuid` is the
// message id and `timestamp` its activity time — mirrors the claude-code-sessions skill.
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

// OpenCode stores messages in a SQLite `message` table keyed by `session_id`, with
// `time_created` in epoch milliseconds. Read-only so a running opencode is untouched.
async function readOpencodeWatermark(
  paths: RuntimePaths,
  id: string
): Promise<Watermark | undefined> {
  const dbPath = path.join(paths.home, ".local", "share", "opencode", "opencode.db");
  if (!(await pathExists(dbPath))) return undefined;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
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
    // The opencode message table's shape changes between versions (the opencode-sessions
    // skill warns to verify columns live). A schema mismatch means we can't read a
    // watermark this run, not that ingest should crash — treat it as absent.
    return undefined;
  } finally {
    db.close();
  }
}

// Classify a session against its stored watermark. A missing baseline (an entry
// written before watermarks existed) is treated as unchanged so a first ingest does
// not blanket-refresh untracked sessions; such a session is watermarked the next
// time it is explicitly ingested. A strict count/last-id difference is `changed`;
// an absent session or one that shrank below its stored count is `vanished`.
export function classifyWatermark(
  stored: { message_count?: number | undefined; last_message_id?: string | undefined },
  current: Watermark | undefined
): WatermarkStatus {
  if (stored.message_count === undefined || stored.last_message_id === undefined) {
    return "unchanged";
  }
  if (current === undefined || current.message_count < stored.message_count) {
    return "vanished";
  }
  if (
    current.message_count !== stored.message_count ||
    current.last_message_id !== stored.last_message_id
  ) {
    return "changed";
  }
  return "unchanged";
}
