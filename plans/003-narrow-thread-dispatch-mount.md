# Plan 003: Narrow the thread-dispatch container mount from all of `~/.mindframe-z` to the archive-cache subtree

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/thread/runner.ts src/thread/runner.test.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

`mfz thread` dispatches headless agents in docker containers to read and distill session transcripts — content that is untrusted from the agent's perspective (transcripts can contain prompt-injection text). The dispatch container currently bind-mounts the **entire** `~/.mindframe-z` tree read-only, which includes `~/.mindframe-z/secrets/sandbox.env` (the Agent Vault broker master password — documented in `src/sandbox/config.ts:102-107` as "the sole recovery root" — plus the scoped agent token), `~/.mindframe-z/secrets/zsh.env` (shell secrets), and `~/.mindframe-z/bedrock/` (extracted AWS credentials written by `src/thread/bedrock.ts`). The dispatched agent has `Read` plus `Bash(jq/ls/grep/find/sqlite3)` enabled, so an injected instruction could read those secrets out of the mount. Only the `archive-cache/` subtree is actually consumed inside the container. Narrowing the mount removes the entire exposure without changing the pipeline.

## Current state

- `src/thread/runner.ts:36-40` — the constant documenting the current (deliberate-convenience, not security-reviewed) subtree relationship:

  ```ts
  // Where the read-only archive-cache is visible inside the dispatch container — a
  // subtree of the existing whole-~/.mindframe-z RO mount below, so hydrated sessions
  // need no dedicated volume. Shared by both harnesses; the cached artifact's own
  // filename (<id>.jsonl or <id>.json) disambiguates format.
  export const CONTAINER_ARCHIVE_CACHE = "/home/sandbox/.mindframe-z/archive-cache";
  ```

- `src/thread/runner.ts:122-123` — the mount itself, inside `DockerAgentRunner.run`'s `docker run` args:

  ```ts
  "--volume",
  `${this.paths.home}/.mindframe-z:/home/sandbox/.mindframe-z:ro`,
  ```

- The conditional-mount pattern to copy, `sessionStoreMountArgs` at `src/thread/runner.ts:369-392`: it checks `pathExists(...)` per host path and only emits `"--volume"` pairs for paths that exist (docker would otherwise create missing host dirs root-owned).
- The host-side archive-cache path is derived in `src/sessions/archive.ts` (`cachedSessionPath`) — confirm in step 1 that its root is `~/.mindframe-z/archive-cache`.
- Credentials the container legitimately needs are already mounted narrowly by `credentialMountArgs` (`runner.ts:340-365`) — e.g. only the scoped `~/.aws` dir in bedrock mode. This plan brings the `.mindframe-z` mount in line with that existing discipline.
- Tests: `src/thread/runner.test.ts` exists and the module exports test seams (`credentialMountArgsForTest`, `sessionStoreMountArgsForTest`) — follow that convention if you extract a helper.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Thread tests | `pnpm test:thread` | all pass |
| Full gate | `pnpm check` | exit 0 |
| Find container consumers | `grep -rn "\.mindframe-z" src/thread skills/ --include='*.ts' --include='*.md'` | see step 1 |

## Scope

**In scope** (the only files you should modify):
- `src/thread/runner.ts`
- `src/thread/runner.test.ts`

**Out of scope** (do NOT touch):
- `src/sandbox/**` — the interactive sandbox already mounts individual files (`src/sandbox/runtime.ts:261-345`); nothing to fix there in this plan.
- `src/sessions/archive.ts` — the host-side cache location is fine; don't move it.
- The `--volume` mounts for credentials, session stores, and skills — already narrow.

## Git workflow

- Branch: `advisor/003-narrow-dispatch-mount`
- Commit: `fix(thread): mount only archive-cache into dispatch containers` (Conventional Commits)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Enumerate what the container actually reads under `/home/sandbox/.mindframe-z`

Run:

```sh
grep -rn "mindframe-z" src/thread --include='*.ts' | grep -v test | grep -vi "host"
grep -rn "mindframe-z" skills/ src/thread/thread-contract 2>/dev/null
```

Expected: the only *container-path* consumer is `CONTAINER_ARCHIVE_CACHE` (`/home/sandbox/.mindframe-z/archive-cache`), referenced by ingest/prompt code that hands cached-session paths to the agent. Also confirm the host cache root: open `src/sessions/archive.ts` and verify `cachedSessionPath` resolves under `<home>/.mindframe-z/archive-cache`.

