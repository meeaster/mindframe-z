import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AGENT_TASK_CONFIG_RELATIVE_PATH,
  AGENT_TASK_GLOBAL_CONFIG_RELATIVE_PATH,
  buildDelegatedPromptBody,
  buildChildSessionPermissions,
  buildToolOverrides,
  canAgentUseTask,
  parseAvailableModels,
  extractDelegatedText,
  formatDelegatedResult,
  loadAgentTaskConfig,
  loadAgentTaskConfigWithSource,
  normalizeOptionalStringArg,
  parseAgentTaskConfig,
  parseModel,
  checkModelAvailability,
  resolveAgentTaskConfigPaths,
  resolveAgentDefault,
  resolveDelegatedModelSelection,
  resolveCallableAgent,
  resolveGlobalAgentTaskConfigPath,
  resolveLogicalModel,
  resolveProjectAgentTaskConfigPath,
  resolveVariant,
  validateModelSelection
} from "./logic.js";

describe("resolveCallableAgent", () => {
  it("accepts built-in callable agent", () => {
    const result = resolveCallableAgent(
      [
        { name: "general", mode: "subagent", permission: [] },
        { name: "primary", mode: "primary" }
      ],
      "general"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("general");
    }
  });

  it("accepts callable .opencode/agents entries", () => {
    const result = resolveCallableAgent(
      [
        { name: "local-doc-writer", mode: "subagent", permission: [] },
        { name: "planner", mode: "subagent", permission: [] }
      ],
      "local-doc-writer"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("local-doc-writer");
    }
  });

  it("rejects unknown agent", () => {
    const result = resolveCallableAgent(
      [{ name: "general", mode: "subagent", permission: [] }],
      "missing"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Unknown agent/);
    }
  });

  it("rejects primary agent", () => {
    const result = resolveCallableAgent(
      [
        { name: "general", mode: "subagent", permission: [] },
        { name: "planner", mode: "primary" }
      ],
      "planner"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/primary agent/);
    }
  });
});

describe("validateModelSelection", () => {
  it("handles allowlist success and failures", () => {
    const models = [
      {
        name: "gpt-5.4",
        variants: ["low", "medium", "high"],
        default_variant: "medium",
        providers: ["github-copilot/gpt-5.4", "openai/gpt-5.4"]
      },
      {
        name: "gpt-5.4-codex",
        variants: ["medium"],
        default_variant: undefined,
        providers: ["openai/gpt-5.4-codex"]
      }
    ];

    expect(validateModelSelection(models, "github-copilot/gpt-5.4", undefined).ok).toBe(true);

    const unsupportedModel = validateModelSelection(models, "openai/gpt-4o", undefined);
    expect(unsupportedModel.ok).toBe(false);
    if (!unsupportedModel.ok) {
      expect(unsupportedModel.error).toMatch(/Unsupported model/);
    }

    const unsupportedVariant = validateModelSelection(models, "github-copilot/gpt-5.4", "xhigh");
    expect(unsupportedVariant.ok).toBe(false);
    if (!unsupportedVariant.ok) {
      expect(unsupportedVariant.error).toMatch(/Unsupported variant/);
    }

    const missingConfig = validateModelSelection([], "github-copilot/gpt-5.4", undefined);
    expect(missingConfig.ok).toBe(false);
    if (!missingConfig.ok) {
      expect(missingConfig.error).toMatch(/Missing models/);
    }
  });
});

describe("resolveVariant", () => {
  it("uses explicit variant or model default", () => {
    const models = [
      {
        name: "gpt-5.4",
        variants: ["medium", "high"],
        default_variant: "medium",
        providers: ["github-copilot/gpt-5.4", "openai/gpt-5.4"]
      },
      {
        name: "gpt-5.3-codex",
        variants: ["high", "xhigh"],
        default_variant: undefined,
        providers: ["github-copilot/gpt-5.3-codex"]
      }
    ];

    expect(resolveVariant(models, "github-copilot/gpt-5.4", undefined)).toBe("medium");
    expect(resolveVariant(models, "github-copilot/gpt-5.4", "high")).toBe("high");
    expect(resolveVariant(models, "github-copilot/gpt-5.3-codex", undefined)).toBeUndefined();
  });
});

