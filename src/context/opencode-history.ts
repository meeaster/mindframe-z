import { pathExists, opencodeDbPath, type RuntimePaths } from "../core/paths.js";
import { openSqlite, type SqliteDatabase } from "../core/sqlite-compat.js";
import { HistoryCollector, addOpenCodeUsage, objectField, unavailableHistory } from "./history.js";
import { isPathWithin } from "./repository.js";
import type { ContextHistory } from "./model.js";

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  version: string;
  time_updated: number;
}

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  time_created: number;
  data: string;
}

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}

function hasRequiredSchema(db: SqliteDatabase): boolean {
  const required: Record<string, string[]> = {
    session: ["id", "parent_id", "directory", "version", "time_updated"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["session_id", "time_created", "data"]
  };
  return Object.entries(required).every(([table, columns]) => {
    const actual = tableColumns(db, table);
    return columns.every((column) => actual.has(column));
  });
}

function loadedInstructionPaths(data: Record<string, unknown>): string[] {
  const candidates = [
    objectField(data.metadata)?.loaded,
    objectField(data.state)?.metadata && objectField(objectField(data.state)?.metadata)?.loaded
  ];
  return candidates.flatMap((value) => {
    if (typeof value === "string") return [value];
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  });
}

function partActivations(
  collector: HistoryCollector,
  data: Record<string, unknown>,
  mcpNames: string[]
): void {
  if (data.type === "compaction") collector.addCompaction();
  const tool = typeof data.tool === "string" ? data.tool : undefined;
  if (tool) {
    if (tool === "skill") {
      const state = objectField(data.state);
      const input = objectField(state?.input) ?? objectField(data.input);
      const skillName =
        typeof input?.name === "string"
          ? input.name
          : typeof input?.skill === "string"
            ? input.skill
            : "name unavailable";
      collector.addActivation("skill", skillName);
    } else {
      const server = mcpNames.find(
        (name) => tool.startsWith(`${name}__`) || tool.startsWith(`${name}_`)
      );
      if (server) collector.addActivation("mcp", server);
      else collector.addActivation("tool", tool);
    }
  }
  for (const loaded of loadedInstructionPaths(data)) collector.addActivation("instruction", loaded);
}

export async function readOpenCodeHistory(
  paths: RuntimePaths,
  mcpNames: string[],
  projectRoot: string,
  windowDays: number
): Promise<ContextHistory> {
  const dbPath = opencodeDbPath(paths);
  if (!(await pathExists(dbPath))) return unavailableHistory(windowDays, "database not found");

  let db: SqliteDatabase;
  try {
    db = openSqlite(dbPath, { readOnly: true });
  } catch {
    return unavailableHistory(windowDays, "database could not be opened read-only");
  }

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const collector = new HistoryCollector();
  try {
    if (!hasRequiredSchema(db))
      return unavailableHistory(windowDays, "required tables or fields are missing");
    const sessions = db
      .prepare("SELECT id, parent_id, directory, version, time_updated FROM session")
      .all() as SessionRow[];
    for (const session of sessions) {
      if (!isPathWithin(projectRoot, session.directory)) continue;
      const messages = db
        .prepare(
          "SELECT id, time_created, data FROM message WHERE session_id = $id AND time_created >= $cutoff"
        )
        .all({ id: session.id, cutoff }) as MessageRow[];
      if (messages.length === 0 && session.time_updated < cutoff) continue;
      collector.addSession(session.id, session.parent_id !== null, session.version);
      for (const message of messages) {
        let data: Record<string, unknown>;
        try {
          const parsed = JSON.parse(message.data);
          data = objectField(parsed) ?? {};
        } catch {
          continue;
        }
        if (data.role !== "assistant") continue;
        const usage = addOpenCodeUsage(data.tokens);
        collector.addRequest(`${session.id}:${message.id}`, usage);
        const modelVersion = typeof data.version === "string" ? data.version : undefined;
        if (modelVersion) collector.addVersion(modelVersion);
      }
      const parts = db
        .prepare(
          "SELECT time_created, data FROM part WHERE session_id = $id AND time_created >= $cutoff"
        )
        .all({ id: session.id, cutoff }) as PartRow[];
      for (const part of parts) {
        try {
          const data = objectField(JSON.parse(part.data));
          if (data) partActivations(collector, data, mcpNames);
        } catch {
          // Ignore malformed structural parts without exposing their content.
        }
      }
    }
    return collector.finish(windowDays);
  } catch {
    return unavailableHistory(windowDays, "database query failed");
  } finally {
    db.close();
  }
}
