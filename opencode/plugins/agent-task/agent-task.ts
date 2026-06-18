import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import {
  type AgentInfo,
  type PermissionRule,
  type DelegatedPromptResult,
  buildChildSessionPermissions,
  buildDelegatedPromptBody,
  buildToolOverrides,
  canAgentUseTask,
  checkModelAvailability,
  extractDelegatedText,
  formatDelegatedResult,
  loadAgentTaskConfigWithSource,
  normalizeOptionalStringArg,
  parseAvailableModels,
  resolveAgentTaskConfigPaths,
  resolveCallableAgent,
  resolveDelegatedModelSelection,
  resolveModelByName,
  resolvePreferredProvider
} from "./logic.js";

type Shell = {
  cwd(directory: string): Shell;
  nothrow(): Shell;
  (
    strings: TemplateStringsArray,
    ...expressions: Array<string>
  ): {
    text(): Promise<string>;
  };
};

async function getConfig(directory: string) {
  return loadAgentTaskConfigWithSource(directory);
}

async function getAvailableModels($: Shell, directory: string): Promise<Set<string>> {
  const output = await $.cwd(directory).nothrow()`opencode models`.text();
  return parseAvailableModels(output);
}

async function getPrimaryTools(
  client: Record<string, unknown>,
  directory: string
): Promise<string[]> {
  const config = client.config as {
    get(input: { query?: { directory?: string } }): Promise<{
      data?: unknown;
    }>;
  };
  const result = await config.get({ query: { directory } });
  const experimental =
    result.data && typeof result.data === "object"
      ? (result.data as { experimental?: { primary_tools?: unknown } }).experimental
      : undefined;
  return Array.isArray(experimental?.primary_tools)
    ? experimental.primary_tools.filter((item): item is string => typeof item === "string")
    : [];
}

async function getCallableAgents(
  client: Record<string, unknown>,
  directory: string
): Promise<AgentInfo[]> {
  const app = client.app as {
    agents(input: { query: { directory: string } }): Promise<{
      data?: Array<{
        name?: string;
        mode?: string;
        permission?: unknown;
        tools?: Record<string, boolean>;
      }>;
      error?: unknown;
    }>;
  };
  const result = await app.agents({ query: { directory } });
  if (!result.data) {
    return [];
  }

  return result.data
    .filter((item) => typeof item.name === "string")
    .map((item) => item as unknown as AgentInfo);
}

export function createAgentTaskModelsTool(input: { $: Shell }): ToolDefinition {
  return tool({
    description:
      "List configured agent_task logical models, provider priority, default variants, and current OpenCode availability.",
    args: {},
    async execute(_, ctx) {
      const cfg = await getConfig(ctx.directory);
      const available = await getAvailableModels(input.$, ctx.directory);

      return JSON.stringify(
        {
          config: cfg.path,
          models: cfg.config.models.map((item) => ({
            name: item.name,
            variants: item.variants ?? [],
            default_variant: item.default_variant,
            providers: item.providers.map((provider) => ({
              model: provider,
              available: available.has(provider)
            })),
            preferred_available_provider:
              item.providers.find((provider) => available.has(provider)) ?? null
          })),
          agents: cfg.config.agents.map((item) => {
            const m = resolveModelByName(cfg.config.models, item.model);
            const resolvedProvider = m ? resolvePreferredProvider(m, available) : undefined;

            return {
              name: item.name,
              model: item.model,
              resolved_provider: resolvedProvider ?? null,
              variant: item.variant,
              available: resolvedProvider !== undefined && available.has(resolvedProvider)
            };
          })
        },
        null,
        2
      );
    }
  });
}

