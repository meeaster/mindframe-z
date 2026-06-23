## 1. Schema Generation

- [x] 1.1 Create `src/core/generate-schemas.ts` that imports all Zod schemas from `manifests.ts` and generates JSON Schema files using `z.toJSONSchema()` with `{ io: "input", unrepresentable: "any" }`
- [x] 1.2 Map schemas to output filenames: `refsManifestSchema` → `schemas/refs.schema.json`, `skillsManifestSchema` → `schemas/skills.schema.json`, `mcpManifestSchema` → `schemas/mcp.schema.json`, `profileSchema` → `schemas/profile.schema.json`, `machineSchema` → `schemas/machine.schema.json`
- [x] 1.3 Add `schemas` CLI command to `src/cli/mindframe-z.ts` that calls the generation function and writes files to `schemas/`
- [x] 1.4 Add `"schemas": "tsx src/core/generate-schemas.ts"` script to `package.json`

## 2. Generated Schema Artifacts

- [x] 2.1 Run `npm run schemas` and verify all five `.schema.json` files are generated correctly
- [x] 2.2 Inspect each generated schema for correctness — especially `mcp.schema.json` (union type) and `profile.schema.json` (complex nested structure)
- [x] 2.3 Commit `schemas/*.schema.json` to the repository

## 3. Editor Configuration

- [x] 3.1 Create `.zed/settings.json` with `yaml-language-server` schema mappings: `refs.schema.json` → `shared/refs.yml`, `skills.schema.json` → `shared/skills.yml`, `mcp.schema.json` → `shared/mcp.yml`, `profile.schema.json` → `profiles/*/profile.yml`, `machine.schema.json` → `machine-config.example.yml`
- [x] 3.2 Create `.vscode/settings.json` with equivalent `yaml.schemas` mappings for VS Code YAML extension
- [x] 3.3 Verify Zed provides autocomplete and validation when opening `shared/mcp.yml`

## 4. Doctor Validation

- [x] 4.1 Add `validateManifests()` function to `src/core/manifests.ts` that validates each YAML file individually against its Zod schema, catching and returning per-file errors instead of throwing
- [x] 4.2 Integrate `validateManifests()` into `mindframe-z doctor` command — report each file with ✓/✗ and error details
- [x] 4.3 Test: `doctor` reports ✓ for all valid manifests
- [x] 4.4 Test: `doctor` reports ✗ with details for an invalid manifest (e.g., `type: "websocket"` in mcp.yml)

## 5. Documentation

- [x] 5.1 Update `ARCHITECTURE.md` to document the `schemas/` directory, schema generation workflow, and editor integration
- [x] 5.2 Update `AGENTS.md` to add `npm run schemas` to the Commands section

## 6. Validation

- [x] 6.1 Run `npm run check` (lint, fmt:check, build, test) and fix any issues
- [x] 6.2 Verify `npm run schemas` generates schemas that match current Zod definitions (no drift)
