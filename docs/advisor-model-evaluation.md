# Advisor Model Evaluation Protocol and Results

This document records a repeatable method for comparing advisor models behind
the same OpenCode executor. It also records the July 14, 2026 pilot and
five-turn Sol-versus-Terra evaluation.

The long-term goal is not to name one globally best advisor. It is to build a
paired corpus that shows which advisor is most useful for particular task
classes, how often auto mode consults it, and whether any quality improvement
justifies the additional cost.

## Evaluation Question

The system under test has two model roles:

- The executor performs the task and writes the user-visible response.
- The advisor reviews the executor context and returns guidance to the
  executor.

An advisor comparison must therefore distinguish two questions:

1. **End-to-end usefulness:** Which executor-plus-advisor lane produces the
   better result over a realistic conversation?
2. **Advisor quality:** Given its lane's context, which advisor identifies more
   important constraints, corrects more mistakes, and supplies more useful
   guidance?

A live multi-turn test answers the first question better than the second. The
lanes naturally diverge after their first responses, so later advisors do not
receive identical transcripts. A frozen-transcript comparison can supplement
the live test when pure advisor quality is the primary question.

## Core Method

Use **matched external inputs with natural internal divergence**:

- Use the same executor model and variant in both lanes.
- Change only the advisor model.
- Prewrite every user prompt before either lane starts.
- Send the same prompt to both lanes in lockstep.
- Do not show one lane the other lane's output.
- Do not tailor follow-up prompts to one lane.
- Allow executor responses, tool use, advisor calls, and conclusions to diverge.

This controls the evaluator's interventions without suppressing the behavior
the test is intended to measure.

Fully independent follow-ups are more conversational, but they confound advisor
quality with prompt quality. For paired model selection, use them only in a
separate ecological-validity test.

## Reusable Protocol

### 1. Select a Scenario

Run an independent, read-only exploration agent before writing prompts. Ask it
to identify repository-grounded problems that:

- Require broad source inspection and nontrivial tradeoffs.
- Have evidence against which recommendations can be checked.
- Are not already settled by an accepted design or implementation plan.
- Support escalating constraints across multiple turns.
- Can remain read-only, or can run in isolated worktrees.
- Are novel to the sessions being tested.

The exploration report should identify relevant files, settled invariants,
open questions, and work-in-progress areas that should not be treated as ground
truth.

### 2. Preregister the Conversation

Write all prompts before launching either lane. A useful five-turn sequence is:

1. Initial investigation and recommendation.
2. New identity, lifecycle, or compatibility constraints.
3. Operational and security boundaries, plus a challenge to the current
   recommendation.
4. Adversarial failure, testing, and observability requirements.
5. A final decision memo that reconciles the earlier turns.

Prompts should refer generically to the lane's previous answer. They must not
contain observations gathered from the other lane after the test starts.

### 3. Isolate the Lanes

Each lane needs a fresh process and unique values for:

- `OPENCODE_DB`
- `OPENCODE_ADVISOR_STATE_ROOT`
- `OPENCODE_ADVISOR_SETTINGS_PATH`

Use inline process environment variables. Shell startup and mise initialization
can override environment supplied only when a pane is created.

Example command templates:

```sh
env \
  OPENCODE_DB="$RUN_ROOT/sol/opencode.db" \
  OPENCODE_ADVISOR_MODE=auto \
  OPENCODE_ADVISOR_MODELS=opencode:openai/gpt-5.6-sol@high \
  OPENCODE_ADVISOR_NATIVE_MODE=continuation \
  OPENCODE_ADVISOR_PROMPT=gpt56 \
  OPENCODE_ADVISOR_EXECUTOR_CONTEXT=1 \
  OPENCODE_ADVISOR_STATE_ROOT="$RUN_ROOT/sol/state" \
  OPENCODE_ADVISOR_SETTINGS_PATH="$RUN_ROOT/sol/settings.json" \
  opencode --auto --model openai/gpt-5.6-luna
```

