---
name: agent-sessions
description: >
  Use when the user wants session archaeology: find, read, reconstruct, catch up on, or audit prior OpenCode or Claude
  Code sessions, including catching up on or resuming from a specific past session, tool calls, subagents, permission
  events, failures, skill usage, durable user perspective, and local session stores.
---

# Agent Sessions

Session archaeology reconstructs past agent work from durable artifacts. Every run follows the same process: **read-only**, **outline before you read**, then drill only into evidence the question needs.

## Steps

1. Identify the source and artifact.

   Use the user's locator, requested harness, mounted path, session ID, or recency clue to choose the branch: [OpenCode](OPENCODE.md), [Claude Code](CLAUDE.md), or a direct exported file. Done when the session source and read path are explicit, not inferred.

2. Confirm the storage shape before trusting recipes.

   Check the live database schema, store layout, transcript file, or export JSON shape before relying on remembered columns or paths. Done when the relevant table/file names and the candidate session artifact are confirmed.

3. Outline before reading full content.

   Pull cheap summaries first: session titles, timestamps, row counts, record types, tool counts, compact boundaries, and short previews. Done when you can name the likely session(s), evidence gaps, and next narrow reads without dumping full transcript bodies.

4. Drill into the minimum sufficient evidence.

   Read full rows or records only for the turns, tools, subagents, errors, files, or timestamps needed to answer. For reconstruction, audit, or perspective-mining work, use [ANALYSIS.md](ANALYSIS.md). Done when every claim you plan to report is backed by a session ID/path plus row, record, timestamp, or quoted artifact.

5. Report scope, findings, and gaps.

   State what you read, whether it was sampled or complete, what happened, and what remains uncertain. Done when the user can distinguish evidence-backed conclusions from missing or uninspected material.

## Rules

- Treat session stores as read-only. Never write, edit, migrate, vacuum, or delete session artifacts unless the user explicitly asks.
- Do not surface secrets or private transcript content beyond what answers the question.
- Prefer structured extraction (`sqlite3`/`opencode db` SQL, `jq`) over raw transcript dumps.
- If a mounted or explicit path is provided, use that path. Do not fall back to the agent's own runtime home.

## Branches

- Use [OPENCODE.md](OPENCODE.md) for OpenCode's SQLite store, `opencode db`, non-standard database files, and `opencode export` JSON.
- Use [CLAUDE.md](CLAUDE.md) for Claude Code's JSONL store, project directory encoding, `history.jsonl`, subagent files, and permission-event classification.
- Use [ANALYSIS.md](ANALYSIS.md) when the user asks what happened, why a run failed, whether guidance fired, what should improve, or which sessions contain durable user perspective.
