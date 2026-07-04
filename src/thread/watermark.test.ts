import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { archiveCacheRoot } from "../core/paths.js";
import { makeTempDir, testRuntimePaths } from "../../tests/integration/support.js";
import {
  classifyWatermark,
  readWatermark,
  tailSignatureFromExport,
  type Watermark
} from "./watermark.js";

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

    const wm = await readWatermark(testRuntimePaths(home), { source: "claude-code", id });

    expect(wm).toEqual({
      message_count: 2,
      last_message_id: "a1",
      last_activity_at: "2026-06-04T17:06:48.203Z"
    });
  });

  it("returns undefined when a claude-code session is absent from the store", async () => {
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "present-id");

    const wm = await readWatermark(testRuntimePaths(home), {
      source: "claude-code",
      id: "missing-id"
    });

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

    const wm = await readWatermark(testRuntimePaths(home), { source: "opencode", id });

    expect(wm).toEqual({
      message_count: 3,
      last_message_id: "msg_c",
      last_activity_at: new Date(1777414500000).toISOString()
    });
  });

  it("keeps the db-backed reader and tailSignatureFromExport in parity for equivalent data", async () => {
    // Guards against the two readers drifting apart: the db-backed reader derives
    // count/last-id via COUNT(*)/ORDER BY, tailSignatureFromExport via array length/last
    // element. Same underlying rows must produce the same {message_count, last_message_id}.
    const home = await makeTempDir();
    const id = "ses_parity";
    const rows = [
      { id: "msg_1", time_created: 1000 },
      { id: "msg_2", time_created: 3000 },
      { id: "msg_3", time_created: 2000 }
    ];
    await writeOpencodeDb(home, id, rows);

    const fromDb = await readWatermark(testRuntimePaths(home), { source: "opencode", id });

    const exportJson = {
      info: { id },
      messages: [...rows]
        .sort((a, b) => a.time_created - b.time_created)
        .map((row) => ({ info: { id: row.id, time: { created: row.time_created } } }))
    };
    const fromExport = tailSignatureFromExport(JSON.stringify(exportJson));

    expect(fromExport).toEqual(fromDb);
  });

  it("returns undefined when an opencode session has no messages", async () => {
    const home = await makeTempDir();
    await writeOpencodeDb(home, "ses_present", [{ id: "msg_a", time_created: 1 }]);

    const wm = await readWatermark(testRuntimePaths(home), {
      source: "opencode",
      id: "ses_absent"
    });

    expect(wm).toBeUndefined();
  });

  it("returns undefined when the opencode db does not exist", async () => {
    const home = await makeTempDir();

    const wm = await readWatermark(testRuntimePaths(home), { source: "opencode", id: "ses_x" });

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

    const wm = await readWatermark(testRuntimePaths(home), { source: "opencode", id: "ses_x" });

    expect(wm).toBeUndefined();
  });

  it("falls back to a hydrated archive-cache copy for a claude-code session absent locally", async () => {
    const home = await makeTempDir();
    const dir = path.join(archiveCacheRoot(testRuntimePaths(home)), "claude-code");
    await mkdir(dir, { recursive: true });
    const lines = [
      { type: "user", uuid: "u1", timestamp: "2026-06-04T17:06:36.796Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-06-04T17:06:48.203Z" }
    ];
    await writeFile(
      path.join(dir, "cached-session.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8"
    );

    const wm = await readWatermark(testRuntimePaths(home), {
      source: "claude-code",
      id: "cached-session"
    });

    expect(wm).toEqual({
      message_count: 2,
      last_message_id: "a1",
      last_activity_at: "2026-06-04T17:06:48.203Z"
    });
  });

  it("falls back to a hydrated archive-cache copy for an opencode session absent from the db", async () => {
    const home = await makeTempDir();
    const dir = path.join(archiveCacheRoot(testRuntimePaths(home)), "opencode");
    await mkdir(dir, { recursive: true });
    const exportJson = {
      info: { id: "ses_cached" },
      messages: [
        { info: { id: "msg_1", time: { created: 1000 } } },
        { info: { id: "msg_2", time: { created: 2000 } } }
      ]
    };
    await writeFile(path.join(dir, "ses_cached.json"), JSON.stringify(exportJson), "utf8");

    const wm = await readWatermark(testRuntimePaths(home), {
      source: "opencode",
      id: "ses_cached"
    });

    expect(wm).toEqual({
      message_count: 2,
      last_message_id: "msg_2",
      last_activity_at: new Date(2000).toISOString()
    });
  });

  it("prefers the live claude-code store over a stale archive-cache copy", async () => {
    const home = await makeTempDir();
    const id = "both-present";
    await writeClaudeTranscript(home, id);
    const dir = path.join(archiveCacheRoot(testRuntimePaths(home)), "claude-code");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.jsonl`), "should not be read", "utf8");

    const wm = await readWatermark(testRuntimePaths(home), { source: "claude-code", id });

    expect(wm?.message_count).toBe(2);
  });
});

describe("tailSignatureFromExport", () => {
  it("reads message_count and the last message's id/time from an opencode export artifact", () => {
    const content = JSON.stringify({
      info: { id: "ses_x" },
      messages: [
        { info: { id: "msg_a", time: { created: 100 } } },
        { info: { id: "msg_b", time: { created: 200 } } }
      ]
    });

    expect(tailSignatureFromExport(content)).toEqual({
      message_count: 2,
      last_message_id: "msg_b",
      last_activity_at: new Date(200).toISOString()
    });
  });

  it("returns undefined for an export with no messages", () => {
    expect(tailSignatureFromExport(JSON.stringify({ info: {}, messages: [] }))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(tailSignatureFromExport("not json")).toBeUndefined();
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

  it("is shrank (not vanished) when a present session's count dropped below stored", () => {
    expect(classifyWatermark(stored, wm({ message_count: 1, last_message_id: "u1" }))).toBe(
      "shrank"
    );
  });

  it("is unchanged when there is no stored baseline to compare against", () => {
    expect(classifyWatermark({}, wm({ message_count: 9, last_message_id: "z9" }))).toBe(
      "unchanged"
    );
  });
});
