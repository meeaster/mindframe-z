---
description: Propose a new change - create it and generate all artifacts in one step
---

Propose a new change - create the change and generate all artifacts in one step.

I'll create a change with artifacts:

- proposal.md (what & why)
- design.md (how)
- tasks.md (implementation steps)

When ready to implement, run /opsx-apply

**Input**: The argument after `/opsx-propose` is the change name (kebab-case), OR a description of what the user wants to build.

**Steps**

1. **If no input provided, ask what they want to build**

   Use the **AskUserQuestion tool** (open-ended, no preset options) to ask:

   > "What change do you want to work on? Describe what you want to build or fix."

   From their description, derive a kebab-case name (e.g., "add user authentication" -> `add-user-auth`).

   **IMPORTANT**: Do NOT proceed without understanding what the user wants to build.

2. **Create the change directory**

   ```bash
   openspec new change "<name>"
   ```

   This creates a scaffolded change at `openspec/changes/<name>/` with `.openspec.yaml`.

3. **Get the artifact build order**

   ```bash
   openspec status --change "<name>" --json
   ```

4. **Create artifacts in sequence until apply-ready**

   Use the **TodoWrite tool** to track progress through the artifacts.

   Loop through artifacts in dependency order. For each artifact that is ready, get instructions:

   ```bash
   openspec instructions <artifact-id> --change "<name>" --json
   ```

   Read any completed dependency files for context, create the artifact file using the returned template, and continue until all apply-required artifacts are complete.

5. **Show final status**
   ```bash
   openspec status --change "<name>"
   ```

**Artifact Creation Guidelines**

- Follow the `instruction` field from `openspec instructions` for each artifact type
- Read dependency artifacts for context before creating a new one
- Use `template` as the structure for your output file - fill in its sections
- Do NOT copy `context` or `rules` blocks into the artifact; they guide you only

**Guardrails**

- Create ALL artifacts needed for implementation (as defined by schema's `apply.requires`)
- Always read dependency artifacts before creating a new one
- If context is critically unclear, ask the user - but prefer making reasonable decisions to keep momentum
- If a change with that name already exists, ask if user wants to continue it or create a new one
- Verify each artifact file exists after writing before proceeding to next