```sh
env \
  OPENCODE_DB="$RUN_ROOT/terra/opencode.db" \
  OPENCODE_ADVISOR_MODE=auto \
  OPENCODE_ADVISOR_MODELS=opencode:openai/gpt-5.6-terra@high \
  OPENCODE_ADVISOR_NATIVE_MODE=continuation \
  OPENCODE_ADVISOR_PROMPT=gpt56 \
  OPENCODE_ADVISOR_EXECUTOR_CONTEXT=1 \
  OPENCODE_ADVISOR_STATE_ROOT="$RUN_ROOT/terra/state" \
  OPENCODE_ADVISOR_SETTINGS_PATH="$RUN_ROOT/terra/settings.json" \
  opencode --auto --model openai/gpt-5.6-luna
```

Verify the executor model and variant in the TUI before sending the first
prompt. Verify the recorded executor and advisor model metadata in each database
after the run. OpenCode 1.18.1 rejected a top-level `--variant high` flag in this
environment; the configured model default selected Luna high, which was visible
in the TUI and recorded in session metadata.

For read-only investigations, both lanes may use the same clean checkout. For
implementation tasks, use separate worktrees at the same commit.

### 4. Run in Lockstep

For each turn:

1. Send the identical prompt to both lanes.
2. Confirm both lanes entered the working state.
3. Wait until both are idle or done.
4. Do not advance the completed lane while the other remains active.
5. Record unexpected permissions, failures, compaction, or operator input.

Compaction is a test event. If only one lane compacts, preserve the result but
flag the run as having unequal context handling.

### 5. Preserve Evidence

Retain the lane databases after the run. They contain the authoritative session
messages, tool parts, advisor outputs, model metadata, and usage fields needed
for later analysis.

Also record:

- Run ID and date.
- Repository path, branch, and commit.
- Worktree status before and after.
- OpenCode and Herdr versions.
- Executor and advisor model IDs and variants.
- Exact prompts in order.
- Session IDs.
- Environment configuration.
- Advisor call count and timing.
- Executor and advisor usage by message or call.
- Pricing source and retrieval date.
- Blind evaluation reports and lane-to-model mapping.
- Protocol deviations.

Archived databases are reusable **for analysis**, not as the writable database
for a new test. Every new lane must start from a fresh database, advisor state
root, and settings path. Continuing an archived database would contaminate the
next run with prior sessions, settings, cache behavior, and continuation state.

OpenCode databases contain complete prompts, outputs, tool metadata, and
possibly sensitive repository context. Keep the corpus private by default. Do
not commit raw databases to this repository without a separate security and
retention decision.

### 6. Evaluate Blind

Use at least two views of the evidence.

**End-to-end transcript evaluation**

- Replace model names with Lane A and Lane B.
- Score the executor transcripts without advisor metadata.
- Verify factual claims against source and settled specifications.

Recommended weighted rubric:

| Dimension | Weight |
| --- | ---: |
| Factual correctness and repository evidence | 25% |
| Architecture and decision quality | 20% |
| Adaptation and coherence across turns | 15% |
| Failure, testing, and observability reasoning | 15% |
| Implementation staging and actionability | 15% |
| Precision, scope discipline, and absence of overclaiming | 10% |

**Raw advisor evaluation**

- Derive a stripped database containing only lane label, call order, and advisor
  output.
- Remove model IDs and pricing metadata.
- Align calls to user turns using the anonymized transcripts.
- Score factual correctness, constraint discovery, actionability, correction of
  executor assumptions, continuity, YAGNI discipline, and downstream uptake.

Use more than one independent blinded judge when practical. Record both the
winner and whether the margin is practically meaningful. A unanimous preference
with a small score difference is evidence, not a decisive model-routing rule.

### 7. Calculate Comparable Cost

Use the current catalog from <https://models.dev/api.json>. OpenCode's stored
cost was `0` for the evaluated OAuth-backed calls, so it was not useful for this
comparison.

Calculate every assistant message or advisor call separately:

```text
USD = (
  input * input_rate
  + (output + reasoning) * output_rate
  + cache_read * cache_read_rate
  + cache_write * cache_write_rate
) / 1,000,000
```

Select a context pricing tier per request, not from aggregate session tokens.
The July 14, 2026 catalog used a higher tier when:

```text
input + cache_read + cache_write > 272,000
```

Rates used for the recorded runs, in USD per million tokens:

