import { pathExists } from "../core/fs-util.js";
import { z } from "zod";
import { opencodeDbPath, type RuntimePaths } from "../core/paths.js";
import { openSqlite, type SqliteDatabase } from "../core/sqlite-compat.js";
import { HistoryCollector, addOpenCodeUsage, objectField, unavailableHistory } from "./history.js";
import { isPathWithin } from "./repository.js";
import type { ContextHistory } from "./model.js";
import {
  jsonString,
  jsonStringArray,
  parseJsonObject,
  parseJsonText,
  type JsonObject
} from "../core/json.js";

const sessionRowSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  directory: z.string(),
  version: z.string(),
  time_updated: z.number()
});
const messageRowSchema = z.object({ id: z.string(), time_created: z.number(), data: z.string() });
const partRowSchema = z.object({ time_created: z.number(), data: z.string() });
const pragmaRowSchema = z.object({ name: z.string() });

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(
    rows.flatMap((row) => {
      const column = pragmaRowSchema.safeParse(row);
      return column.success ? [column.data.name] : [];
    })
  );
}

function hasRequiredSchema(db: SqliteDatabase): boolean {
  const required = {
    session: ["id", "parent_id", "directory", "version", "time_updated"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["session_id", "time_created", "data"]
  } satisfies Record<string, readonly string[]>;
  return Object.entries(required).every(([table, columns]) => {
    const actual = tableColumns(db, table);
    return columns.every((column) => actual.has(column));
  });
}

function loadedInstructionPaths(data: JsonObject): string[] {
  const candidates = [
    objectField(data.metadata)?.loaded,
    objectField(data.state)?.metadata && objectField(objectField(data.state)?.metadata)?.loaded
  ];
  return candidates.flatMap((value) => {
    const string = jsonString(value);
    if (string !== undefined) return [string];
    return jsonStringArray(value);
  });
}

function partActivations(collector: HistoryCollector, data: JsonObject, mcpNames: string[]): void {
  if (data.type === "compaction") collector.addCompaction();
  const tool = jsonString(data.tool);
  if (tool) {
    if (tool === "skill") {
      const state = objectField(data.state);
      const input = objectField(state?.input) ?? objectField(data.input);
      const skillName = jsonString(input?.name) ?? jsonString(input?.skill) ?? "name unavailable";
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
      .all()
      .flatMap((row) => {
        const parsed = sessionRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
    for (const session of sessions) {
      if (!isPathWithin(projectRoot, session.directory)) continue;
      const messages = db
        .prepare(
          "SELECT id, time_created, data FROM message WHERE session_id = $id AND time_created >= $cutoff"
        )
        .all({ id: session.id, cutoff })
        .flatMap((row) => {
          const parsed = messageRowSchema.safeParse(row);
          return parsed.success ? [parsed.data] : [];
        });
      if (messages.length === 0 && session.time_updated < cutoff) continue;
      collector.addSession(session.id, session.parent_id !== null, session.version);
      for (const message of messages) {
        let data: JsonObject;
        try {
          data = parseJsonObject(parseJsonText(message.data) ?? {}) ?? {};
        } catch {
          continue;
        }
        if (data.role !== "assistant") continue;
        const usage = addOpenCodeUsage(data.tokens);
        collector.addRequest(`${session.id}:${message.id}`, usage);
        const modelVersion = jsonString(data.version);
        if (modelVersion) collector.addVersion(modelVersion);
      }
      const parts = db
        .prepare(
          "SELECT time_created, data FROM part WHERE session_id = $id AND time_created >= $cutoff"
        )
        .all({ id: session.id, cutoff })
        .flatMap((row) => {
          const parsed = partRowSchema.safeParse(row);
          return parsed.success ? [parsed.data] : [];
        });
      for (const part of parts) {
        try {
          const data = objectField(parseJsonText(part.data));
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