export function createAgentTaskTool(input: {
  client: Record<string, unknown>;
  $: Shell;
}): ToolDefinition {
  return tool({
    description:
      "Explicitly delegate to a callable OpenCode agent with optional model and variant overrides.",
    args: {
      description: tool.schema.string().describe("Short task description"),
      prompt: tool.schema.string().describe("Detailed task prompt for delegated execution"),
      agent: tool.schema
        .string()
        .describe("Callable OpenCode agent name (built-in or .opencode/agents)"),
      model: tool.schema
        .string()
        .optional()
        .describe("Optional exact provider/model string for delegated execution"),
      variant: tool.schema
        .string()
        .optional()
        .describe("Optional configured variant override for the delegated model"),
      task_id: tool.schema
        .string()
        .optional()
        .describe("Resume an existing delegated child session instead of creating a fresh one")
    },
    async execute(args, ctx) {
      const modelArg = normalizeOptionalStringArg(args.model, "model");
      if (!modelArg.ok) {
        return `Error: ${modelArg.error}`;
      }

      const variantArg = normalizeOptionalStringArg(args.variant, "variant");
      if (!variantArg.ok) {
        return `Error: ${variantArg.error}`;
      }

      const cfg = await getConfig(ctx.directory);
      const models = cfg.config.models;
      const agentDefaults = cfg.config.agents;
      const paths = resolveAgentTaskConfigPaths(ctx.directory);

      const available = await getAvailableModels(input.$, ctx.directory);

      const agents = await getCallableAgents(input.client, ctx.directory);
      const resolved = resolveCallableAgent(agents, args.agent);
      if (!resolved.ok) {
        return `Error: ${resolved.error}`;
      }

      const selection = resolveDelegatedModelSelection({
        models,
        agentDefaults,
        availableModels: available,
        agent: resolved.value.name,
        model: modelArg.value,
        variant: variantArg.value
      });
      if (!selection.ok) {
        return `Error: ${selection.error} Checked config files in order: ${paths.join(", ")}`;
      }

      const availability = checkModelAvailability(available, selection.value.resolvedModel);
      if (!availability.ok) {
        return `Error: ${availability.error}`;
      }

      const agentName = resolved.value.name;
      await ctx.ask({
        permission: "task",
        patterns: [agentName],
        always: ["*"],
        metadata: {
          description: args.description,
          agent: agentName,
          model: selection.value.resolvedModel,
          variant: selection.value.variant
        }
      });

      const primaryTools = await getPrimaryTools(input.client, ctx.directory);
      const allowTask = canAgentUseTask(resolved.value);

      const body = buildDelegatedPromptBody({
        agent: agentName,
        model: selection.value.resolvedModel,
        variant: selection.value.variant,
        prompt: args.prompt
      });
      if (!body.ok) {
        return `Error: ${body.error}`;
      }

      const clientSession = input.client.session as {
        get(input: { path: { id: string }; query?: { directory?: string } }): Promise<{
          data?: { id?: string };
          error?: unknown;
        }>;
        create(input: {
          body: {
            parentID: string;
            title: string;
            permission?: PermissionRule[];
          };
          query: { directory: string };
        }): Promise<{
          data?: { id: string };
          error?: unknown;
        }>;
        prompt(input: {
          path: { id: string };
          query?: { directory?: string };
          body: {
            agent: string;
            model: { providerID: string; modelID: string };
            variant?: string;
            tools?: Record<string, boolean>;
            parts: Array<{ type: "text"; text: string }>;
          };
        }): Promise<{
          data?: DelegatedPromptResult;
          error?: unknown;
        }>;
      };

      const found =
        args.task_id !== undefined
          ? await clientSession.get({
              path: { id: args.task_id },
              query: { directory: ctx.directory }
            })
          : undefined;
      let sessionId = found?.data?.id;

      if (sessionId === undefined) {
        const created = await clientSession.create({
          body: {
            parentID: ctx.sessionID,
            title: `${args.description} (@${agentName})`,
            permission: buildChildSessionPermissions({
              allowTask,
              primaryTools
            })
          },
          query: { directory: ctx.directory }
        });

        if (created.error || !created.data?.id) {
          return `Error: Failed to create delegated child session: ${String(created.error ?? "unknown error")}`;
        }

        sessionId = created.data.id;
      }

      if (sessionId === undefined) {
        return "Error: Failed to resolve delegated child session.";
      }

      const prompted = await clientSession.prompt({
        path: { id: sessionId },
        body: {
          agent: body.value.agent,
          model: body.value.model,
          ...(body.value.variant !== undefined ? { variant: body.value.variant } : {}),
          tools: buildToolOverrides({ allowTask, primaryTools }),
          parts: body.value.parts
        },
        query: { directory: ctx.directory }
      });

      if (prompted.error) {
        return `Error: Failed to prompt delegated session: ${String(prompted.error)}`;
      }

      const output = formatDelegatedResult({
        sessionId,
        text: extractDelegatedText(prompted.data),
        requestedModel: selection.value.requestedModel,
        resolvedModel: selection.value.resolvedModel,
        variant: selection.value.variant
      });

      ctx.metadata({
        title: args.description,
        metadata: {
          sessionId,
          agent: agentName,
          logicalModel: selection.value.requestedModel,
          model: selection.value.resolvedModel,
          variant: selection.value.variant,
          output
        }
      });

      return output;
    }
  });
}