| Model | Input | Output and reasoning | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.6-luna` | $1.00 | $6.00 | $0.10 | $1.25 |
| `openai/gpt-5.6-terra` | $2.50 | $15.00 | $0.25 | $3.125 |
| `openai/gpt-5.6-sol` | $5.00 | $30.00 | $0.50 | $6.25 |

The higher context tier doubled input and cache rates and increased output rates
to $9.00 for Luna, $22.50 for Terra, and $45.00 for Sol. No request in the
five-turn run crossed the threshold.

Treat these values as comparable API estimates, not OAuth invoices.

### 8. Interpret by Scenario

Do not collapse all runs into one global average. Tag each scenario, for example:

- Architecture and design.
- Implementation planning.
- Security or threat modeling.
- Debugging and root-cause analysis.
- Code review.
- Refactoring.
- Test strategy.
- Product or requirements analysis.

Compare quality, advisor invocation behavior, and cost within each class. The
useful routing question is usually "when does the stronger advisor change the
outcome enough to justify its cost?" rather than "which model wins overall?"

## Pilot Run

The pilot established the mechanics and exposed two protocol problems.

An initial launch attempted to set advisor models through pane environment
configuration. Shell and mise initialization replaced the intended override,
and both lanes used Terra. That run was invalid and discarded.

The corrected one-turn smoke test used inline `env` commands:

| Lane | Session | Advisor | Advisor tokens | Estimated advisor cost |
| --- | --- | --- | ---: | ---: |
| Sol | `ses_09c6138baffek3Apd6SZ2MhFVl` | `gpt-5.6-sol@high` | 90,873 | $0.6005 |
| Terra | `ses_09c61387effeMXtxKRlXZBWyX3` | `gpt-5.6-terra@high` | 81,808 | $0.2198 |

Both lanes recommended isolated state, fixed checkpoints, separate worktrees,
and paired frozen-transcript scoring. Terra was cheaper and faster in that
sample, but the live trajectories and advisor contexts differed. The pilot was
useful as a routing and capture smoke test, not as a quality winner.

## Five-Turn Evaluation

### Run Metadata

| Field | Value |
| --- | --- |
| Date | July 14, 2026 |
| Repository | `/home/mark/code/mindframe-z` |
| Branch | `main` |
| Commit | `5dd3fba9f9a3c48ddcf555697383cd88b6f13f61` |
| Worktree | Clean before and after; read-only task |
| OpenCode | `1.18.1` |
| Herdr | `0.7.3` |
| Executor | `openai/gpt-5.6-luna@high` in both lanes |
| Advisor mode | `auto`, continuation mode |
| Sol session | `ses_09c4c5cd5ffe80d939kJTpDPvJ` |
| Terra session | `ses_09c4c5c9fffeN1kW3BrsOREUo3` |
| Temporary run root | `/tmp/opencode/mfz-advisor-ab.euDknP/` |

The temporary path is evidence from this machine, not durable corpus storage.

### Scenario

An independent exploration agent surveyed the repository before prompts were
written. It recommended the unresolved cross-harness export-source question:

> Should export-only conversation sources such as a future ChatGPT export
> become first-class sweepable sources, remain explicit imports, normalize into
> archive-cache artifacts, or use another lifecycle?

The scenario required reasoning across session identity, watermarks, sweep,
quiescence, hydration, archive cache, dispatch mounts, source provenance, and
the external OpenSpec store. The task remained read-only.

### Preregistered Prompts

#### Turn 1

```text
Read-only architecture investigation. Do not edit files or create artifacts. In
this repository, decide how Mindframe-Z should support export-based conversation
sources such as a future ChatGPT export in the thread system. Should exports
become first-class sweepable session sources, remain explicit import-only
inputs, normalize into archive-cache artifacts, or use another design? Inspect
the relevant source, tests, plans, and external OpenSpec store before deciding.
Recommend one architecture, state its invariants and migration boundaries, cite
exact repository evidence, and reject the strongest alternatives. This is turn
1 of a five-turn analysis; keep a coherent decision record for later
constraints.
```

#### Turn 2

```text
Turn 2 constraint update. Assume export bundles are periodically re-downloaded
as complete snapshots; filenames and message ordering can change; duplicated,
merged, or branched conversations may share partial history; there is no API,
cheap listing, or reliable freshness signal; and sweep must not repeatedly
ingest an unchanged snapshot. Revise the turn-1 recommendation. Define canonical
source identity, conversation identity, snapshot and revision provenance,
deduplication and replacement semantics, and what changed, unchanged, vanished,
and shrank mean. Resolve how deterministic watermarks and quiescence work
without hand-waving, citing current contracts. Remain read-only.
```

#### Turn 3

```text
Turn 3 operational and security constraints. Raw exports may be very large and
untrusted; import media may be offline or removable; thread dispatch containers
must not gain broader host mounts; and current live Claude Code and OpenCode
ingestion and sweep behavior must remain stable. Specify the exact boundary
between source acquisition, normalization, archive cache, hydration, sweep,
gather, synthesis, and dispatch. State where any adapter or interface belongs
and what it must not know. Challenge the strongest assumption in your current
design, compare it against the best alternative, and revise the decision if the
evidence warrants it. Do not edit files.
```

#### Turn 4

```text
Turn 4 validation requirement. Produce an adversarial failure model and test
protocol for the architecture you now recommend. Cover crash consistency,
partial or corrupt exports, interrupted copies, duplicate snapshots,
conversation branches and rewrites, reordered messages, clock skew, concurrent
import and sweep, cache loss, schema evolution, malicious payloads, and retry
behavior. Map proposed tests to current modules and specifications,
distinguishing unit, integration, and end-to-end evidence. Define diagnostics,
provenance, and operational observability sufficient to investigate failures
without making observability authoritative or weakening read-only and fail-open
boundaries. Identify claims your tests still cannot prove. Remain read-only.
```

#### Turn 5

```text
Turn 5 final decision memo. Consolidate the five-turn investigation into one
implementable staged recommendation for the maintainer. Include the chosen
architecture, minimal first slice, explicitly deferred work, exact data model,
schema, and interface changes, compatibility and migration behavior, preserved
invariants, acceptance gates, rollback plan, top risks, and rejected
alternatives. Reconcile any contradictions or changed assumptions from earlier
turns. Cite exact repository files and specifications, and distinguish current
repository facts from your proposals. End with a concise build order and
decision summary. Do not edit files.
```

### Usage and Cost

| Metric | Luna with Sol advisor | Luna with Terra advisor |
| --- | ---: | ---: |
| Advisor calls | 6 | 5 |
| Advisor input | 179,671 | 307,221 |
| Advisor output | 4,658 | 4,210 |
| Advisor reasoning | 17,082 | 11,257 |
| Advisor cache read | 654,848 | 427,008 |
| Advisor total tokens | 856,259 | 749,696 |
| Estimated advisor cost | $1.8780 | $1.1068 |
| Estimated executor cost | $0.8977 | $0.8785 |
| Estimated lane total | **$2.7757** | **$1.9853** |

Terra was about 28.5% cheaper for the complete lane. Sol advisor cost was about
69.7% higher. Sol made two advisor calls during the first turn and one during
each later turn; Terra made one call per turn. The additional Sol call surfaced
useful source-versus-harness and sweep-signal details, but did not change the
eventual top-level architecture.

### Blinded Evaluation

Three blinded evaluations were performed:

1. A weighted, source-grounded evaluation of both executor transcripts.
2. A separate evaluation of guidance trajectory and final usefulness.
3. A raw-advisor evaluation using a stripped SQLite database containing only
   lane labels, call order, and advisor output.

Lane A was Sol and Lane B was Terra. All three evaluations preferred Lane A.

| Evaluation | Sol | Terra | Interpretation |
| --- | ---: | ---: | --- |
| Weighted end-to-end quality | 8.77 | 8.57 | Sol preferred; margin not practically large |
| Raw advisor guidance | 9.3 | 9.0 | Sol preferred for implementation safety |
| Guidance trajectory judge | Preferred | Runner-up | Sol preferred with 75% confidence |

Both lanes reached the same central recommendation:

- Keep exports explicit and import-only.
- Normalize them into immutable artifacts in a dedicated store.
- Do not reuse archive-cache.
- Do not add export sources to sweep.
- Separate session-source identity from executable harness identity.
- Narrow dispatch mounts and expose only the selected artifact.
- Preserve existing Claude Code and OpenCode behavior.

Sol's advantage appeared in implementation-critical details:

- It more consistently separated `vanished` from `unavailable` or `corrupt`.
- It limited `shrank` to a strict retained subgraph rather than a rewrite.
- It identified the gather-versus-import TOCTOU race and required immutable
  revision pins.
- It gave a stronger crash-consistency and transactional publication protocol.
- It separated logical snapshot objects from import observations in the final
  data model.

Terra's advantages were:

- Better YAGNI and first-slice discipline.
- More concise guidance.
- Stronger early use of `not_observed` for absence from a later export.
- Clear insistence on a real sanitized export fixture before fixing a schema.
- Lower cost with nearly the same top-level architecture.

The material Terra weaknesses were intermediate guidance that used `vanished`
for missing or corrupt imported artifacts, grouped rewrites with `shrank`, and
left parts of current snapshot and revision reconciliation underspecified. The
Luna executor corrected much of this by the final response.

### Conclusion From This Run

For this architecture, security, and reliability scenario, Sol provided the
better advisor guidance. Its advantage was moderate and concentrated in edge
semantics and implementation safety. Terra reached nearly the same strategic
answer with lower cost and better scope discipline.

This run supports the following provisional routing hypothesis:

- Prefer Sol for high-risk architecture involving state machines, persistence,
  concurrency, security boundaries, and failure semantics.
- Prefer Terra for lower-risk design work where strategic convergence and cost
  efficiency matter more than exhaustive edge-case precision.

This is a hypothesis for future paired tests, not a general model policy.

## Corpus Design

A future evaluation skill should store each run as an immutable evidence bundle.
The exact durable root is not decided. A private external store is preferable to
committing raw OpenCode databases to this repository.

Proposed layout:

```text
advisor-evaluations/
  runs/
    <run-id>/
      manifest.yml
      prompts.md
      pricing.json
      lane-a/
        opencode.db
      lane-b/
        opencode.db
      derived/
        transcript-a.json
        transcript-b.json
        advisor-responses.db
      evaluations/
        judge-1.md
        judge-2.md
        advisor-judge.md
      result.md
  index.yml
