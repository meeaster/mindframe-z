import process from "node:process";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";

const HOOK_URL = process.env.LAPDOG_URL ? `${process.env.LAPDOG_URL}/claude/hooks` : null;

const HOOK_TIMEOUT_MS = 2000;

type HookBody = {
  hook_event_name: string;
  session_id: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  status?: string;
  error?: unknown;
};

async function postHook(body: HookBody): Promise<void> {
  if (!HOOK_URL) return;
  try {
    await fetch(HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS)
    });
  } catch {
    // fail-open: a missing or slow lapdog must never affect a dispatch.
  }
}

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const permissionInputSchema = z
  .object({
    sessionID: z.string().optional(),
    tool: z.string().optional(),
    metadata: z.unknown().optional()
  })
  .passthrough();
const eventSchema = z
  .object({
    type: z.string().optional(),
    properties: z
      .object({
        sessionID: z.string().optional(),
        info: z.object({ id: z.string().optional() }).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

function permissionFields(input: z.input<typeof permissionInputSchema>) {
  const value = permissionInputSchema.parse(input);
  return {
    sessionID: value.sessionID ?? "unknown",
    tool: value.tool ?? "unknown",
    metadata: value.metadata
  };
}

const LIFECYCLE_EVENTS = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.idle",
  "session.status",
  "session.compacted"
]);

const LIFECYCLE_HOOK_NAME = new Map([
  ["session.created", "SessionStart"],
  ["session.updated", "Notification"],
  ["session.deleted", "SessionEnd"],
  ["session.idle", "Stop"],
  ["session.status", "Notification"],
  ["session.compacted", "PreCompact"]
]);

function sessionIdFromEvent(event: z.input<typeof eventSchema>): string {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return "unknown";
  return parsed.data.properties?.sessionID ?? parsed.data.properties?.info?.id ?? "unknown";
}

function eventType(event: z.input<typeof eventSchema>): string | undefined {
  const parsed = eventSchema.safeParse(event);
  return parsed.success ? parsed.data.type : undefined;
}

export default async function lapdogPlugin(_input: PluginInput): Promise<Hooks> {
  if (!HOOK_URL) return {};

  return {
    "tool.execute.before": async (input) => {
      await postHook({
        hook_event_name: "PreToolUse",
        session_id: input.sessionID,
        tool_name: input.tool,
        tool_use_id: input.callID
      });
    },

    "tool.execute.after": async (input, output) => {
      const metadata = z
        .object({ error: z.unknown().optional() })
        .passthrough()
        .parse(output.metadata ?? {});
      const failed = metadata.error !== undefined && metadata.error !== null;
      const hook: HookBody = {
        hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
        session_id: input.sessionID,
        tool_name: input.tool,
        tool_input: input.args,
        tool_use_id: input.callID,
        tool_response: output.output
      };
      if (failed) hook.error = metadata.error;
      await postHook(hook);
    },

    "chat.message": async (input, output) => {
      if (output.message.role !== "user") return;
      const text = (output.parts ?? [])
        .map((part) => {
          const parsed = textPartSchema.safeParse(part);
          return parsed.success ? parsed.data.text : "";
        })
        .join("");
      await postHook({
        hook_event_name: "UserPromptSubmit",
        session_id: input.sessionID,
        prompt: text || JSON.stringify(output.message)
      });
    },

    "permission.ask": async (input, output) => {
      const { sessionID, tool, metadata } = permissionFields(input);
      await postHook({
        hook_event_name: "PermissionRequest",
        session_id: sessionID,
        tool_name: tool,
        tool_input: metadata,
        status: output.status
      });
    },

    "experimental.session.compacting": async (input) => {
      await postHook({
        hook_event_name: "PreCompact",
        session_id: input.sessionID
      });
    },

    event: async (input) => {
      const type = eventType(input.event);
      if (!type || !LIFECYCLE_EVENTS.has(type)) return;
      const hookEvent = LIFECYCLE_HOOK_NAME.get(type);
      if (!hookEvent) return;
      await postHook({
        hook_event_name: hookEvent,
        session_id: sessionIdFromEvent(input.event)
      });
    }
  };
}
