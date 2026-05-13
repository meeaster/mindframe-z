# Jira Writer Specification

## Intent

`jira-writer` creates concise, narrative-first Jira stories that help teams understand why work exists, what needs to be done, and what durable context matters for future auditability.

The skill favors practical work definition over exhaustive templates. Stories should be easy to read top-to-bottom, easy to pick up, and proportional to the complexity of the work.

## Scope

In scope:

- Drafting Jira stories from rough notes, requirements, discovery, bug reports, or implementation ideas.
- Rewriting Jira story descriptions to be clearer, shorter, and more actionable.
- Preserving relevant evidence, links, logs, timestamps, and scope context when they explain why the work exists.
- Choosing whether lightweight scope or value sections are useful.

Out of scope:

- Jira transition comments, status updates, or Done comments.
- Detailed implementation plans unless explicitly requested.
- Default acceptance-criteria generation.
- Jira API operations or ticket creation through an external service.

## Users And Trigger Context

- Primary users: agents helping draft work items for human teams.
- Common user requests: "draft a Jira story", "create a Jira ticket", "turn this into a story", "rewrite this Jira description".
- Should not trigger for: code implementation, PR descriptions, PR review comments, generic writing, or Jira API automation.

## Runtime Contract

- Required first actions: identify the requested work and the context that explains why it exists.
- Required outputs: a Jira-ready title and narrative description, with inline evidence, value, or scope only when useful.
- Non-negotiable constraints: do not put open questions in the story by default; do not add acceptance criteria by default; preserve exact diagnostic snippets when they explain the work; do not include implementation specifics unless they define the work.
- Expected bundled files loaded at runtime: `SKILL.md` only.

## Source And Evidence Model

Authoritative sources:

- User preference in the creation request: Jira stories should stay high level, lightweight, and not overcomplicated.
- User preference from iteration: stories should preserve the why, inline useful evidence, and support future auditability while still reading naturally.
- Prior local `jira-writer` and `reader-first-writing` skills used only as reference material.

Useful improvement sources:

- positive examples: Jira stories the user says are useful and appropriately scoped.
- negative examples: stories that are too detailed, too templated, or too implementation-heavy.
- validation results: structural skill validation and user feedback.

Data that must not be stored:

- secrets
- customer data
- private URLs or identifiers not needed for reproduction

## Reference Architecture

- `SKILL.md` contains all runtime instructions.
- `SOURCES.md` contains source decisions and change history.
- `references/` contains maintenance evidence only by default.
- `references/evidence/` contains anonymized examples used for future iteration.
- `scripts/` contains no runtime scripts.
- `assets/` contains no templates.

## Validation

- Lightweight validation: run the skill structural validator against the skill directory.
- Deeper validation: compare draft outputs against positive and negative examples after enough real usage exists.
- Holdout examples: none yet.
- Acceptance gates: concise trigger description, valid frontmatter, no missing bundled references, and runtime guidance that keeps stories narrative-first without implementation play-by-play.

## Known Limitations

- The skill does not create or update Jira issues through an API.
- The skill intentionally avoids forcing acceptance criteria, so teams that require strict Jira templates must request them explicitly.

## Maintenance Notes

- Update `SKILL.md` when output shape, trigger behavior, or story constraints change.
- Update `SOURCES.md` when source decisions, changelog entries, or evidence handling changes.
- Update `references/evidence/` when preserving anonymized examples would improve future revisions.
