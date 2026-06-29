---
name: skill-patterns
description: The rendered forms a well-written skill takes on the page — frontmatter shapes, opening lines, step-and-criterion blocks, glossary entries, composition moves, prose habits. Use when writing or reviewing a SKILL.md, when another skill needs the authoring forms, or alongside the /writing-great-skills doctrine.
---

# Skill Patterns

**Source:** Matt Pocock's skills, [github.com/mattpocock/skills](https://github.com/mattpocock/skills), commit `5d78bd0` (2026-06-25), surveyed 2026-06-28.

The `/writing-great-skills` skill names the **levers** — **predictability**, the two loads, the **information hierarchy**, **leading words**, the **failure modes**. This catalogues the **forms** those levers take on the page: the concrete, repeatable shapes you copy when you write one. Reach for a lever there; reach for its form here.

Every form below is *observed* — lifted from skills that already ship, not invented. So this skill is itself a form: an all-**reference** catalogue, a flat peer-set, the arrangement `codebase-design` and `writing-great-skills` use. Read the doctrine for *why* a form works; read this for *what it looks like*. Don't restate the why — when a form needs justifying, run `/writing-great-skills` and point at its GLOSSARY rather than re-explaining here.

**Bold terms** belong to that GLOSSARY — look them up there.

## Frontmatter forms

- **The name is the leading word.** kebab-case, matching the folder, and the word you both type to invoke and repeat through the body — `tdd`, `prototype`, `triage`, `seam`. Pick a word the model already holds.
- **Two description shapes, one per invocation axis.** Model-invoked: essence first, then a trigger list, leading word front-loaded — `Test-driven development. Use when the user wants to build features test-first, mentions "red-green-refactor", or wants integration tests.` User-invoked: one human-facing line, triggers stripped, plus `disable-model-invocation: true` in the frontmatter.
- **One trigger per branch.** Synonyms renaming a single **branch** are **duplication** — collapse them, keep only genuinely distinct paths.
- **`argument-hint` when the skill consumes input** — `argument-hint: "What would you like to learn about?"` — so the human sees what to pass.

## Opening forms

- **Essence line.** The first sentence states what the skill *is*, bolding the leading word: *A prototype is **throwaway code that answers a question**.* One line; everything after elaborates it.
- **Name the crux.** When one phase carries the whole skill, say so and concentrate effort there: *"**This is the skill.** Everything else is mechanical."* — then *"Spend disproportionate effort here."*
- **Skip-discipline preamble.** For a phased skill, set the default to thorough up front: *"A discipline for hard bugs. Skip phases only when explicitly justified."*

## Body forms

- **Numbered phase closing on a completion criterion.** `### 1. Name`, each phase ending on a *checkable* bar — usually a `- [ ]` checklist. Make the bar *exhaustive* where it matters (*"every remaining element is load-bearing"*, not *"shrink the repro"*); a vague bar invites **premature completion**.
- **WRONG / RIGHT contrast.** Render an anti-pattern and its fix side by side in one fenced block, so the gap is visible at a glance (TDD's horizontal-vs-vertical slicing).
- **Glossary block.** `**Term** — definition. _Avoid_: synonym, synonym`. The `_Avoid_` line is load-bearing: it steers the agent off the near-synonyms it would otherwise drift into (`module` not `component`/`service`; `seam` not `boundary`).
- **Relationships list.** After a glossary, pin how the terms connect: *"A **Module** has exactly one **Interface**… An **Adapter** sits at a **Seam**."*
- **Durable template.** Templates live in `<xml-tag>…</xml-tag>` or a fenced block. Describe behaviour, interfaces, and types — never file paths or line numbers, which go stale before the work starts.
- **ASCII shape diagram.** A box drawing when the point *is* the shape — a deep module (small interface, tall implementation) versus a shallow one.
- **Branch selector.** *"Pick a branch"* → **context pointers** each worded with the *condition* that fires it: *'"Does this logic feel right?" → LOGIC.md'*. The wording, not the target, decides reach.

## Composition forms

- **`/skill`-prose invocation.** Compose by naming the skill in prose — *"Run the `/grilling` skill"* — never a deep `../other-skill/FILE.md` link. Shared reference lives in the skill that owns it; other skills reach it by invoking it.
- **Thin orchestrator.** A whole skill can be one line that fires others: `grill-me` is *"Run a `/grilling` session."* Spend a skill name only to give a path its own trigger.
- **Router.** A user-invoked skill that maps the rest — main flow, on-ramps, standalone — so the human remembers one name instead of many (`ask-matt`). Cures **cognitive load**.
- **Shared-reference skill.** A model-invoked skill that is all glossary, invoked by others for the vocabulary (`codebase-design`). One home for reference several skills need.

## Prose forms

- **Repeat the leading word as a token, never as a sentence.** *tight*, *red*, *seam*, *tracer bullet* recur as bare words; each appearance recruits the same prior and accretes a distributed definition. A triad spelled out at three sites is begging to **collapse** into one word.
- **Inline rationale.** A short *"Why bother: …"* after a demanding step keeps the agent bought in without a paragraph of justification.
- **Imperative and terse.** Second person, em-dashes, no hedging. Then hunt **no-ops** sentence by sentence — cut any line the model already obeys by default.

For full copy-paste skeletons of the four archetypes — phased step-skill, reference-skill, thin orchestrator, router — see [SKELETONS.md](SKELETONS.md).
