## Why

mindframe-z uses YAML manifests (`shared/refs.yml`, `shared/skills.yml`, `shared/mcp.yml`, `profiles/*/profile.yml`, `machine-config.example.yml`) as the source of truth for configuration. These files are validated at runtime by Zod schemas in `src/core/manifests.ts`, but editors have no awareness of the expected structure. When editing manifests, there is no autocomplete, no inline validation, and no early error detection — mistakes are only caught at `apply` time.

## What Changes

- Add JSON Schema files generated from the existing Zod schemas using Zod 4's native `z.toJSONSchema()`, providing editor validation and autocomplete for all custom YAML config files
- Add a `mindframe-z schemas` CLI command and `npm run schemas` script to regenerate JSON Schemas from Zod definitions (single source of truth)
- Add Zed editor configuration (`.zed/settings.json`) mapping the generated schemas to YAML file globs, so `yaml-language-server` provides validation and completion
- Add VS Code configuration (`.vscode/settings.json`) with equivalent schema mappings
- Enhance `mindframe-z doctor` to validate each manifest file individually against its Zod schema and report per-file errors, instead of crashing on the first failure

## Capabilities

### New Capabilities

- `yaml-schemas`: JSON Schema generation from Zod definitions, editor integration, and CLI validation for custom YAML config files

### Modified Capabilities

<!-- No existing specs to modify -->

## Impact

- `src/core/manifests.ts` — may need minor adjustments for `z.toJSONSchema()` compatibility (e.g., `z.coerce` handling)
- `src/cli/mindframe-z.ts` — new `schemas` command, enhanced `doctor` validation
- `schemas/` — new directory with generated JSON Schema files (committed artifacts)
- `.zed/settings.json` — new file for Zed yaml-language-server configuration
- `.vscode/settings.json` — new file for VS Code YAML extension configuration
- `package.json` — new `schemas` script
- `ARCHITECTURE.md` — document schema generation and editor integration