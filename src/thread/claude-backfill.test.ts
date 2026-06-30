import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import { buildBackfillBodyForTest } from "./claude-backfill.js";

async function writeTranscript(
  projectsDir: string,
  encodedCwd: string,
  sessionId: string,
  lines: unknown[]
): Promise<string> {
  const dir = path.join(projectsDir, encodedCwd);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

describe("buildBackfillBody", () => {
  it("locates the transcript by session id under an opaque encoded-cwd dir", async () => {
    const projectsDir = await makeTempDir();
    await writeTranscript(projectsDir, "-home-mark-code-x", "sess-1", [
      { type: "user", cwd: "/home/mark/code/x", timestamp: "2026-06-30T00:00:00Z", message: {} },
      { type: "assistant", timestamp: "2026-06-30T00:00:01Z", message: { model: "m", usage: {} } }
    ]);

    const body = await buildBackfillBodyForTest(projectsDir, "sess-1");
    expect(body?.session_id).toBe("sess-1");
    expect(body?.cwd).toBe("/home/mark/code/x");
    expect(body?.entries).toHaveLength(2);
    expect(body?.subagents).toEqual([]);
  });

  it("bundles subagent transcripts found under <session-id>/subagents", async () => {
    const projectsDir = await makeTempDir();
    const encoded = "-repo";
    await writeTranscript(projectsDir, encoded, "sess-2", [
      { type: "user", cwd: "/repo", timestamp: "2026-06-30T00:00:00Z", message: {} }
    ]);
    const subDir = path.join(projectsDir, encoded, "sess-2", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      path.join(subDir, "agent-abc.jsonl"),
      JSON.stringify({ type: "user", message: { content: "do it" } }) + "\n",
      "utf8"
    );

    const body = await buildBackfillBodyForTest(projectsDir, "sess-2");
    expect(body?.subagents).toHaveLength(1);
    expect(body?.subagents[0]!.agent_id).toBe("agent-abc");
    expect(body?.subagents[0]!.entries).toHaveLength(1);
  });

  it("returns undefined when no transcript matches the session id", async () => {
    const projectsDir = await makeTempDir();
    await writeTranscript(projectsDir, "-x", "other", [
      { type: "user", timestamp: "2026-06-30T00:00:00Z", message: {} }
    ]);
    await expect(buildBackfillBodyForTest(projectsDir, "missing")).resolves.toBeUndefined();
  });

  it("skips truncated trailing lines from a partial flush at teardown", async () => {
    const projectsDir = await makeTempDir();
    const dir = path.join(projectsDir, "-x");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "sess-3.jsonl"),
      JSON.stringify({ type: "user", cwd: "/x", timestamp: "2026-06-30T00:00:00Z", message: {} }) +
        "\n" +
        '{"type":"assistant","timestamp":"2026-06', // truncated
      "utf8"
    );

    const body = await buildBackfillBodyForTest(projectsDir, "sess-3");
    expect(body?.entries).toHaveLength(1);
  });

  it("returns undefined for an empty transcript file", async () => {
    const projectsDir = await makeTempDir();
    const dir = path.join(projectsDir, "-x");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "sess-4.jsonl"), "", "utf8");
    await expect(buildBackfillBodyForTest(projectsDir, "sess-4")).resolves.toBeUndefined();
  });
});