**Verify**: you can list every container-side consumer and each one is under `archive-cache`. If any prompt, persona, or skill references another `/home/sandbox/.mindframe-z/...` path (e.g. `references.md`, `secrets`, `threads/`), STOP and report which.

### Step 2: Replace the whole-tree mount with a conditional archive-cache mount

In `DockerAgentRunner.run` (`runner.ts:111-131`), replace the two lines

```ts
"--volume",
`${this.paths.home}/.mindframe-z:/home/sandbox/.mindframe-z:ro`,
```

with a spread of a new helper, following the `sessionStoreMountArgs` pattern:

```ts
...(await archiveCacheMountArgs(this.paths)),
```

```ts
async function archiveCacheMountArgs(paths: RuntimePaths): Promise<string[]> {
  const hostCache = path.join(paths.home, ".mindframe-z", "archive-cache");
  if (!(await pathExists(hostCache))) return [];
  return ["--volume", `${hostCache}:${CONTAINER_ARCHIVE_CACHE}:ro`];
}
```

Update the comment block above `CONTAINER_ARCHIVE_CACHE` (lines 36-40): it is no longer "a subtree of the existing whole-~/.mindframe-z RO mount" — it now has its own dedicated conditional mount, and the rest of `~/.mindframe-z` (notably `secrets/` and `bedrock/`) is deliberately NOT visible to dispatch containers. Say that in the comment.

**Verify**: `pnpm build` → exit 0. `grep -n '\.mindframe-z:/home/sandbox' src/thread/runner.ts` → only the `archive-cache` mapping remains.

### Step 3: Add test coverage

In `src/thread/runner.test.ts`, following the existing tests for the mount-arg helpers (export `archiveCacheMountArgsForTest = archiveCacheMountArgs` per the file's existing `...ForTest` convention):

1. Host cache dir exists → returns `["--volume", "<home>/.mindframe-z/archive-cache:/home/sandbox/.mindframe-z/archive-cache:ro"]`.
2. Host cache dir absent → returns `[]`.
3. A guard test that the whole-tree mount never comes back: assert no produced mount arg equals `` `${home}/.mindframe-z:/home/sandbox/.mindframe-z:ro` `` (test the helper output and/or grep-style assertion on the args builder if one is exposed).

**Verify**: `pnpm test:thread` → all pass, including 3 new tests.

### Step 4: End-to-end sanity (only if docker + a configured thread exist locally)

If the local machine has docker and an existing thread, run one real dispatch (e.g. `pnpm dev thread sweep` or a low-cost `mfz thread` read path that dispatches) and confirm it completes. If no docker or no threads are configured, skip and note it in your report — the unit tests are the required gate.

**Verify**: dispatch completes without "no such file or directory" errors referencing `/home/sandbox/.mindframe-z`.

## Test plan

- 3 new unit tests in `src/thread/runner.test.ts` (step 3), modeled on the existing `sessionStoreMountArgsForTest` tests in the same file.
- Verification: `pnpm test:thread` → all pass; `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n '"--volume"' src/thread/runner.ts` output contains no whole-tree `.mindframe-z` mapping (only `archive-cache`)
- [ ] `pnpm test:thread` exits 0, including the 3 new tests
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 finds any container-side consumer of `~/.mindframe-z` outside `archive-cache` — the mount can't be narrowed blindly; report the consumer list so the advisor can re-scope.
- An existing runner test asserts the whole-tree mount as expected behavior AND its intent is unclear from its name/comments.
- Step 4's real dispatch fails with a path error under `/home/sandbox/.mindframe-z` — that means a runtime consumer the grep missed; report the exact path.

## Maintenance notes

- Anyone adding a new artifact the dispatch agent must read should add a narrow mount (new helper or an entry in `archiveCacheMountArgs`) — never re-broaden to the tree. Reviewers: treat any `--volume` whose source is `~/.mindframe-z` root as a red flag.
- The `agent-sessions` skill reads session stores via `/mnt/claude-sessions` and `/mnt/opencode-data` (separate mounts) — unaffected here, but worth re-checking if the skill's SKILL.md changes its path resolution.
