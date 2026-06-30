export const CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop"
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

// Terminal lifecycle events that finalize a session's root span in lapdog. They
// must run synchronously: a headless `claude -p` dispatch runs in a `docker run
// --rm` container that is reaped the instant the process returns, so an async
// (fire-and-forget) close curl is killed mid-flight before it reaches lapdog,
// leaving the session perpetually "running" on the dashboard.
const TERMINAL_HOOK_EVENTS = new Set<ClaudeHookEvent>(["Stop", "SessionEnd"]);

export const CLAUDE_HOOK_COMMAND =
  "curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d @- ${LAPDOG_URL}/claude/hooks >/dev/null 2>&1 || true";

export interface ClaudeSettings {
  hooks: Record<
    ClaudeHookEvent,
    Array<{ matcher: string; hooks: Array<{ type: "command"; command: string; async: boolean }> }>
  >;
}

export function buildClaudeSettings(): ClaudeSettings {
  const hooks = {} as ClaudeSettings["hooks"];
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: "",
        hooks: [
          {
            type: "command" as const,
            command: CLAUDE_HOOK_COMMAND,
            async: !TERMINAL_HOOK_EVENTS.has(event)
          }
        ]
      }
    ];
  }
  return { hooks };
}

export function buildClaudeSettingsJson(): string {
  return JSON.stringify(buildClaudeSettings(), null, 2) + "\n";
}
