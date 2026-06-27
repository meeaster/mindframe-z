import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// === Types ===

export type AgentInfo = {
  name: string;
  mode?: string;
  permission?: PermissionRule[] | Record<string, unknown>;
  tools?: Record<string, boolean>;
};

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
};

export type AllowedModel = {
  name: string;
  variants: string[] | undefined;
  default_variant: string | undefined;
  providers: string[];
};

export type AgentDefault = {
  name: string;
  model: string;
  variant: string | undefined;
};

export type AgentTaskConfig = {
  models: AllowedModel[];
  agents: AgentDefault[];
};

export type AgentTaskConfigLoadResult = {
  config: AgentTaskConfig;
  path: string;
};

export const AGENT_TASK_CONFIG_RELATIVE_PATH = ".opencode/agent-task.json";
export const AGENT_TASK_GLOBAL_CONFIG_RELATIVE_PATH = "agent-task.json";

export type DelegatedPromptBody = {
  agent: string;
  model: { providerID: string; modelID: string };
  variant: string | undefined;
  parts: Array<{ type: "text"; text: string }>;
};

export type DelegatedPromptResult = {
  parts: Array<{ type: string; text: string }> | undefined;
};

type OkResult<T> = { ok: true; value: T };
type ErrResult = { ok: false; error: string };
type Result<T> = OkResult<T> | ErrResult;

// === Logic / utility functions ===

export function resolveCallableAgent(list: AgentInfo[], name: string): Result<AgentInfo> {
  const match = list.find((item) => item.name === name);
  if (!match) {
    return {
      ok: false,
      error: `Unknown agent "${name}". Choose a callable agent discovered by OpenCode.`
    };
  }

  if (match.mode === "primary") {
    return {
      ok: false,
      error: `Agent "${name}" is a primary agent. Only callable non-primary agents are supported.`
    };
  }

  return { ok: true, value: match };
}

export function validateModelSelection(
  models: AllowedModel[],
  model: string,
  variant: string | undefined
): { ok: true } | { ok: false; error: string } {
  if (!models.length) {
    return {
      ok: false,
      error: "Missing models configuration. Add at least one model entry before using agent_task."
    };
  }

  const match = models.find((item) => item.providers.includes(model));
  if (!match) {
    return {
      ok: false,
      error: `Unsupported model "${model}". Add it to a model's providers list.`
    };
  }

  if (variant === undefined) {
    return { ok: true };
  }

  if (match.variants === undefined || !match.variants.includes(variant)) {
    return {
      ok: false,
      error: `Unsupported variant "${variant}" for model "${model}". Configure it on the matching model entry.`
    };
  }

  return { ok: true };
}

export function resolveVariant(
  models: AllowedModel[],
  model: string,
  variant: string | undefined
): string | undefined {
  if (variant !== undefined) {
    return variant;
  }

  return models.find((item) => item.providers.includes(model))?.default_variant;
}

export function resolveLogicalModel(models: AllowedModel[], model: string): string | undefined {
  return models.find((item) => item.providers.includes(model))?.name;
}

export function resolveModelByName(models: AllowedModel[], name: string): AllowedModel | undefined {
  return models.find((item) => item.name === name);
}

export function resolvePreferredProvider(
  model: AllowedModel,
  available: Set<string> | undefined
): string | undefined {
  return model.providers.find((provider) => available?.has(provider)) ?? model.providers[0];
}

export function resolveAgentDefault(
  agentDefaults: AgentDefault[],
  name: string
): AgentDefault | undefined {
  return agentDefaults.find((item) => item.name === name);
}

export function parseAvailableModels(output: string): Set<string> {
  const ansiColorPattern = new RegExp(`${String.fromCharCode(27)}\\[\\d*;?\\d*m`, "g");

  return new Set(
    output
      .split("\n")
      .map((item) => item.replace(ansiColorPattern, "").trim())
      .filter((item) => parseModel(item) !== null)
  );
}

