---
description: Audit bash tool usage and recommend OpenCode permission improvements
---

Audit recent OpenCode bash tool usage from the local OpenCode database and recommend narrow permission improvements for `mindframe-z` profile permissions.

Use direct `opencode db` commands.

If the user provides arguments, treat them as a focus filter for commands, sessions, directories, or time ranges: `$ARGUMENTS`.

## Safety

- Treat the OpenCode database as read-only.
- Use only `opencode db "<SQL>" --format json`.
- Do not run mutating SQL: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `VACUUM`, mutating `PRAGMA`, or migrations.
- Do not print secrets, tokens, full transcript text, or large command outputs unless directly necessary.
- Prefer aggregates, command strings, session IDs, workdirs, counts, and short previews.

## Workflow

1. Inspect the live schema before assuming columns.

```bash
opencode db "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name" --format json
opencode db "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('session','part','session_message','permission','event') ORDER BY name" --format json
```

2. Read the current profile permission rules.

Read `profiles/base/profile.yml`, `profiles/work/profile.yml`, `profiles/personal/profile.yml`, and relevant `AGENTS.md` files. Also check `.opencode/opencode.jsonc` only to confirm whether it has local bash overrides. Treat `profiles/*/profile.yml` as the source of truth for permission recommendations.

For bash permission matching, remember that OpenCode evaluates matching rules in insertion order and the last matching rule wins. Shell text must match the exact command form the bash tool sees. Inline env prefixes, wrappers, aliases, and chained commands are distinct.

3. Summarize bash tool usage by command.

Start broad to understand global recurrence, then filter to this repository path. Prefer path filtering over `project_id`; older rows may not be keyed consistently by project.

```bash
opencode db "SELECT json_extract(data, '$.state.input.command') AS command, COUNT(*) AS count, SUM(CASE WHEN json_extract(data, '$.state.status')='error' THEN 1 ELSE 0 END) AS errors, MIN(json_extract(data, '$.state.input.workdir')) AS sample_workdir, MAX(time_created) AS last_seen FROM part WHERE json_extract(data, '$.tool')='bash' AND json_extract(data, '$.state.input.command') IS NOT NULL GROUP BY command ORDER BY count DESC LIMIT 100" --format json
opencode db "SELECT json_extract(p.data, '$.state.input.command') AS command, COUNT(*) AS count, SUM(CASE WHEN json_extract(p.data, '$.state.status')='error' THEN 1 ELSE 0 END) AS errors, MIN(json_extract(p.data, '$.state.input.workdir')) AS sample_workdir, MAX(p.time_created) AS last_seen FROM part p LEFT JOIN session s ON s.id = p.session_id WHERE json_extract(p.data, '$.tool')='bash' AND json_extract(p.data, '$.state.input.command') IS NOT NULL AND (s.directory LIKE '/home/mark/code/mindframe-z%' OR json_extract(p.data, '$.state.input.workdir') LIKE '/home/mark/code/mindframe-z%') GROUP BY command ORDER BY count DESC LIMIT 100" --format json
```

4. Inspect recent bash calls scoped to this repository.

```bash
opencode db "SELECT p.id, p.session_id, s.title, s.directory, json_extract(p.data, '$.state.status') AS status, json_extract(p.data, '$.state.input.command') AS command, json_extract(p.data, '$.state.input.workdir') AS workdir, json_extract(p.data, '$.state.input.description') AS description, p.time_created FROM part p LEFT JOIN session s ON s.id = p.session_id WHERE json_extract(p.data, '$.tool')='bash' AND json_extract(p.data, '$.state.input.command') IS NOT NULL AND (s.directory LIKE '/home/mark/code/mindframe-z%' OR json_extract(p.data, '$.state.input.workdir') LIKE '/home/mark/code/mindframe-z%') ORDER BY p.time_created DESC LIMIT 100" --format json
```

5. Inspect failed bash calls scoped to this repository for repeated permission-friction-adjacent patterns, but do not assume every error is permission related.

```bash
opencode db "SELECT json_extract(p.data, '$.state.input.command') AS command, COUNT(*) AS errors, MIN(json_extract(p.data, '$.state.input.workdir')) AS sample_workdir, MAX(substr(json_extract(p.data, '$.state.output'), 1, 240)) AS output_preview FROM part p LEFT JOIN session s ON s.id = p.session_id WHERE json_extract(p.data, '$.tool')='bash' AND json_extract(p.data, '$.state.status')='error' AND json_extract(p.data, '$.state.input.command') IS NOT NULL AND (s.directory LIKE '/home/mark/code/mindframe-z%' OR json_extract(p.data, '$.state.input.workdir') LIKE '/home/mark/code/mindframe-z%') GROUP BY command ORDER BY errors DESC LIMIT 50" --format json
```

