---
description: Load openspec and research enrichment context
---

Load the openspec apply skill and the thermo-nuclear-code-quality-review skill, then read the "$1" spec.

Use the thermo-nuclear skill only as pre-implementation quality guidance: understand how the finished work will be reviewed, and apply those standards while planning and coding. Do not run a review or report review findings unless the user explicitly asks for one.

Then launch parallel @explore and @research subagents, but treat them as fact-finding assistants only. Their purpose is to gather current context, not to decide implementation direction. In the prompt you pass to each subagent, explicitly say:

- Do not make judgment calls about what should be built or how the primary agent should implement it.
- Do not rank options, choose an approach, or present recommendations unless asked for a purely factual tradeoff from source material.
- Report observed facts with file paths, code references, docs references, and uncertainties.
- Separate facts from assumptions.
- Leave final design and implementation decisions to the primary agent.

Use @explore for current codebase state: architecture, existing patterns, conventions, seams, tests, and relevant files. Ask it to read the spec itself, then return concise, source-grounded findings only.

Use @research only for external documentation, APIs, SDKs, CLIs, integrations, protocols, or upstream repositories. Ask it to read the spec itself, then return source-grounded documentation facts only.

Try to front-load documentation lookups so context is ready for implementation, but don't block on it if gaps appear later.
