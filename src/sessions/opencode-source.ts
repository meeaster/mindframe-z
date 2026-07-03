import { DatabaseSync } from "node:sqlite";
import { execa } from "execa";
import type { RuntimePaths } from "../core/paths.js";
import { opencodeDataHome, opencodeDbPath, pathExists } from "../core/paths.js";
import type { BackupItem } from "./backup-item.js";
import { primaryRelPath } from "./archive.js";

// Extract one session via the vendor-maintained `opencode export` — never pass
// --sanitize, since the archive is meant to be full-fidelity (the private,
// encrypted, IAM-scoped bucket is the privacy boundary instead). The raw stdout
// bytes are uploaded verbatim, not re-serialized, so the artifact matches exactly
// what the CLI produced. `dataHome` is forced onto the child's env so this shells
// out against the exact same database `listOpencodeItems` just enumerated, instead
// of the ambient `opencode` binary silently resolving its own (possibly different)
// data directory.
async function exportSession(id: string, dataHome: string): Promise<Buffer> {
  const result = await execa("opencode", ["export", id], {
    encoding: "buffer",
    env: { ...process.env, XDG_DATA_HOME: dataHome }
  });
  return Buffer.from(result.stdout);
}

// OpenCode sessions are enumerated from opencode.db (`SELECT id FROM session`) —
// current OpenCode keeps session info in that table, not `storage/session/info/
// <id>.json` files. Each session's freshness signal is the greater of its own
// `time_updated` and its latest message's `time_created`, because message growth
// may not bump the session row's `time_updated`.
export async function listOpencodeItems(paths: RuntimePaths): Promise<BackupItem[]> {
  const dataHome = opencodeDataHome(paths);
  const dbPath = opencodeDbPath(paths);
  if (!(await pathExists(dbPath))) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const sessions = db.prepare("SELECT id, time_updated FROM session").all() as Array<{
      id: string;
      time_updated: number;
    }>;
    const lastMessageMs = new Map<string, number>();
    for (const row of db
      .prepare("SELECT session_id, MAX(time_created) AS last_ms FROM message GROUP BY session_id")
      .all() as Array<{ session_id: string; last_ms: number }>) {
      lastMessageMs.set(row.session_id, row.last_ms);
    }
    return sessions.map((session) => ({
      relPath: primaryRelPath("opencode", session.id),
      sourceMs: Math.max(session.time_updated, lastMessageMs.get(session.id) ?? 0),
      contentType: "application/json",
      load: () => exportSession(session.id, dataHome)
    }));
  } finally {
    db.close();
  }
}
