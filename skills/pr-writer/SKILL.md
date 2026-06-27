---
name: pr-writer
description: Write or refresh a GitHub PR title and description, then create or update the PR with gh on approval. Use when opening a PR, writing or rewriting a PR title/body, or refreshing one after the branch changed.
---

# PR Writer

Write a **reader-first** PR description — a cover note for a reviewer, not a changelog, template, or validation log. Because a PR body is short, draft it **in chat**: show the proposed title and body, refine with the user, then push with `gh` on approval. There is no local artifact and no drift check — GitHub is the PR's home.

## Process

### 1. Inspect the full branch diff

Requires authenticated `gh`. Describe the *whole branch against its base*, not the latest commit or stale PR text.

```bash
git branch --show-current
git status --porcelain
BASE=$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git log $BASE..HEAD --oneline
git diff $BASE...HEAD
```

For an existing PR, also read its current text: `gh pr view <N> --json number,title,body,url,baseRefName,headRefName`. If on `main`/`master`, create a feature branch first.

### 2. Draft title and body in chat

Write the title and body following the doctrine below, sized to the change. Present both to the user.

**Done when:** a reviewer could read the title alone and know what the whole branch does, and the body names the change and its effect.

### 3. Refine with the user

Let the user react; rewrite in chat. Stay here until approved — do not touch `gh` while refining.

### 4. Push with gh

Create a draft PR, or update an existing one:

```bash
gh pr create --draft --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"

gh api -X PATCH repos/{owner}/{repo}/pulls/<N> -f title='<title>' -f body="$(cat <<'EOF'
<body>
EOF
)"
```

Report the PR URL.

## Title

Format: `<STORY-KEY>: <subject>` — prefix the Jira story key when the work has one (e.g. `OBSERVE-453: Route dependency fetches through Artifactory`). Omit the prefix only when there is genuinely no story.

- Describe the dominant change, not the latest commit.
- No bracketed agent/tool labels (`[claude]`, `[ai]`, `[wip]`), no automation attribution, no trailing period.
- No vague titles: `update`, `cleanup`, `fix stuff`, `address feedback`.

## Reader-first doctrine

The body addresses a **reviewer**. It never narrates its own creation or the instructions you were given.

**Put in:**
- *What* changed and its effect — high level, the shape before the detail.
- *Why* — the reason behind non-obvious decisions, tradeoffs, risk, or migration concerns.

**Form:**
- Prose for the *what* and *why*.
- Bullets for enumerating discrete changes or affected areas.
- The smallest structure that makes review easier — no mandated sections.

**Keep out** (the AI tells):
- No `Summary` / `Changes` / `Test Plan` template, no empty headings, no placeholders.
- No test criteria or "how it was tested" section, and no `tests were not run` — that is an instruction you were given leaking into the artifact, not content for the reviewer.
- No pasted command transcripts, CI logs, copied commit log, or file-by-file narration.
- No process words: `this PR updates`, `decision model`, `runtime guidance`, `validation results`.
- No customer/org names, emails, secrets, or PII. No agent trace links.

## Optional reviewer aids

Add only when they cut the reviewer's reconstruction work, with one sentence saying what to notice:

- **before/after** — changed contract, payload, config, or CLI surface.
- **schema/interface** — new or changed API response, type, or event shape.
- **mermaid** — async flows, queues, retries, state transitions, multi-service interaction.
- **review order** — broad, generated, or layered diffs: where to start.
- **rollout/migration note** — when adopters or operators must adjust.

## Default body shape

```markdown
<What changed and what effect it has.>

<Why this approach — tradeoff, risk, migration, or review focus — when not obvious from the diff.>
```

Example (bug fix):

```markdown
Inactive authenticated users now go through account reactivation before the login view honors a `next` URL.

The GET login path previously redirected authenticated users without checking `is_active`, which could bounce an inactive user between `/auth/login/` and a protected view. The POST path already handled this; this applies the same guard to GET, with a regression test covering the loop.
```

## Issue references

Use only when verified from branch name, commits, or user input — never invent IDs.

- `Fixes OBSERVE-1234` / `Fixes #1234` — closes the issue on merge.
- `Refs OBSERVE-1234` / `Refs #1234` — links without closing.
