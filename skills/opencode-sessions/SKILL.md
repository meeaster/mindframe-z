---
name: opencode-sessions
description: Use when the user wants to read or analyze OpenCode sessions — find a past session, trace its tool calls or subagents, reconstruct what happened — or otherwise query OpenCode's local SQLite database (`opencode db`) for messages, projects, or todos.
---

# OpenCode Sessions

`opencode db` is the supported read path into OpenCode's local SQLite database. Two rules govern every run: treat the database as **read-only**, and **outline before you read** — pull cheap summaries first and drill into full rows only where the question needs them.

## Read-only

- Run only `SELECT` (and read-only PRAGMAs). Never `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, or `VACUUM` unless the user explicitly asks.
- For a database you don't own — a copy, a backup, or another machine's file — open it read-only with `sqlite3` (see below) so you can't write it even by mistake.
- Don't surface secrets or private transcript content beyond what answers the question.

## Locate the database and pick a read path

```bash
opencode db path
```

`opencode db "<SQL>"` runs one query and exits; with no query it opens an interactive `sqlite3` shell. It takes **SQL, not sqlite dot commands** — `.tables` and `.schema` error; use `sqlite_master`. Pass `--format json` for structured output (default is `tsv`).

`opencode db` only ever reaches **the standard local store**, and it opens the file **read-write** — it sets WAL mode and applies pending migrations on every open. So use it only for this machine's own live database. For a database in a **non-standard location** — a copy, a backup, a mounted volume, or another machine's or version's file — read it directly with `sqlite3`, so a version mismatch or a migration can't mutate it:

```bash
sqlite3 -json 'file:/path/to/opencode.db?mode=ro' "SELECT ..."
```

`sqlite3` takes the same SQL — only the locator and the `-json` flag differ from `opencode db`. Use `?mode=ro` for a normal file; use `?immutable=1` when the file is on a read-only filesystem or is a standalone snapshot without its `-wal`/`-shm` sidecars.

The schema changes between OpenCode versions. Verify it live before trusting any column below:

```bash
opencode db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" --format json
opencode db "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('session','message','part') ORDER BY name" --format json
```

## Schema map

A map to orient queries, not the source of truth — confirm columns against the live schema.

| Table | Holds | Notes |
| ----- | ----- | ----- |
| `session` | one row per session | `id`, `title`, `slug`, `directory`, `path`, `project_id`, `parent_id`, `agent`, `model`, `cost`, `tokens_*`, `time_created`, `time_updated`, `time_archived`. `parent_id` set ⇒ subagent session. |
| `message` | one row per turn | `data` JSON carries `role`, and for assistants `agent`, `model`, `cost`, `tokens`, `finish`. |
| `part` | turn contents | `data` JSON `type` ∈ `text`/`reasoning`/`tool`/`step-start`/`step-finish`/`patch`/`subtask`. Tool parts add `tool`, `callID`, `state.status` (`completed`/`error`/`running`/`pending`), `state.input`, `state.output`, `state.error`. |
| `session_message` | session-level event markers | The V2 event store, mid-rollout — today typically just `agent-switched`/`model-switched`. |
| `project`, `workspace` | scope metadata | Where and in which worktree sessions ran. |
| `todo` | per-session todo items | `status` ∈ `pending`/`in_progress`/`completed`/`cancelled`. |

The transcript lives in **`message` + `part`** (V1) or **`session_message`** (V2), depending on version — V2 is rolling out and recent migrations reset it. Don't assume; count rows in both for the session, then analyze whichever holds the content (today that is `message`/`part`).

## Outline, then drill down

Cheap summaries first; full `data` columns only for the rows you've decided you need. This keeps queries fast and avoids dumping large JSON into context.

- Never `SELECT *` on `message`/`part` across a session — select named columns, and outline with `length(data)` and `substr(data, 1, 160)` before fetching full `data`.
- Use `LIMIT` while exploring; `json_extract(data, '$.path')` to pull single fields without the whole blob.

Recent sessions:

```bash
opencode db "SELECT id, title, directory, agent, model, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 20" --format json
```

Search for a session:

```bash
opencode db "SELECT id, title, directory, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE title LIKE '%skill%' ORDER BY time_updated DESC LIMIT 50" --format json
```

Inspect one session:

```bash
opencode db "SELECT id, title, project_id, directory, parent_id, agent, model, cost, strftime('%Y-%m-%d %H:%M', time_created/1000, 'unixepoch') AS time_created, strftime('%Y-%m-%d %H:%M', time_updated/1000, 'unixepoch') AS time_updated FROM session WHERE id = 'ses_xxx'" --format json
```

## Analyzing a prior session

To reconstruct what happened in a session — its turns, tool calls, failures, and what to improve — follow [SESSIONS.md](SESSIONS.md) for the transcript drill-down recipes, the analysis workflow, and the reporting pattern.

## Archived export JSON

A session that vanished from the local store can be hydrated from an S3 archive into a read-only cache. A hydrated OpenCode session is **not** a sqlite database — it's the JSON that `opencode export <id>` produces, one file at `<cache-root>/opencode/<id>.json` holding the whole session:

```json
{ "info": { "id": "ses_...", "title": "...", "time": { "created": ..., "updated": ... }, ... },
  "messages": [ { "info": { "id": "msg_...", "role": "user" | "assistant", "time": { "created": ... }, ... }, "parts": [ ... ] } ] }
```

When you're handed a path like this directly (e.g. `Its transcript is the file /mnt/.../archive-cache/opencode/<id>.json`), **read the file with `jq` or a text tool — do not run `opencode db` or `sqlite3` against it.** It's a plain JSON document: `info` mirrors the `session` table's row, and each `messages[].info`/`messages[].parts` pair mirrors one `message`/`part` row pair from the live schema above. `messages` is already in chronological order — the last entry is the tail.

```bash
jq '.info' <path>
jq '.messages | length' <path>
jq '.messages[-1].info' <path>
```

This is the only case where you read OpenCode session content from a file instead of the database — because the database it came from no longer has this session.