6. Count the scoped activity so the report distinguishes counted rows from sampled rows.

```bash
opencode db "SELECT COUNT(*) AS total_bash_rows, COUNT(DISTINCT json_extract(p.data, '$.state.input.command')) AS distinct_commands FROM part p LEFT JOIN session s ON s.id = p.session_id WHERE json_extract(p.data, '$.tool')='bash' AND json_extract(p.data, '$.state.input.command') IS NOT NULL AND (s.directory LIKE '/home/mark/code/mindframe-z%' OR json_extract(p.data, '$.state.input.workdir') LIKE '/home/mark/code/mindframe-z%')" --format json
opencode db "SELECT COUNT(*) AS failed_bash_rows, COUNT(DISTINCT json_extract(p.data, '$.state.input.command')) AS failed_distinct_commands FROM part p LEFT JOIN session s ON s.id = p.session_id WHERE json_extract(p.data, '$.tool')='bash' AND json_extract(p.data, '$.state.status')='error' AND json_extract(p.data, '$.state.input.command') IS NOT NULL AND (s.directory LIKE '/home/mark/code/mindframe-z%' OR json_extract(p.data, '$.state.input.workdir') LIKE '/home/mark/code/mindframe-z%')" --format json
```

7. If command arguments were provided, run a focused query using `LIKE` filters. Escape user-provided quote characters before building SQL.

Example pattern:

```bash
opencode db "SELECT p.id, p.session_id, s.title, json_extract(p.data, '$.state.status') AS status, json_extract(p.data, '$.state.input.command') AS command, json_extract(p.data, '$.state.input.workdir') AS workdir, p.time_created FROM part p LEFT JOIN session s ON s.id = p.session_id WHERE json_extract(p.data, '$.tool')='bash' AND json_extract(p.data, '$.state.input.command') LIKE '%git status%' ORDER BY p.time_created DESC LIMIT 100" --format json
```

## Classification Rules

Recommend `allow` only for repeated, low-risk commands that are read-only or local validation commands.

Good candidates:

- Read-only Git inspection: `git status*`, `git diff*`, `git log*`, `git branch --show-current`, `git branch -vv`, `git remote -v`, `git rev-parse*`, `git ls-files *`.
- Local search/listing tools when already allowed by profile policy: `rg *`, `jq *`, simple listing forms if desired.
- `mindframe-z` validation commands that do not publish, deploy, mutate remotes, or expose secrets: `pnpm check`, `pnpm build`, `pnpm test`, `pnpm fmt`, `pnpm fmt:check`, `pnpm schemas`, `pnpm dev -- doctor`, and dry-run apply commands.
- Syntax checks over profile-owned files, for example `zsh -n profiles/*/.zshrc`.
- Read-only service checks with narrow exact patterns, for example `gh auth status` or `gh repo view *`, if the project already permits that service.

Keep as `ask` or recommend `deny`:

- Remote mutations: `git push*`, `git pull*`, `git fetch*` if network access should be reviewed, `gh api -X PATCH*`, `gh pr merge*`, deploy/publish/release commands.
- Local destructive or state-changing commands: `rm *`, `mv *`, `cp *` outside obvious temp/read-only contexts, `git reset*`, `git checkout*`, `git stash*`, `git clean*`, package installs, `mise install`, `mfz apply`, `pnpm dev -- sync*`, chmod/chown, service control.
- Commands with heredocs or shell chains that hide substantial behavior.
- Commands containing token, key, credential, AWS secret, Datadog secret, GitHub token, or private config path patterns.
- Broad wrappers or aliases unless the alias behavior is known and safe.

When recommending rules, keep them narrow and order-aware. Preserve broad `"*": ask` before narrower allow rules, and preserve deny rules after allow rules when they must override.

## Output

Report in this order:

1. Data inspected: tables, row counts or limits, and whether analysis was sampled.
2. Current bash permission coverage: rules found and important last-match implications.
3. Repeated commands likely still causing asks, grouped by recommended action.
4. Concrete permission recommendations as YAML snippets or exact edits for `profiles/base/profile.yml` or the profile that owns the relevant rule.
5. Commands that should remain `ask` or become `deny`, with brief rationale.
6. Gaps: schema uncertainty, missing permission files, focused filters used, or areas not inspected.

Prefer a small, actionable recommendation over a large allowlist.
