---
name: jira-writer
description: Creates clear, high-level Jira stories from notes, requirements, discovery, bug reports, or implementation ideas. Use when asked to draft a Jira story, create a Jira ticket, turn rough notes into Jira-ready work, or rewrite a story so it is concise and actionable.
---

# Jira Writer

Use this skill to draft Jira stories that read like a short human narrative: why the work exists, what needs to change, and what scope or evidence a future reader needs to understand it.

## Default Shape

Return a Jira-ready story with:

1. `Title`: short, action-oriented, and specific enough to find later.
2. `Description`: a short top-to-bottom narrative covering the signal or problem, useful evidence, why the work matters, and the high-level solution direction.
3. `Scope`: only when boundaries, environments, systems, or sequencing matter.

Add `Value` only when the narrative does not already make the value clear. Add acceptance criteria only when the user asks for them or a checklist is needed to prevent ambiguity.

## Workflow

1. Identify the work being requested.
2. Identify the context that explains why the story exists: observed signals, user impact, operational noise, rollout sequencing, or audit references.
3. Preserve the facts and evidence that a future reader would need to understand or rediscover the reason for the work.
4. Draft at the problem-and-solution level, not the step-by-step implementation level.
5. Keep the value plain and proportional; do not over-explain obvious maintenance work.
6. Inline evidence where it naturally supports the story. Put references at the end only when they are useful but would interrupt the narrative.
7. Remove process residue, branch notes, PR housekeeping, tool usage, and AI workflow narration.
8. If key information is missing, ask before drafting or mention the gap outside the Jira story. Do not put open questions inside the story by default.

## Evidence Rules

- Include diagnostic evidence and reference links when they explain why the story exists or make the work auditable later.
- Prefer embedding links, timestamps, monitors, notebooks, Confluence pages, metric windows, or log queries in the narrative sentence that uses them.
- Preserve exact log or error messages in fenced code blocks when the work is tied to that signal.
- Summarize noisy evidence, but keep exact snippets that future readers may need to search for.
- Do not dump unrelated investigation artifacts.

## Writing Rules

- Lead with the work to be done.
- Keep the solution high level unless the user explicitly asks for more detail.
- Prefer concise prose over rigid templates.
- Use bullets only when they make scope or impacted areas easier to scan.
- Include context that explains the why; exclude command-level steps and implementation play-by-play unless they materially define the requested work.
- Do not invent business value; if the value is obvious or minimal, keep it simple.
- Do not add acceptance criteria by default.

## Avoid

- open questions inside the Jira story
- implementation plans or command-level steps
- discovery chronology or development diary detail
- AI-process narration
- branch names, PR links, or review-state housekeeping
- boilerplate acceptance criteria
- inflated value statements for routine work
- unrelated evidence dumps

## Output

Return only the Jira-ready artifact unless the user asks for explanation:

```md
Title: <short action-oriented title>

<short narrative description with inline evidence when useful>

Scope:
<short scope list, if useful>
```
