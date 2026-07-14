import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import { readOpenCodeHistory } from "./opencode-history.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, "opencode"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi"),
    miseConfigDir: path.join(home, "mise")
  };
}

describe("OpenCode context history", () => {
  it("reads the database read-only and keeps missing prompt telemetry out of the denominator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-opencode-history-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-opencode-history-home-"));
    const sibling = path.join(path.dirname(root), `${path.basename(root)}-sibling`);
    const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, version TEXT, time_updated INTEGER)"
    );
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)"
    );
    db.exec(
      "CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)"
    );
    const now = Date.now();
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("main", null, root, "1.17", now);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run(
      "child",
      "main",
      root,
      "1.17",
      now
    );
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run(
      "sibling",
      null,
      sibling,
      "1.17",
      now
    );
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
    insertMessage.run(
      "m1",
      "main",
      now,
      JSON.stringify({ role: "assistant", tokens: { input: 4, cache: { read: 6 }, output: 2 } })
    );
    insertMessage.run(
      "m2",
      "main",
      now,
      JSON.stringify({ role: "assistant", tokens: { output: 8 } })
    );
    insertMessage.run(
      "m3",
      "child",
      now,
      JSON.stringify({ role: "assistant", tokens: { input: 1 } })
    );
    insertMessage.run(
      "m4",
      "main",
      now - 3 * 24 * 60 * 60 * 1000,
      JSON.stringify({ role: "assistant", tokens: { input: 100 } })
    );
    insertMessage.run(
      "m5",
      "sibling",
      now,
      JSON.stringify({ role: "assistant", tokens: { input: 100 } })
    );
    const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)");
    insertPart.run(
      "p1",
      "main",
      now,
      JSON.stringify({ type: "tool", tool: "docs__search", state: { input: { query: "secret" } } })
    );
    insertPart.run(
      "p2",
      "main",
      now,
      JSON.stringify({ type: "tool", tool: "skill", state: { input: { name: "used" } } })
    );
    insertPart.run("p3", "main", now, JSON.stringify({ type: "compaction" }));
    db.close();
    const before = await stat(dbPath);

    const history = await readOpenCodeHistory(paths(home), ["docs"], root, 1);
    const after = await stat(dbPath);
    expect(history).toMatchObject({
      available: true,
      sessions: 2,
      childSessions: 1,
      modelRequests: 3,
      usageBearingRequests: 2,
      promptInputTokensWindowTotal: 11,
      outputTokens: 10,
      compactions: 1
    });
    expect(history.activations.find((entry) => entry.name === "used")).toMatchObject({ count: 1 });
    expect(JSON.stringify(history)).not.toContain("secret");
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("reports missing stores and schemas as unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-opencode-missing-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-opencode-missing-home-"));
    await expect(readOpenCodeHistory(paths(home), ["docs"], root, 1)).resolves.toMatchObject({
      available: false,
      unavailableReason: "database not found"
    });

    const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (id TEXT)");
    db.close();
    await expect(readOpenCodeHistory(paths(home), ["docs"], root, 1)).resolves.toMatchObject({
      available: false,
      unavailableReason: "required tables or fields are missing"
    });
  });
});
