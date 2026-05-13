# Jira Writer Working Set

## EX-001: Datadog agent/tracer update with diagnostic evidence

- Label: positive
- Kind: fix
- Origin: human-verified
- Source: local OpenCode session titled `Datadog agent and tracer version update`
- Status: working
- Expected behavior: Write a Jira story that reads top-to-bottom, explains the operational signal, preserves the exact relevant log message, and frames the high-level solution without command-level implementation steps.
- Observed behavior: Early guidance risked stripping too much context or moving evidence into a detached reference section.
- Skill delta: Add narrative-first evidence guidance and preserve exact diagnostic snippets when they explain why the work exists.
- Anonymization: Customer/environment names generalized except for non-sensitive QA naming pattern used to explain scope.

### Content

The story should explain that repeated Datadog system-probe errors are appearing in QA environments, include the exact error in a fenced code block when available, and state that updating Datadog Agent and .NET tracer versions in QA is a controlled way to validate remediation before considering production rollout.

It should not turn into a command list, YAML edit plan, branch note, PR update, or generic reference dump.
