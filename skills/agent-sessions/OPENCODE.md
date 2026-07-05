# OpenCode Sessions

OpenCode session archaeology reads either the local SQLite store or an exported JSON transcript. Use SQL for databases and `jq` for exported JSON.

## Pick The Read Path

For the standard local store, locate the database and query through OpenCode:

```bash
opencode db path
opencode db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" --format json
```

`opencode db "<SQL>"` runs SQL and exits; with no query it opens an interactive `sqlite3` shell. It takes SQL, not sqlite dot commands. Use `sqlite_master` instead of `.tables` or `.schema`, and pass `--format json` for structured output.

`opencode db` reaches only the standard local store and opens it read-write because it sets WAL mode and applies pending migrations. For a non-standard location, copy, backup, mounted volume, or another machine/version's file, read directly with `sqlite3`:

```bash
sqlite3 -json 'file:/path/to/opencode.db?mode=ro' "SELECT ..."
```

Use `?mode=ro` for a normal file. Use `?immutable=1` when the file is on a read-only filesystem or is a standalone snapshot without `-wal`/`-shm` sidecars.

## Schema Map

Confirm columns against the live schema before trusting this map:

```bash
opencode db "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('session','message','part') ORDER BY name" --format json
```

| Table | Holds | Notes |
| ----- | ----- | ----- |
| `session` | one row per session | `id`, `title`, `slug`, `directory`, `path`, `project_id`, `parent_id`, `agent`, `model`, `cost`, `tokens_*`, `time_created`, `time_updated`, `time_archived`. `parent_id` set means subagent session. |
| `message` | one row per turn | `data` JSON carries `role`, and for assistants `agent`, `model`, `cost`, `tokens`, `finish`. |
| `part` | turn contents | `data` JSON `type` can include `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `patch`, `subtask`, or `compaction`. Tool parts add `tool`, `callID`, `state.status`, `state.input`, `state.output`, and `state.error`. |
| `session_message` | session-level event markers | V2 event store, mid-rollout. Count rows before assuming it has transcript content. |
| `project`, `workspace` | scope metadata | Where and in which worktree sessions ran. |
| `todo` | per-session todo items | `status` can be `pending`, `in_progress`, `completed`, or `cancelled`. |

The transcript usually lives in `message` plus `part`; some versions may use `session_message`. Count both before analyzing:

```bash
opencode db "SELECT 'message' tbl, COUNT(*) c FROM message WHERE session_id='ses_xxx' UNION ALL SELECT 'part', COUNT(*) FROM part WHERE session_id='ses_xxx' UNION ALL SELECT 'session_message', COUNT(*) FROM session_message WHERE session_id='ses_xxx'" --format json
```

## Find A Session

Recent sessions:

```bash
opencode db "SELECT id, title, directory, agent, model, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 20" --format json
```

Search titles:

```bash
opencode db "SELECT id, title, directory, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE title LIKE '%skill%' ORDER BY time_updated DESC LIMIT 50" --format json
```

Inspect one session:

```bash
opencode db "SELECT id, title, project_id, directory, parent_id, agent, model, cost, strftime('%Y-%m-%d %H:%M', time_created/1000, 'unixepoch') AS time_created, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE id = 'ses_xxx'" --format json
```

Check compact boundaries when a long session may have changed scope. A `compaction` part is often followed by a fresh user opening inside the same session:

```bash
opencode db "SELECT m.id AS message_id, strftime('%Y-%m-%d %H:%M', m.time_created/1000, 'unixepoch') AS time_created, json_extract(p.data,'$.type') AS part_type, substr(json_extract(p.data,'$.text'),1,260) AS text FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = 'ses_xxx' AND json_extract(p.data,'$.type') IN ('compaction','text') ORDER BY m.time_created" --format json
```

Search by evidence as well as intent. Prompts and titles explain why a session happened; tool traces prove what it touched. For file changes, skill usage, tools, MCP servers, commands, or specs, search the concrete path/name in tool inputs and outputs, then confirm the match:

```bash
opencode db "SELECT s.id, s.title, s.directory, strftime('%Y-%m-%d %H:%M', s.time_created/1000, 'unixepoch') AS time_created, json_extract(p.data,'$.tool') AS tool, substr(json_extract(p.data,'$.state.input.patchText'),1,220) AS patch_snippet, json_extract(p.data,'$.state.input.filePath') AS file_path FROM part p JOIN session s ON s.id = p.session_id WHERE json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool') IN ('write','edit','apply_patch') AND p.data LIKE '%skills/<name>/SKILL.md%' ORDER BY s.time_created DESC LIMIT 50" --format json
```

## Drill Down

Outline parts before fetching full `data`:

```bash
opencode db "SELECT id, message_id, json_extract(data,'$.type') type, length(data) bytes, substr(data,1,160) preview FROM part WHERE session_id='ses_xxx' ORDER BY message_id, id LIMIT 100" --format json
```

Summarize tool usage and failures:

```bash
opencode db "SELECT json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') status, COUNT(*) c FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.type')='tool' GROUP BY tool, status ORDER BY c DESC" --format json
opencode db "SELECT json_extract(data,'$.tool') tool, substr(json_extract(data,'$.state.error'),1,200) err FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.state.status')='error'" --format json
```

Find subagent delegations:

```bash
opencode db "SELECT json_extract(data,'$.agent') agent, substr(json_extract(data,'$.description'),1,80) descr, substr(json_extract(data,'$.prompt'),1,200) prompt FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.type')='subtask'" --format json
opencode db "SELECT id, title, agent FROM session WHERE parent_id='ses_xxx'" --format json
```

Fetch full `data` only for specific rows or bounded chunks. Format epoch milliseconds in SQL; do not convert raw epochs manually.

```bash
opencode db "SELECT id, message_id, data, strftime('%Y-%m-%d %H:%M', time_created/1000, 'unixepoch') AS time_created FROM part WHERE id IN ('prt_xxx','prt_yyy') ORDER BY time_created" --format json
opencode db "SELECT id, message_id, data, strftime('%Y-%m-%d %H:%M', time_created/1000, 'unixepoch') AS time_created FROM part WHERE session_id='ses_xxx' ORDER BY message_id, id LIMIT 100 OFFSET 0" --format json
```

## Archived Export JSON

A hydrated OpenCode session may be an `opencode export <id>` JSON file, not a database. It has one file at `<cache-root>/opencode/<id>.json`:

```json
{ "info": { "id": "ses_...", "title": "...", "time": { "created": 0, "updated": 0 } },
  "messages": [ { "info": { "id": "msg_...", "role": "user" }, "parts": [] } ] }
```

When handed this path directly, read it with `jq` or a text tool; do not run `opencode db` or `sqlite3` against it. `messages` is already chronological.

```bash
jq '.info' <path>
jq '.messages | length' <path>
jq '.messages[-1].info' <path>
```
