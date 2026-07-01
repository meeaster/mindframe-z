---
name: claude-code-sessions
description: Use when the user wants to read or analyze Claude Code sessions (Claude sessions) — find a past session by prompt, project, or recency; trace its tool calls, subagents, or permission events; reconstruct what happened — from the local Claude Code session store.
---

# Claude Code Sessions

Claude Code stores sessions as **JSONL files** under a **store root** (`$STORE`, resolved below) — there is no database or query CLI. Always inspect them with `jq`, never the Read tool: a session transcript routinely exceeds Read's size cap, and `jq` slices out only the records you need. Two rules govern every run: treat the files as **read-only**, and **outline before you read** — pull cheap summaries (`history.jsonl`, titles, tool counts) first and slice full transcript records only where the question needs them.

## Read-only

- Never write, edit, or delete anything under `$STORE`. Read only.
- Don't surface secrets (`$STORE/.credentials.json`, tokens) or private transcript content beyond what answers the question.

## Locate the store

Resolve the **store root** first; every recipe below reads through `$STORE`:

```bash
STORE="${CLAUDE_SESSIONS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
```

`~/.claude` is the default. A caller that exposes the store at a different home — e.g. a sandbox that mounts it read-only elsewhere — sets `CLAUDE_SESSIONS_DIR`; use that and never fall back to `~/.claude` when it is set. Each command runs in a fresh shell, so set `STORE` at the top of every block. The layout shifts between Claude Code versions — confirm a file exists before relying on it.

```bash
ls "$STORE"
```

The project-dir encoding is **lossy**: `/`, `.`, and `_` in the real path all collapse to `-` (so `/home/u/a.b` and `/home/u/a-b` can both map to `-home-u-a-b`). Never reconstruct the encoded name by hand. Glob the projects dir and confirm against the `cwd` field inside the files:

```bash
ls "$STORE"/projects/
# then confirm which dir is your project:
jq -rc 'select(.cwd) | .cwd' "$STORE"/projects/<encoded>/*.jsonl | head -1
```

## Storage map

A map to orient lookups, not a guaranteed schema — confirm against the live files.

| Path | Holds | Notes |
| ---- | ----- | ----- |
| `$STORE/history.jsonl` | every prompt, all projects | One line per prompt: `display`, `timestamp`, `project` (real path), `sessionId`. The cheapest cross-project lookup layer. |
| `~/.claude.json` | global metadata | Project list, trust/onboarding flags, recent session ids. Peer of the store root, not inside it; may be absent when the store is a mounted subset. |
| `$STORE/projects/<encoded>/<session-id>.jsonl` | one session transcript | The main artifact. Record `type` ∈ `user`/`assistant`/`system`/`ai-title`/`last-prompt`/`mode`/`permission-mode`/`attachment`/`file-history-snapshot`. |
| `.../<session-id>/subagents/agent-*.jsonl` | subagent transcripts | Each has a sibling `agent-*.meta.json` with `agentType`, `description`, and `toolUseId` linking back to the parent's `Agent` tool call. |
| `$STORE/transcripts/` | noisier global store | Late fallback only — not keyed cleanly by project/session. |

Inside a session JSONL: session metadata (`cwd`, `gitBranch`, `version`, `sessionId`) rides on records that carry it; the AI-generated title is in `ai-title` records (`aiTitle`); tool calls are `tool_use` blocks in `assistant` `message.content`; tool output is in the next `user` record's `toolUseResult` (prefer it — it's more compact than the raw inline text).

## Outline, then drill down

Cheapest path that answers the question; full transcript reads only when needed. Most requests stop at the first two steps.

**Find a session** — start from `history.jsonl`, filtering by the real project path:

```bash
jq -rc 'select(.project=="/abs/project/path") | {timestamp, display, sessionId}' "$STORE"/history.jsonl | tail -20
```

Match by first-prompt phrase + recency. An explicit `sessionId` beats everything; `gitBranch` or an edited file breaks ties. Treat a slash-command first line (`/model`, `/resume`) as weak — those repeat across sessions.

**Lead with the structural key, not phrase regexes.** The `project + tail -20` query above is already a near-complete index — scan that list by eye and match on recency (and a `/clear` boundary, a strong session delimiter). Phrase is a *tiebreaker within that list*, not the primary filter: do not iterate `jq` regexes hunting for a phrase, because the user's words rarely match the stored `display` text verbatim and each miss costs a round-trip. When the user gives a temporal locator ("the last session I did", "yesterday's"), recency alone usually resolves it in one query.

**Find sessions that loaded a skill** — a skill load is a `Skill` tool_use with `.input.skill == "<name>"`, in the main transcript *or* a subagent's. Prompt-phrase search misses these (the load is a tool call, not user text). Scan both layers with one grep on the literal JSON, then confirm:

```bash
grep -rl '"skill":"<name>"' "$STORE"/projects/*/*.jsonl "$STORE"/projects/*/*/subagents/*.jsonl
# a subagents/ hit means a SUBAGENT loaded it — map back to the parent session by the dir name
```

A `$STORE/projects/<encoded>/<sid>/subagents/agent-*.jsonl` hit belongs to parent session `<sid>`. Also catch user-typed slash invocations (`/<name>`) in `history.jsonl` — those are separate from `Skill` tool loads, so union both when "used a skill" means either.

**Identify a session file** — title and metadata without reading the body:

```bash
jq -rc 'select(.type=="ai-title") | .aiTitle' "$STORE"/projects/<encoded>/<sid>.jsonl | head -1
jq -rc 'select(.gitBranch or .version) | {cwd, gitBranch, version}' "$STORE"/projects/<encoded>/<sid>.jsonl | head -1
```

**Summarize tool usage** — counts before transcript:

```bash
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$STORE"/projects/<encoded>/<sid>.jsonl | sort | uniq -c | sort -rn
```

## Analyzing a prior session

To reconstruct what happened in a session — its turns, tool calls, failures, subagents, and what to improve — follow [SESSIONS.md](SESSIONS.md) for the transcript drill-down recipes, the analysis workflow, and the reporting pattern.
