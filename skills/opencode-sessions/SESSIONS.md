# Analyzing a Prior Session

Reconstruct what happened in an OpenCode session — its turns, tool calls, failures, and what to improve — from `message`/`part` (or `session_message`, where V2 holds the content). All [read-only and outline-first rules from SKILL.md](SKILL.md) still apply: outline before you read full `data`.

## Drill-down recipes

Count both transcript stores first, then work in whichever holds the rows:

```bash
opencode db "SELECT 'message' tbl, COUNT(*) c FROM message WHERE session_id='ses_xxx' UNION ALL SELECT 'part', COUNT(*) FROM part WHERE session_id='ses_xxx' UNION ALL SELECT 'session_message', COUNT(*) FROM session_message WHERE session_id='ses_xxx'" --format json
```

Outline parts (types, sizes, previews) before fetching any full `data`:

```bash
opencode db "SELECT id, message_id, json_extract(data,'$.type') type, length(data) bytes, substr(data,1,160) preview FROM part WHERE session_id='ses_xxx' ORDER BY message_id, id LIMIT 100" --format json
```

Summarize tool usage and failures across the session:

```bash
opencode db "SELECT json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') status, COUNT(*) c FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.type')='tool' GROUP BY tool, status ORDER BY c DESC" --format json
```

Read the errors directly:

```bash
opencode db "SELECT json_extract(data,'$.tool') tool, substr(json_extract(data,'$.state.error'),1,200) err FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.state.status')='error'" --format json
```

Find subagent delegations — both as `subtask` parts and as child sessions:

```bash
opencode db "SELECT json_extract(data,'$.agent') agent, substr(json_extract(data,'$.description'),1,80) descr, substr(json_extract(data,'$.prompt'),1,200) prompt FROM part WHERE session_id='ses_xxx' AND json_extract(data,'$.type')='subtask'" --format json
opencode db "SELECT id, title, agent FROM session WHERE parent_id='ses_xxx'" --format json
```

Fetch full `data` only for the specific rows the analysis needs, or read the session in bounded chunks when full fidelity is required. **`time_created`/`time_updated` are stored as epoch milliseconds** — always format them in SQL with `strftime('%Y-%m-%d %H:%M', time/1000, 'unixepoch')` and copy the result verbatim. Never hand a raw epoch to a timestamp or convert it yourself; models render epoch→calendar unreliably and will fabricate the wrong date.

```bash
opencode db "SELECT id, message_id, data, strftime('%Y-%m-%d %H:%M', time_created/1000, 'unixepoch') AS time_created FROM part WHERE id IN ('prt_xxx','prt_yyy') ORDER BY time_created" --format json
opencode db "SELECT id, message_id, data, strftime('%Y-%m-%d %H:%M', time_created/1000, 'unixepoch') AS time_created FROM part WHERE session_id='ses_xxx' ORDER BY message_id, id LIMIT 100 OFFSET 0" --format json
```

## Analysis workflow

Reconstruct the timeline; don't just dump rows. Cover, in order:

1. The user request, the assistant's actions, and the final outcome.
2. Tool calls — failures, retries, long outputs, and permission rejections (`state.error` containing "rejected permission").
3. Whether skills, MCP/executor tools, and documentation lookups fired, and early enough.
4. Subagent delegations — the prompt sent, the result returned, and how the parent used it.
5. Where behavior diverged from the relevant `AGENTS.md` or skill guidance, when the user wants improvement ideas.

Outlining reaches the right evidence safely — it is not a reason to under-sample. When improvement analysis needs the full session, read it.

## Reporting pattern

Report in this order:

1. **Scope** — session IDs, tables, row counts, and whether the read was sampled or complete.
2. **Timeline** — the main turns and important tool or subagent events.
3. **Findings** — stuck points, missed guidance, effective behavior, risky behavior, with row IDs or timestamps.
4. **Recommendations** — specific changes to `AGENTS.md`, a skill, subagent prompting, or MCP usage — only when the session's evidence supports them.
5. **Gaps** — missing rows, schema uncertainty, truncated output, or parts not inspected.
