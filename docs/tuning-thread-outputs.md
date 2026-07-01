# Tuning Thread Outputs — an experiment playbook

How to improve what the thread pipeline produces (session files and digests) by
adjusting its levers, and how to run an experiment that tells you which lever
actually helped before you commit to it. Written from the experiments that set the
current defaults; use it to run the next round.

## The pipeline and its levers

Ingest runs three agent stages, each writing the next stage's input:

```
raw transcript ──gather──▶ dossier ──synthesize──▶ session.md ──digest──▶ digest.md
```

Every stage has two independent levers:

- **Prompt** — the persona/instructions for that stage (`src/thread/personas.ts`), plus
  any reader skill it loads (`opencode-sessions`, `claude-code-sessions`).
- **Model + effort** — `harness:model@effort` (`profiles/<name>/profile.yml` `thread.defaults`,
  or per-thread `synthesis` overrides). Each of `gather`, `synthesize`, and `digest` is an
  independent default; an unset `digest` inherits the resolved `synthesize` id.

A fourth lever is the **reader skill** the gather loads — it controls what the gather
even sees (e.g. whether timestamps arrive pre-formatted or as raw epoch).

**Effort is not one lever — it behaves differently at each stage**, because its cost and its
quality effect both depend on the stage's shape (see the effort × stage findings below):

- **gather** runs a *tool loop* (reads the session store turn by turn), so higher effort means
  more turns and the input/cache tokens multiply — effort is a *strong* cost lever here.
- **synthesize** and **digest** are *single-shot* over an in-prompt input, so higher effort only
  adds thinking tokens to one turn — effort is a *weak* cost lever, and `max` can blow the output
  ceiling and fail the dispatch outright.

## Method

Run the levers in this order — cheapest and most diagnostic first.

1. **Diagnose before spending.** Find *which stage* dropped the quality you want before
   changing anything. Output can only be as good as its input, so trace the missing thing
   upstream (below). Changing a downstream model can never recover what an upstream stage
   already threw away.
2. **Prompt before model.** A missing nuance is usually the prompt never *asking* for it,
   not the model being unable. The model faithfully does what it was told; if the gather
   persona never mentions user pushback, even a strong model omits it. Prompt fixes are
   ~free; model upgrades multiply cost.
3. **Isolate one variable.** Hold the input constant and change exactly one lever, or the
   comparison is noise. Reuse a saved dossier to test synthesize/digest; reuse a fixed
   prompt to test gather models.
4. **Read the text, not the counts.** Counts (decisions, sources) swing ±40% run-to-run on
   identical inputs. Judge rationale density, preserved voice, and captured tensions by
   reading the artifacts, not by tallying bullets.
5. **Decide on cost/value, and tier it.** Put a dollar cost on each config and ask whether
   the quality delta is worth the cost delta. The answer is usually a tier (a cheap default
   plus a pricier setting reserved for high-value sessions), not a single winner.
6. **Test before you add a config option.** A config knob is permanent branching. Run the
   experiment first; adopt the winner as *the* implementation. Only make it configurable if
   both modes prove genuinely needed.

## Diagnosing where output is lost

Treat the pipeline as a funnel and check the intermediate artifacts directly:

```bash
# What the gather actually captured (the synthesizer can't exceed this):
grep -niE "<the nuance you want>" ~/.mindframe-z/thread-runs/runs/<run-id>/dossiers/*.md

# What the synthesizer kept (the digest can't exceed this):
awk '/^## Decisions/{f=1;next} /^## /{f=0} f' ~/.mindframe-z/threads/<slug>/sessions/<id>.md
```

If the nuance is absent in the dossier, the **gather** is the gate — fix its prompt or
model. If it is in the dossier but absent in `session.md`, the **synthesize** is the gate.
If it is in `session.md` but absent in `digest.md`, the **digest** is the gate.

Prior outputs are not lost when a re-ingest overwrites them: every ingest commits to the
thread's destination repo, so recover any past version for comparison with
`git -C <destination> show <commit>:<slug>/digest.md`.

## Running a cheap, isolated experiment

Don't pay for the whole pipeline to test one stage. Write a throwaway under `scripts/` that
imports the exported `dispatch` + `DockerAgentRunner` and runs a single stage, then delete
it when done (see the git history of `scripts/` for the gather-test and combined-experiment
shapes). Patterns that keep an experiment honest and cheap:

- **Stage-only dispatch.** Run just the gather, or just the digest, over a held-constant
  input. A gather-only run is judged by reading its dossier — no synthesize/digest needed.
- **Hold the input constant.** Feed every variant the *same* saved dossier
  (`thread-runs/runs/<id>/dossiers/`) so you measure the lever, not gather variance.
- **Recover baselines from git** rather than re-running them.
- **Same prompt across models** (or same model across prompts) — never change both at once.

## Current validated settings

