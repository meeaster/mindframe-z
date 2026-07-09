// Bun (as of 1.3.x) does not ship node:sqlite; compiled binaries must use
// bun:sqlite. Both expose synchronous prepare/get/all/close, but named-parameter
// binding differs: node:sqlite binds `$id` from `{ id }`, bun:sqlite wants the
// prefix in the key. Normalize by prefixing keys for bun.
import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

export interface SqliteStatement {
  get(params?: Record<string, unknown>): unknown;
  all(params?: Record<string, unknown>): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function openSqlite(dbPath: string, options: { readOnly?: boolean } = {}): SqliteDatabase {
  if (process.versions.bun) {
    const { Database } = requireModule("bun:sqlite") as {
      Database: new (p: string, o: { readonly?: boolean }) => SqliteDatabase;
    };
    const db = new Database(dbPath, { readonly: options.readOnly ?? false });
    return {
      prepare(sql) {
        const stmt = db.prepare(sql);
        return {
          get: (params) => stmt.get(prefixParams(params)),
          all: (params) => stmt.all(prefixParams(params))
        };
      },
      close: () => db.close()
    };
  }
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (p: string, o: { readOnly?: boolean }) => SqliteDatabase;
  };
  return new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false });
}

// bun:sqlite binds named params by their `$`-prefixed key; node:sqlite derives the
// prefix from a bare key. Prefix here so callers pass bare `{ id }` in both runtimes.
export function prefixParams(
  params?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [`$${k}`, v]));
}
