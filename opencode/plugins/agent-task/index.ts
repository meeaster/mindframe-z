import type { Plugin } from "@opencode-ai/plugin";
import { createAgentTaskModelsTool, createAgentTaskTool } from "./agent-task.js";

const AgentTaskPlugin: Plugin = async ({ client, $ }) => ({
  tool: {
    agent_task_models: createAgentTaskModelsTool({ $ }),
    agent_task: createAgentTaskTool({
      client: client as unknown as Record<string, unknown>,
      $
    })
  }
});

export default AgentTaskPlugin;
