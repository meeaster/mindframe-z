## 1. Profile Schema & Merge

- [x] 1.1 Add `commands: z.array(z.string()).default([])` to `profileSchema` in `src/core/manifests.ts`
- [x] 1.2 Add `commands` to `mergeProfiles` in `src/core/profile.ts` with `dedupe([...base.commands, ...child.commands])`
- [x] 1.3 Add `enabledCommands: string[]` to `ResolvedProfile` interface, populated during resolution (validated against `opencode/commands/` directory — throw on missing)
- [x] 1.4 Add `commands` to profile defaults in `loadManifests` (the fallback object passed to `readYaml`)

## 2. Command Rendering

- [x] 2.1 Create `collectCommandFiles()` in `src/renderers/opencode.ts` — walks `opencode/commands/`, filters by profile `commands` list, returns `RenderedFile[]`
- [x] 2.2 Add command files and directory symlink (`~/.config/opencode/commands` → runtime `commands/`) to `renderOpenCode` return value
- [x] 2.3 Ensure command collection only runs for the `opencode` target (not `claude-code`, `mise`, or `dotfiles`)

## 3. CLI Updates

- [x] 3.1 Add `commands` line to `statusFn` output, listing enabled command names or `none`
- [x] 3.2 Add command sync detection: scan `opencode/commands/*.md`, find files not in active profile's `commands` list, offer to add them to a chosen profile (parallel to existing skill sync logic)

## 4. Integration Tests

- [x] 4.1 Add `opencode/commands/` fixture directory with a test command markdown file to `writeFixture`
- [x] 4.2 Add `commands: [test-cmd]` to test profile YAML fixture
- [x] 4.3 Test: `apply --target opencode` renders command file to `.runtime/.../opencode/commands/test-cmd.md`
- [x] 4.4 Test: `apply` creates symlink from `<opencodeConfigDir>/commands` to runtime commands directory
- [x] 4.5 Test: `status` output includes `commands` line with enabled command names
- [x] 4.6 Test: profile referencing a command with no corresponding `.md` file throws an error
- [x] 4.7 Test: command merge — child profile adds commands on top of parent, deduplication works

## 5. Documentation

- [x] 5.1 Update `ARCHITECTURE.md` to document the `commands` profile field and render path
- [x] 5.2 Move existing `.opencode/commands/*.md` files to `opencode/commands/` and add them to base profile `commands` list
