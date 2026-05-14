---
name: claude-code-docs
description: Navigate and fetch Claude Code documentation. Use when answering questions about Claude Code features, configuration, capabilities, hooks, plugins, MCP servers, settings, CLI usage, deployment options, or troubleshooting. Triggers on "how do I [X] in Claude Code", "does Claude Code support [Y]", "Claude Code [feature]", configuration questions, or any Claude Code usage inquiry.
---

# Claude Code Documentation

## Documentation URLs

- **Docs map**: `https://code.claude.com/docs/en/claude_code_docs_map.md`
- **Individual pages**: `https://code.claude.com/docs/en/{page}.md`
- **LLMs index**: `https://code.claude.com/docs/llms.txt`

## Workflow

1. **Fetch the docs map** using WebFetch to get the full documentation structure
2. **Identify relevant pages** based on the user's question
3. **Fetch specific pages** using the URL pattern above

## Quick Category Reference

| Category        | Topics                                     | Key Pages                                                            |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Getting Started | Installation, first steps, workflows       | `quickstart`, `common-workflows`, `overview`                         |
| Build           | Plugins, hooks, skills, agents, MCP, CI/CD | `plugins`, `hooks`, `skills`, `sub-agents`, `mcp`, `github-actions`  |
| Deployment      | Cloud providers, network, sandboxing       | `amazon-bedrock`, `google-vertex-ai`, `network-config`, `sandboxing` |
| Administration  | Security, costs, monitoring, permissions   | `security`, `iam`, `costs`, `monitoring-usage`, `data-usage`         |
| Configuration   | Settings, memory, models, IDE integration  | `settings`, `memory`, `model-config`, `vs-code`, `jetbrains`         |
| Reference       | CLI, commands, keyboard shortcuts          | `cli-reference`, `slash-commands`, `hooks`, `interactive-mode`       |

## Example

User asks: "How do I create a custom hook in Claude Code?"

1. Fetch docs map to confirm hook-related pages
2. Fetch `https://code.claude.com/docs/en/hooks.md` for full hook reference
3. Optionally fetch `https://code.claude.com/docs/en/hooks-guide.md` for quickstart examples
