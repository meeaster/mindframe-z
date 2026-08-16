import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { openSqlite, type SqliteDatabase } from "../core/sqlite-compat.js";
import type { RuntimePaths } from "../core/paths.js";
import { parseJsonlObjects, pathExists, readTextFile } from "../core/fs-util.js";
import { opencodeDbPath } from "../core/paths.js";
import type { ThreadHarness } from "../core/manifests.js";
import { cachedSessionPath } from "../sessions/archive.js";
import { watermarkClaudeRecordSchema, watermarkExportSchema } from "./schema.js";

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
  const content = await readTextFile(cached);
  return content === undefined ? undefined : tailSignatureFromJsonl(content);
}

// A transcript line is a message turn when its `type` is user or assistant; other
// lines (queue ops, titles, attachments) are not counted. The turn's `uuid` is the
// message id and `timestamp` its activity time — mirrors the thread-sessions Claude branch.
function tailSignatureFromJsonl(content: string): Watermark | undefined {
  let count = 0;
  let last: { uuid?: string | undefined; timestamp?: string | undefined } | undefined;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let record: {
      type?: string | undefined;
      uuid?: string | undefined;
      timestamp?: string | undefined;
    };
    try {
      record = watermarkClaudeRecordSchema.parse(JSON.parse(line));
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
  let parsed: z.infer<typeof watermarkExportSchema>;
  try {
    parsed = watermarkExportSchema.parse(JSON.parse(content));
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

/** Resolve a predecessor cursor without advancing it to the current source tail. */
export async function resolveLegacyWatermark(
  paths: RuntimePaths,
  session: { source: ThreadHarness; id: string },
  cursor: string | number
): Promise<Watermark | undefined> {
  if (session.source === "claude-code") {
    const content = await readTranscriptContent(paths, session.source, session.id);
    return content === undefined ? undefined : claudeBoundary(content, cursor);
  }
  return openCodeBoundary(paths, session.id, cursor);
}

async function readTranscriptContent(
  paths: RuntimePaths,
  source: ThreadHarness,
  id: string
): Promise<string | undefined> {
  if (source === "claude-code") {
    const live = await locateClaudeTranscript(paths, id);
    if (live !== undefined) return readFile(path.join(paths.claudeDir, live), "utf8");
  }
  const cached = cachedSessionPath(paths, source, id);
  return readTextFile(cached);
}

function claudeBoundary(content: string, cursor: string | number): Watermark | undefined {
  // Legacy record-count cursors count valid JSONL records only.
  const records = parseJsonlObjects(content).flatMap((record) => {
    const parsed = watermarkClaudeRecordSchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });

  const numericCursor = z.number().safeParse(cursor);
  const boundary = numericCursor.success
    ? records.slice(0, numericCursor.data)
    : records.filter((record) => {
        const timestamp = record.timestamp === undefined ? NaN : Date.parse(record.timestamp);
        const cutoff = Date.parse(String(cursor));
        return Number.isFinite(timestamp) && Number.isFinite(cutoff) && timestamp <= cutoff;
      });
  const messages = boundary.filter(
    (record) =>
      (record.type === "user" || record.type === "assistant") &&
      record.uuid !== undefined &&
      record.timestamp !== undefined
  );
  const last = messages.at(-1);
  if (last?.uuid === undefined || last.timestamp === undefined) return undefined;
  return {
    message_count: messages.length,
    last_message_id: last.uuid,
    last_activity_at: last.timestamp
  };
}

async function openCodeBoundary(
  paths: RuntimePaths,
  id: string,
  cursor: string | number
): Promise<Watermark | undefined> {
  const numericCursor = z.number().safeParse(cursor);
  const cutoff = numericCursor.success ? numericCursor.data : Date.parse(String(cursor));
  if (!Number.isFinite(cutoff)) return undefined;
  const dbPath = opencodeDbPath(paths);
  if (await pathExists(dbPath)) {
    let db: SqliteDatabase;
    try {
      db = openSqlite(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          "SELECT id, time_created FROM message WHERE session_id = $id AND time_created <= $cutoff ORDER BY time_created ASC, id ASC"
        )
        .all({ id, cutoff })
        .map((row) =>
          z
            .object({ id: z.string().optional(), time_created: z.number().finite().optional() })
            .parse(row)
        );
      const last = rows.at(-1);
      if (last?.id !== undefined && last.time_created !== undefined) {
        return {
          message_count: rows.length,
          last_message_id: last.id,
          last_activity_at: new Date(last.time_created).toISOString()
        };
      }
    } catch {
      // Try the archive export below when the live database is unavailable or changed shape.
    } finally {
      try {
        db!.close();
      } catch {
        // The database may not have opened.
      }
    }
  }

  const cached = cachedSessionPath(paths, "opencode", id);
  let parsed: z.infer<typeof watermarkExportSchema>;
  try {
    // Any unusable export — absent, unreadable, or not JSON — means "no boundary
    // from the cache" here, so the read stays inside this catch rather than
    // propagating the way the other cache reads do.
    const content = await readTextFile(cached);
    if (content === undefined) return undefined;
    parsed = watermarkExportSchema.parse(JSON.parse(content));
  } catch {
    return undefined;
  }
  const messages = (parsed.messages ?? []).filter((message) => {
    const created = message.info?.time?.created;
    return created !== undefined && created <= cutoff;
  });
  const last = messages.at(-1)?.info;
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
  const content = await readTextFile(cached);
  return content === undefined ? undefined : tailSignatureFromExport(content);
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
      .get({ id });
    const parsedRow = z
      .object({
        count: z.number().int(),
        last_id: z.string().nullable(),
        last_ms: z.number().nullable()
      })
      .parse(row);
    if (parsedRow.count === 0 || parsedRow.last_id === null || parsedRow.last_ms === null)
      return undefined;
    return {
      message_count: parsedRow.count,
      last_message_id: parsedRow.last_id,
      last_activity_at: new Date(parsedRow.last_ms).toISOString()
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