export function canAgentUseTask(agent: AgentInfo): boolean {
  if (Array.isArray(agent.permission)) {
    return agent.permission.some((rule) => rule.permission === "task" && rule.action !== "deny");
  }

  return agent.tools?.task ?? false;
}

export function buildChildSessionPermissions(input: {
  allowTask: boolean;
  primaryTools: string[] | undefined;
}): PermissionRule[] {
  return [
    {
      permission: "todowrite",
      pattern: "*",
      action: "deny"
    },
    {
      permission: "todoread",
      pattern: "*",
      action: "deny"
    },
    ...(input.allowTask ? [] : [{ permission: "task", pattern: "*", action: "deny" as const }]),
    ...(input.primaryTools ?? []).map((toolName) => ({
      permission: toolName,
      pattern: "*",
      action: "allow" as const
    }))
  ];
}

export function buildToolOverrides(input: {
  allowTask: boolean;
  primaryTools: string[] | undefined;
}): Record<string, boolean> {
  return {
    todowrite: false,
    todoread: false,
    ...(input.allowTask ? {} : { task: false }),
    ...Object.fromEntries((input.primaryTools ?? []).map((toolName) => [toolName, false]))
  };
}

export function checkModelAvailability(
  available: Set<string>,
  model: string
): { ok: true } | { ok: false; error: string } {
  if (available.has(model)) {
    return { ok: true };
  }

  return {
    ok: false,
    error: `Model "${model}" is configured for agent_task but is not currently available in OpenCode.`
  };
}

const modelEntrySchema = z
  .object({
    name: z.string().min(1),
    variants: z.array(z.string()).optional(),
    default_variant: z.string().optional(),
    providers: z.array(z.string()).min(1)
  })
  .refine(
    (model) =>
      model.default_variant === undefined ||
      (model.variants?.includes(model.default_variant) ?? false)
  );

const agentEntrySchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().optional()
});

const agentTaskConfigSchema = z.object({
  models: z.array(z.unknown()).default([]),
  agents: z.array(z.unknown()).default([])
});

export function parseAgentTaskConfig(input: unknown): AgentTaskConfig {
  const parsed = agentTaskConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { models: [], agents: [] };
  }

  const models: AllowedModel[] = parsed.data.models.flatMap((item) => {
    const model = modelEntrySchema.safeParse(item);
    if (!model.success) return [];
    return [
      {
        name: model.data.name,
        variants: model.data.variants,
        default_variant: model.data.default_variant,
        providers: model.data.providers
      }
    ];
  });

  const agents: AgentDefault[] = parsed.data.agents.flatMap((item) => {
    const agent = agentEntrySchema.safeParse(item);
    if (!agent.success) return [];
    return [
      {
        name: agent.data.name,
        model: agent.data.model,
        variant: agent.data.variant
      }
    ];
  });

  return { models, agents };
}

export function resolveGlobalAgentTaskConfigPath(env = process.env): string {
  const root = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(root, "opencode", AGENT_TASK_GLOBAL_CONFIG_RELATIVE_PATH);
}

export function resolveProjectAgentTaskConfigPath(directory: string): string {
  return path.join(directory, AGENT_TASK_CONFIG_RELATIVE_PATH);
}

export function resolveAgentTaskConfigPaths(directory: string, env = process.env): string[] {
  return [resolveGlobalAgentTaskConfigPath(env), resolveProjectAgentTaskConfigPath(directory)];
}

async function canRead(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function loadAgentTaskConfigWithSource(
  directory: string,
  env = process.env
): Promise<AgentTaskConfigLoadResult> {
  const paths = resolveAgentTaskConfigPaths(directory, env);

  for (const file of paths) {
    if (!(await canRead(file))) {
      continue;
    }

    try {
      const raw = await readFile(file, "utf8");
      return {
        config: parseAgentTaskConfig(JSON.parse(raw)),
        path: file
      };
    } catch {
      return { config: { models: [], agents: [] }, path: file };
    }
  }

  return {
    config: { models: [], agents: [] },
    path: paths[0]!
  };
}

export async function loadAgentTaskConfig(
  directory: string,
  env = process.env
): Promise<AgentTaskConfig> {
  return (await loadAgentTaskConfigWithSource(directory, env)).config;
}

export function parseModel(value: string): { providerID: string; modelID: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return null;
  }

  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1)
  };
}