The defaults these experiments produced. Update this table when a new experiment overturns one.

| Stage | Default | Higher tier | Why |
| --- | --- | --- | --- |
| gather | `haiku@low` + human-dynamics prompt (budget) | `claude-sonnet-5@low` | Choose by *model, not effort*. Sonnet 5 over haiku buys auditable `msg_`/`prt_` citations, an explicit read-coverage disclosure, and capture of discarded branches and tool-call errors that haiku omits. Effort above `low` only multiplies gather's tool-loop cost for diminishing polish. |
| synthesize | `claude-sonnet-5@low` (or `@medium`) | — | Effort barely moves cost (single-shot, fixed input) but higher effort *compresses* — it captures fewer decisions. Synthesize feeds the digest, so preserve recall here and let the digest compress. Avoid `@high` (over-compresses) and `@max` (blows the output ceiling, fails the dispatch). |
| digest | `claude-sonnet-5@low`/`@medium` | `claude-sonnet-5@high` | Independent lever now (unset inherits `synthesize`). Cheap single-shot. `low`/`medium` are content-complete but their *presentation* varies run to run (the architecture diagram / component breakdown appear inconsistently); `@high` reliably includes the full structure and, since digest *is* the compression stage, adds polish without the over-compression penalty synthesize suffers. Defensible to spend up here — it is the final, human-read artifact. |
| timestamps | deterministic SQL in the reader skill | — | Models convert epoch-ms→date unreliably; format with `strftime` in the query and copy verbatim. |

The `personal` profile uses `gather: haiku@low`, `synthesize: claude-sonnet-5@low`, `digest: claude-sonnet-5@high`.

## Findings log

- **Sonnet 5 effort × stage (two trials each, one dossier/thread held constant).** Ran
  `claude-sonnet-5` at `low`/`medium`/`high` on each stage, plus a haiku baseline on gather.
  The dominant result: **effort's cost and quality effects are stage-shaped, not uniform.**
  - *Cost.* On gather (tool loop) effort scaled cost steeply and reproducibly — `low` to `high`
    roughly doubled-to-tripled it as the loop took more turns and re-sent context. On synthesize
    and digest (single-shot) effort barely moved cost; input is a fixed majority of the bill and
    only thinking tokens grow. `sonnet5@max` on synthesize streamed ~20k thinking tokens and then
    **failed** (`docker exited with status 1`) — it blew the model's output ceiling. Do not use
    `@max` on the single-shot stages.
  - *Gather quality — model ≫ effort.* The quote-count proxy was misleading (it swung ~2× between
    identical haiku runs — measure cost and read the text instead). Reading the dossiers, the real
    jump is haiku → Sonnet 5 at *any* effort: Sonnet 5 produces auditable per-turn `msg_`/`prt_`
    citations, discloses how much of the session it read, and captures discarded design branches
    and tool-call failures that haiku silently drops. `sonnet5@low` already delivers that;
    `medium`/`high` add only marginal completeness for a steep tool-loop cost premium.
  - *Synthesize quality — recall vs compression.* Higher effort captured *fewer* decisions in both
    trials (it merges and compresses); `low`/`medium` preserved the most. Because the dossier is
    already distilled and synthesize feeds the digest, the compression at `high` is actively
    counterproductive — keep synthesize low.
  - *Digest quality — flat content, variable presentation.* All efforts captured the same key
    decisions both trials; `low`/`medium` sometimes dropped the architecture diagram / component
    breakdown, while `high` reliably kept the full structure. Digest is cheap and the final
    human-read artifact, so spending up to `@high` is the one place it pays.
- **Haiku has no effort levels.** `--effort` is a no-op on Haiku (the trace shows flat per-turn
  thinking regardless of the flag), so `haiku@low` and `haiku@high` are the same config — any
  difference between them is run-to-run variance, not an effort effect.
- **Gather prompt (highest leverage, ~free).** The original gather produced a sterile
  technical dossier with zero user quotes. Adding "capture the human dynamics — pushback,
  overrides, mind-changes, frustration — and quote their words" took Haiku from 0 → 11
  verbatim quotes at the same cost. Sonnet@high on the same prompt reached 29.
- **Synthesize model/effort.** sonnet@high 11 decisions, sonnet@max 12–20, opus@high 11,
  opus@max 14 — all within run-to-run variance (~$0.67–1.65). The text, not the count, is
  the differentiator: opus@high best preserved the user's reasoning tensions.
- **Combined synth+digest.** Sharing raw context made the digest *flatter*, not richer —
  the standout tension survived the two-pass funnel but was diluted in one overloaded pass.
- **Timestamps.** OpenCode stores epoch-ms; Claude Code stores ISO strings. The model
  fabricated wrong dates from epochs nondeterministically (two runs, two wrong dates).
  Formatting in SQL fixed it; Claude Code was never affected.
