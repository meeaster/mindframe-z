## 1. Git Root Detection

- [x] 1.1 Add `findGitRoot(cwd: string): Promise<string | undefined>` helper to `config-io.ts` that runs `git rev-parse --show-toplevel` and returns the trimmed stdout on success, `undefined` on failure
- [x] 1.2 Add `resolveSkillConfigPaths(runtimePaths: RuntimePaths): Promise<SkillConfigPaths>` helper to `config-io.ts` that calls `findGitRoot(process.cwd())` and returns `{ opencode, claude, isRepo, repoRoot }` — opencode/claude paths point to local files when in repo, global files when not

## 2. Read/Write Refactor

- [x] 2.1 Refactor `readLocalSkillOverrides` to use `resolveSkillConfigPaths` — when in repo, read from local config; when not, read from global config
- [x] 2.2 Refactor `writeLocalSkillOverrides` to use `resolveSkillConfigPaths` — write to the resolved path; call `ensureGitExcluded` only when `isRepo` is true
- [x] 2.3 Refactor `resolveSkillToggleState` to read from the correct scope (local when in repo, global when not), then merge with profile defaults (overrides win)

## 3. OpenCode Global Config Preservation

- [x] 3.1 When writing `permission.skill` to the global OpenCode config (`~/.config/opencode/opencode.jsonc`), read the existing file first and merge only the `permission.skill` key — preserve all other keys (instructions, mcp, plugin, bash permissions, etc.)

## 4. Tests

- [x] 4.1 Add tests for `findGitRoot` — mock `execa` to simulate git success/failure
- [x] 4.2 Add tests for `resolveSkillConfigPaths` — in-repo returns local paths, out-of-repo returns global paths
- [x] 4.3 Update existing `readLocalSkillOverrides` tests to cover both repo and non-repo contexts
- [x] 4.4 Update existing `writeLocalSkillOverrides` tests to verify global write path skips `ensureGitExcluded`
- [x] 4.5 Add tests for `resolveSkillToggleState` precedence: local > global > profile defaults
- [x] 4.6 Add tests for global OpenCode config preservation (other keys survive a skill write)

## 5. Cleanup

- [x] 5.1 Update `skill-local-toggle` spec in `openspec/specs/skill-local-toggle/spec.md` by archiving the delta spec
- [x] 5.2 Update ARCHITECTURE.md "Local Skill Toggles" section to document the repo-scoped vs global-scoped behavior
