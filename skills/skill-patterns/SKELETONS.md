# Skeletons

Copy-paste starting points for the four archetypes. Each is the skeleton of a real shipping skill stripped to its bones — fill in, then prune. The forms are catalogued in [SKILL.md](SKILL.md); these are them assembled.

## Phased step-skill

For ordered work that closes each phase on a checkable bar (`diagnosing-bugs`, `triage`, `to-issues`). Model-invoked so the agent can reach for it.

```markdown
---
name: <leading-word>
description: <Essence.> Use when the user <trigger>, mentions "<phrase>", or <trigger>.
---

# <Title>

<Essence line — what this is, in one sentence, leading word bolded.>
<Skip-discipline preamble: the default is thorough; deviate only with reason.>

## Phase 1 — <name>

**This is the skill.** <Why this phase carries the rest.>

<The work.>

### Completion criterion — <one checkable line>

- [ ] <exhaustive, checkable bar>
- [ ] <…>

If you catch yourself <the rush>, stop — <the failure this phase prevents>.

## Phase 2 — <name>

<The work, ending on its own bar.>

Do not proceed until <criterion>.
```

## Reference-skill (all glossary)

For a shared vocabulary other skills lean on (`codebase-design`, `domain-modeling`). No steps — a flat peer-set. Model-invoked so other skills can invoke it for the terms.

```markdown
---
name: <leading-word>
description: Shared vocabulary for <domain>. Use when the user wants to <task>, or when another skill needs the <domain> vocabulary.
---

# <Title>

<One line: what this vocabulary is for, and the instruction to use it exactly.>

## Glossary

Use these terms exactly — don't substitute <near-synonyms>.

**<Term>** — <definition>. _Avoid_: <synonym>, <synonym>.

**<Term>** — <definition>. _Avoid_: <synonym>.

## Principles

- **<Named principle>.** <One or two sentences.>
- **<The deletion test.>** <A checkable thought-experiment.>

## Relationships

- A **<Term>** has exactly one **<Term>**.
- A **<Term>** sits at a **<Term>**.
```

## Thin orchestrator

A whole skill that is one line firing others (`grill-me`, `grill-with-docs`, `implement`). User-invoked: it exists to give a composed path its own trigger.

```markdown
---
name: <leading-word>
description: <One human-facing line — what running this gets you.>
disable-model-invocation: true
---

Run a `/<other-skill>` session, using the `/<other-skill>` skill.
```

## Router

A user-invoked map over your other user-invoked skills, so the human remembers one name (`ask-matt`). It can only *name* them — it cannot fire a user-invoked skill.

```markdown
---
name: <leading-word>
description: Ask which skill or flow fits your situation. A router over the <set> skills.
disable-model-invocation: true
---

# <Title>

You don't remember every skill, so ask.

## The main flow: <start> → <end>

1. **`/<skill>`** — <when to start here>.
2. **Branch — <question>?**
   - **Yes** → **`/<skill>`** → **`/<skill>`**.
   - **No** → **`/<skill>`**.

## On-ramps

- **<Starting situation>** → **`/<skill>`**. <What it produces and where it merges.>

## Standalone

- **`/<skill>`** — <off the main flow entirely>.
```
