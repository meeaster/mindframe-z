import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, testRuntimePaths } from "../../tests/integration/support.js";
import type { ResolvedProfile } from "../core/profile.js";
import { listOpencodeItems } from "../sessions/opencode-source.js";
import type { AgentRunner } from "./runner.js";
import {
  concludePending,
  enumerateSweepSessions,
  listPending,
  rejectPending,
  runSweep
} from "./sweep.js";
import { readSweepState, readVerdictLedger, writeSweepState } from "./verdicts.js";

function profile(quiescenceMinutes = 0): ResolvedProfile {
  return {
    profile: {
      thread: {
        defaults: { quiescence_minutes: quiescenceMinutes },
        credentials: "subscription"
      }
    }
  } as ResolvedProfile;
}

function runner(text: string, calls: string[] = []): AgentRunner {
  return {
    async run(request) {
      calls.push(request.prompt);
      return {
        text,
        rawTrace: JSON.stringify({ text }) + "\n",
        durationMs: 1,
        usage: {
          cost_usd: 0.01,
          input_tokens: null,
          output_tokens: null,
          reasoning_tokens: null
        }
      };
    }
  };
}

async function writeThread(
  home: string,
  slug: string,
  charter = "Track sweep work.",
  sessions: Array<{
    id: string;
    source: "claude-code" | "opencode";
    message_count?: number;
    last_message_id?: string;
    last_activity_at?: string;
  }> = []
): Promise<void> {
  const dir = path.join(home, ".mindframe-z", "threads", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        slug,
        charter,
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

async function writeClaudeSession(
  home: string,
  id: string,
  messageIds = ["u1", "a1"],
  mtime = new Date(Date.now() - 60 * 60_000)
): Promise<void> {
  const dir = path.join(home, ".claude", "projects", "-fixture");
  await mkdir(dir, { recursive: true });
  const lines = messageIds.map((uuid, index) => ({
    type: index % 2 === 0 ? "user" : "assistant",
    uuid,
    timestamp: new Date(1777414400000 + index * 1000).toISOString()
  }));
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  await utimes(file, mtime, mtime);
}

async function writeOpencodeDb(home: string): Promise<void> {
  const dir = path.join(home, ".local", "share", "opencode");
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL, parent_id TEXT)"
  );
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL)"
  );
  db.prepare("INSERT INTO session (id, time_updated, parent_id) VALUES (?, ?, ?)").run(
    "ses_parent",
    1000,
    null
  );
  db.prepare("INSERT INTO session (id, time_updated, parent_id) VALUES (?, ?, ?)").run(
    "ses_child",
    2000,
    "ses_parent"
  );
  db.prepare("INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)").run(
    "msg_1",
    "ses_parent",
    3000
  );
  db.prepare("INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)").run(
    "msg_2",
    "ses_child",
    4000
  );
  db.close();
}

