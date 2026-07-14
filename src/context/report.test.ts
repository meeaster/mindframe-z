import { describe, expect, it } from "vitest";
import { buildHistory, type ContextReport } from "./model.js";
import { formatContextHistoryReport, formatContextReport } from "./report.js";

describe("context reports", () => {
  it("nests startup files and established MCP schemas under their phases", () => {
    const report: ContextReport = {
      profile: "test",
      inspectedDirectory: "/work",
      projectRoot: "/work",
      harnesses: [
        {
          harness: "opencode",
          scopeNotes: [],
          mcpServers: [{ name: "docs", enabled: true, loading: "per-step" }],
          contributors: [
            {
              category: "instruction",
              name: "base",
              loading: "startup",
              measurement: "estimated-tokens",
              estimatedTokens: 1_050
            },
            {
              category: "MCP tools",
              name: "docs",
              loading: "per-step",
              measurement: "unknown"
            },
            {
              category: "repository instruction",
              name: "nested",
              loading: "conditional:path",
              measurement: "estimated-tokens",
              estimatedTokens: 500
            }
          ],
          maxConditionalPath: {
            directory: "/work/nested",
            contributors: ["/work/nested/AGENTS.md"],
            estimatedTokens: 500
          }
        }
      ]
    };

    const output = formatContextReport(report);

    expect(output).toContain("Startup (~1.1k)");
    expect(output).toContain("Files (1 | ~1.1k)");
    expect(output).toContain("Conditional/nested excluded (1 | ~500)");
    expect(output).toContain("Per request (1 unmeasured)");
    expect(output).toContain("MCP servers (1 enabled)");
    expect(output).toContain("docs  enabled | schemas unmeasured (not probed)");
    expect(output).toContain("Maximum path: ~500 at ./nested");
    expect(output.indexOf("Startup (")).toBeLessThan(output.indexOf("Per request ("));
    expect(output).not.toContain("Instructions/indexes");
    expect(output).not.toContain("Notes:");
  });

  it("keeps skill body inventory inside Startup without counting it in the phase", () => {
    const report: ContextReport = {
      profile: "test",
      inspectedDirectory: "/work/project",
      projectRoot: "/work/project",
      homeDirectory: "/home/test",
      harnesses: [
        {
          harness: "opencode",
          scopeNotes: [],
          mcpServers: [],
          contributors: [
            {
              category: "skill catalogue",
              name: "local-skill",
              source: "/home/test/.agents/skills/local-skill/SKILL.md",
              loading: "startup",
              measurement: "estimated-tokens",
              estimatedTokens: 12
            },
            {
              category: "skill body",
              name: "local-skill",
              source: "/home/test/.agents/skills/local-skill/SKILL.md",
              loading: "conditional:invocation",
              measurement: "estimated-tokens",
              estimatedTokens: 100
            },
            {
              category: "skill catalogue",
              name: "project-skill",
              source: "/work/project/skills/project-skill/SKILL.md",
              loading: "startup",
              measurement: "estimated-tokens",
              estimatedTokens: 8
            },
            {
              category: "skill body",
              name: "project-skill",
              source: "/work/project/skills/project-skill/SKILL.md",
              loading: "conditional:invocation",
              measurement: "estimated-tokens",
              estimatedTokens: 60
            }
          ]
        }
      ]
    };

    const output = formatContextReport(report);

    expect(output).toContain("Startup (~20)");
    expect(output).toContain("Skills (2 skills | ~20 catalogue; ~160 body inventory excluded)");
    expect(output).toContain("~/.agents/skills/");
    expect(output).toContain("(1 skill | ~12 catalogue; ~100 body inventory excluded)");
    expect(output).toContain("local-skill  ~12 catalogue; ~100 body inventory on invocation");
    expect(output).toContain("./skills/");
    expect(output).toContain("project-skill  ~8 catalogue; ~60 body inventory on invocation");
    expect(output).not.toContain("/local-skill/SKILL.md");
  });

  it("shows unknown Claude MCP schemas as inventory excluded from Per request", () => {
    const report: ContextReport = {
      profile: "test",
      inspectedDirectory: "/work",
      harnesses: [
        {
          harness: "claude-code",
          scopeNotes: [],
          mcpServers: [
            { name: "disabled", enabled: false, loading: "unknown" },
            { name: "unknown-mcp", enabled: true, loading: "unknown" }
          ],
          contributors: [
            {
              category: "skill catalogue",
              name: "manual-only",
              source: "/home/test/.claude/skills/manual-only/SKILL.md",
              loading: "deferred",
              measurement: "unknown"
            },
            {
              category: "skill body",
              name: "manual-only",
              source: "/home/test/.claude/skills/manual-only/SKILL.md",
              loading: "conditional:invocation",
              measurement: "estimated-tokens",
              estimatedTokens: 20
            },
            {
              category: "MCP tools",
              name: "unknown-mcp",
              loading: "unknown",
              measurement: "unknown"
            }
          ]
        }
      ]
    };

    const output = formatContextReport(report);

    expect(output).toContain("Startup (none)");
    expect(output).toContain(
      "manual-only  not advertised catalogue; ~20 body inventory on invocation"
    );
    expect(output).not.toContain("Skills (1 skill | 1 unmeasured");
    expect(output).toContain(
      "Skills (1 skill | none catalogue; 1 not advertised; ~20 body inventory excluded)"
    );
    expect(output).toContain(
      "(1 skill | none catalogue; 1 not advertised; ~20 body inventory excluded)"
    );
    expect(output).toContain("Per request (not established)");
    expect(output).toContain(
      "MCP schema inventory (1 enabled; 1 disabled | loading unknown; excluded from Per request)"
    );
    expect(output).not.toContain("disabled  disabled");
    expect(output).toContain("1 schemas unmeasured (not probed); 1 unknown loading");
  });

  it("places probe measurements in their MCP section and preserves shared membership", () => {
    const report: ContextReport = {
      profile: "test",
      inspectedDirectory: "/work",
      mcpProbes: [
        {
          server: "docs",
          harnesses: ["opencode", "claude-code"],
          probe: {
            harness: "opencode",
            server: "docs",
            toolCount: 1,
            pages: 1,
            instructions: { characters: 26, bytes: 26, estimatedTokens: 7 },
            toolSchemas: { characters: 139, bytes: 139, estimatedTokens: 35 }
          }
        }
      ],
      harnesses: [
        {
          harness: "opencode",
          scopeNotes: [],
          mcpServers: [{ name: "docs", enabled: true, loading: "per-step" }],
          contributors: [
            {
              category: "MCP tools",
              name: "docs",
              loading: "per-step",
              measurement: "estimated-tokens",
              estimatedTokens: 35
            }
          ]
        },
        {
          harness: "claude-code",
          scopeNotes: [],
          mcpServers: [{ name: "docs", enabled: true, loading: "unknown" }],
          contributors: [
            {
              category: "MCP tools",
              name: "docs",
              loading: "unknown",
              measurement: "estimated-tokens",
              estimatedTokens: 35
            }
          ]
        }
      ]
    };

    const output = formatContextReport(report);

    expect(output).not.toContain("MCP probes");
    expect(output).toContain(
      "docs  enabled | 1 tool | schemas 139 chars (~35); instructions 26 chars (~7)"
    );
    expect(output).toContain(
      "server instructions are probe metadata; excluded from the phase baseline"
    );
    expect(output.match(/contacted servers are not sandboxed/g)).toHaveLength(1);
  });

  it("reports probe availability separately from unknown Claude loading", () => {
    const serverNames = Array.from({ length: 11 }, (_, index) => `server-${index + 1}`);
    const report: ContextReport = {
      profile: "test",
      inspectedDirectory: "/work",
      mcpProbes: serverNames.map((server, index) =>
        index < 9
          ? {
              server,
              harnesses: ["claude-code"],
              probe: {
                harness: "claude-code",
                server,
                toolCount: 2,
                pages: 1,
                instructions: { characters: 4, bytes: 4, estimatedTokens: 1 },
                toolSchemas: { characters: 8, bytes: 8, estimatedTokens: 2 }
              }
            }
          : { server, harnesses: ["claude-code"], unavailable: "unavailable" }
      ),
      harnesses: [
        {
          harness: "claude-code",
          scopeNotes: [],
          mcpServers: serverNames.map((name) => ({ name, enabled: true, loading: "unknown" })),
          contributors: []
        }
      ]
    };

    expect(formatContextReport(report)).toContain(
      "totals: 9 measured; 2 unavailable; 11 unknown loading"
    );
    expect(formatContextReport(report)).toContain("Per request (not established)");
    expect(formatContextReport(report)).toContain(
      "MCP schema inventory (11 enabled | loading unknown; excluded from Per request)"
    );
  });

  it("keeps history telemetry-only and concise", () => {
    const report: ContextReport = {
      profile: "test",
      inspectedDirectory: "/work",
      harnesses: [
        {
          harness: "opencode",
          scopeNotes: [],
          contributors: [],
          mcpServers: [],
          history: buildHistory(30, {
            sessions: 1,
            childSessions: 0,
            modelRequests: 2,
            usageBearingRequests: 1,
            uncachedInputTokens: 1_000,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
            promptInputTokensWindowTotal: 1_100,
            maxPromptInputTokens: 1_100,
            outputTokens: 1_000_000_000,
            compactions: 2,
            activations: [{ category: "skill", name: "used", count: 2 }],
            versions: ["1.0"]
          })
        }
      ]
    };

    const output = formatContextHistoryReport(report);

    expect(output).toContain("Telemetry only");
    expect(output).toContain("prompt traffic: 1.1k (1k uncached; 100 cache read; 0 cache write)");
    expect(output).toContain("output: 1b; compactions: 2");
    expect(output).toContain("activity: skill calls 2");
    expect(output).not.toContain("Instructions/indexes");
  });
});
