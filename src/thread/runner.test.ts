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
      skills: ["claude-code-sessions"],
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
    expect(command.env).toEqual({});
    expect(command.args).toContain("--effort");
  });

  it("forces the gather to read the Claude store via bash, never the Read tool", () => {
    const command = buildHarnessCommand({
      role: "gather",
      harness: "claude-code",
      model: "haiku",
      effort: "low",
      persona: "gatherer.",
      skills: ["claude-code-sessions"],
      prompt: "read session"
    });

    const prompt = command.args.join("\n");
    expect(prompt).toContain("pre-authorized for this dispatch");
    expect(prompt).toContain("Never use the `Read` or `glob` tools on `/mnt/claude-sessions`");
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
