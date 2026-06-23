## Context

mindframe-z uses YAML manifests as the source of truth for configuration. Runtime validation already exists via Zod schemas in `src/core/manifests.ts` — `readYaml(file, schema, fallback)` parses each YAML file and runs `schema.parse(parsed)`. But this validation only happens at `apply` time and crashes on the first error. Editors have no awareness of the expected structure, offering no autocomplete or inline validation for YAML config files.

Zod 4 introduced native `z.toJSONSchema()` which converts Zod schemas to JSON Schema without external dependencies. This makes it possible to derive editor-friendly schemas from the same Zod definitions that validate at runtime — maintaining a single source of truth.

## Goals / Non-Goals

**Goals:**
- Editors (Zed, VS Code) provide autocomplete and inline validation when editing mindframe-z YAML files
- JSON Schemas are generated from existing Zod schemas — one source of truth
- `mindframe-z schemas` regenerates all JSON Schema files from Zod definitions
- `mindframe-z doctor` validates YAML files individually and reports per-file errors
- Generated schemas are committed to the repo so they work out-of-the-box after clone

**Non-Goals:**
- Schema validation for non-custom files (mise.toml, OpenCode's own config) — those have their own schemas
- CI enforcement of schema freshness (could be added later, but not now)
- Generating schemas for the machine config file that lives outside the repo (`~/.mindframe-z/config.yml`) — only the example file gets a schema
- Custom schema descriptions or annotations beyond what Zod's `.describe()` provides (YAGNI)

## Decisions

### 1. Zod 4 native `z.toJSONSchema()` over external library

**Choice:** Use Zod 4's built-in `z.toJSONSchema()` instead of `zod-to-json-schema` or hand-written JSON Schema.

**Alternatives considered:**
- `zod-to-json-schema` (npm package) — External dependency, and Zod 4 has this built-in natively
- Hand-written JSON Schema files — Dual maintenance burden; schemas would drift from Zod

**Rationale:** Zero new dependencies. The Zod schemas already define the exact shape; generating JSON Schema from them ensures parity. Using `io: "input"` mode produces schemas that match what users actually write in YAML (before Zod coercion).

### 2. Schema file location: centralized `schemas/` directory

**Choice:** All JSON Schema files live in a top-level `schemas/` directory with `<name>.schema.json` naming.

**Alternatives considered:**
- Co-located schemas (`shared/refs.schema.json` next to `shared/refs.yml`) — Clutters source directories, inconsistent with the project's separation of shared/ and profiles/
- Inside `src/` alongside manifests.ts — Mixes build artifacts with source
- `.schemas/` hidden directory — Less discoverable

**Rationale:** Centralized location is easy to reference from editor configs. The `.schema.json` suffix distinguishes them from any other JSON files. New manifest types just add another file to `schemas/`.

### 3. Committed artifacts, not gitignored

**Choice:** Generated JSON Schema files are committed to the repository.

**Alternatives considered:**
- Gitignore and regenerate on clone — Requires a build step before editors work; poor DX
- Gitignore with git hooks — Adds complexity to an already-simple repo

**Rationale:** Schemas are small (~1-2KB each), rarely change (only when Zod schemas change), and committing them means editors work immediately after clone. When Zod schemas change, `npm run schemas` regenerates and the diff is committed.

### 4. Editor config via project-level settings files

**Choice:** Add `.zed/settings.json` and `.vscode/settings.json` with `yaml.schemas` mappings pointing to `./schemas/*.schema.json`.

**Alternatives considered:**
- Inline `# yaml-language-server: $schema=...` comments in each YAML file — Clutters source files, easy to forget when creating new files
- Global editor config (~/.config/zed/settings.json) — Not portable to other users/machines

**Rationale:** Project-level settings are portable, version-controlled, and don't pollute YAML source files. Zed's `yaml-language-server` resolves `./` relative to the worktree root. VS Code's Red Hat YAML extension supports the same mapping.

### 5. Doctor validates manifests individually

**Choice:** Enhance `mindframe-z doctor` to load and validate each YAML file individually against its Zod schema, reporting per-file ✓/✗ status instead of crashing on first error.

**Alternatives considered:**
- New `validate` command — Adds a command for something `doctor` already conceptually does
- Keep validation as crash-on-first-error — Poor UX; partial failures hide problems

**Rationale:** `doctor` already checks system health (paths, symlinks). Per-file manifest validation fits naturally. The implementation calls the existing `readYaml()` but wraps each call in try/catch to report individually.

### 6. Use `io: "input"` for schema generation

**Choice:** Generate JSON Schemas using `z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })`.

**Rationale:** The schemas are for validating what users write in YAML files — the input type. `z.coerce.string()` means "accept string or number input, coerce to string" — for editor validation, we want the schema to accept the input type (string | number), not just the output (string). Using `unrepresentable: "any"` prevents `z.unknown()` and similar types from throwing during generation.

## Risks / Trade-offs

- **Zod 4 `z.toJSONSchema()` is relatively new** — It may have edge cases with complex schemas like the `mcpServerSchema` union type. Mitigation: generate and inspect the output; adjust Zod schemas if needed for representability.
- **Zed relative path resolution was buggy in older versions** — Zed issue #30938 reported `yaml-language-server` failing to resolve `./` paths. This appears fixed in recent Zed versions. Mitigation: document the `./schemas/` convention; if issues arise, users can switch to inline `$schema` comments.
- **Commited schemas can drift from Zod** — If someone changes a Zod schema but forgets to run `npm run schemas`, the committed JSON Schema will be stale. Mitigation: this is low-risk because the schemas rarely change, and `npm run check` could be extended to verify schema freshness later.
- **Machine config file (`~/.mindframe-z/config.yml`) is outside the repo** — The schema can only be applied to the example file (`machine-config.example.yml`), not to the actual machine config that lives in `$HOME`. Mitigation: acceptable trade-off; the example file is what users reference when creating their machine config.