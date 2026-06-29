---
name: adversarial-code-review
description: Adversarial code review — dispatch the current branch to a two-engine panel (Claude Opus + GPT-5.5), each running the thermo-nuclear review, then chair the merge into consensus/split findings. User-invoked.
disable-model-invocation: true
---

# Adversarial Code Review

Run the current branch's changes past a **panel** of two independent engines — Claude Opus and GPT-5.5 — each loading the `thermo-nuclear-code-quality-review` skill, then **chair** the merge of their verdicts.

You are the chair, not a third reviewer. You read the same case the panel did so you can weigh its findings — confirm, downgrade, or reject — instead of rubber-stamping two pasted reviews. Disagreement between the engines is the signal:

- **Consensus** — both engines raise it. High conviction; lead with these.
- **Split** — only one engine raises it. Real but weaker; keep it, attributed to the engine that raised it.

## 1. Fix the scope

Resolve the base and capture the exact diff range both engines will review:

```bash
git merge-base HEAD master
```

Done when you have the range (base SHA `..HEAD`) and know it is non-empty.

## 2. Dispatch the panel in parallel

Launch both engines as **background** commands so they run concurrently while you read the case, each loading the thermo-nuclear skill by slash command and writing to its own file:

```bash
claude -p "/thermo-nuclear-code-quality-review Review the current branch's diff against master." \
  --model opus --effort high \
  --allowedTools "Read Grep Glob Bash(git *)" \
  --output-format text > /tmp/adv-review-opus.md 2>&1
```

```bash
opencode run "/thermo-nuclear-code-quality-review Review the current branch's diff against master." \
  -m openai/gpt-5.5 --variant high \
  --dangerously-skip-permissions > /tmp/adv-review-gpt.md 2>&1
```

Done when both background runs are launched.

## 3. Read the case and the rubric while the panel runs

Build your own understanding of both the change and the bar the panel is held to:

- Read the **rubric** the panel runs — `~/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md` — so you adjudicate against the same standard the engines were given, not your own. Read it, do not invoke it; you are the chair, not a reviewer.
- Read the **whole diff** (`git diff <base>..HEAD`) and every file it touches **in full** — not just the lines that changed.
- Load an unchanged file only when a specific finding turns on it (a named caller, helper, or type). Do not pre-read the wider codebase.

Done when you hold the rubric and understand every changed file well enough to judge a finding about it.

## 4. Collect both reviews

Wait for both background runs to finish, then read both files. Verify each is a real review — non-empty, no auth/tool/launch error. If one engine failed, report which and why; do not silently present a one-engine panel as a full one.

Done when you hold both engines' full review text.

## 5. Chair the merge

Produce one merged report:

- Classify **every** finding from both reviews as **consensus** or **split** (attribute split findings to Opus or GPT-5.5).
- Adjudicate each against the case and the rubric you read: confirm it, downgrade it, or reject it with a reason. Do not pass through a finding you cannot stand behind.
- Order surviving findings by the rubric's priority ranking (structural regressions first, legibility last) — do not invent a new ranking.
- For each, give a concrete recommended change aligned with the rubric's remedies (delete indirection, decompose the file, isolate the branch behind an abstraction, reuse the canonical helper, etc.).

Done when every finding from both reviews is accounted for — confirmed, downgraded, or rejected — with no silent drops.

## 6. Ask before implementing

Stop at recommendations. Ask the user whether to implement them before changing any code; never apply the changes automatically.
