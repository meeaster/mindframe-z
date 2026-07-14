import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimePaths } from "../core/paths.js";
import { readClaudeHistory } from "./claude-history.js";

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

describe("Claude context history", () => {
  it("deduplicates usage, separates listings from invocation, and excludes out-of-scope records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-claude-history-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-claude-history-home-"));
    const sibling = path.join(path.dirname(root), `${path.basename(root)}-sibling`);
    const project = path.join(home, ".claude", "projects", "encoded");
    const fallbackProject = path.join(home, ".claude", "projects", "fallback");
    await mkdir(path.join(project, "session-child", "subagents"), { recursive: true });
    await mkdir(fallbackProject, { recursive: true });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const record = (value: Record<string, unknown>) =>
      JSON.stringify({ cwd: root, timestamp: now, sessionId: "main", version: "2.1", ...value });
    const lines = [
      "not-json",
      record({
        type: "attachment",
        attachment: { type: "skill_listing", names: ["unused"], content: "listing" }
      }),
      record({
        type: "attachment",
        attachment: {
          type: "deferred_tools_delta",
          addedNames: ["deferred-search"],
          addedLines: ["one", "two"]
        }
      }),
      record({
        type: "attachment",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["docs"],
          addedBlocks: ["mcp instructions"]
        }
      }),
      record({
        type: "attachment",
        attachment: {
          type: "nested_memory",
          sourcePath: "/private/CLAUDE.md",
          content: "nested instructions"
        }
      }),
      record({
        type: "attachment",
        attachment: {
          type: "invoked_skills",
          skills: [{ name: "used", path: "/private/skill", content: "body" }]
        }
      }),
      record({
        type: "assistant",
        requestId: "request-1",
        message: {
          role: "assistant",
          id: "message-1",
          usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 2 },
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "used" } },
            { type: "tool_use", name: "mcp__docs__search", input: { secret: "hidden" } }
          ]
        }
      }),
      record({
        type: "assistant",
        requestId: "request-1",
        message: {
          role: "assistant",
          id: "message-1",
          usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 2 },
          content: [{ type: "text", text: "secret transcript" }]
        }
      }),
      record({
        type: "assistant",
        requestId: "request-output-only",
        message: { role: "assistant", usage: { output_tokens: 7 }, content: [] }
      }),
      record({ type: "system", subtype: "compact_boundary" }),
      JSON.stringify({
        cwd: sibling,
        timestamp: now,
        sessionId: "outside",
        type: "assistant",
        message: { role: "assistant", usage: { input_tokens: 100 } }
      })
    ];
    lines.push(
      JSON.stringify({
        cwd: root,
        timestamp: old,
        sessionId: "old",
        type: "assistant",
        message: { role: "assistant", usage: { input_tokens: 100 } }
      })
    );
    await writeFile(path.join(project, "main.jsonl"), `${lines.join("\n")}\n`, "utf8");
    await writeFile(
      path.join(project, "session-child", "subagents", "agent-1.jsonl"),
      `${record({ sessionId: "child", type: "assistant", requestId: "child-request", message: { role: "assistant", usage: { input_tokens: 1 }, content: [] } })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(project, "session-child", "subagents", "agent-2.jsonl"),
      `${record({ sessionId: "child", type: "assistant", requestId: "child-request", message: { role: "assistant", usage: { input_tokens: 1 }, content: [] } })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(fallbackProject, "fallback.jsonl"),
      [
        record({
          sessionId: "fallback-session",
          uuid: "fallback-uuid",
          type: "assistant",
          message: {
            role: "assistant",
            usage: { input_tokens: 1 },
            content: [{ type: "tool_use", name: "Skill", input: { skill: "used" } }]
          }
        }),
        record({
          sessionId: "fallback-session",
          type: "assistant",
          message: {
            role: "assistant",
            id: "fallback-message",
            usage: { input_tokens: 1 },
            content: [{ type: "tool_use", name: "Skill", input: { skill: "fallback" } }]
          }
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const transcript = path.join(project, "main.jsonl");
    const before = await stat(transcript);
    const history = await readClaudeHistory(paths(home), ["docs"], root, 1);
    const after = await stat(transcript);
    expect(history).toMatchObject({
      available: true,
      sessions: 4,
      childSessions: 2,
      modelRequests: 5,
      usageBearingRequests: 4,
      promptInputTokensWindowTotal: 18,
      outputTokens: 9,
      compactions: 1
    });
    expect(history.activations.find((entry) => entry.name === "unused")).toBeUndefined();
    expect(history.activations.find((entry) => entry.name === "used")).toMatchObject({
      count: 1,
      characters: 4
    });
    expect(
      history.activations
        .filter((entry) => entry.category === "skill" && entry.name === "used")
        .reduce((count, entry) => count + entry.count, 0)
    ).toBe(2);
    expect(history.activations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "deferred_tools_delta:deferred-search", count: 1 }),
        expect.objectContaining({ name: "deferred_tools_delta:lines", count: 2, characters: 6 }),
        expect.objectContaining({ name: "mcp_instructions_delta:blocks", characters: 16 }),
        expect.objectContaining({
          category: "instruction",
          source: "/private/CLAUDE.md",
          characters: 19
        })
      ])
    );
    expect(JSON.stringify(history)).not.toContain("secret");
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("reports a missing Claude store without failing static callers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-claude-missing-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-claude-missing-root-"));
    await expect(readClaudeHistory(paths(home), ["docs"], root, 1)).resolves.toMatchObject({
      available: false,
      unavailableReason: "Claude projects directory not found"
    });
  });
});
