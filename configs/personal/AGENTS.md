For any file search or grep in the current git-indexed directory, use fff tools.

<!-- context7 -->

For library/framework/SDK/API/CLI usage, use Context7 to fetch current documentation -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

Context7 steps:

1. Resolve the library with `context7.resolve_library_id({ libraryName, query })`, using the library name and the user's full question, unless the user provides an exact library ID in `/org/project` or `/org/project/version` format.
2. Pick the best match by exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score. Use version-specific IDs when the user mentions a version.
3. Query docs with `context7.query_docs({ libraryId, query })`, using the selected library ID and the user's full question.
4. Answer using the fetched docs.
<!-- context7 -->

<!-- deepwiki -->

Use DeepWiki for GitHub repository documentation, implementation details, and source-grounded questions. It works well when the user asks how a repository works internally, what a function/module does in source, how a project is structured, or when Context7 cannot find a good library match.

Prefer `ask_question` with the GitHub repo in `owner/repo` format and the user's full question. Use `read_wiki_structure` first when the available documentation topics would help narrow a broad repository question. Use `read_wiki_contents` when the user wants repository documentation rather than a targeted answer.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

<!-- deepwiki -->

<!-- mcp-interactions -->

Use MCP tools selectively and do not query multiple documentation MCPs in parallel unless the user explicitly asks for a comparison.

- For library/framework/SDK/API/CLI usage, start with Context7 because it prioritizes official docs.
- For GitHub repository internals, source structure, implementation details, or "how does this repo work" questions, use DeepWiki directly.
- If Context7 has no good match or the result is thin, use DeepWiki as the fallback.
- For explicit comparisons or evaluations, query both tools with the same question and compare source quality, specificity, freshness, and usefulness.
- Prefer MCP documentation tools over general web search for library and repository documentation.
<!-- mcp-interactions -->

## Git

- Use Conventional Commits.

## GitHub Actions

- Prefer mature latest action versions; pin actions to commit SHAs.
- Validate workflow changes with `actionlint` and `zizmor --min-severity high`.
- For local or reusable actions, declare outputs in action metadata.
- Write step outputs to `$GITHUB_OUTPUT` at the end of the step.

## Package Installs

- Prefer exact versions and packages older than 7 days.

## Documentation

- Flag docs that may be obsolete after code changes.
- Avoid hardcoded counts in docs; use descriptive terms instead.

## Collaboration

- Push back on flawed assumptions and ask when intent is unclear.

## Code Conventions

- Do not use `isRecord`-style guard helpers; understand the code path types directly, and when input shape is uncertain validate it once at the boundary with a schema instead of scattering guards through the logic.
