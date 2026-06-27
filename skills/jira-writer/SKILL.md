---
name: jira-writer
description: Draft, refine, and sync Jira stories as local markdown, then push to Jira on approval. Use when asked to write or update a Jira story, turn notes or a bug into a ticket, or rewrite a story to read clearly.
---

# Jira Writer

Author Jira stories that read like a short human narrative — **reader-first**: why the work exists, what changes, and the context a future reader needs. You draft in a local markdown file, refine it with the user, and only push to Jira once they approve.

The skill is portable: it owns *what the story says* and *how it syncs*, not where the repo lives. It operates on the artifact file you point it at, or creates one under `.claude/artifacts/jira/`.

## Process

### 1. Resolve the artifact

- **New story** — create `.claude/artifacts/jira/DRAFT-<type>-<slug>.jira.md` with front matter (see below) and an empty `issue_key`.
- **Existing story** — if given an issue key, find its file under `.claude/artifacts/jira/`. If none exists, fetch the issue (`getJiraIssue`) and write a local artifact from it before editing.

### 2. Draft the body in the file

Write the story into the markdown body following **reader-first** doctrine below. Draft from the conversation context and any evidence already gathered; do not interview the user for fields they have not raised.

**Done when:** the body is a coherent top-to-bottom narrative a teammate could read cold, with no section left as a placeholder.

### 3. Refine with the user

Show the drafted body and let the user react. Edit the file in place. Stay in this loop until they approve — do not push to Jira while refining.

### 4. Drift check, then push

Once approved, run the **drift check** before writing to Jira. Then:
- **New** — `createJiraIssue`, then rename the file to `<type>-<KEY>-<slug>.jira.md` and write `issue_key`, `issue_id`, `issue_url` back into front matter.
- **Existing** — `editJiraIssue` with the body.

Write the current timestamp to `last_synced`. Report the issue URL.

## Reader-first doctrine

The story addresses a **reader** — a teammate, or future-you rediscovering why this work happened. It never narrates its own creation.

**Put in:**
- The work to be done, stated first.
- The *why* — the signal, problem, or impact that makes this worth doing. Proportional: explain what is not obvious, skip what is.
- Exact log/error messages in fenced code blocks when the work is tied to that signal — future readers search for these.
- Evidence (links, monitors, notebooks, timestamps) inlined in the sentence that uses it. Put references at the end only when they matter but would interrupt the narrative.

**Form:**
- Prose for the *why* and the narrative arc.
- Bullets for enumerations — discrete changes, affected components, scope items.

**Keep out** (these are the AI tells that make a story read like slop):
- Acceptance criteria — unless the user explicitly asks. They get ignored.
- Open questions — raise them *to the user*, not inside the story.
- Implementation play-by-play, command-level steps.
- Process meta-narration: branch names, PR housekeeping, "tests were not run", or anything that describes how the artifact was produced rather than the work itself.
- Inflated value statements for routine work; unrelated evidence dumps.

## Front matter

Flat keys, identity only. No volatile Jira runtime state beyond what sync needs.

```yaml
---
cloud_id: <atlassian cloud id>
project_key: OBSERVE
issue_type: Story
summary: <title — short, specific, findable later>
issue_key: OBSERVE-453   # empty until created
issue_id: ""
issue_url: ""
parent: OBSERVE-305      # omit if none
last_synced: ""          # ISO timestamp, written on every push
---
```

The markdown body *is* the Jira description. Keep it outward-facing so it reads correctly in Jira alone — no local-only links or notes in the body.

## Drift check

Jira issues carry a precise `updated` timestamp. Before pushing to an existing issue, guard against clobbering a coworker's edit:

1. Fetch the issue (`searchJiraIssuesUsingJql` with `key = <KEY>`, or `getJiraIssue`) and read its `updated`.
2. Compare against `last_synced` in front matter.
3. If `updated` is **newer** than `last_synced`, someone edited the issue since you last synced. **Stop. Show the remote state and tell the user** — do not push. Let them decide.
4. If not newer (or this is the first push of the session and you already read it), push freely.

Within one session, trust the local file after the first check — do not re-guard every push.
