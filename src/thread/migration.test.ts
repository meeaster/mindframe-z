import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, testRuntimePaths } from "../../tests/integration/support.js";
import { archiveCacheRoot } from "../core/paths.js";
import { migrateThreadDirectory } from "./migration.js";
import { readThreadManifest, readThreadRuns } from "./storage.js";

async function writeClaudeTranscript(home: string, id: string): Promise<void> {
  const dir = path.join(home, ".claude", "projects", "fixture");
  await mkdir(dir, { recursive: true });
  const records = [
    { type: "user", uuid: "u1", timestamp: "2026-07-01T00:00:00.000Z" },
    { type: "system", uuid: "system-1", timestamp: "2026-07-01T00:01:00.000Z" },
    { type: "assistant", uuid: "a1", timestamp: "2026-07-01T00:02:00.000Z" },
    { type: "user", uuid: "u2", timestamp: "2026-07-01T00:03:00.000Z" }
  ];
  await writeFile(
    path.join(dir, `${id}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
}

describe("thread manifest migration", () => {
  it("converts timestamp and raw-record Claude cursors at their represented boundaries", async () => {
    const home = await makeTempDir();
    const storePath = path.join(home, "store", "threads");
    const sourceDir = path.join(storePath, "legacy");
    await mkdir(sourceDir, { recursive: true });
    await writeClaudeTranscript(home, "timestamp-session");
    await writeClaudeTranscript(home, "count-session");
    await writeFile(
      path.join(sourceDir, "manifest.json"),
      JSON.stringify({
        slug: "legacy",
        charter: "Preserve old metadata.",
        destination: "personal",
        created_at: "2026-07-01T00:00:00.000Z",
        read_subagents: true,
        sessions: [
          {
            id: "timestamp-session",
            source: "claude-code",
            high_water: "2026-07-01T00:02:30.000Z",
            project: "/tmp/project"
          },
          { id: "count-session", source: "claude-code", high_water: 3 }
        ],
        excluded: [{ id: "excluded", reason: "folded into another session" }],
        runs: [
          {
            at: "2026-07-01T00:04:00.000Z",
            mode: "incremental",
            sessions: ["timestamp-session"],
            cost_usd: 1.5
          }
        ],
        synthesis: { digest: "claude-code:sonnet@high" }
      }) + "\n"
    );

    const result = await migrateThreadDirectory({
      paths: testRuntimePaths(home),
      sourceDir,
      storeName: "personal",
      storePath
    });
    expect(result.importedRuns).toBe(1);
    const manifest = await readThreadManifest(sourceDir);
    expect(manifest.store).toBe("personal");
    expect(manifest.read_subagents).toBe(true);
    expect(manifest.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "timestamp-session",
          message_count: 2,
          last_message_id: "a1",
          project: "/tmp/project"
        }),
        expect.objectContaining({ id: "count-session", message_count: 2, last_message_id: "a1" })
      ])
    );
    expect(manifest.excluded).toEqual([{ id: "excluded", reason: "folded into another session" }]);
    expect((await readThreadRuns(sourceDir)).runs[0]).toMatchObject({
      kind: "imported",
      mode: "incremental",
      cost_usd: 1.5
    });
  });

  it("rejects unknown predecessor fields and unresolved cursors without modifying the source", async () => {
    const home = await makeTempDir();
    const storePath = path.join(home, "store", "threads");
    const sourceDir = path.join(storePath, "legacy");
    await mkdir(sourceDir, { recursive: true });
    const original =
      JSON.stringify(
        {
          slug: "legacy",
          charter: "Legacy",
          destination: "personal",
          created_at: "2026-07-01T00:00:00.000Z",
          sessions: [],
          unknown: true
        },
        null,
        2
      ) + "\n";
    await writeFile(path.join(sourceDir, "manifest.json"), original);
    await expect(
      migrateThreadDirectory({
        paths: testRuntimePaths(home),
        sourceDir,
        storeName: "personal",
        storePath
      })
    ).rejects.toThrow(/Unrecognized key|unknown/i);
    await expect(readFile(path.join(sourceDir, "manifest.json"), "utf8")).resolves.toBe(original);
  });

  it("converts an OpenCode update timestamp from an archived export", async () => {
    const home = await makeTempDir();
    const storePath = path.join(home, "store", "threads");
    const sourceDir = path.join(storePath, "opencode");
    await mkdir(sourceDir, { recursive: true });
    const cache = path.join(archiveCacheRoot(testRuntimePaths(home)), "opencode");
    await mkdir(cache, { recursive: true });
    await writeFile(
      path.join(cache, "session.json"),
      JSON.stringify({
        messages: [
          { info: { id: "m1", time: { created: 1000 } } },
          { info: { id: "m2", time: { created: 2000 } } },
          { info: { id: "m3", time: { created: 3000 } } }
        ]
      })
    );
    await writeFile(
      path.join(sourceDir, "manifest.json"),
      JSON.stringify({
        slug: "opencode",
        charter: "OpenCode boundary",
        destination: "personal",
        created_at: "2026-07-01T00:00:00.000Z",
        sessions: [{ id: "session", source: "opencode", high_water: 2000 }]
      })
    );
    await migrateThreadDirectory({
      paths: testRuntimePaths(home),
      sourceDir,
      storeName: "personal",
      storePath
    });
    await expect(readThreadManifest(sourceDir)).resolves.toMatchObject({
      sessions: [
        { message_count: 2, last_message_id: "m2", last_activity_at: "1970-01-01T00:00:02.000Z" }
      ]
    });
  });
});
