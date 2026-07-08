# Plan 017: Run the lapdog cost-span envelope spike (feasibility gate for the observability build-out)

> **Executor instructions**: This is a **spike plan** — the deliverable is a
> written findings document, not production code. Follow the steps, honor the
> STOP conditions. When done, update the status row in `plans/README.md` —
> unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `grep -c '\[x\]' openspec/changes/lapdog-thread-observability/tasks.md`
> If the container/hooks/cost-span tasks are already checked (not just the
> observe-surface ones plan 011 corrects), this spike is moot; STOP and report.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (read/probe only; no production code changes)
- **Depends on**: none (plan 011 corrects the surrounding task ledger; not blocking)
- **Category**: direction
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

The thread-pipeline observability build-out (local lapdog dashboard over `gather → synthesize → digest` dispatches) has a converged design, and its own handoff doc names exactly one feasibility unknown that "can nudge the design": whether a bare injected cost span renders in lapdog's dashboard, or whether lapdog requires a minimal session/trace envelope around it — and which endpoint to POST to. The design doc mandates spiking this **first** ("Build order", step 1). Answering it costs an hour with a running lapdog and de-risks the entire remaining 20+ task build; skipping it risks building the wrong emit path.

## Current state

- The design + build order live in `docs/handoff-lapdog-threads-observability.md`. Build order step 1, verbatim:

  > **SPIKE FIRST — cost-span envelope.** Against a running `mfz thread observe up` lapdog: does a bare injected cost span render in the dashboard, or does lapdog need a minimal session/trace **envelope** around it? Check whether to POST to `/v0.4/traces`, OTLP `:4318`, or `/evp_proxy/v4/api/v2/llmobs`, and what minimal shape the web UI actually displays. This is the one unknown that can nudge the design.

- Already shipped (evidence): `mfz thread observe up/down/status` (`src/cli/mfz.ts:545-566`, `src/thread/cli.ts:415-436`); cost-span construction code exists at `src/thread/cost-span.ts` (`buildCostSpanPayload`, `emitCostSpan`) and is invoked from `DockerAgentRunner.run` when lapdog is reachable (`src/thread/runner.ts:134-142`) — read these to see what shape is currently emitted and to which URL (`lapdogUrl()` in `src/thread/lapdog.ts`).
- The lapdog server itself is the reference repo at `/home/mark/references/dd-apm-test-agent` (read-only — do not modify): a DataDog APM test agent with `--lapdog-mode` and a web UI; `ddapm_test_agent/agent.py` defines its CLI flags and endpoints.
- Not-yet-built parts (what the spike informs): hooks baked into `Dockerfile.tools`, the OpenCode→Claude hook translation plugin, and the final cost-span emit path (`openspec/changes/lapdog-thread-observability/tasks.md`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Start lapdog | `pnpm dev thread observe up` | dashboard reachable |
| Status | `pnpm dev thread observe status` | reports running + URL |
| Probe endpoints | `curl -s -o /dev/null -w '%{http_code}' <lapdog-url>/v0.4/traces` (and the other two) | per-endpoint code recorded |
| Stop | `pnpm dev thread observe down` | clean shutdown |

## Scope

**In scope**:
- `docs/lapdog-cost-span-spike.md` (create — the findings document)
- Throwaway curl/node one-liners run from the shell (not committed)

**Out of scope** (do NOT touch):
- ANY production source change — `src/thread/cost-span.ts`, `runner.ts`, `Dockerfile.tools`, plugins all stay untouched.
- `/home/mark/references/dd-apm-test-agent` — read-only reference; never edit.
- Implementing build-order steps 2–5.

## Git workflow

- Branch: `advisor/017-lapdog-spike`
- Commit: `docs(thread): record lapdog cost-span envelope spike findings`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Understand what we already emit

Read `src/thread/cost-span.ts` (payload shape, target path) and `src/thread/lapdog.ts` (URL resolution, reachability probe). Record in the findings doc: current endpoint, current payload skeleton (field names only — no secrets), and whether `emitLapdogCostSpan` fire-and-forgets errors.

**Verify**: findings doc has a "Current emit path" section with file:line references.

### Step 2: Stand up lapdog and probe the three candidate ingest paths

`pnpm dev thread observe up`, confirm the dashboard loads in a browser (or curl the UI port). Consult the reference repo's `ddapm_test_agent/agent.py` (and `README`) to confirm which of `/v0.4/traces`, OTLP `:4318`, and `/evp_proxy/v4/api/v2/llmobs` are enabled in lapdog mode, then probe each with a minimal well-formed payload for that protocol (msgpack or JSON trace list for `/v0.4/traces`; OTLP JSON for `:4318`; LLMObs event for the evp proxy). For each: record request shape, response code, and — the actual question — whether anything **renders in the web UI**.

**Verify**: a findings table: endpoint × (accepted? / rendered in UI? / minimal required fields).

### Step 3: Answer the envelope question

For the most promising endpoint, strip the payload down until the UI stops rendering it: does a bare cost span render, or does the UI require an enclosing trace/session (trace_id/span_id parentage, service/session tags)? Identify the **minimal envelope** that makes a cost span visible and attributable to a session id.

**Verify**: the findings doc states, in one sentence each: (a) bare span renders yes/no; (b) the minimal envelope; (c) the recommended endpoint.

### Step 4: Write the recommendation

Conclude `docs/lapdog-cost-span-spike.md` with: recommended emit path for build-order step 5, any nudge to the design (per the handoff's warning), and whether the currently-shipped `cost-span.ts` shape already matches (if yes, say so — the build-out then starts at step 2 of the build order). Cross-link the handoff doc.

**Verify**: doc answers every question posed by handoff build-order step 1.

## Test plan

None — no production code. The findings doc is the artifact.

## Done criteria

- [ ] `docs/lapdog-cost-span-spike.md` exists, with the endpoint table and the three one-sentence answers of step 3
- [ ] `git diff --stat -- src opencode Dockerfile.tools` → empty
- [ ] `pnpm dev thread observe down` was run (no orphaned containers: `docker ps` shows no lapdog)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `mfz thread observe up` cannot start lapdog on this machine (missing image/docker) — the spike needs the live UI; report the blocker.
- The lapdog reference repo's endpoint behavior contradicts the handoff doc's three candidates entirely — record what you found and stop before deep-diving protocol archaeology beyond ~an hour.

## Maintenance notes

- The findings feed directly into `openspec/changes/lapdog-thread-observability` execution (build-order steps 2–5); whoever implements those should treat the spike doc as an input and delete/supersede it once the emit path ships.
- If the spike shows the existing `cost-span.ts` emit already renders, update the openspec tasks accordingly (that's plan-011-style ledger hygiene, one checkbox).
