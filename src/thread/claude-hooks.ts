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

export const CLAUDE_HOOK_COMMAND =
  "curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d @- ${LAPDOG_URL}/claude/hooks >/dev/null 2>&1 || true";

export interface ClaudeSettings {
  hooks: Record<
    ClaudeHookEvent,
    Array<{ matcher: string; hooks: Array<{ type: "command"; command: string; async: true }> }>
  >;
}

export function buildClaudeSettings(): ClaudeSettings {
  const hook = {
    matcher: "",
    hooks: [{ type: "command" as const, command: CLAUDE_HOOK_COMMAND, async: true as const }]
  };
  const hooks = {} as ClaudeSettings["hooks"];
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [hook];
  }
  return { hooks };
}

export function buildClaudeSettingsJson(): string {
  return JSON.stringify(buildClaudeSettings(), null, 2) + "\n";
}