describe("resolveLogicalModel", () => {
  it("maps provider model back to logical model name", () => {
    const models = [
      {
        name: "gpt-5.4",
        variants: ["medium", "high"],
        default_variant: "medium",
        providers: ["github-copilot/gpt-5.4", "openai/gpt-5.4"]
      }
    ];

    expect(resolveLogicalModel(models, "github-copilot/gpt-5.4")).toBe("gpt-5.4");
    expect(resolveLogicalModel(models, "openai/gpt-5.4")).toBe("gpt-5.4");
    expect(resolveLogicalModel(models, "openai/gpt-4o")).toBeUndefined();
  });
});

describe("resolveAgentDefault", () => {
  it("finds a preferred model for an agent", () => {
    const defaults = [
      { name: "general", model: "gpt-5.4", variant: "medium" },
      { name: "planner", model: "gpt-5.4", variant: undefined }
    ];

    expect(resolveAgentDefault(defaults, "general")).toEqual(defaults[0]);
    expect(resolveAgentDefault(defaults, "missing")).toBeUndefined();
  });
});

describe("resolveDelegatedModelSelection", () => {
  it("uses agent defaults only when model is omitted", () => {
    const models = [
      {
        name: "gpt-5.4",
        variants: ["medium", "high"],
        default_variant: "medium",
        providers: ["github-copilot/gpt-5.4", "openai/gpt-5.4"]
      }
    ];

    const agentDefaults = [{ name: "general", model: "gpt-5.4", variant: "high" }];

    const defaultSelection = resolveDelegatedModelSelection({
      models,
      agentDefaults,
      availableModels: new Set(["github-copilot/gpt-5.4"]),
      agent: "general",
      model: undefined,
      variant: undefined
    });
    expect(defaultSelection.ok).toBe(true);
    if (defaultSelection.ok) {
      expect(defaultSelection.value).toEqual({
        requestedModel: "gpt-5.4",
        resolvedModel: "github-copilot/gpt-5.4",
        variant: "high"
      });
    }

    const explicitSelection = resolveDelegatedModelSelection({
      models,
      agentDefaults,
      availableModels: new Set(["github-copilot/gpt-5.4"]),
      agent: "general",
      model: "openai/gpt-5.4",
      variant: undefined
    });
    expect(explicitSelection.ok).toBe(true);
    if (explicitSelection.ok) {
      expect(explicitSelection.value).toEqual({
        requestedModel: "gpt-5.4",
        resolvedModel: "openai/gpt-5.4",
        variant: "medium"
      });
    }
  });
});

describe("checkModelAvailability", () => {
  it("requires the exact provider model to exist in OpenCode", () => {
    expect(
      checkModelAvailability(new Set(["github-copilot/gpt-5.4"]), "github-copilot/gpt-5.4").ok
    ).toBe(true);

    const missing = checkModelAvailability(new Set(["github-copilot/gpt-5.4"]), "openai/gpt-5.4");
    expect(missing.ok).toBe(false);
  });
});

describe("parseAvailableModels", () => {
  it("keeps only exact provider model rows", () => {
    expect([
      ...parseAvailableModels("Models\n\x1b[32mgithub-copilot/gpt-5.4\x1b[0m\nopenai/gpt-5.4\n")
    ]).toEqual(["github-copilot/gpt-5.4", "openai/gpt-5.4"]);
  });
});

describe("normalizeOptionalStringArg", () => {
  it("rejects empty strings", () => {
    expect(normalizeOptionalStringArg(undefined, "model")).toEqual({
      ok: true,
      value: undefined
    });
    expect(normalizeOptionalStringArg(" github-copilot/gpt-5.4 ", "model")).toEqual({
      ok: true,
      value: "github-copilot/gpt-5.4"
    });

    const empty = normalizeOptionalStringArg("   ", "variant");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error).toMatch(/Invalid variant/);
    }
  });
});

describe("canAgentUseTask", () => {
  it("matches built-in task inheritance rule", () => {
    expect(
      canAgentUseTask({
        name: "general",
        permission: [{ permission: "task", pattern: "*", action: "allow" }]
      })
    ).toBe(true);
    expect(canAgentUseTask({ name: "general", permission: [] })).toBe(false);
  });
});

describe("buildChildSessionPermissions", () => {
  it("mirrors built-in task restrictions", () => {
    expect(
      buildChildSessionPermissions({
        allowTask: false,
        primaryTools: ["question"]
      })
    ).toEqual([
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "question", pattern: "*", action: "allow" }
    ]);
  });
});

