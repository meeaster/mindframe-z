---
name: confluence-writer
description: Draft, refine, and sync Confluence pages as local markdown, then publish to Confluence on approval. Use when asked to write or update a Confluence page, turn a design or thread into a shareable doc, or publish a page for the team to read.
---

# Confluence Writer

Author Confluence pages that read **reader-first** for an audience who wasn't in the room — a teammate finding this page later. You draft in a local markdown file, refine it with the user, and only publish to Confluence once they approve. This avoids the failure where the MCP pushes a page before you've seen what it will write.

The skill is portable: it owns *what the page says* and *how it syncs*, not where the repo lives. It operates on the artifact file you point it at, or creates one under `.claude/artifacts/confluence/`.

## Process

### 1. Resolve the artifact

- **New page** — create `.claude/artifacts/confluence/DRAFT-<slug>.confluence.md` with front matter (see below) and an empty `page_id`.
- **Existing page** — if given a page id or title, find its file under `.claude/artifacts/confluence/`. If none exists, fetch the page (`getConfluencePage`) and write a local artifact from it before editing.

### 2. Draft the body in the file

Write the page into the markdown body following **reader-first** doctrine below. Draft from the conversation context and any material already gathered.

**Done when:** the page is self-contained — a teammate who wasn't in the discussion could read it top to bottom and understand the state, with no placeholder section.

### 3. Refine with the user

Show the drafted body and let the user react. Edit the file in place. Stay in this loop until they approve — do not publish while refining.

### 4. Drift check, then publish

Once approved, run the **drift check** before writing to Confluence. Then:
- **New** — `createConfluencePage`, then rename the file to `<page_id>-<slug>.confluence.md` and write `page_id`, `page_url` back into front matter.
- **Existing** — `updateConfluencePage` with the body.

Write the current timestamp to `last_synced`. Report the page URL.

## Reader-first doctrine

The page is **audience-facing** — written for humans on the team, not a working note and not a record of how it was made.

**Put in:**
- The point first — lead with what the reader needs, not preamble.
- A self-contained narrative: someone without the backstory can follow it.
- The *why* behind decisions, proportional to what's non-obvious.
- Data, tables, and compact examples where they let the reader grasp state faster than prose.

**Form:**
- Prose for explanation and the *why*.
- Bullets and tables for enumerations and structured data.
- Page title lives in front matter, **not** as a body `# H1`.

**Keep out:**
- Process meta-narration — how the page was drafted, what was considered and rejected, AI-workflow notes.
- Local-only references: no Obsidian wikilinks, no local file paths. Body links point only to published destinations — Jira issues, other Confluence pages, external URLs.
- Slop tells: empty headings, performative filler, restating the obvious.

## Front matter

```yaml
---
title: <page title — not repeated as a body H1>
cloud_id: <atlassian cloud id>
space_key: Watchtower
page_id: ""              # empty until created
page_url: ""
parent_page_id: ""       # omit if top-level
last_synced: ""          # ISO timestamp, written on every publish
---
```

The markdown body *is* the page content.

## Drift check

Confluence pages report a `lastModified` time, but only as a coarse human string (e.g. `"Jun 15, 2026"`) — there is no precise, body-free version endpoint in the MCP. The guard is coarse but catches the real case (a coworker editing between your sessions):

1. Query the page (`searchConfluenceUsingCql` with `id = <page_id>`) and read its `lastModified`.
2. Compare against `last_synced` in front matter, at day granularity.
3. If the page was modified **after** your `last_synced`, someone edited it since you last published. **Stop. Fetch the body, show the user what's there, and tell them** — do not publish over it. Let them decide.
4. Otherwise publish freely.

Within one session, trust the local file after the first check.
