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

function sessionId(input: { sessionID: string }): string {
  return input.sessionID;
}

function sessionIdFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "sessionID" in value &&
    typeof (value as { sessionID: unknown }).sessionID === "string"
  ) {
    return (value as { sessionID: string }).sessionID;
  }
  return "unknown";
}

function eventType(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

export default async function lapdogPlugin(_input: PluginInput): Promise<Hooks> {
  if (!HOOK_URL) return {};

  return {
    "tool.execute.before": async (input) => {
      await postHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId(input),
        tool_name: input.tool,
        tool_use_id: input.callID
      });
    },

    "tool.execute.after": async (input, output) => {
      const metadata = (output.metadata ?? {}) as Record<string, unknown>;
      const failed = metadata.error !== undefined && metadata.error !== null;
      await postHook({
        hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
        session_id: sessionId(input),
        tool_name: input.tool,
        tool_input: input.args,
        tool_use_id: input.callID,
        tool_response: output.output,
        ...(failed ? { error: metadata.error } : {})
      });
    },

    "chat.message": async (input, output) => {
      if (output.message.role !== "user") return;
      const text = (output.parts ?? [])
        .map((part: unknown) =>
          typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
            ? ((part as { text?: string }).text ?? "")
            : ""
        )
        .join("");
      await postHook({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId(input),
        prompt: text || JSON.stringify(output.message)
      });
    },

    "permission.ask": async (input, output) => {
      await postHook({
        hook_event_name: "PermissionRequest",
        session_id: sessionIdFromUnknown(input),
        tool_name: (input as { tool?: string }).tool ?? "unknown",
        tool_input: (input as { metadata?: unknown }).metadata,
        status: output.status
      });
    },

    "experimental.session.compacting": async (input) => {
      await postHook({
        hook_event_name: "PreCompact",
        session_id: sessionIdFromUnknown(input)
      });
    },

    event: async (input) => {
      const type = eventType(input.event);
      const sid = sessionIdFromUnknown(input.event);
      switch (type) {
        case "session.created":
          await postHook({
            hook_event_name: "SessionStart",
            session_id: sid
          });
          return;
        case "session.deleted":
          await postHook({
            hook_event_name: "SessionEnd",
            session_id: sid
          });
          return;
        case "session.idle":
        case "session.next.text.ended":
          await postHook({
            hook_event_name: "Stop",
            session_id: sid
          });
          return;
        case "session.next.compaction.started":
        case "session.compacted":
          await postHook({
            hook_event_name: "PreCompact",
            session_id: sid
          });
          return;
        case "session.status":
          await postHook({
            hook_event_name: "Notification",
            session_id: sid
          });
          return;
        default:
          // OpenCode does not emit a dedicated SubagentStart/SubagentStop event;
          // any event whose type starts with "subagent." is forwarded best-effort
          // as a Notification so the lapdog dashboard still sees subagent traffic.
          if (type !== undefined && type.startsWith("subagent.")) {
            await postHook({
              hook_event_name: "Notification",
              session_id: sid,
              subagent_event: type
            });
          }
      }
    }
  };
}