export function normalizeOptionalStringArg(
  value: string | undefined,
  name: string
): Result<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const normalized = value.trim();
  if (!normalized) {
    return {
      ok: false,
      error: `Invalid ${name}. Omit it or pass a non-empty string.`
    };
  }

  return { ok: true, value: normalized };
}

export function buildDelegatedPromptBody(input: {
  agent: string;
  model: string;
  variant: string | undefined;
  prompt: string;
}): Result<DelegatedPromptBody> {
  const parsedModel = parseModel(input.model);
  if (!parsedModel) {
    return {
      ok: false,
      error: `Invalid model "${input.model}". Use provider/model format.`
    };
  }

  return {
    ok: true,
    value: {
      agent: input.agent,
      model: parsedModel,
      variant: input.variant,
      parts: [{ type: "text", text: input.prompt }]
    }
  };
}

export type DelegatedSelectionInput = {
  models: AllowedModel[];
  agentDefaults: AgentDefault[];
  availableModels: Set<string> | undefined;
  agent: string;
  model: string | undefined;
  variant: string | undefined;
};

export function resolveDelegatedModelSelection(input: DelegatedSelectionInput): Result<{
  requestedModel: string | undefined;
  resolvedModel: string;
  variant: string | undefined;
}> {
  const agentDefault =
    input.model !== undefined ? undefined : resolveAgentDefault(input.agentDefaults, input.agent);
  const defaultModel = agentDefault
    ? resolveModelByName(input.models, agentDefault.model)
    : undefined;
  const resolvedModel =
    input.model ??
    (defaultModel !== undefined
      ? resolvePreferredProvider(defaultModel, input.availableModels)
      : undefined);

  if (resolvedModel === undefined) {
    return {
      ok: false,
      error: `No preferred model configured for agent "${input.agent}". Pass model explicitly or add an agents entry.`
    };
  }

  if (input.model === undefined && agentDefault !== undefined && defaultModel === undefined) {
    return {
      ok: false,
      error: `Agent "${input.agent}" references unknown model "${agentDefault.model}". Use a name from the models list.`
    };
  }

  const resolvedVariant =
    input.model !== undefined
      ? resolveVariant(input.models, resolvedModel, input.variant)
      : resolveVariant(input.models, resolvedModel, input.variant ?? agentDefault?.variant);
  const modelCheck = validateModelSelection(input.models, resolvedModel, resolvedVariant);
  if (!modelCheck.ok) {
    return modelCheck;
  }

  return {
    ok: true,
    value: {
      requestedModel:
        input.model !== undefined
          ? resolveLogicalModel(input.models, resolvedModel)
          : agentDefault?.model,
      resolvedModel,
      variant: resolvedVariant
    }
  };
}

export function extractDelegatedText(input: DelegatedPromptResult | undefined): string {
  if (!input?.parts) {
    return "";
  }

  for (let i = input.parts.length - 1; i >= 0; i -= 1) {
    const part = input.parts[i];
    if (part?.type === "text") {
      return part.text ?? "";
    }
  }

  return "";
}

export function formatDelegatedResult(input: {
  sessionId: string;
  text: string;
  requestedModel: string | undefined;
  resolvedModel: string | undefined;
  variant: string | undefined;
}): string {
  const lines = [`task_id: ${input.sessionId} (for resuming to continue this task if needed)`];

  if (input.requestedModel !== undefined) {
    lines.push(`requested_model: ${input.requestedModel}`);
  }

  if (input.resolvedModel !== undefined) {
    lines.push(`resolved_model: ${input.resolvedModel}`);
  }

  if (input.variant !== undefined) {
    lines.push(`variant: ${input.variant}`);
  }

  lines.push("", "<task_result>", input.text, "</task_result>");
  return lines.join("\n");
}