```

The manifest should record lane-to-model mapping separately from files supplied
to blind judges. It should include scenario tags, model variants, repository
commit, session IDs, environment settings, protocol deviations, and hashes of
the evidence files.

The aggregate index should store normalized results, not replace run-level
evidence. Useful fields include:

- Scenario tags.
- Pair of executor and advisor models.
- Conversation length.
- Advisor call count.
- Quality scores and judge agreement.
- Material factual errors.
- Estimated executor, advisor, and total cost.
- Context tier usage.
- Compaction or failure events.
- Human review outcome.

## Skill Roadmap

A reusable skill can eventually automate these stages:

1. **Explore:** dispatch a read-only repository explorer and propose candidate
   scenarios.
2. **Prepare:** preregister prompts, rubric, run manifest, and lane mapping.
3. **Launch:** create isolated databases, advisor state, settings, panes, and
   worktrees when required.
4. **Run:** send prompts in lockstep and record state transitions.
5. **Collect:** verify model routing, export transcripts, extract advisor calls,
   and calculate catalog-based cost.
6. **Blind:** produce model-free transcript and advisor evidence bundles.
7. **Judge:** run independent evaluators and retain disagreements.
8. **Report:** write the run result and update the aggregate index.

The skill should never silently reuse a writable database or advisor continuation
state. It should fail the run when model routing cannot be verified, record
invalid runs rather than deleting their evidence, and keep pricing snapshots
separate from provider billing claims.

## Remaining Limitations

- The five-turn test used one repository and one architecture scenario.
- Live lanes do not isolate pure advisor capability after their transcripts
  diverge.
- Auto-mode call count is part of system behavior but also changes cost and the
  amount of guidance received.
- Model judges can share blind spots even when run independently.
- A human maintainer did not independently score the final architecture.
- API estimates do not represent OAuth billing.
- Temporary run paths are not durable evidence storage.

Future runs should vary scenario class, repeat representative scenarios, and add
human review where the recommendation could drive expensive or security-critical
work.
