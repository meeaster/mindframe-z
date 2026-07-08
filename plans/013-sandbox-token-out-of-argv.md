# Plan 013: Keep the Agent Vault token out of `docker run` argv

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/sandbox/runtime.ts src/sandbox/cli.ts src/sandbox/runtime.test.ts`
> Compare the excerpts below against the live code; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

`mfz sandbox` / `mfz cc` / `mfz oc` launch the sandbox container with every env var rendered as an inline `docker run -e NAME=value` argument. The scoped Agent Vault token — embedded in `HTTPS_PROXY`/`HTTP_PROXY`/`OPENCLAW_PROXY_URL` as basic-auth userinfo and raw in `AGENT_VAULT_TOKEN` — therefore appears in the `docker` client's argv, readable by any local process via `ps`/`/proc/*/cmdline`. The token is scoped (`no-access` proxy token), which bounds the blast radius, but the compose path already does this correctly (`--env-file` + process env, `src/sandbox/lifecycle.ts:73-86`); the `docker run` path should stop putting credentials in argv too. Docker supports `-e NAME` (no value): the value is inherited from the docker client's own environment, which we control via `execa`'s `env` option.

## Current state

- `src/sandbox/runtime.ts:633` — every env var inlined into argv:

  ```ts
  ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
  ```

- `src/sandbox/runtime.ts:655-676` — where the token lands (inside `resolveSandboxRuntimeInputs`; values shown are the test-time placeholders, real token injected by the caller):

  ```ts
  const agentToken = options.agentToken ?? "PLACEHOLDER";
  const proxyUrl = `http://${agentToken}:${sandboxVaultName}@host.docker.internal:${agentVaultMitmPort}`;
  const env: Record<string, string> = {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: noProxy.join(","),
    ...
    OPENCLAW_PROXY_URL: proxyUrl,
    ...
    AGENT_VAULT_TOKEN: agentToken,
    ...
    GH_TOKEN: "PLACEHOLDER"
  };
  ```

- `src/sandbox/cli.ts:53-61` — the launch site; `runtime.dockerRunArgs` is executed with `execa("docker", runtime.dockerRunArgs, { stdio: "inherit" })`. The real token comes from `secrets[sandboxAgentTokenVar]` at `cli.ts:56`.
- `SandboxRuntimeInputs` is the return type of `resolveSandboxRuntimeInputs` (defined in `runtime.ts`) — it must grow a field carrying the secret values separately from argv.
- Exemplar for the safe pattern, `src/sandbox/lifecycle.ts:73-86`: compose is invoked with `--env-file` + `{ env: { ...process.env, ...(await readSandboxOperationalSecrets(paths)) } }` so values flow via process env, never argv.
- Tests: `src/sandbox/runtime.test.ts` covers `dockerRunArgs` — run `pnpm test:sandbox` and read the assertions before changing shapes.
- TS conventions: strict, `exactOptionalPropertyTypes`, `.js` imports.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Sandbox tests | `pnpm test:sandbox` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/sandbox/runtime.ts`
- `src/sandbox/cli.ts`
- `src/sandbox/runtime.test.ts`

**Out of scope** (do NOT touch):
- `src/sandbox/lifecycle.ts` (compose path) — already correct.
- `src/thread/runner.ts` — thread dispatch env contains no secrets in subscription mode (bedrock creds go via file mounts); out of scope here.
- The token model itself (scoping, vault names) — decided by the credential-broker spec.

## Git workflow

- Branch: `advisor/013-token-out-of-argv`
- Commit: `fix(sandbox): pass token-bearing env via process env instead of docker argv`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Split env into public and secret in `resolveSandboxRuntimeInputs`

In `runtime.ts`, classify as **secret** every var whose value embeds `agentToken`: `HTTPS_PROXY`, `HTTP_PROXY`, `OPENCLAW_PROXY_URL`, `AGENT_VAULT_TOKEN` (and `GH_TOKEN` — placeholder today, but it is a credential slot; classify it secret now so a future real value never regresses). Everything else (NO_PROXY, CA paths, addresses, WORKSPACE_DIR, bedrock flags) stays public.

- Add `secretEnv: Record<string, string>` to `SandboxRuntimeInputs` and populate it; remove those keys from the public `env`.
- In the args builder (line ~633 region), render public vars as today (`"-e", "NAME=value"`) and secret vars as name-only: `"-e", name` — docker then reads the value from the client process env. Add a comment: name-only `-e` keeps token values out of argv (`ps`-visible); values travel via the execa `env` below.

**Verify**: `pnpm build` → exit 0.

### Step 2: Supply the values at the launch site

In `cli.ts` (line ~61), change the launch to:

```ts
await execa("docker", runtime.dockerRunArgs, {
  stdio: "inherit",
  env: { ...process.env, ...runtime.secretEnv }
});
```

Check for any other `execa("docker", runtime.dockerRunArgs` call sites (`grep -rn "dockerRunArgs" src/`) and apply the same change everywhere.

**Verify**: `pnpm build` → exit 0; `grep -rn "dockerRunArgs" src/` shows every executor passes `secretEnv`.

### Step 3: Tests

In `src/sandbox/runtime.test.ts`:

1. Update existing `dockerRunArgs` assertions for the new shape.
2. New: no argv element contains the agent token — resolve inputs with `agentToken: "TESTTOKEN123"` and assert `runtime.dockerRunArgs.every((arg) => !arg.includes("TESTTOKEN123"))`.
3. New: `secretEnv` contains exactly `HTTPS_PROXY`, `HTTP_PROXY`, `OPENCLAW_PROXY_URL`, `AGENT_VAULT_TOKEN`, `GH_TOKEN`, each with the expected value.
4. New: argv contains the name-only forms (`"-e", "HTTPS_PROXY"` adjacent pair) and still contains inline public vars (e.g. an element starting `NO_PROXY=`).

**Verify**: `pnpm test:sandbox` → all pass.

### Step 4: Live smoke (only if the sandbox is initialized locally)

If `mfz sandbox init` state exists and docker is available: launch `pnpm dev cc -- --help` (or the lightest target that starts the container), and while it runs check `ps aux | grep 'docker run' | grep -c TESTTOKEN\|AGENT_VAULT_TOKEN=` style inspection — the docker client cmdline must not contain a token value. If no sandbox is initialized, skip and note it; unit tests are the required gate.

**Verify**: container starts and can reach the proxy (the harness inside gets its env), and no token value appears in the docker client's `/proc/<pid>/cmdline`.

## Test plan

- The four test items in step 3, in `src/sandbox/runtime.test.ts`, following its existing structure.
- Verification: `pnpm test:sandbox`; then `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm test:sandbox` exits 0, including a test asserting the token string never appears in `dockerRunArgs`
- [ ] `grep -n 'AGENT_VAULT_TOKEN=' src/sandbox/runtime.ts` → no inline-value rendering for that var
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- Some consumer parses `dockerRunArgs` to *read* env values (would break on name-only form) — grep for consumers before changing the shape.
- Step 4's live smoke shows the container missing proxy env (would mean docker didn't inherit a var — likely a var name mismatch between `secretEnv` and the `-e` name list; fix once, then STOP if it persists).

## Maintenance notes

- Rule for future env additions in `resolveSandboxRuntimeInputs`: anything derived from a credential goes in `secretEnv`. Reviewers should reject new inline `-e NAME=value` args whose value came from secrets.
- The same name-only `-e` technique applies to `src/thread/runner.ts` if thread dispatch env ever grows a secret — noted, not done here.
