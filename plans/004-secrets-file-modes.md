# Plan 004: Create the zsh secrets file and secrets directory with restrictive modes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba63dbf..HEAD -- src/core/render.ts src/renderers/dotfiles.ts src/core/fs.ts tests/integration/dotfiles.test.ts`
> Plan 001 is EXPECTED to have changed `src/core/render.ts` and created
> `src/core/fs.ts` — verify plan 001 is DONE in `plans/README.md` first.
> Any other mismatch with the "Current state" excerpts is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-atomic-home-writes-and-parse-abort.md
- **Category**: security
- **Planned at**: commit `ba63dbf`, 2026-07-06

## Why this matters

`mfz apply` creates `~/.mindframe-z/secrets/zsh.env` — the designated home for shell secrets, sourced by every managed `.zshrc` — with no file mode, so it lands world-readable (umask default `0644`), and the mode persists after the owner later fills it with real tokens. The parent `~/.mindframe-z/secrets/` directory is likewise created `0755`. The sibling secret file in the same directory, `sandbox.env`, is deliberately written `0o600` with an explicit `chmod` (`src/sandbox/config.ts:83-84`) — the zsh secrets file should get identical protection.

## Current state

- `src/renderers/dotfiles.ts:44-49` — the renderer emits the secrets file as a `localFiles` entry (created empty, only if missing):

  ```ts
  return {
    files,
    ...(hasManagedZsh(profile)
      ? { localFiles: [{ path: zshSecretsFile(paths), content: "", ifMissing: true }] }
      : {}),
    links
  };
  ```

- `src/core/render.ts` — `writeLocalFiles` writes `localFiles` entries. After plan 001 it routes content through `writeFileAtomic(filePath, content, mode?)` from `src/core/fs.ts`, whose optional `mode` parameter was added specifically for this plan. Pre-001 shape for reference (lines 50-62 at planning time): `mkdir(dirname, { recursive: true })` then plain `writeFile(path, content, "utf8")`; an `ifMissing` file that already exists is skipped via the `lstat` branch.
- The `RenderedFile` type (in `src/core/render.ts`, near the top) currently has `path`, `content`, and optional `ifMissing` — no `mode`.
- The exemplar to match, `src/sandbox/config.ts:74-85`:

  ```ts
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  ```

- `zshSecretsFile(paths)` is defined in `src/core/zsh.ts` and resolves under `~/.mindframe-z/secrets/`.
- Repo TS conventions: strict + `exactOptionalPropertyTypes` — optional fields are declared `mode?: number | undefined`.
- Integration coverage for dotfiles lives in `tests/integration/dotfiles.test.ts` (temp home; model new assertions on its existing cases).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm build` | exit 0 |
| Dotfiles integration tests | `pnpm test:dotfiles` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/core/render.ts` (`RenderedFile` type + `writeLocalFiles`)
- `src/renderers/dotfiles.ts` (the `localFiles` entry)
- `tests/integration/dotfiles.test.ts` (add assertions)

**Out of scope** (do NOT touch):
- `src/sandbox/config.ts` — already correct; it is the exemplar, not a target.
- `~/.mindframe-z/gitconfig`, `references.md`, `extra_folders.md` writers — non-secret files; leave default modes.
- `src/core/zsh.ts` — path helpers only, no change needed.

## Git workflow

- Branch: `advisor/004-secrets-file-modes`
- Commit: `fix(dotfiles): create zsh secrets file 0600 and secrets dir 0700`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `mode` to `RenderedFile` and honor it in `writeLocalFiles`

In `src/core/render.ts`:

1. Extend the type: `mode?: number | undefined;`
2. In `writeLocalFiles`, for entries with `mode` set:
   - Create the parent dir with that restriction: `await mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 })` when `file.mode` is set (note `mkdir` mode applies only to directories it creates), and `await chmod(path.dirname(file.path), 0o700)` to cover a pre-existing dir.
   - When the file already exists and `ifMissing` skips the write, still `await chmod(file.path, file.mode)` before `continue` — this retrofits protection onto files created by earlier mfz versions and now holding real secrets.
   - When writing, pass the mode through: `writeFileAtomic(file.path, file.content, file.mode)`.
   Entries without `mode` keep today's behavior exactly.

**Verify**: `pnpm build` → exit 0.

### Step 2: Set the mode on the zsh secrets entry

In `src/renderers/dotfiles.ts`, change the `localFiles` entry to:

```ts
{ path: zshSecretsFile(paths), content: "", ifMissing: true, mode: 0o600 }
```

**Verify**: `pnpm build` → exit 0.

### Step 3: Integration assertions

In `tests/integration/dotfiles.test.ts`, extend (or add alongside) the existing managed-zsh test:

1. After an apply with managed zsh, `stat` the secrets file: `(mode & 0o777) === 0o600`.
2. `stat` the secrets dir: `(mode & 0o777) === 0o700`.
3. Pre-create the secrets file `0o644` with content, run apply, assert content untouched (ifMissing) AND mode now `0o600`.

Use `fs.promises.stat` and mask with `0o777`.

**Verify**: `pnpm test:dotfiles` → all pass, including the new assertions.

## Test plan

- The three integration assertions above in `tests/integration/dotfiles.test.ts`, modeled on that file's existing apply-then-inspect cases.
- Verification: `pnpm test:dotfiles` then `pnpm check` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "0o600" src/renderers/dotfiles.ts` → 1 match on the secrets entry
- [ ] `pnpm test:dotfiles` exits 0, including the new mode assertions
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 001 is not DONE (this plan writes through `writeFileAtomic`'s `mode` parameter).
- `writeLocalFiles` no longer matches the post-001 shape described above.
- Any existing dotfiles test asserts a permissive mode on the secrets file (would indicate a decided behavior this plan contradicts).

## Maintenance notes

- Any future `localFiles` entry that will hold secret material must set `mode: 0o600`; reviewers should ask "who fills this file later?" for every new entry.
- Windows/WSL note: modes are POSIX; if this repo ever targets non-WSL Windows, the chmod calls become no-ops — acceptable.
- Deferred: tightening `~/.mindframe-z` itself to `0o700` — broader behavior change touching non-secret indexes agents must read; not done here.
