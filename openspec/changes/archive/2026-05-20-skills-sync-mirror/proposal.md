## Why

Removing a skill from profile YAML does not uninstall it from the agent runtime environment. The `mfz skills apply` command only installs missing skills; there is no path to remove stale or removed skills. This breaks the architectural principle that manifests are source of truth and tool-level state is rendered output.

## What Changes

- **BREAKING**: Replace `mfz skills apply` and `mfz skills update` with `mfz skills sync` and `mfz skills upgrade`
- `mfz skills sync` mirrors installed skills to the resolved profile: installs missing profile skills, removes installed skills not in the profile, and does not update existing skills
- `mfz skills upgrade` refreshes/updates existing profile-managed git skills without changing skill set membership
- Allow empty skill target arrays (`skillName: []`) in profiles to disable an inherited skill
- Skill removal delegates to `npx skills remove` for clean uninstall

## Capabilities

### New Capabilities

- `skills-sync`: Reconcile installed agent skills with the resolved profile (add missing, remove extra, skip updates).
- `skills-upgrade`: Refresh existing profile-managed git skills to latest versions.
- `skill-disable-inheritance`: Allow a child profile to disable a skill inherited from a parent by overriding its target list to `[]`.

### Modified Capabilities

<!-- No existing specs to modify -->

## Impact

- `src/cli/mfz.ts`: remove `skills apply` and `skills update` commands; add `skills sync` and `skills upgrade`
- `src/skills/npx-skills.ts`: add `buildNpxSkillsRemoveCommand`, `removeSkill`, and reconciliation logic
- `src/core/manifests.ts`: relax `profileSkillTargetsSchema` to allow empty arrays (disabled skill)
- `src/core/profile.ts`: update `expandSkillTargets` to return empty array for disabled skills; filter disabled from `enabledSkills`
- `schemas/profile.schema.json`: regenerate after schema changes
- `tests/integration/cli.test.ts`: update tests for new command structure
- `AGENTS.md`: update command references
