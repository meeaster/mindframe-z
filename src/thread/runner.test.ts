import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRuntimePaths } from "../core/paths.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  buildHarnessCommand,
  credentialMountArgsForTest,
  emitLapdogCostSpan,
  lapdogDockerArgs,
  parseHarnessResult,
  sessionStoreMountArgsForTest,
  skillMountArgsForTest,
  type AgentRunRequest,
  type AgentRunResult
} from "./runner.js";

describe("thread runner", () => {
  it("builds Claude Code args with JSON streaming and write tools denied", () => {
    const command = buildHarnessCommand({
      role: "gather",
      harness: "claude-code",
      model: "haiku",
      effort: "low",
      persona: "gatherer.",
      skills: ["claude-code-sessions"],
      prompt: "read session"
    });

    expect(command.tool).toBe("claude");
    expect(command.args).toContain("stream-json");
    expect(command.args).toContain("--disallowedTools");
    expect(command.args).toContain("Edit");
    expect(command.args).toContain("Write");
    expect(command.args).toContain("Bash(sqlite3:*)");
    expect(command.args).toContain("/mnt/claude-sessions");
    expect(command.args).toContain("/mnt/opencode-data");
    expect(command.args.join("\n")).toContain("/mnt/claude-sessions");
    expect(command.env).toEqual({});
    expect(command.args).toContain("--effort");
  });

  it("tells Claude Code to read the non-standard OpenCode database with sqlite3", () => {
    const command = buildHarnessCommand({
      role: "discover",
      harness: "claude-code",
      model: "haiku",
      persona: "discover.",
      skills: ["opencode-sessions"],
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
    const result = parseHarnessResult(
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

  it("parses OpenCode text and per-step usage from JSONL", () => {
    const result = parseHarnessResult(
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

  it("mounts only requested skills read-only at runtime", () => {
    const paths = createRuntimePaths({ root: "/repo", home: "/home/test" });

    expect(skillMountArgsForTest(paths, ["claude-code-sessions"])).toEqual([
      "--volume",
      "/repo/skills/claude-code-sessions:/home/sandbox/.claude/skills/claude-code-sessions:ro",
      "--volume",
      "/repo/skills/claude-code-sessions:/home/sandbox/.agents/skills/claude-code-sessions:ro"
    ]);
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

describe("emitLapdogCostSpan", () => {
  const baseRequest: AgentRunRequest = {
    role: "discover",
    harness: "claude-code",
    model: "claude-sonnet-4-6",
    persona: "p.",
    skills: [],
    prompt: "hi"
  };
  const baseResult: AgentRunResult = {
    text: "x",
    rawTrace: "{}",
    durationMs: 100,
    rawUsage: { input_tokens: 10, output_tokens: 5 },
    usage: {
      cost_usd: 0.01,
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: null
    }
  };

  it("is a no-op when lapdog is not reachable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      emitLapdogCostSpan(false, baseRequest, baseResult, 1_000)
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POSTs a cost span to localhost:8126 when lapdog is reachable", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([String(input), init ?? {}]);
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await emitLapdogCostSpan(true, baseRequest, baseResult, 1_000);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe("http://localhost:8126/v0.4/traces");
    expect(init.body).toBeInstanceOf(Uint8Array);
    vi.unstubAllGlobals();
  });

  it("swallows fetch errors (fail-open) and resolves to undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await expect(emitLapdogCostSpan(true, baseRequest, baseResult, 1_000)).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("does not POST when rawUsage has no token fields (metrics would be empty)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result: AgentRunResult = { ...baseResult, rawUsage: {} };
    await emitLapdogCostSpan(true, baseRequest, result, 1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
