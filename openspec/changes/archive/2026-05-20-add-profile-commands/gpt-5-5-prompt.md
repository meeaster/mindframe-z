Role: You are implementing a feature for mindframe-z, a profile-aware AI tool config renderer (TypeScript/ESM). You will add support for OpenCode custom commands to be managed through profiles.

# Goal

Implement profile-aware command management so that OpenCode custom slash commands can be enabled/disabled per profile, rendered to a runtime directory, and symlinked into the global OpenCode config.

# Success criteria

- `npm run check` passes (lint → fmt → build → test)
- All 7 integration test assertions for commands pass
- Existing tests remain passing
- No new type errors

# Constraints

- ALWAYS mirror existing patterns. Every task has an existing code analog — follow those patterns exactly.
- NEVER modify `.opencode/` directory contents. That is OpenSpec's workspace, not a mindframe-z source.
- Commands are OpenCode-only. Do NOT add `targets` filtering or claude-code support for commands.
- Keep LOC minimal. Do not add abstractions, helpers, or utility functions unless the existing codebase uses them.
- Do NOT add comments to code.
- Do NOT commit changes.

# Available evidence — codebase patterns to follow

## Pattern 1: Profile schema fields (`src/core/manifests.ts`)
The `profileSchema` uses zod. New array fields use `z.array(z.string()).default([])`. See `skills` and `opencode_plugins` as examples.

## Pattern 2: Profile merge (`src/core/profile.ts:54-82`)
`mergeProfiles()` combines parent + child. Arrays use `dedupe([...base.x, ...child.x])`. See `skills`, `references`, `opencode_plugins`.

## Pattern 3: Profile resolution (`src/core/profile.ts:95-134`)
`resolveProfile()` loads manifests, resolves inheritance, then maps profile arrays to resolved entries. For commands, you only need the string names (no metadata lookup like skills/MCP).

## Pattern 4: Plugin file collection (`src/renderers/opencode.ts:12-49`)
`collectPluginFiles()` walks `opencode/plugins/`, filters by profile `opencode_plugins` list, copies files to runtime. `collectCommandFiles()` follows the identical pattern but for `.md` files in `opencode/commands/`.

## Pattern 5: Symlink creation (`src/renderers/opencode.ts:102-107`)
The renderer returns `LinkPlan[]` with `linkPath` and `targetPath`. The CLI handles backup/replace logic. Add a link for `~/.config/opencode/commands` → runtime `commands/`.

## Pattern 6: Status output (`src/cli/mindframe-z.ts:126-141`)
`statusFn()` prints tab-separated lines. Commands should follow the same format: `commands\t<names>` or `commands\tnone`.

## Pattern 7: Sync detection (`src/cli/mindframe-z.ts` and `src/sync/`)
The sync command detects unmanaged skills and promotes them. For commands, scan `opencode/commands/*.md`, find basenames not in the active profile's `commands` list, report them.

## Pattern 8: Integration test fixtures (`tests/integration/cli.test.ts`)
`writeFixture()` creates temp directories with `shared/`, `profiles/`, `opencode/plugins/`. Add `opencode/commands/` with a test `.md` file. Add `commands: [test-cmd]` to the personal profile fixture.

# Tasks — implement in order

## 1. Profile Schema & Merge
1.1 Add `commands: z.array(z.string()).default([])` to `profileSchema` in `src/core/manifests.ts`
1.2 Add `commands` to `mergeProfiles` in `src/core/profile.ts` with `dedupe([...base.commands, ...child.commands])`
1.3 Add `enabledCommands: string[]` to `ResolvedProfile` interface, populated during `resolveProfile()` by validating each command name has a corresponding `.md` file in `opencode/commands/` — throw on missing
1.4 Add `commands: []` to the profile defaults fallback object in `loadManifests` (the object passed to `readYaml` when profile.yml doesn't exist)

## 2. Command Rendering
2.1 Create `collectCommandFiles()` in `src/renderers/opencode.ts` — walks `opencode/commands/`, filters by profile `commands` list, returns `RenderedFile[]` with content copied verbatim
2.2 Add command files to `renderOpenCode` files array and add a `LinkPlan` for `<opencodeConfigDir>/commands` → `.runtime/<profile>/opencode/commands/`
2.3 Command collection only applies to the `opencode` target (it's already in the opencode renderer, so this is implicit)

## 3. CLI Updates
3.1 Add `commands` line to `statusFn` output in `src/cli/mindframe-z.ts`
3.2 Add command sync detection: scan `opencode/commands/*.md`, find files not in active profile's `commands` list, offer to add them to a chosen profile. Follow the existing skill sync pattern in `src/sync/`.

## 4. Integration Tests
4.1 Add `opencode/commands/` fixture directory with a test command markdown file to `writeFixture` in `tests/integration/cli.test.ts`
4.2 Add `commands: [test-cmd]` to the personal profile YAML fixture
4.3 Test: `apply --target opencode` renders command file to the runtime commands directory
4.4 Test: `apply` creates symlink from `<opencodeConfigDir>/commands` to runtime commands directory
4.5 Test: `status` output includes `commands` line with enabled command names
4.6 Test: profile referencing a command with no corresponding `.md` file throws an error
4.7 Test: command merge — child profile adds commands on top of parent, deduplication works

## 5. Documentation
5.1 Update `ARCHITECTURE.md` to document the `commands` profile field and render path
5.2 Move existing `.opencode/commands/*.md` files to `opencode/commands/` and add them to base profile `commands` list

# Output

- Make code changes directly. No preamble explaining your plan.
- After each task group, run `npm run check` to validate.
- If a test fails, fix it immediately — do not proceed to the next task.
- After all tasks are complete, run `npm run check` one final time and report the result.

# Stop rules

- If `npm run check` passes after all tasks, stop and report success.
- If you encounter an ambiguous design question not answered by the patterns above, ask before proceeding.
- Do NOT proceed to the next task group until the current group's `npm run check` passes.
