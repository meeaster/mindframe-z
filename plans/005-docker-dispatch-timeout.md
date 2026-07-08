# Plan 005: Give thread docker dispatches a timeout that kills the container and fails the run cleanly

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/thread/runner.ts src/thread/runner.test.ts`
> Plan 003 is EXPECTED to have touched `runner.ts` (mount args). Compare the
> `runProcess` excerpt below against the live code; on a mismatch there,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (merge-order note: plan 003 also edits `runner.ts` — rebase on whichever lands first)
- **Category**: bug
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

Every thread dispatch (`gather`, `synthesize`, `digest`, `triage`) runs an agent via `docker run --rm -i` and awaits it with no timeout of any kind. A hung agent — model stall, network hang inside the container — blocks the awaiting `dispatch` forever; since ingest and sweep await dispatches, one hang wedges the entire run until the operator kills the CLI, and the `finally` cleanup of the transcript temp dir never executes. A timeout that force-removes the container and rejects turns an indefinite wedge into a clean, reported failure.

## Current state

- `src/thread/runner.ts:474-488` — the process runner, settles only on close/error:

  ```ts
  function runProcess(command: string, args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `${command} exited with status ${code}`));
      });
      child.stdin.end(stdin);
    });
  }
  ```

- `src/thread/runner.ts:111-131` — the call site inside `DockerAgentRunner.run`: `runProcess("docker", ["run", "--rm", "-i", ...env/mount args..., this.image, tool, ...args], request.prompt)`. There is no `--name`, so the container can't be addressed for cleanup.
- Docker subtlety the design must respect: SIGKILL-ing the `docker run` **client** does not kill the container. The reliable kill is `docker rm -f <name>`, which requires naming the container at start.
- Long dispatches are legitimate: synthesize runs use high-effort models over large dossiers (see `docs/tuning-thread-outputs.md`). The default must be generous — 30 minutes.
- Test-seam convention in this file: private helpers get `export const <name>ForTest = <name>;` (see `runner.ts:367,394`).
- TS conventions: strict, `exactOptionalPropertyTypes` (`x?: T | undefined`), `.js` import extensions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Thread tests | `pnpm test:thread` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/thread/runner.ts`
- `src/thread/runner.test.ts`

**Out of scope** (do NOT touch):
- `src/sandbox/**` — interactive sandbox sessions are user-attended; no timeout wanted there.
- Retry logic — a timed-out dispatch fails the run; retrying is the operator's call.
- Making the timeout configurable via profile/manifest — YAGNI per repo convention ("Test before you add a config option", `docs/tuning-thread-outputs.md`); a constant is enough until proven otherwise.

## Git workflow

- Branch: `advisor/005-dispatch-timeout`
- Commit: `fix(thread): time out hung dispatch containers instead of wedging the run`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend `runProcess` with timeout + onTimeout hook

Change the signature to:

```ts
const DISPATCH_TIMEOUT_MS = 30 * 60_000;

function runProcess(
  command: string,
  args: string[],
  stdin: string,
  options?: { timeoutMs?: number | undefined; onTimeout?: (() => Promise<void>) | undefined }
): Promise<string> {
```

Behavior: start a `setTimeout` for `options?.timeoutMs` (skip when undefined). On fire: run `await options?.onTimeout?.()` (best-effort — swallow its errors into the rejection message), then `child.kill("SIGKILL")`, then reject with `new Error(\`${command} timed out after ${timeoutMs}ms\`)`. Guard so only the first settle wins (a `settled` boolean), and `clearTimeout` in the close/error handlers. Add `export const runProcessForTest = runProcess;` per the file's convention.

**Verify**: `pnpm build` → exit 0.

### Step 2: Name the container and wire the timeout at the dispatch call site

In `DockerAgentRunner.run`:

1. Generate a unique name: `const containerName = \`mfz-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}\`;`
2. Add `"--name", containerName,` right after `"-i",` in the args array.
3. Pass options to `runProcess`:

```ts
const rawTrace = await runProcess("docker", [...], request.prompt, {
  timeoutMs: DISPATCH_TIMEOUT_MS,
  onTimeout: async () => {
    await runProcess("docker", ["rm", "-f", containerName], "").catch(() => undefined);
  }
});
```

`docker rm -f` kills and removes the container, which also causes the hung client to exit; the SIGKILL in step 1 is the belt-and-braces for a hung client itself. Add a one-line comment explaining why `--name` + `rm -f` (killing the client alone leaves the container running).

**Verify**: `pnpm build` → exit 0.

### Step 3: Tests

In `src/thread/runner.test.ts`, using `runProcessForTest` (no docker required):

1. **Timeout fires**: `runProcessForTest("sleep", ["5"], "", { timeoutMs: 100 })` rejects within ~1s with a message containing `timed out`.
2. **onTimeout runs**: same call with an `onTimeout` spy — assert it was invoked once.
3. **No spurious timeout**: `runProcessForTest("echo", ["ok"], "", { timeoutMs: 5000 })` resolves to `"ok\n"`.
4. **No timer leak**: after the success case, the test completes promptly (vitest will hang the worker if the timer keeps the loop alive — use `unref()` on the timer OR clearTimeout on settle; assert by the suite not timing out).

**Verify**: `pnpm test:thread` → all pass, including 3–4 new tests, and the suite does not hang.

## Test plan

- The unit tests above in `src/thread/runner.test.ts`, modeled on the file's existing `...ForTest` tests. They use `sleep`/`echo`, not docker, so they run anywhere.
- Verification: `pnpm test:thread` → all pass; `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "DISPATCH_TIMEOUT_MS" src/thread/runner.ts` → constant defined and used at the dispatch call site
- [ ] `grep -n '"--name"' src/thread/runner.ts` → container is named
- [ ] `pnpm test:thread` exits 0, including the new timeout tests
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `runProcess` no longer matches the excerpt (drift beyond plan 003's mount edits).
- Existing runner tests spawn `runProcess` with real docker and would now need docker to pass — report rather than adding docker to the test path.
- You find an existing cancellation/timeout mechanism elsewhere in the dispatch path (would mean this plan duplicates it).

## Maintenance notes

- If a future stage legitimately exceeds 30 minutes, raise `DISPATCH_TIMEOUT_MS` — and only then consider per-stage values; resist a config knob until an experiment demands it.
- Reviewers: check the timer is cleared/unref'd on all settle paths — a leaked timer keeps short-lived CLI processes alive.
- Interaction: plan 008 (cross-process lock) wraps the same commands; a timeout firing must still release that lock (it will, via the `finally` in the lock wrapper — verify when both have landed).