describe("thread sweep", () => {
  it("enumerates source signals without standalone subagent or opencode child sessions", async () => {
    const home = await makeTempDir();
    await writeClaudeSession(home, "root-session");
    const subDir = path.join(home, ".claude", "projects", "-fixture", "root-session", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(subDir, "agent-a.jsonl"), "{}\n", "utf8");
    await writeOpencodeDb(home);

    const signals = await enumerateSweepSessions(testRuntimePaths(home));

    expect(signals.map((signal) => signal.id)).toEqual([
      "claude-code:root-session",
      "opencode:ses_parent"
    ]);
  });

  it("leaves backup OpenCode enumeration full-fidelity unless sweep asks for roots", async () => {
    const home = await makeTempDir();
    await writeOpencodeDb(home);

    const backupItems = await listOpencodeItems(testRuntimePaths(home));
    const signals = await enumerateSweepSessions(testRuntimePaths(home));

    expect(backupItems.map((item) => path.basename(item.relPath, ".json")).sort()).toEqual([
      "ses_child",
      "ses_parent"
    ]);
    expect(signals.map((signal) => signal.id)).toEqual(["opencode:ses_parent"]);
  });

  it("stakes the first baseline and does not triage pre-existing history", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeClaudeSession(home, "old-session");
    const calls: string[] = [];

    const report = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits matched", calls)
    });

    expect(report.baseline_staked).toBe(true);
    expect(report.triage_dispatches).toBe(0);
    expect(calls).toHaveLength(0);
    await expect(readSweepState(testRuntimePaths(home))).resolves.toMatchObject({
      baseline_at: report.baseline_at
    });
  });

  it("reports member drift even on the first baseline-staking sweep", async () => {
    const home = await makeTempDir();
    await writeClaudeSession(home, "member", ["u1", "a1"]);
    await writeThread(home, "thread-a", "Track members.", [
      {
        id: "member",
        source: "claude-code",
        message_count: 1,
        last_message_id: "u1",
        last_activity_at: "2020-01-01T00:00:00.000Z"
      }
    ]);

    const report = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("")
    });

    expect(report.drifted).toEqual([{ thread: "thread-a", id: "claude-code:member" }]);
  });

  it("gates member drift on the cheap source signal, not the transcript tail", async () => {
    const home = await makeTempDir();
    // Both members' pins are inconsistent with their on-disk transcripts (count 1 vs 2
    // messages), so a blind watermark read would flag both as drifted. Only the member
    // whose file mtime moved past its pin should be reported.
    await writeClaudeSession(home, "stale-member", ["u1", "a1"], new Date("2020-01-01T00:00:00Z"));
    await writeClaudeSession(home, "fresh-member", ["u1", "a1"], new Date());
    await writeThread(home, "thread-a", "Track members.", [
      {
        id: "stale-member",
        source: "claude-code",
        message_count: 1,
        last_message_id: "u1",
        last_activity_at: "2020-06-01T00:00:00.000Z"
      },
      {
        id: "fresh-member",
        source: "claude-code",
        message_count: 1,
        last_message_id: "u1",
        last_activity_at: "2020-06-01T00:00:00.000Z"
      }
    ]);

    const report = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("")
    });

    expect(report.drifted).toEqual([{ thread: "thread-a", id: "claude-code:fresh-member" }]);
  });

  it("triages a quiet post-baseline session once and derives pending proposals", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "new-session");
    const calls: string[] = [];

    const report = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits session matches", calls)
    });

    expect(report.proposals).toEqual([
      { id: "claude-code:new-session", thread: "thread-a", reason: "session matches" }
    ]);
    expect(calls).toHaveLength(1);
    await expect(listPending(testRuntimePaths(home))).resolves.toMatchObject([
      { id: "claude-code:new-session", thread: "thread-a", stale: false }
    ]);

    const threadManifestBefore = await readFile(
      path.join(home, ".mindframe-z", "threads", "thread-a", "manifest.json"),
      "utf8"
    );
    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits should not run", calls)
    });
    expect(calls).toHaveLength(1);
    await expect(
      readFile(path.join(home, ".mindframe-z", "threads", "thread-a", "manifest.json"), "utf8")
    ).resolves.toBe(threadManifestBefore);
  });

  it("reopens judgment for edited charters and includes new threads without special flags", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a", "Original charter.");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "new-session");
    const calls: string[] = [];

    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a no_fit not relevant", calls)
    });
    expect(calls).toHaveLength(1);

    await writeThread(home, "thread-a", "Changed charter.");
    await writeThread(home, "thread-b", "Brand new charter.");
    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a no_fit still not relevant\nthread-b fits new thread match", calls)
    });

    expect(calls).toHaveLength(2);
    expect(await listPending(testRuntimePaths(home))).toEqual([
      {
        id: "claude-code:new-session",
        thread: "thread-b",
        reason: "new thread match",
        stale: false
      }
    ]);
  });

  it("defers hot sessions without losing them", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "hot-session", ["u1", "a1"], new Date());
    const calls: string[] = [];

    const deferred = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(30),
      runner: runner("thread-a fits should wait", calls)
    });

    expect(deferred.deferred).toEqual([
      { id: "claude-code:hot-session", reason: "recent activity" }
    ]);
    expect(calls).toHaveLength(0);

    const included = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(30),
      includeHot: true,
      runner: runner("thread-a fits now judged", calls)
    });

    expect(included.proposals).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("contains malformed triage lines and records the well-formed verdicts", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "new-session");

    const report = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("not parseable\nthread-a no_fit weak signal")
    });

    expect(report.malformed).toEqual([
      { id: "claude-code:new-session", line: "claude-code:new-session: not parseable" }
    ]);
    const ledger = await readVerdictLedger(testRuntimePaths(home));
    expect(ledger.verdicts).toMatchObject([{ verdict: "no_fit", reason: "weak signal" }]);
    const runDirs = await readdir(path.join(home, ".mindframe-z", "thread-runs", "runs"));
    expect(runDirs).toHaveLength(1);
    await expect(
      readFile(
        path.join(home, ".mindframe-z", "thread-runs", "runs", runDirs[0]!, "triage.jsonl"),
        "utf8"
      )
    ).resolves.toContain("weak signal");
    await expect(
      readFile(
        path.join(home, ".mindframe-z", "thread-runs", "runs", runDirs[0]!, "status.json"),
        "utf8"
      )
    ).resolves.toContain('"current_step": "complete"');
  });

  it("reports missing and duplicate triage verdict lines as malformed", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeThread(home, "thread-b");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "new-session");

    const report = await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits first\nthread-a no_fit duplicate")
    });

    expect(report.proposals).toEqual([
      { id: "claude-code:new-session", thread: "thread-a", reason: "first" }
    ]);
    expect(report.malformed).toEqual([
      {
        id: "claude-code:new-session",
        line: "claude-code:new-session: duplicate verdict for thread-a: thread-a no_fit duplicate"
      },
      {
        id: "claude-code:new-session",
        line: "claude-code:new-session: missing verdict for thread-b"
      }
    ]);
  });

  it("flags stale pending proposals when the charter changes", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a", "Original charter.");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "new-session");
    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits original match")
    });

    await writeThread(home, "thread-a", "Changed charter.");

    await expect(listPending(testRuntimePaths(home))).resolves.toMatchObject([
      { id: "claude-code:new-session", thread: "thread-a", stale: true }
    ]);
  });

  it("reject suppresses future proposals until explicit ingest makes the row inert", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "noisy-session");
    await rejectPending(testRuntimePaths(home), "claude-code:noisy-session", "thread-a");
    const calls: string[] = [];

    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits should not run", calls)
    });

    expect(calls).toHaveLength(0);
    expect(await listPending(testRuntimePaths(home))).toEqual([]);

    await writeThread(home, "thread-a", "Track sweep work.", [
      { id: "noisy-session", source: "claude-code" }
    ]);
    expect(await listPending(testRuntimePaths(home))).toEqual([]);
  });

  it("reject fails for unknown threads", async () => {
    const home = await makeTempDir();

    await expect(
      rejectPending(testRuntimePaths(home), "claude-code:noisy-session", "missing-thread")
    ).rejects.toThrow("Unknown thread: missing-thread");
  });

  it("conclude passes current proposals and later growth reopens them", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "maybe-session", ["u1", "a1"]);
    const calls: string[] = [];

    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits maybe relevant", calls)
    });
    expect(await concludePending(testRuntimePaths(home))).toBe(1);
    expect(await listPending(testRuntimePaths(home))).toEqual([]);

    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits unchanged should not dispatch", calls)
    });
    expect(calls).toHaveLength(1);

    await writeClaudeSession(home, "maybe-session", ["u1", "a1", "u2"], new Date());
    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits grew", calls)
    });
    expect(calls).toHaveLength(2);
  });

  it("pending listing is repeatable and does not change the ledger", async () => {
    const home = await makeTempDir();
    await writeThread(home, "thread-a");
    await writeSweepState(testRuntimePaths(home), { baseline_at: "2020-01-01T00:00:00.000Z" });
    await writeClaudeSession(home, "new-session");
    await runSweep({
      paths: testRuntimePaths(home),
      profile: profile(),
      runner: runner("thread-a fits session matches")
    });
    const ledgerBefore = await readFile(
      path.join(home, ".mindframe-z", "thread-sweep", "ledger.json"),
      "utf8"
    );

    expect(await listPending(testRuntimePaths(home))).toEqual(
      await listPending(testRuntimePaths(home))
    );
    expect(
      await readFile(path.join(home, ".mindframe-z", "thread-sweep", "ledger.json"), "utf8")
    ).toBe(ledgerBefore);
  });
});
