# Session Analysis

Use this when the user asks what happened, why a run failed, whether guidance fired, what should improve, or which sessions contain durable user perspective.

## Workflow

Reconstruct the timeline; do not dump rows or records. Cover, in order:

1. The user request, the assistant's actions, and the final outcome.
2. Tool calls, including failures, retries, long outputs, permission rejections, and policy denials.
3. Whether skills, MCP/executor tools, and documentation lookups fired, and whether they fired early enough.
4. Subagent delegations: prompt sent, result returned, and how the parent used it.
5. Where behavior diverged from relevant `AGENTS.md`, `CLAUDE.md`, or skill guidance, when the user wants improvement ideas.

Outlining is a safety and focus technique, not a reason to under-sample. When improvement analysis needs the full session, read it in bounded chunks until every finding has evidence.

## User Perspective Mining

Use perspective mining when the user wants sessions that contain durable opinions, preferences, frustrations, design principles, taste, changed views, or recurring workflow lessons. Admit a perspective only when a future agent could use it to make a better decision without asking again.

Before summarizing a substantive user message, classify its shape:

- **Dictated exploration**: conversational, typo-heavy, self-correcting, low-structure thinking aloud. Preserve the user's intent, uncertainty, taste, and opinionated phrasing instead of smoothing it into bland requirements.
- **Structured brief**: headings, bullets, constraints, paths, or explicit deliverables. Extract requirements, constraints, and decisions; do not over-read it as spontaneous preference.
- **Pasted context**: logs, code, specs, transcripts, XML-ish wrappers, or long quoted material. Separate the user's actual ask from the supplied material.
- **Correction or override**: pushback, reversal, rejection, clarification, or changed mind. Treat this as high-signal evidence of preference or boundary.
- **Skill or prompt meta-design**: comments about skills, prompts, personas, agents, threads, invocation, or guidance. Capture the rationale, not just the requested edit.
- **Review or audit request**: asks for critique, categorization, risks, or improvement. Capture standards and review taste only when the user states or reveals them.

Look especially for repeated language such as "I think", "I don't like", "what I want", "to be clear", "actually", "maybe", and moments where the user corrects the agent's behavior. Length is only a triage signal: medium-long unstructured messages are often dictated exploration, while very long messages are usually pasted context or structured briefs.

Exclude routine task instructions, pasted context with no user stance, transient frustration with no reusable principle, and implementation-only preferences scoped to one branch. When reporting candidates for thread ingestion, include the session locator, the message shape, the reusable perspective, and why it passes the admission rule.

## Reporting Pattern

Report in this order:

1. **Scope**: source, session IDs or files, row/record counts, and whether the read was sampled or complete.
2. **Location**: how the session was found, including prompt, project, recency, branch, path, or mounted store.
3. **Timeline**: main turns and important tool or subagent events.
4. **Findings**: stuck points, missed guidance, effective behavior, and risky behavior, with row IDs, record positions, timestamps, or quoted artifacts.
5. **Recommendations**: specific changes to instructions, skills, subagent prompts, or MCP usage, only when the evidence supports them.
6. **Gaps**: missing files, schema drift, truncated output, sampled areas, or records not inspected.