describe("buildToolOverrides", () => {
  it("disables delegated tools during prompt", () => {
    expect(
      buildToolOverrides({
        allowTask: false,
        primaryTools: ["question"]
      })
    ).toEqual({
      todowrite: false,
      todoread: false,
      task: false,
      question: false
    });
  });
});

describe("parseAgentTaskConfig", () => {
  it("reads logical models with providers", () => {
    const config = parseAgentTaskConfig({
      models: [
        {
          name: "gpt-5.4",
          variants: ["medium", "high"],
          default_variant: "medium",
          providers: ["github-copilot/gpt-5.4", "openai/gpt-5.4"]
        },
        {
          name: "gpt-5.3-codex",
          variants: ["medium"],
          providers: ["github-copilot/gpt-5.3-codex"]
        }
      ],
      agents: [
        {
          name: "general",
          model: "gpt-5.4",
          variant: "high"
        }
      ]
    });

    expect(config.models.length).toBe(2);
    expect(config.agents).toEqual([
      {
        name: "general",
        model: "gpt-5.4",
        variant: "high"
      }
    ]);
    expect(config.models[0]?.name).toBe("gpt-5.4");
    expect(config.models[0]?.variants).toEqual(["medium", "high"]);
    expect(config.models[0]?.default_variant).toBe("medium");
    expect(config.models[0]?.providers).toEqual(["github-copilot/gpt-5.4", "openai/gpt-5.4"]);
  });

  it("drops invalid default_variant entries", () => {
    const config = parseAgentTaskConfig({
      models: [
        {
          name: "gpt-5.4",
          variants: ["medium", "high"],
          default_variant: "xhigh",
          providers: ["github-copilot/gpt-5.4"]
        }
      ]
    });

    expect(config.models).toEqual([]);
  });
});

describe("loadAgentTaskConfig", () => {
  it("reads .opencode/agent-task.json from project directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-task-config-"));
    const opencodeDir = path.join(directory, ".opencode");
    const root = path.join(directory, "xdg");
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      path.join(directory, AGENT_TASK_CONFIG_RELATIVE_PATH),
      JSON.stringify({
        models: [
          {
            name: "gpt-5.4",
            variants: ["medium", "high"],
            default_variant: "medium",
            providers: ["github-copilot/gpt-5.4", "openai/gpt-5.4"]
          }
        ]
      })
    );

    const config = await loadAgentTaskConfig(directory, {
      ...process.env,
      XDG_CONFIG_HOME: root
    });
    expect(config.models).toEqual([
      {
        name: "gpt-5.4",
        variants: ["medium", "high"],
        default_variant: "medium",
        providers: ["github-copilot/gpt-5.4", "openai/gpt-5.4"]
      }
    ]);
  });

  it("returns empty allowlist when file is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-task-missing-"));
    const config = await loadAgentTaskConfig(directory, {
      ...process.env,
      XDG_CONFIG_HOME: path.join(directory, "xdg")
    });
    expect(config.models).toEqual([]);
  });
});

describe("resolveAgentTaskConfigPaths", () => {
  it("prefers global before project", async () => {
    const directory = "/tmp/project";
    const env = { ...process.env, XDG_CONFIG_HOME: "/tmp/xdg" };
    expect(resolveAgentTaskConfigPaths(directory, env)).toEqual([
      "/tmp/xdg/opencode/agent-task.json",
      path.join(directory, ".opencode", "agent-task.json")
    ]);
    expect(resolveGlobalAgentTaskConfigPath(env)).toBe("/tmp/xdg/opencode/agent-task.json");
    expect(resolveProjectAgentTaskConfigPath(directory)).toBe(
      path.join(directory, ".opencode", "agent-task.json")
    );
  });
});

