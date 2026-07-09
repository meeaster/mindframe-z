---
name: thread-sessions
description: The read contract for thread gather and triage — literal store paths, JSONL record shapes, and sqlite query forms for reading a mounted Claude Code or OpenCode session store with bash. Use when extracting or judging a session from a read-only mounted store.
---

# thread-sessions

You read a session from a read-only mounted store and return a dossier (gather), a verdict (triage), or a candidate list (discover). The store is already mounted at a literal path; substitute that path into every command — write it inline, not via a shell variable, because this dispatch's bash matches exact command forms and a variable-assignment prefix will not match. Read with bash — `jq`, `ls`, `grep`, `find`, `sqlite3` — which is pre-authorized for this dispatch. Use `jq`, not raw file reads, because transcripts routinely exceed tool size caps. If a read is denied, rewrite it as a simpler literal-path `jq`/`bash`/`sqlite3` form and retry — a dispatch that gives up returns no dossier.

## Claude Code Store

The store root is the literal path `/mnt/claude-sessions`, holding `projects/`, `history.jsonl`, and `transcripts/`.

The container's own `/home/sandbox/.claude` is this dispatch's writable runtime home — it holds only this dispatch's own transcript and the mounted skills, none of the sessions you are searching. Route every session read through `/mnt/claude-sessions` above.

### Storage Map

| Path | Holds | Notes |
| ---- | ----- | ----- |
| `/mnt/claude-sessions/history.jsonl` | interactively typed prompts | Fast label cache, not the session index. Non-interactive sessions can have transcripts without history lines. |
| `/mnt/claude-sessions/projects/<encoded>/<session-id>.jsonl` | one session transcript | Main artifact. Records can include `user`, `assistant`, `system`, `ai-title`, `last-prompt`, `mode`, `permission-mode`, `attachment`, `file-history-snapshot`, and queue operations. |
| `.../<session-id>/subagents/agent-*.jsonl` | subagent transcripts | Each has a sibling `.meta.json` with `agentType`, `description`, and `toolUseId` linking back to the parent `Agent` tool call. |
| `/mnt/claude-sessions/transcripts/` | noisier global store | Late fallback only; not keyed cleanly by project/session. |

Inside a session JSONL, metadata (`cwd`, `gitBranch`, `version`, `sessionId`) rides on records that carry it. The AI-generated title is in `ai-title.aiTitle`. Tool calls are `tool_use` blocks in assistant `message.content`; tool output is in the next user record's `toolUseResult`.

The layout shifts between Claude Code versions; confirm these paths exist before relying on the map.

### Find A Session By ID

`history.jsonl` is only a label cache; the transcript glob is the authoritative session set. Find a session file by its id:

```bash
find /mnt/claude-sessions/projects -name "<session-id>.jsonl"
```

List recent transcripts newest-first and label each by `ai-title`:

```bash
ls -t /mnt/claude-sessions/projects/*/*.jsonl | head -20 | while read -r f; do
  printf '%s\t%s\n' "$(basename "$f" .jsonl)" \
    "$(jq -rc 'select(.type=="ai-title") | .aiTitle' "$f" | tail -1)"
done
```

When a session contains `/compact`, treat the next substantive queued/user message as a fresh opening prompt for a new phase:

```bash
jq -r 'select(.type=="queue-operation" and .operation=="enqueue") | [.timestamp, (.content|gsub("\n";" ")|.[0:220])] | @tsv' /mnt/claude-sessions/projects/*/<session-id>.jsonl
```

### Drill Down

Outline the turn sequence:

```bash
jq -rc 'select(.type=="user" or .type=="assistant") | {t:.type, c:(.message.content | if type=="string" then .[0:80] else (map(.type)|join(",")) end)}' /mnt/claude-sessions/projects/*/<session-id>.jsonl
```

Summarize tool usage:

