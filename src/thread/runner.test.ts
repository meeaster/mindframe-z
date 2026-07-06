import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimePaths } from "../core/paths.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  buildHarnessCommand,
  credentialMountArgsForTest,
  lapdogDockerArgs,
  parseHarnessResult,
  sessionStoreMountArgsForTest,
  skillMountArgsForTest,
  type AgentRunRequest
} from "./runner.js";

describe("thread runner", () => {
  it("builds Claude Code args with JSON streaming and write tools denied", () => {
    const command = buildHarnessCommand({
      role: "gather",
      harness: "claude-code",
      model: "haiku",
      effort: "low",
      persona: "gatherer.",
      skills: ["agent-sessions"],
      sessionSources: ["claude-code"],
      prompt: "read session"
    });

    expect(command.tool).toBe("claude");
    expect(command.args).toContain("stream-json");
    expect(command.args).toContain("--disallowedTools");
    expect(command.args).toContain("Edit");
    expect(command.args).toContain("Write");
    expect(command.args).toContain("Bash(sqlite3:*)");
    expect(command.args).toContain("Bash(find:*)");
    expect(command.args).toContain("/mnt/claude-sessions");
    expect(command.args).toContain("/mnt/opencode-data");
    expect(command.args.join("\n")).toContain("/mnt/claude-sessions");
    expect(command.env).toEqual({ CLAUDE_SESSIONS_DIR: "/mnt/claude-sessions" });
    expect(command.args).toContain("--effort");
  });

  it("points the gather at the mounted store root, never the writable ~/.claude", () => {
    const command = buildHarnessCommand({
      role: "gather",
      harness: "claude-code",
      model: "haiku",
      effort: "low",
      persona: "gatherer.",
      skills: ["agent-sessions"],
      sessionSources: ["claude-code"],
      prompt: "read session"
    });

    const prompt = command.args.join("\n");
    expect(command.env.CLAUDE_SESSIONS_DIR).toBe("/mnt/claude-sessions");
    expect(prompt).toContain("mounted read-only at /mnt/claude-sessions");
    expect(prompt).toContain("Do not rely on expanding `$CLAUDE_SESSIONS_DIR`");
    expect(prompt).toContain("holds none of the sessions you are searching");
    expect(prompt).toContain("pre-authorized for this dispatch");
    expect(prompt).toContain("Never use the `Read` or `glob` tools on the store");
  });

  it("tells Claude Code to read the non-standard OpenCode database with sqlite3", () => {
    const command = buildHarnessCommand({
      role: "discover",
      harness: "claude-code",
      model: "haiku",
      persona: "discover.",
      skills: ["agent-sessions"],
      sessionSources: ["opencode"],
      prompt: "find opencode sessions"
    });

    expect(command.args.join("\n")).toContain("read it with sqlite3, never `opencode db`");
    expect(command.args.join("\n")).toContain("immutable=1");
  });

  it("builds OpenCode args with JSON output and readonly agent", () => {
    const command = buildHarnessCommand({
      role: "synthesize",
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
      persona: "synthesizer.",
      skills: ["thread-contract"],
      prompt: "write session"
    });

    expect(command.tool).toBe("opencode");
    expect(command.args).toContain("--format");
    expect(command.args).toContain("json");
    expect(command.args).toContain("--agent");
    expect(command.args).toContain("thread-readonly");
    expect(command.env).toEqual({ OPENCODE_DISABLE_AUTOCOMPACT: "true" });
  });

  it("parses Claude result cost and usage from JSONL", () => {
    const { result } = parseHarnessResult(
      "claude-code",
      JSON.stringify({
        type: "result",
        result: "final text",
        total_cost_usd: 0.12,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 }
      }),
      123
    );

    expect(result.text).toBe("final text");
    expect(result.usage).toEqual({
      cost_usd: 0.12,
      input_tokens: 15,
      output_tokens: 20,
      reasoning_tokens: null
    });
    expect(result.durationMs).toBe(123);
  });

  it("captures the Claude session_id so the cost span attributes to the real session", () => {
    const { result } = parseHarnessResult(
      "claude-code",
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-xyz" }),
        JSON.stringify({ type: "result", result: "done", session_id: "sess-xyz" })
      ].join("\n"),
      1
    );

    expect(result.sessionId).toBe("sess-xyz");
  });

  it("leaves sessionId undefined when no event carries one", () => {
    const { result } = parseHarnessResult(
      "claude-code",
      JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 1 } }),
      1
    );

    expect(result.sessionId).toBeUndefined();
  });

  it("parses OpenCode text and per-step usage from JSONL", () => {
    const { result } = parseHarnessResult(
      "opencode",
      [
        JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }),
        JSON.stringify({
          type: "step_finish",
          part: {
            type: "step-finish",
            cost: 0.2,
            tokens: { input: 1, output: 2, reasoning: 3 }
          }
        })
      ].join("\n"),
      234
    );

    expect(result.text).toBe("hello");
    expect(result.usage).toEqual({
      cost_usd: 0.2,
      input_tokens: 1,
      output_tokens: 2,
      reasoning_tokens: 3
    });
    expect(result.durationMs).toBe(234);
  });

  it("preserves the cache split in the token breakdown even when usage.input_tokens is summed", () => {
    const { breakdown } = parseHarnessResult(
      "claude-code",
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20
        }
      }),
      1
    );

    expect(breakdown).toEqual({
      nonCachedInput: 5,
      cacheReadInput: 10,
      cacheWriteInput: 20,
      output: 0
    });
  });

  it("mounts Claude credentials into the sandbox user home", async () => {
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(path.join(paths.claudeDir, ".credentials.json"), "{}\n", "utf8");

    await expect(credentialMountArgsForTest(paths, "claude-code")).resolves.toEqual([
      "--volume",
      `${path.join(paths.claudeDir, ".credentials.json")}:/home/sandbox/.claude/.credentials.json:ro`
    ]);
  });

  it("mounts the scoped AWS creds directory in bedrock mode instead of the OAuth token", async () => {
    const paths = createRuntimePaths({ root: "/repo", home: "/home/test" });

    await expect(
      credentialMountArgsForTest(paths, "claude-code", "/home/test/.mindframe-z/bedrock")
    ).resolves.toEqual(["--volume", "/home/test/.mindframe-z/bedrock:/home/sandbox/.aws:ro"]);
  });

  it("mounts requested skills from flat, nested, and co-located source layouts", async () => {
    const root = await makeTempDir();
    const paths = createRuntimePaths({ root, home: "/home/test" });
    const flat = path.join(root, "skills", "agent-sessions");
    const nested = path.join(root, "skills", "writing", "pr-writer");
    // thread-contract is an internal skill co-located with the threads source.
    const internal = path.join(root, "src", "thread", "thread-contract");
    await mkdir(flat, { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(internal, { recursive: true });
    await writeFile(path.join(flat, "SKILL.md"), "flat\n", "utf8");
    await writeFile(path.join(nested, "SKILL.md"), "nested\n", "utf8");
    await writeFile(path.join(internal, "SKILL.md"), "internal\n", "utf8");

    await expect(
      skillMountArgsForTest(paths, ["agent-sessions", "pr-writer", "thread-contract"])
    ).resolves.toEqual([
      "--volume",
      `${flat}:/home/sandbox/.claude/skills/agent-sessions:ro`,
      "--volume",
      `${flat}:/home/sandbox/.agents/skills/agent-sessions:ro`,
      "--volume",
      `${nested}:/home/sandbox/.claude/skills/pr-writer:ro`,
      "--volume",
      `${nested}:/home/sandbox/.agents/skills/pr-writer:ro`,
      "--volume",
      `${internal}:/home/sandbox/.claude/skills/thread-contract:ro`,
      "--volume",
      `${internal}:/home/sandbox/.agents/skills/thread-contract:ro`
    ]);
  });

  it("throws when a requested skill cannot be found", async () => {
    const root = await makeTempDir();
    const paths = createRuntimePaths({ root, home: "/home/test" });
    await mkdir(path.join(root, "skills"), { recursive: true });

    await expect(skillMountArgsForTest(paths, ["missing"])).rejects.toThrow(/missing/);
  });

  it("mounts host session files outside the writable Claude runtime home", async () => {
    const home = await makeTempDir();
    const xdg = await makeTempDir();
    const paths = createRuntimePaths({ root: process.cwd(), home });
    await mkdir(path.join(paths.claudeDir, "projects"), { recursive: true });
    await writeFile(path.join(paths.claudeDir, "history.jsonl"), "{}\n", "utf8");

    const oldXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdg;
    try {
      await expect(sessionStoreMountArgsForTest(paths)).resolves.toEqual([
        "--volume",
        `${path.join(paths.claudeDir, "history.jsonl")}:/mnt/claude-sessions/history.jsonl:ro`,
        "--volume",
        `${path.join(paths.claudeDir, "projects")}:/mnt/claude-sessions/projects:ro`
      ]);
    } finally {
      process.env.XDG_DATA_HOME = oldXdgDataHome;
    }
  });
});

describe("lapdogDockerArgs", () => {
  it("returns an empty arg list when lapdog is not reachable", () => {
    expect(lapdogDockerArgs(false)).toEqual([]);
  });

  it("injects the network and LAPDOG_URL env when lapdog is reachable", () => {
    const args = lapdogDockerArgs(true);
    expect(args).toEqual(["--network", "mfz-net", "--env", "LAPDOG_URL=http://lapdog:8126"]);
  });
});

describe("AgentRunResult shape", () => {
  it("does not leak rawUsage into the public result type", () => {
    const { result } = parseHarnessResult(
      "claude-code",
      JSON.stringify({ type: "result", result: "", usage: { input_tokens: 1 } }),
      1
    );
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["text", "rawTrace", "usage", "durationMs"])
    );
    expect("rawUsage" in result).toBe(false);
  });

  it("never returns a typed AgentRunRequest that still requires rawUsage", () => {
    const request: AgentRunRequest = {
      role: "discover",
      harness: "claude-code",
      model: "claude-sonnet-4-6",
      persona: "p.",
      skills: [],
      prompt: "hi"
    };
    expect(request).toBeDefined();
  });
});