describe("loadAgentTaskConfigWithSource", () => {
  it("reads global config from XDG path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-task-home-"));
    const directory = await mkdtemp(path.join(tmpdir(), "agent-task-project-"));
    const root = path.join(home, "xdg");
    const file = path.join(root, "opencode", AGENT_TASK_GLOBAL_CONFIG_RELATIVE_PATH);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        models: [
          {
            name: "gpt-5.4",
            providers: ["github-copilot/gpt-5.4"]
          }
        ]
      })
    );

    const result = await loadAgentTaskConfigWithSource(directory, {
      ...process.env,
      XDG_CONFIG_HOME: root
    });

    expect(result.path).toBe(file);
    expect(result.config.models).toEqual([
      {
        name: "gpt-5.4",
        variants: undefined,
        default_variant: undefined,
        providers: ["github-copilot/gpt-5.4"]
      }
    ]);
  });

  it("falls back to project config when global is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-task-fallback-"));
    await mkdir(path.join(directory, ".opencode"), { recursive: true });
    await writeFile(
      path.join(directory, AGENT_TASK_CONFIG_RELATIVE_PATH),
      JSON.stringify({
        models: [
          {
            name: "gpt-5.3-codex",
            providers: ["openai/gpt-5.3-codex"]
          }
        ]
      })
    );

    const result = await loadAgentTaskConfigWithSource(directory, {
      ...process.env,
      XDG_CONFIG_HOME: path.join(directory, "missing-xdg")
    });

    expect(result.path).toBe(path.join(directory, AGENT_TASK_CONFIG_RELATIVE_PATH));
    expect(result.config.models).toEqual([
      {
        name: "gpt-5.3-codex",
        variants: undefined,
        default_variant: undefined,
        providers: ["openai/gpt-5.3-codex"]
      }
    ]);
  });

  it("prefers global config when both exist", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-task-both-"));
    const root = path.join(directory, "xdg");
    const globalFile = path.join(root, "opencode", AGENT_TASK_GLOBAL_CONFIG_RELATIVE_PATH);
    const projectFile = path.join(directory, AGENT_TASK_CONFIG_RELATIVE_PATH);
    await mkdir(path.dirname(globalFile), { recursive: true });
    await mkdir(path.dirname(projectFile), { recursive: true });
    await writeFile(
      globalFile,
      JSON.stringify({
        models: [{ name: "global", providers: ["github-copilot/gpt-5.4"] }]
      })
    );
    await writeFile(
      projectFile,
      JSON.stringify({
        models: [{ name: "project", providers: ["openai/gpt-5.4"] }]
      })
    );

    const result = await loadAgentTaskConfigWithSource(directory, {
      ...process.env,
      XDG_CONFIG_HOME: root
    });

    expect(result.path).toBe(globalFile);
    expect(result.config.models[0]?.name).toBe("global");
  });

  it("returns empty config with global path when neither file exists", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-task-empty-"));
    const root = path.join(directory, "xdg");
    const result = await loadAgentTaskConfigWithSource(directory, {
      ...process.env,
      XDG_CONFIG_HOME: root
    });

    expect(result.config.models).toEqual([]);
    expect(result.path).toBe(path.join(root, "opencode", AGENT_TASK_GLOBAL_CONFIG_RELATIVE_PATH));
  });
});

describe("buildDelegatedPromptBody", () => {
  it("forwards selected agent, model, and variant", () => {
    const body = buildDelegatedPromptBody({
      agent: "local-doc-writer",
      model: "openai/gpt-5.4",
      variant: "high",
      prompt: "Create migration guide"
    });

    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.value).toEqual({
        agent: "local-doc-writer",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        variant: "high",
        parts: [{ type: "text", text: "Create migration guide" }]
      });
    }
  });
});

describe("parseModel", () => {
  it("rejects malformed provider model strings", () => {
    expect(parseModel("")).toBeNull();
    expect(parseModel("gpt-5.4")).toBeNull();
    expect(parseModel("openai/gpt-5.4/mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4/mini"
    });
  });
});

describe("extractDelegatedText", () => {
  it("returns the last text part", () => {
    expect(
      extractDelegatedText({
        parts: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "first" },
          { type: "text", text: "final" }
        ]
      })
    ).toBe("final");
  });
});

describe("formatDelegatedResult", () => {
  it("mirrors task-style output envelope", () => {
    expect(
      formatDelegatedResult({
        sessionId: "ses_123",
        text: "hello world",
        requestedModel: "gpt-5.4",
        resolvedModel: "github-copilot/gpt-5.4",
        variant: "medium"
      })
    ).toBe(
      [
        "task_id: ses_123 (for resuming to continue this task if needed)",
        "requested_model: gpt-5.4",
        "resolved_model: github-copilot/gpt-5.4",
        "variant: medium",
        "",
        "<task_result>",
        "hello world",
        "</task_result>"
      ].join("\n")
    );
  });
});
