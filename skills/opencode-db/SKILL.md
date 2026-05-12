---
name: opencode-db
description: Use when the user wants to safely inspect or query OpenCode's local database with `opencode db`, including sessions, messages, projects, workspaces, tool calls, skill/MCP usage, subagents, or prior assistant behavior.
---

# OpenCode DB

Use this skill to inspect OpenCode's local SQLite database safely and progressively. Prefer `opencode db` over direct database access because it is the supported read path for ad hoc inspection.

## Safety Rules

- Treat the database as read-only unless the user explicitly asks for a supported migration command.
- Use `opencode db "<SQL>" --format json` for agent-friendly non-interactive queries.
- Do not run `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `VACUUM`, mutating PRAGMAs, or `opencode db migrate` unless explicitly requested.
- If direct `sqlite3` access is necessary, inspect a copy of the database instead of the live file.
- Do not expose secrets or sensitive transcript content beyond what is needed to answer the user's question.

## Locate And Inspect

```bash
opencode db path
opencode db --help
```

Non-interactive `opencode db "<query>"` accepts SQL, not sqlite dot commands. Do not use `.tables` or `.schema` in non-interactive queries; use `sqlite_master` instead.

```bash
opencode db "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name" --format json
opencode db "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('session','message','part','session_message','project','workspace') ORDER BY name" --format json
```

## Schema Orientation

Treat this as a map, not the source of truth. Verify the live schema before relying on columns.

| Area               | Common Tables          | Notes                                                                                                                                         |
| ------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions           | `session`              | Usually query by `id`, `title`, `directory`, `path`, `project_id`, `parent_id`, `time_created`, `time_updated`, `time_archived` when present. |
| Legacy transcript  | `message`, `part`      | Messages belong to `session_id`; parts contain JSON `data` and often carry text, tool calls, reasoning, and step markers.                     |
| Newer event stream | `session_message`      | Unified session events/messages with `type`, `data`, and timestamps. Check this and legacy tables.                                            |
| Scope metadata     | `project`, `workspace` | Useful for filtering and understanding where sessions happened.                                                                               |

## Progressive Disclosure

Start small to avoid accidental context explosions, then expand deliberately when full evidence is needed.

1. Find candidate sessions with small summary queries.
2. Count related rows before reading large JSON columns.
3. Build an outline with IDs, types, timestamps, `length(data)`, and short previews.
4. Fetch full `data` only for relevant rows, time ranges, message IDs, or event types.
5. If accurate analysis requires full fidelity, read the full relevant session in bounded chunks and synthesize as you go.
6. State whether conclusions are based on a sample, a relevant span, or the full session.

Avoid broad `SELECT *` queries. Select only needed columns and use `LIMIT` while exploring.

## Common Queries

Recent sessions:

```bash
opencode db "SELECT id, title, directory, path, time_created, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 20" --format json
```

If `time_archived` does not exist in the live schema, remove that filter.

Search candidate sessions:

```bash
opencode db "SELECT id, title, directory, path, time_updated FROM session WHERE title LIKE '%skill%' OR title LIKE '%MCP%' OR title LIKE '%agent%' OR title LIKE '%AGENTS%' OR title LIKE '%opencode%' ORDER BY time_updated DESC LIMIT 50" --format json
```

Inspect one session:

```bash
opencode db "SELECT id, title, project_id, directory, path, parent_id, time_created, time_updated FROM session WHERE id = 'ses_xxx'" --format json
```

Count transcript rows before expansion:

```bash
opencode db "SELECT 'session_message' AS table_name, COUNT(*) AS count FROM session_message WHERE session_id = 'ses_xxx' UNION ALL SELECT 'message', COUNT(*) FROM message WHERE session_id = 'ses_xxx' UNION ALL SELECT 'part', COUNT(*) FROM part WHERE session_id = 'ses_xxx'" --format json
```

Outline newer event rows:

```bash
opencode db "SELECT id, type, time_created, length(data) AS data_bytes, substr(data, 1, 160) AS data_preview FROM session_message WHERE session_id = 'ses_xxx' ORDER BY time_created ASC LIMIT 100" --format json
```

Outline legacy parts:

```bash
opencode db "SELECT id, message_id, time_created, length(data) AS data_bytes, substr(data, 1, 160) AS data_preview FROM part WHERE session_id = 'ses_xxx' ORDER BY message_id ASC, id ASC LIMIT 100" --format json
```

Summarize legacy part/tool types:

```bash
opencode db "SELECT json_extract(data, '$.type') AS part_type, json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.status') AS status, COUNT(*) AS count, MAX(length(data)) AS max_data_bytes FROM part WHERE session_id = 'ses_xxx' GROUP BY part_type, tool, status ORDER BY count DESC" --format json
```

Fetch selected full rows only after outlining:

```bash
opencode db "SELECT id, message_id, data, time_created FROM part WHERE id IN ('prt_xxx','prt_yyy') ORDER BY time_created ASC" --format json
opencode db "SELECT id, type, data, time_created FROM session_message WHERE id IN ('evt_xxx','evt_yyy') ORDER BY time_created ASC" --format json
```

Chunk full reads when needed:

```bash
opencode db "SELECT id, message_id, data, time_created FROM part WHERE session_id = 'ses_xxx' ORDER BY message_id ASC, id ASC LIMIT 100 OFFSET 0" --format json
opencode db "SELECT id, type, data, time_created FROM session_message WHERE session_id = 'ses_xxx' ORDER BY time_created ASC LIMIT 100 OFFSET 0" --format json
```

## Session Analysis Workflow

When the user wants to understand another session, do not only dump rows. Reconstruct the useful timeline.

- Identify the user request, assistant actions, and final outcome.
- Check both `session_message` and legacy `message`/`part` stores.
- Look for tool calls, failed commands, retries, long outputs, permission problems, and explicit blockers.
- Look for skill loads, MCP/executor usage, documentation lookups, and whether they happened early enough.
- Look for subagent/task calls, including the prompt, returned result, and how the parent assistant used it.
- Compare observed behavior with applicable `AGENTS.md` or skill guidance when the user asks for improvement ideas.
- Recommend concrete guidance changes only when supported by evidence from the session.

For improvement analysis, full-session reads may be necessary. Progressive disclosure is a way to reach the right evidence safely, not a reason to under-sample.

## Reporting Pattern

Report results in this order when analyzing sessions:

1. What data was inspected: session IDs, tables, row counts, and whether the read was sampled or complete.
2. Timeline summary: the main turns/actions and important tool or subagent events.
3. Findings: stuck points, missed guidance, effective behavior, or risky behavior, with row IDs or timestamps when useful.
4. Recommendations: specific changes to `AGENTS.md`, a skill, subagent prompting, MCP usage guidance, or verification workflow.
5. Gaps: missing rows, schema uncertainty, truncated output, or parts not inspected.
