## 1. Schema changes

- [x] 1.1 Add `enabled: z.boolean().default(true)` to profile skill config schema in `src/core/manifests.ts`, changing from `z.union([profileSkillTargetsSchema, z.null()])` to an object shape `z.object({ enabled: z.boolean().default(true), targets: profileSkillTargetsSchema.optional() })` with backward-compatible union for `null` and bare array legacy formats
- [x] 1.2 Add `enabled: boolean` to the `ResolvedSkill` type in `src/core/profile.ts`
- [x] 1.3 Change skill merge in `mergeProfiles()` from `{ ...base.skills, ...child.skills }` to `deepMerge(base.skills, child.skills)` (mirrors MCP merge strategy)
- [x] 1.4 Update skill resolution in `resolveProfile()` to extract and pass through `enabled` from each skill entry

## 2. Profile migration

- [x] 2.1 Migrate `profiles/base/profile.yml` — convert all skill entries from `null` / `[targets]` to `{ enabled: true/false, targets: [...] }` shape; most skills default to `enabled: false`, a few core skills default to `enabled: true`
- [x] 2.2 Migrate `profiles/personal/profile.yml` and `profiles/work/profile.yml` skill entries to the new shape
- [x] 2.3 Remove any `[]` empty-array entries (superseded by `enabled: false`)
- [x] 2.4 Run `pnpm schemas` to regenerate `schemas/profile.schema.json` and commit

## 3. Sync behavior change

- [x] 3.1 Update `src/skills/npx-skills.ts` sync logic so `mfz skills sync` installs ALL profile-declared skills regardless of `enabled` value
- [x] 3.2 Update sync tests in `src/skills/npx-skills.test.ts` to verify disabled skills are installed
- [x] 3.3 Update `src/sync/skills.ts` (detecting unmanaged skills) — no behavioral change needed, but verify it still works with new schema

## 4. Local config read/write utilities

- [x] 4.1 Create `src/tui/config-io.ts` with functions to read/write `permission.skill` block from `.opencode/opencode.jsonc` (parse JSONC, merge skill block, preserve other keys)
- [x] 4.2 Add functions to read/write `skillOverrides` block from `.claude/settings.local.json` (parse JSON, merge skillOverrides, preserve other keys)
- [x] 4.3 Add a function to resolve effective toggle state: read local config → fall back to profile default `enabled` value

## 5. TUI implementation

- [x] 5.1 Add `@clack/core` and `@clack/prompts` to `package.json` dependencies
- [x] 5.2 Create `src/tui/skills-tui.ts` — subclass `MultiSelectPrompt` from `@clack/core` to build a persistent toggle list:
  - Keyboard: arrows (navigate), Space (toggle), a (all), i (invert), Tab (switch target), s (save), q (quit)
  - Display: skill name + description, ◉/○ indicators, target header
  - Sliding window for long skill lists
- [x] 5.3 Wire TUI to read effective toggle state on startup (profile defaults + local overrides) and write to local config files on save
- [x] 5.4 Handle edge cases: no installed skills, no existing config files, JSON parse errors in existing config

## 6. CLI commands

- [x] 6.1 Add `mfz skills tui` subcommand in `src/cli/mfz.ts` — resolves profile, launches TUI
- [x] 6.2 Add `mfz skills enable <name>` subcommand — takes `--target <opencode|claude-code>` (optional, defaults to all profile targets), writes to local config
- [x] 6.3 Add `mfz skills disable <name>` subcommand — same as enable but writes deny/off
- [x] 6.4 Update `mfz skills` help text to document new subcommands

## 7. Integration tests

- [x] 7.1 Add integration tests for `mfz skills tui` — verify TUI reads profile defaults and writes to local config files (use temp dirs, mock stdin)
- [x] 7.2 Add integration tests for `mfz skills enable/disable` — verify CLI writes correct entries to `.opencode/opencode.jsonc` and `.claude/settings.local.json`
- [x] 7.3 Add integration tests for sync behavior change — verify disabled skills are installed
- [x] 7.4 Add integration tests for deep merge skill inheritance
- [x] 7.5 Add integration tests for legacy format backward compatibility

## 8. Documentation

- [x] 8.1 Update `ARCHITECTURE.md` skill merge behavior row from "child target list overrides parent" to "deep merge — child keys override parent" (mirrors MCP row)
- [x] 8.2 Add TUI toggle pattern to `ARCHITECTURE.md` (new section on local vs global config management)

## 9. Validation

- [x] 9.1 Run `mfz doctor` to validate migrated profile YAMLs
- [x] 9.2 Run `pnpm check` (lint → fmt → build → test)
- [x] 9.3 Manual smoke test: run `mfz skills tui`, toggle a skill, verify `.opencode/opencode.jsonc` has correct permission entry
