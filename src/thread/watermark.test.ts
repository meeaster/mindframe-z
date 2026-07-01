import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import { makeTempDir } from "../../tests/integration/support.js";
import { classifyWatermark, readWatermark, type Watermark } from "./watermark.js";

function paths(home: string): RuntimePaths {
  return {
    root: home,
    home,
    configsDir: path.join(home, "configs"),
    opencodeConfigDir: path.join(home, ".config", "opencode"),
    claudeDir: path.join(home, ".claude"),
    miseConfigDir: path.join(home, ".config", "mise")
  };
}

// A claude transcript with two message turns wrapped in non-message lines, so the
// reader must count only user/assistant turns and read the last turn's uuid/timestamp.
async function writeClaudeTranscript(home: string, id: string): Promise<void> {
  const projectDir = path.join(home, ".claude", "projects", "-tmp-project");
  await mkdir(projectDir, { recursive: true });
  const lines = [
    { type: "queue-operation", uuid: "q1", timestamp: "2026-06-04T17:00:00.000Z" },
    { type: "user", uuid: "u1", timestamp: "2026-06-04T17:06:36.796Z", sessionId: id },
    { type: "assistant", uuid: "a1", timestamp: "2026-06-04T17:06:48.203Z", sessionId: id },
    { type: "ai-title", uuid: "t1", timestamp: "2026-06-04T17:07:00.000Z" }
  ];
  await writeFile(
    path.join(projectDir, `${id}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8"
  );
}

// A minimal opencode.db with the columns the reader queries. Rows are inserted out of
// chronological order to prove the reader orders by time_created, not insertion order.
async function writeOpencodeDb(
  home: string,
  sessionId: string,
  rows: { id: string; time_created: number }[]
): Promise<void> {
  const dir = path.join(home, ".local", "share", "opencode");
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL)"
  );
  const insert = db.prepare("INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)");
  for (const row of rows) insert.run(row.id, sessionId, row.time_created);
  db.close();
}

describe("readWatermark", () => {
  it("reads a claude-code transcript tail signature, counting only message turns", async () => {
    const home = await makeTempDir();
    const id = "d134c87c-3233-4b80-94a5-9f96a1571cdd";
    await writeClaudeTranscript(home, id);

    const wm = await readWatermark(paths(home), { source: "claude-code", id });

    expect(wm).toEqual({
      message_count: 2,
      last_message_id: "a1",
      last_activity_at: "2026-06-04T17:06:48.203Z"
    });
  });

  it("returns undefined when a claude-code session is absent from the store", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "present-id");

    const wm = await readWatermark(paths(home), { source: "claude-code", id: "missing-id" });

    expect(wm).toBeUndefined();
  });

  it("reads an opencode tail signature ordered by time_created", async () => {
    const home = await makeTempDir();
    const id = "ses_0e6f6854cffeuGdDonIIPFVmgg";
    await writeOpencodeDb(home, id, [
      { id: "msg_b", time_created: 1777414465891 },
      { id: "msg_a", time_created: 1777414400000 },
      { id: "msg_c", time_created: 1777414500000 }
    ]);

    const wm = await readWatermark(paths(home), { source: "opencode", id });

    expect(wm).toEqual({
      message_count: 3,
      last_message_id: "msg_c",
      last_activity_at: new Date(1777414500000).toISOString()
    });
  });

  it("returns undefined when an opencode session has no messages", async () => {
    const home = await makeTempDir();
    await writeOpencodeDb(home, "ses_present", [{ id: "msg_a", time_created: 1 }]);

    const wm = await readWatermark(paths(home), { source: "opencode", id: "ses_absent" });

    expect(wm).toBeUndefined();
  });

  it("returns undefined when the opencode db does not exist", async () => {
    const home = await makeTempDir();

    const wm = await readWatermark(paths(home), { source: "opencode", id: "ses_x" });

    expect(wm).toBeUndefined();
  });

  it("returns undefined instead of throwing when the message table shape is unexpected", async () => {
    // The opencode schema changes between versions; a column the reader assumes may be
    // gone after an upgrade. That must degrade to "no watermark", not crash the ingest.
    const home = await makeTempDir();
    const dir = path.join(home, ".local", "share", "opencode");
    await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, payload TEXT)");
    db.close();

    const wm = await readWatermark(paths(home), { source: "opencode", id: "ses_x" });

    expect(wm).toBeUndefined();
  });
});

describe("classifyWatermark", () => {
  const stored = { message_count: 3, last_message_id: "a1" };
  const wm = (over: Partial<Watermark>): Watermark => ({
    message_count: 3,
    last_message_id: "a1",
    last_activity_at: "2026-06-04T17:06:48.203Z",
    ...over
  });

  it("is unchanged when count and last id both match", () => {
    expect(classifyWatermark(stored, wm({}))).toBe("unchanged");
  });

  it("is changed when the message count grew", () => {
    expect(classifyWatermark(stored, wm({ message_count: 5, last_message_id: "a3" }))).toBe(
      "changed"
    );
  });

  it("is changed when the last id differs at the same count", () => {
    expect(classifyWatermark(stored, wm({ last_message_id: "a2" }))).toBe("changed");
  });

  it("is vanished when the session is absent from the store", () => {
    expect(classifyWatermark(stored, undefined)).toBe("vanished");
  });

  it("is vanished when the current count shrank below the stored count", () => {
    expect(classifyWatermark(stored, wm({ message_count: 1, last_message_id: "u1" }))).toBe(
      "vanished"
    );
  });

  it("is unchanged when there is no stored baseline to compare against", () => {
    expect(classifyWatermark({}, wm({ message_count: 9, last_message_id: "z9" }))).toBe(
      "unchanged"
    );
  });
});
