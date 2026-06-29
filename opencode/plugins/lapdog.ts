import process from "node:process";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

const HOOK_URL = process.env.LAPDOG_URL ? `${process.env.LAPDOG_URL}/claude/hooks` : null;

const HOOK_TIMEOUT_MS = 2000;

async function postHook(body: Record<string, unknown>): Promise<void> {
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

function textPartText(part: unknown): string {
  if (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  ) {
    return (part as { text: string }).text;
  }
  return "";
}

function permissionFields(input: unknown): {
  sessionID: string;
  tool: string;
  metadata: unknown;
} {
  const value = input as { sessionID?: unknown; tool?: unknown; metadata?: unknown };
  return {
    sessionID: typeof value.sessionID === "string" ? value.sessionID : "unknown",
    tool: typeof value.tool === "string" ? value.tool : "unknown",
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

const LIFECYCLE_HOOK_NAME: Record<
  string,
  "SessionStart" | "SessionEnd" | "Stop" | "Notification" | "PreCompact"
> = {
  "session.created": "SessionStart",
  "session.updated": "Notification",
  "session.deleted": "SessionEnd",
  "session.idle": "Stop",
  "session.status": "Notification",
  "session.compacted": "PreCompact"
};

function sessionIdFromEvent(event: unknown): string {
  if (typeof event !== "object" || event === null) return "unknown";
  const properties = (event as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return "unknown";
  const props = properties as { sessionID?: unknown; info?: { id?: unknown } };
  if (typeof props.sessionID === "string") return props.sessionID;
  if (props.info && typeof props.info === "object" && typeof props.info.id === "string") {
    return props.info.id;
  }
  return "unknown";
}

function eventType(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
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
      const metadata = (output.metadata ?? {}) as { error?: unknown };
      const failed = metadata.error !== undefined && metadata.error !== null;
      await postHook({
        hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
        session_id: input.sessionID,
        tool_name: input.tool,
        tool_input: input.args,
        tool_use_id: input.callID,
        tool_response: output.output,
        ...(failed ? { error: metadata.error } : {})
      });
    },

    "chat.message": async (input, output) => {
      if (output.message.role !== "user") return;
      const text = (output.parts ?? []).map(textPartText).join("");
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
      const hookEvent = LIFECYCLE_HOOK_NAME[type];
      if (!hookEvent) return;
      await postHook({
        hook_event_name: hookEvent,
        session_id: sessionIdFromEvent(input.event)
      });
    }
  };
}
