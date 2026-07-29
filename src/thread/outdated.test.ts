import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveCacheRoot,
  threadCliLogPath,
  threadDestinationRoot,
  threadRunsRoot,
  threadStoreRoot,
  threadSweepRoot
} from "../core/paths.js";
import {
  cli,
  makeTempDir,
  setupIntegrationFixture,
  testRuntimePaths
} from "../../tests/integration/support.js";
import { runThreadOutdated } from "./cli.js";
import { listOutdatedThreads } from "./outdated.js";

type StoredSession = {
  id: string;
  source: "claude-code" | "opencode";
  message_count?: number;
  last_message_id?: string;
  last_activity_at?: string;
};

async function writeThread(home: string, slug: string, sessions: StoredSession[]): Promise<void> {
  const dir = path.join(home, ".mindframe-z", "threads", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        slug,
        charter: "Track current thread work.",
        destination: "personal",
        created_at: "2026-07-06T00:00:00.000Z",
        sessions,
        synthesis: {}
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function writeClaudeTranscript(
  home: string,
  id: string,
  messageIds: string[]
): Promise<void> {
  const dir = path.join(home, ".claude", "projects", "-fixture");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${id}.jsonl`),
    messageIds
      .map((uuid, index) =>
        JSON.stringify({
          type: index % 2 === 0 ? "user" : "assistant",
          uuid,
          timestamp: new Date(1777414400000 + index * 1000).toISOString()
        })
      )
      .join("\n") + "\n",
    "utf8"
  );
}

function stored(id: string, messageCount: number, lastMessageId: string): StoredSession {
  return {
    id,
    source: "claude-code",
    message_count: messageCount,
    last_message_id: lastMessageId,
    last_activity_at: "2020-01-01T00:00:00.000Z"
  };
}

const logs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  logs.length = 0;
});

describe("listOutdatedThreads", () => {
  it("reports growth and same-count tail replacement while excluding other watermark statuses", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    await writeClaudeTranscript(home, "grew", ["u1", "a1", "u2", "a2"]);
    await writeClaudeTranscript(home, "tail", ["u1", "replacement"]);
    await writeClaudeTranscript(home, "unchanged", ["u1", "a1"]);
    await writeClaudeTranscript(home, "shrank", ["u1", "a1"]);
    await writeClaudeTranscript(home, "legacy", ["u1", "a1", "u2"]);
    await writeThread(home, "mixed", [
      stored("grew", 2, "a1"),
      stored("tail", 2, "a1"),
      stored("unchanged", 2, "a1"),
      stored("vanished", 2, "a1"),
      stored("shrank", 3, "u2"),
      { id: "legacy", source: "claude-code" }
    ]);

    await expect(listOutdatedThreads(paths)).resolves.toEqual([
      {
        slug: "mixed",
        sessions: [
          { source: "claude-code", id: "grew", change: "grew", behind_messages: 2 },
          { source: "claude-code", id: "tail", change: "tail_changed", behind_messages: null }
        ]
      }
    ]);
  });

  it("omits healthy threads and orders results deterministically", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    await writeClaudeTranscript(home, "z-session", ["u1", "a1", "u2"]);
    await writeClaudeTranscript(home, "a-session", ["u1", "a1", "u2"]);
    await writeClaudeTranscript(home, "healthy-session", ["u1", "a1"]);
    await writeThread(home, "z-thread", [
      stored("z-session", 1, "u1"),
      stored("a-session", 1, "u1")
    ]);
    await writeThread(home, "a-thread", [stored("a-session", 1, "u1")]);
    await writeThread(home, "healthy", [stored("healthy-session", 2, "a1")]);

    await expect(listOutdatedThreads(paths)).resolves.toEqual([
      {
        slug: "a-thread",
        sessions: [{ source: "claude-code", id: "a-session", change: "grew", behind_messages: 2 }]
      },
      {
        slug: "z-thread",
        sessions: [
          { source: "claude-code", id: "a-session", change: "grew", behind_messages: 2 },
          { source: "claude-code", id: "z-session", change: "grew", behind_messages: 2 }
        ]
      }
    ]);
  });

  it("fails on a malformed individual thread manifest", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    const invalidDir = path.join(threadStoreRoot(paths), "invalid");
    await mkdir(invalidDir, { recursive: true });
    await writeFile(path.join(invalidDir, "manifest.json"), "not json\n", "utf8");

    await expect(listOutdatedThreads(paths)).rejects.toThrow();
  });

  it("does not create or change thread manifests, sweep state, or destinations", async () => {
    const home = await makeTempDir();
    const paths = testRuntimePaths(home);
    await writeClaudeTranscript(home, "session", ["u1", "a1", "u2"]);
    await writeThread(home, "thread", [stored("session", 1, "u1")]);

    const sweepDir = threadSweepRoot(paths);
    const destinationDir = threadDestinationRoot(paths, "personal");
    await mkdir(sweepDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    await writeFile(path.join(sweepDir, "ledger.json"), "ledger\n", "utf8");
    await writeFile(path.join(destinationDir, "marker"), "destination\n", "utf8");
    const manifestPath = path.join(home, ".mindframe-z", "threads", "thread", "manifest.json");
    const before = await Promise.all([
      readFile(manifestPath, "utf8"),
      readFile(path.join(sweepDir, "ledger.json"), "utf8"),
      readFile(path.join(destinationDir, "marker"), "utf8")
    ]);

    await listOutdatedThreads(paths);

    await expect(readFile(manifestPath, "utf8")).resolves.toBe(before[0]);
    await expect(readFile(path.join(sweepDir, "ledger.json"), "utf8")).resolves.toBe(before[1]);
    await expect(readFile(path.join(destinationDir, "marker"), "utf8")).resolves.toBe(before[2]);
    await expect(readFile(path.join(archiveCacheRoot(paths), "marker"), "utf8")).rejects.toThrow();
  });
});

describe("thread outdated cli", () => {
  function captureConsole(): void {
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => logs.push(String(value)));
  }

  it("prints deterministic four-column TSV and no human output for healthy threads", async () => {
    captureConsole();
    const { root, home } = await setupIntegrationFixture();
    await writeClaudeTranscript(home, "grew", ["u1", "a1", "u2"]);
    await writeClaudeTranscript(home, "one", ["u1", "a1"]);
    await writeClaudeTranscript(home, "tail", ["u1", "replacement"]);
    await writeClaudeTranscript(home, "healthy", ["u1", "a1"]);
    await writeThread(home, "thread-a", [
      stored("tail", 2, "a1"),
      stored("grew", 1, "u1"),
      stored("one", 1, "u1")
    ]);
    await writeThread(home, "thread-healthy", [stored("healthy", 2, "a1")]);

    await runThreadOutdated({ root, home, profile: "personal" });

    expect(logs).toEqual([
      "thread-a\tclaude-code:grew\tgrew\t2 messages behind",
      "thread-a\tclaude-code:one\tgrew\t1 message behind",
      "thread-a\tclaude-code:tail\ttail changed\tnot quantifiable"
    ]);

    logs.length = 0;
    const healthyFixture = await setupIntegrationFixture();
    await writeClaudeTranscript(healthyFixture.home, "only-healthy", ["u1", "a1"]);
    await writeThread(healthyFixture.home, "healthy", [stored("only-healthy", 2, "a1")]);
    await runThreadOutdated({
      root: healthyFixture.root,
      home: healthyFixture.home,
      profile: "personal"
    });
    expect(logs).toEqual([]);
  });

  it("emits the stable JSON collection, including an empty collection", async () => {
    captureConsole();
    const { root, home } = await setupIntegrationFixture();

    await runThreadOutdated({ root, home, profile: "personal", json: true });

    expect(JSON.parse(logs[0]!)).toEqual({ threads: [] });
  });

  it("emits structured growth and tail changes without changing thread state", async () => {
    captureConsole();
    const { root, home } = await setupIntegrationFixture();
    await writeClaudeTranscript(home, "grew", ["u1", "a1", "u2"]);
    await writeClaudeTranscript(home, "tail", ["u1", "replacement"]);
    await writeThread(home, "thread-a", [stored("grew", 1, "u1"), stored("tail", 2, "a1")]);
    const paths = testRuntimePaths(home, root);
    const manifestPath = path.join(home, ".mindframe-z", "threads", "thread-a", "manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");

    await runThreadOutdated({ root, home, profile: "personal", json: true });

    expect(JSON.parse(logs[0]!)).toEqual({
      threads: [
        {
          slug: "thread-a",
          sessions: [
            { source: "claude-code", id: "grew", change: "grew", behind_messages: 2 },
            { source: "claude-code", id: "tail", change: "tail_changed", behind_messages: null }
          ]
        }
      ]
    });
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
    await expect(
      readFile(path.join(threadSweepRoot(paths), "ledger.json"), "utf8")
    ).rejects.toThrow();
  });

  it("runs through the CLI without creating operational or domain state", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    await writeClaudeTranscript(home, "session", ["u1", "a1", "u2"]);
    await writeThread(home, "thread", [stored("session", 1, "u1")]);
    const paths = testRuntimePaths(home, root);
    const manifestPath = path.join(home, ".mindframe-z", "threads", "thread", "manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");

    const result = await cli("mfz", root, home, ["thread", "outdated", "--json"]);

    expect(JSON.parse(result.stdout)).toEqual({
      threads: [
        {
          slug: "thread",
          sessions: [{ source: "claude-code", id: "session", change: "grew", behind_messages: 2 }]
        }
      ]
    });
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
    for (const statePath of [
      threadCliLogPath(paths),
      threadRunsRoot(paths),
      threadSweepRoot(paths),
      threadDestinationRoot(paths, "personal")
    ]) {
      await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("fails through the CLI when the thread store cannot be enumerated", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = testRuntimePaths(home, root);
    await mkdir(path.dirname(threadStoreRoot(paths)), { recursive: true });
    await writeFile(threadStoreRoot(paths), "not a directory\n", "utf8");

    await expect(cli("mfz", root, home, ["thread", "outdated", "--json"])).rejects.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Error")
    });
  });

  it("fails through the CLI when an individual thread manifest is malformed", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = testRuntimePaths(home, root);
    const invalidDir = path.join(threadStoreRoot(paths), "invalid");
    await mkdir(invalidDir, { recursive: true });
    await writeFile(path.join(invalidDir, "manifest.json"), "not json\n", "utf8");

    await expect(cli("mfz", root, home, ["thread", "outdated", "--json"])).rejects.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Error")
    });
  });
});
