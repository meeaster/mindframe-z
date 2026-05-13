# Jira Writer Sources

## Source Inventory

- Initial user preference: Jira stories should stay high-level, lightweight, and avoid unnecessary implementation detail.
- Iteration feedback from the Datadog agent/tracer story: Jira stories should also preserve the why, relevant evidence, and audit context when those details explain why the work exists.
- Prior local `jira-writer` and `reader-first-writing` skills were used as reference material, not copied as runtime dependencies.

## Decisions

- Keep `SKILL.md` inline and runtime-only; the workflow is still simple enough to avoid routed references.
- Treat Jira stories as coherent narratives first, not fixed templates or reference dumps.
- Inline evidence when it supports the story flow; use an end section only when a reference is useful but interrupts readability.
- Preserve exact log/error snippets when a future reader may need to search for or recognize the signal again.
- Keep iteration examples in `references/evidence/` as maintenance evidence, not runtime-loaded guidance.

## Changelog

- 2026-05-13: Created `jira-writer` as a simple inline skill focused on high-level Jira stories.
- 2026-05-13: Updated guidance to preserve narrative context, inline evidence, and auditability based on the Datadog agent/tracer story iteration.
