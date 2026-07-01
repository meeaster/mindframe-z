# Analyzing a Prior Session

Reconstruct what happened in a Claude Code session — its turns, tool calls, failures, subagents, and what to improve — from the session JSONL. All [read-only and outline-first rules from SKILL.md](SKILL.md) still apply: outline before reading full records.

Resolve the store root as in [SKILL.md](SKILL.md) (`STORE="${CLAUDE_SESSIONS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"`), then set `F="$STORE/projects/<encoded>/<session-id>.jsonl"` for the recipes below.

## Drill-down recipes

Outline the turn sequence before reading any full message body:

```bash
jq -rc 'select(.type=="user" or .type=="assistant") | {t:.type, c:(.message.content | if type=="string" then .[0:80] else (map(.type)|join(",")) end)}' "$F"
```

Summarize tool usage; read the inputs only for the calls that matter:

```bash
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$F" | sort | uniq -c | sort -rn
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command' "$F"
```

Find failures — and classify them, because Claude Code's `is_error` flag covers three distinct things:

```bash
jq -rc 'select(.type=="user") | .message.content[]? | select(.type=="tool_result" and .is_error==true) | (.content|tostring|.[0:160])' "$F"
```

- **User rejection** — "The user doesn't want to proceed with this tool use" / "The user rejected permission". A boundary signal, not a failure.
- **Permission denial** — "Permission to use … has been denied" / "Added deny rule". Policy enforcement, distinct from rejection.
- **Runtime/tool error** — everything else (file not found, validation error, non-2xx). The only true failure.

Interruption markers like `[Request interrupted by user for tool use]` arrive as plain `user` text records — also boundary, not failure.

Trace subagents — two levels of detail are available; the caller's question decides which:

- **Input and output, from the parent transcript.** The prompt sent is the `Agent` `tool_use.input`; the result the subagent returned is the matching `tool_result` (paired by `tool_use_id`). No nested file needed.

  ```bash
  jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Agent") | {id, desc:.input.description, prompt:.input.prompt}' "$F"
  jq -rc 'select(.type=="user") | .message.content[]? | select(.type=="tool_result") | {id:.tool_use_id, result:(.content|tostring)}' "$F"
  ```

- **Full internal trace, from the nested transcript** (`agent-<id>.jsonl`) — when the question is about *how* the subagent worked. Read its `.meta.json` sidecar first; it links the subagent to the parent `Agent` call via `toolUseId`.

  ```bash
  for m in "$STORE"/projects/<encoded>/<session-id>/subagents/*.meta.json; do jq -rc '{agentType, description, toolUseId}' "$m"; done
  ```

Identify which file edits happened without scanning prose via `file-history-snapshot` records (`snapshot.trackedFileBackups`).

High-signal patterns worth surfacing: `Skill` tool calls (explicit skill loads), `mcp__*` tool names (MCP usage), and retry loops on a tool — for retries, extract the error pattern plus the final successful call shape, not the whole replay.

When a `toolUseResult` is large, prefer its structured summary fields over the raw embedded text.

## Analysis workflow

Reconstruct the timeline; don't just dump records. Cover, in order:

1. The user request, the assistant's actions, and the final outcome.
2. Tool calls — failures, retries, long outputs, and the rejection/denial/error classification above.
3. Whether skills, MCP tools, and documentation lookups fired, and early enough.
4. Subagent delegations — the `description` and prompt sent, the result returned, and how the parent used it.
5. Where behavior diverged from the relevant `CLAUDE.md` or skill guidance, when the user wants improvement ideas.

Outlining reaches the right evidence cheaply — it is not a reason to under-sample. When improvement analysis needs the full session, read it.

## Reporting pattern

Report in this order:

1. **Scope** — config root, session file(s) read, and whether the read was sampled or complete.
2. **Location** — how the session was found (prompt, project, recency, branch).
3. **Timeline** — the main turns and important tool or subagent events.
4. **Findings** — stuck points, missed guidance, effective behavior, risky behavior, with record positions or timestamps.
5. **Recommendations** — specific changes to `CLAUDE.md`, a skill, or subagent prompting — only when the session's evidence supports them.
6. **Gaps** — missing files, schema drift, truncated output, or records not inspected.
