# Plan 016: Spike a minimal `mfz thread eval` — stage-only dispatch over held-constant input (design/spike)

> **Executor instructions**: This is a **spike plan** — the deliverable is a
> minimal working command plus a written findings section, not a polished
> feature. Follow the steps, honor the STOP conditions, and keep the
> anti-scope rules (no config knobs). When done, update the status row in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/thread/cli.ts src/thread/dispatch.ts src/thread/runner.ts docs/tuning-thread-outputs.md`
> Plans 003/005/008 legitimately touch runner/cli. What matters: `dispatch`
> and `DockerAgentRunner` are still exported and the tuning doc still
> prescribes throwaway scripts. On a mismatch there, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW-MED (additive command; risk is over-building)
- **Depends on**: none (interacts with 005/008 — see maintenance notes)
- **Category**: direction
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

The maintainer's own tuning playbook (`docs/tuning-thread-outputs.md`) instructs writing **throwaway scripts under `scripts/`** that import `dispatch` + `DockerAgentRunner` to run a single pipeline stage over a held-constant input, then deleting them — a written procedure performed by hand, repeatedly. `ARCHITECTURE.md` lists an "eval suite" among not-yet-implemented thread features. Absorbing the playbook's exact method into a first-class `mfz thread eval` makes model/prompt/effort tuning repeatable and comparable without re-writing the same script. The tuning doc also warns: "A config knob is permanent branching. Run the experiment first" — so this spike builds only the levers the playbook already proves necessary.

## Current state

- The method to encode, from `docs/tuning-thread-outputs.md` ("Running a cheap, isolated experiment"), verbatim principles:
  - **Stage-only dispatch**: run just the gather, or just the digest, over a held-constant input; judge a gather-only run by reading its dossier.
  - **Hold the input constant**: feed variants the same saved dossier (`~/.mindframe-z/thread-runs/runs/<id>/dossiers/`).
  - **Recover baselines from git** rather than re-running.
  - **Same prompt across models** or same model across prompts — one variable at a time.
- Pipeline stages: `gather → synthesize → digest` (see the same doc's funnel section). Stage dispatch machinery: `dispatch` (in `src/thread/dispatch.ts`) and `DockerAgentRunner` (`src/thread/runner.ts`) — the tuning doc names these as the exact imports the throwaway scripts use. Personas live in `src/thread/personas.ts` (`THREAD_PERSONAS`); the synthesizer/digest artifact contract in `src/thread/contract.ts` / `src/thread/thread-contract/` (see `ARCHITECTURE.md` "Dispatch uses src/thread/runner.ts…").
- Cost/usage is already parsed per dispatch (`AgentRunResult.usage`, used for `runs.json`) — the eval reuses it for its cost report.
- Model id parsing: `parseModelId` in `src/thread/storage.ts` (`<harness>:<model>@<effort>` format, e.g. `claude-code:haiku@low`).
- CLI wiring exemplar: any existing `thread` subcommand in `src/cli/mfz.ts` (lines ~545+) delegating to `src/thread/cli.ts` `run...` functions.
- Dossier snapshots on disk: `~/.mindframe-z/threads/runs/<run-id>/` holds `status.json`, traces, and dossier snapshots (`src/thread/observability.ts:104` writes `<source>-<id>.md` dossier files). Operational, machine-local, not pushed.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Thread tests | `pnpm test:thread` | all pass |
| Run the new command | `pnpm dev thread eval --help` | usage text |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope**:
- `src/thread/eval.ts` (create) + `src/thread/eval.test.ts` (create)
- `src/thread/cli.ts` and `src/cli/mfz.ts` (register the subcommand)
- `docs/tuning-thread-outputs.md` (replace the "write a throwaway script" instruction with the command, once it works)
- A findings section appended to this plan file (spike output)

**Out of scope** (anti-scope — the spike fails if these creep in):
- Config knobs in profiles/manifests for eval behavior — CLI flags only, and only the four below.
- Comparison/diff/scoring features, result databases, HTML reports.
- Batch/matrix runs (N models × M prompts) — one dispatch per invocation.
- Touching ingest/sweep behavior.

## Git workflow

- Branch: `advisor/016-thread-eval-spike`
- Commit: `feat(thread): add stage-only eval dispatch for tuning experiments`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the seams

Read `src/thread/dispatch.ts` (exported `dispatch` signature), `src/thread/runner.ts` (`AgentRunRequest` fields: role, harness, model, effort, persona, skills, sessionSources, prompt, files), `src/thread/personas.ts`, and how ingest builds a synthesize prompt from a dossier (find the synthesize call site in `src/thread/ingest.ts`). Record in the findings section: the exact function you can call per stage and what input each stage needs (gather: session ref; synthesize: dossier text; digest: session files/log — confirm from code).

**Verify**: you can name, with file:line, the call path for each of the three stages.

### Step 2: Implement the minimal command

`mfz thread eval --stage <gather|synthesize|digest> --model <harness:model@effort> [--input <path>] [--session <source:id>]`

- `--stage synthesize --input <dossier.md>`: dispatch the synthesize persona over the file's content; write output + raw trace under a fresh `~/.mindframe-z/threads/runs/<run-id>/` (reuse `writeRunStatus`/`writeRunTrace` from `src/thread/observability.ts`).
- `--stage gather --session <source:id>`: dispatch the gather persona against the session (reuse ingest's gather-request construction).
- `--stage digest --input <dir-or-file>`: same pattern over digest input (whatever step 1 showed digest consumes).
- Print, tab-separated: stage, model, `cost_usd`, duration, and the output path. Nothing else.
- Reuse `parseModelId` for `--model`; default nothing — every eval names its model explicitly (that's the experiment variable).

**Verify**: `pnpm build` → exit 0; `pnpm dev thread eval --help` shows the flags.

### Step 3: Test the non-docker logic

`src/thread/eval.test.ts`: with a stub `AgentRunner` (the seam sweep tests already use — see `runSweep`'s `runner?` arg for the pattern), cover: input file read → prompt construction per stage; output + status written under a run dir; the printed summary shape. No docker in tests.

**Verify**: `pnpm test:thread` → all pass including the new file.

### Step 4: One real experiment + findings

If docker and a saved dossier exist locally: run one real `--stage synthesize` eval over a saved dossier with a cheap model. Then append a `## Spike findings` section to this plan file answering:

