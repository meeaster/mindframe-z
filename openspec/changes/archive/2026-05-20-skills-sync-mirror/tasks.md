## 1. Schema and profile resolution

- [x] 1.1 Allow empty skill target arrays in `profileSkillTargetsSchema` (remove `min(1)`)
- [x] 1.2 Update `expandSkillTargets` in `src/core/profile.ts` to handle empty targets (disabled skills)
- [x] 1.3 Filter disabled skills from `enabledSkills` in `resolveProfile`
- [x] 1.4 Regenerate `schemas/profile.schema.json` with `pnpm schemas`

## 2. Skill removal plumbing

- [x] 2.1 Add `buildNpxSkillsRemoveCommand` to `src/skills/npx-skills.ts`
- [x] 2.2 Add `removeSkill` function to `src/skills/npx-skills.ts`
- [x] 2.3 Add `buildNpxSkillsInstallCommand` (rename from `buildNpxSkillsCommand` or add separate install function)

## 3. Sync command

- [x] 3.1 Implement skill reconciliation logic (compute add/remove per target from profile vs installed)
- [x] 3.2 Replace `skills apply` and `skills update` commands with `skills sync` and `skills upgrade` in `src/cli/mfz.ts`
- [x] 3.3 Wire sync to install missing and remove extra using `npx skills`

## 4. Upgrade command

- [x] 4.1 Implement `skills upgrade` to run `npx skills update` for git-sourced profile skills only

## 5. Tests

- [x] 5.1 Update integration tests for `skills sync` (adds missing, removes extra)
- [x] 5.2 Update integration tests for `skills upgrade` (updates git skills, skips local)
- [x] 5.3 Add/update test for empty target array as disabled skill
- [x] 5.4 Update `npx-skills.test.ts` for new remove command builder
- [x] 5.5 Remove tests for old `skills apply` and `skills update` commands

## 6. Documentation

- [x] 6.1 Update `AGENTS.md` command references (`skills apply`/`update` → `skills sync`/`upgrade`)
- [x] 6.2 Update `ARCHITECTURE.md` if skill command references exist