```bash
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' /mnt/claude-sessions/projects/*/<session-id>.jsonl | sort | uniq -c | sort -rn
```

Find failures — Claude Code's `is_error` flag covers user rejections, permission denials, and runtime errors:

```bash
jq -rc 'select(.type=="user") | .message.content[]? | select(.type=="tool_result" and .is_error==true) | (.content|tostring|.[0:160])' /mnt/claude-sessions/projects/*/<session-id>.jsonl
```

Trace subagents from the parent transcript:

```bash
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Agent") | {id, desc:.input.description, prompt:.input.prompt}' /mnt/claude-sessions/projects/*/<session-id>.jsonl
```

Read nested subagent transcripts only when the question is about how the subagent worked. Read `.meta.json` first:

```bash
for m in /mnt/claude-sessions/projects/*/<session-id>/subagents/*.meta.json; do jq -rc '{agentType, description, toolUseId}' "$m"; done
```

## OpenCode Store

The database is a single read-only file at `/mnt/opencode-data/opencode/opencode.db`. Read it with `sqlite3` in immutable mode:

```bash
sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' "SELECT ..."
```

`?immutable=1` tells sqlite the file cannot be written, so it never attempts WAL or migration on the read-only mount.

### Schema Map

| Table | Holds | Notes |
| ----- | ----- | ----- |
| `session` | one row per session | `id`, `title`, `slug`, `directory`, `path`, `project_id`, `parent_id`, `agent`, `model`, `cost`, `tokens_*`, `time_created`, `time_updated`, `time_archived`. `parent_id` set means subagent session. |
| `message` | one row per turn | `data` JSON carries `role`, and for assistants `agent`, `model`, `cost`, `tokens`, `finish`. |
| `part` | turn contents | `data` JSON `type` can include `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `patch`, `subtask`, or `compaction`. Tool parts add `tool`, `callID`, `state.status`, `state.input`, `state.output`, and `state.error`. |
| `session_message` | session-level event markers | V2 event store, mid-rollout. |
| `project`, `workspace` | scope metadata | Where and in which worktree sessions ran. |
| `todo` | per-session todo items | `status` can be `pending`, `in_progress`, `completed`, or `cancelled`. |

Confirm columns against the live schema before relying on the map — OpenCode changes table shapes between versions:

```bash
sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('session','message','part') ORDER BY name"
```

The transcript usually lives in `message` plus `part`; some versions use `session_message` instead, so count rows in both before analyzing.

### Find A Session By ID

Recent sessions:

```bash
sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' "SELECT id, title, directory, agent, model, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 20"
```

Inspect one session:

```bash
sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' "SELECT id, title, project_id, directory, parent_id, agent, model, cost, strftime('%Y-%m-%d %H:%M', time_created/1000, 'unixepoch') AS time_created, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE id = 'ses_xxx'"
```

### Drill Down

Outline parts before fetching full `data`:

```bash
sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' "SELECT id, message_id, json_extract(data,'$.type') type, length(data) bytes, substr(data,1,160) preview FROM part WHERE session_id='ses_xxx' ORDER BY message_id, id LIMIT 100"
```

Summarize tool usage and failures:

```bash
sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' "SELECT json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') status, COUNT(*) c FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.type')='tool' GROUP BY tool, status ORDER BY c DESC"
```

Find subagent delegations:

```bash
sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' "SELECT json_extract(data,'$.agent') agent, substr(json_extract(data,'$.description'),1,80) descr, substr(json_extract(data,'$.prompt'),1,200) prompt FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.type')='subtask'"
```

## Archive Cache

A hydrated copy of a session may be visible at `/home/sandbox/.mindframe-z/archive-cache`. The artifact's filename disambiguates format: `<id>.jsonl` is a Claude Code transcript (read with `jq`); `<id>.json` is an OpenCode export with `info` and `messages[]` already chronological (read with `jq`). When handed this path directly, read it with `jq` or a text tool.