1. Did the stage seams hold, or did any stage need refactoring to be callable standalone? (List any seams that were awkward — that's phase-2 input.)
2. What did the run cost, and did the cost surface match `runs.json`'s numbers?
3. Which (if any) additional lever did the experiment *prove* necessary — and which tempting levers were resisted?
4. Recommendation: promote as-is / extend / abandon.

If no docker/dossier available, answer 1 and 3 from code and mark 2 as not-run.

**Verify**: the findings section exists and answers all four questions.

### Step 5: Update the tuning doc

In `docs/tuning-thread-outputs.md`, replace the throwaway-script instruction with the eval command (keep the principles text; only the mechanics change).

**Verify**: `grep -n "throwaway" docs/tuning-thread-outputs.md` → no remaining instruction to write scripts (context mentions are fine).

## Test plan

Step 3's stub-runner tests; the one real dispatch in step 4 is the end-to-end proof, optional by environment.

## Done criteria

- [ ] `pnpm dev thread eval --help` exits 0 with exactly the four flags above
- [ ] `pnpm test:thread` and `pnpm check` exit 0
- [ ] `## Spike findings` section appended to this file, all four questions answered
- [ ] `docs/tuning-thread-outputs.md` references the command instead of throwaway scripts
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A stage cannot be dispatched standalone without refactoring ingest internals — the spike's answer is then "seams first"; write that finding and stop rather than refactoring ingest here.
- You catch yourself adding a fifth flag or a profile config key — re-read the anti-scope; if it truly seems necessary, STOP and make the case in the findings instead.

## Maintenance notes

- Interacts with plan 005 (eval dispatches inherit the timeout — desirable) and plan 008 (eval writes under `threads/runs/`; decide during implementation whether it takes the store lock — it does not touch ledgers/manifests, so likely not; note the decision in findings).
- If the spike is promoted, the natural phase 2 is exactly what the findings' question 1 surfaces — not a feature list invented up front.
