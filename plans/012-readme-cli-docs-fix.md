# Plan 012: Correct the README's sandbox/observe/cc/oc command documentation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `grep -n "sandbox observe" README.md` — if no
> match, this plan is already done; STOP and report.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

The README — the primary onboarding doc — documents commands that don't exist in that form. Copy-pasting `mfz sandbox observe` fails: the command is registered under `thread` (`mfz thread observe up/down/status`). The `cc`/`oc` shortcuts are framed as nested under `mfz sandbox`, but they are top-level commands. Actively wrong docs are worse than missing ones.

## Current state

- `README.md:144-148` (the Sandbox section):

  ```markdown
  ### Sandbox

  - `mfz sandbox` — launch the active profile inside a credential-brokered container
    (`cc` / `oc` to run Claude Code or OpenCode inside it).
  - `mfz sandbox observe` — manage the optional lapdog observability dashboard.
  ```

- Actual CLI registration (verified in `src/cli/mfz.ts`): `observe` is a subcommand of `thread` (lines 545-566: `thread.command("observe")` with `up`/`down`/`status`); `cc` and `oc` are **top-level** commands (lines 568, 578) that launch the harness inside the sandbox. The rendered `.zshrc` even aliases them as top-level: `alias mfzcc='mfz cc'` (`src/renderers/dotfiles.ts:17-18`).
- The command *placement* (observe under `thread`, cc/oc top-level) is treated as the decided current taxonomy — this plan fixes the docs to match the code, not the other way around.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Find stale references | `grep -rn "sandbox observe" README.md docs/ AGENTS.md ARCHITECTURE.md` | see step 1 |
| Prove commands exist | `pnpm dev thread observe --help` | usage text, exit 0 |
| Prove cc is top-level | `pnpm dev cc --help` | usage text, exit 0 |

## Scope

**In scope** (the only files you should modify):
- `README.md`
- Other `docs/*.md` / `AGENTS.md` / `ARCHITECTURE.md` lines ONLY if step 1's grep finds the same stale command forms there.

**Out of scope** (do NOT touch):
- `src/**` — no command rehoming; the CLI taxonomy is not this plan's business.
- `openspec/**` — plan 011 owns ledger corrections.

## Git workflow

- Branch: `advisor/012-readme-cli-fix`
- Commit: `docs(readme): correct thread observe and top-level cc/oc command forms`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Find every stale occurrence

```sh
grep -rn "sandbox observe\|sandbox cc\|sandbox oc" README.md docs/ AGENTS.md ARCHITECTURE.md
```

**Verify**: you have the complete list (expected: README.md:148 and possibly the sandbox framing at :146).

### Step 2: Rewrite the Sandbox section

Replace the bullets so they read (adjust wording to taste, facts fixed):

```markdown
### Sandbox

- `mfz sandbox` — manage the credential-brokered sandbox (init, build).
- `mfz cc` / `mfz oc` — run Claude Code or OpenCode inside the sandbox
  (top-level shortcuts).
- `mfz thread observe` — manage the optional lapdog observability dashboard
  (documented under Threads because it observes thread dispatches).
```

Before finalizing, run `pnpm dev sandbox --help` and mirror the real subcommand list in the first bullet (don't invent subcommands).

**Verify**: `pnpm dev thread observe --help` exits 0; `pnpm dev cc --help` exits 0; `pnpm dev sandbox --help` output is consistent with the first bullet.

### Step 3: Fix any other occurrences from step 1

Apply the same corrections wherever the grep hit.

**Verify**: `grep -rn "sandbox observe" README.md docs/ AGENTS.md ARCHITECTURE.md` → no matches.

## Test plan

No code tests. The verification greps and `--help` invocations above are the gate.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "sandbox observe" README.md docs/ AGENTS.md ARCHITECTURE.md` → no matches
- [ ] `pnpm dev thread observe --help` and `pnpm dev cc --help` exit 0
- [ ] `git diff --stat -- src` → empty
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `mfz thread observe` or top-level `cc`/`oc` no longer exist in `src/cli/mfz.ts` (the taxonomy moved — docs should then follow the new one, which needs re-scoping).
- You feel the urge to *move* the commands instead of the docs — that's a maintainer taste decision explicitly rejected as a plan; report it as a suggestion instead.

## Maintenance notes

- If the maintainer later rehomes `observe`/`cc`/`oc` (the taxonomy question noted in the audit), this section must move with it.
- Reviewers of future CLI additions: check the README Features section in the same PR — this drift happened because command moves didn't update docs.
