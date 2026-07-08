# Agent Harness Research — Deep Agents, AI SDK Harness, and Alternatives

Research notes for future `mfz thread` and renderer prototypes. This document
captures the July 2026 exploration of LangChain Deep Agents, Vercel AI SDK
Harness, OpenHarness, OpenCode Go, and adjacent agent frameworks.

The source repositories were cloned outside this repo under `/tmp/opencode/` for
inspection:

- `/tmp/opencode/deepagents` — `langchain-ai/deepagents`
- `/tmp/opencode/vercel-ai` — `vercel/ai`
- `/tmp/opencode/open-harness` — `MaxGfeller/open-harness`

The goal was not to pick a winner in the abstract. The goal was to understand
which runtimes and SDKs could support future `mfz` prototypes around profile
rendering, session archaeology, thread execution, and multi-harness dispatch.

## Executive Summary

The most promising path is incremental:

1. Add `deep-agents` as a third `ThreadHarness` next to `claude-code` and `opencode`.
2. Keep `mfz thread`'s gather/synthesize/digest pipeline intact while swapping only the runner.
3. Evaluate Vercel AI SDK Harness as a later meta-runner that can normalize Deep Agents, OpenCode, Claude Code, Codex, and Pi under one API.
4. Use OpenHarness as a source of TypeScript-native ideas and reusable patterns, especially `SessionStore`, compaction, approval callbacks, and ChatGPT/Codex OAuth.

Best fit by problem:

| Problem | Best Candidate | Why |
| --- | --- | --- |
| Durable long-running agent work | Deep Agents | LangGraph checkpointing, resumable threads, filesystem/sandbox backends |
| One interface over many coding agents | Vercel AI SDK Harness | `HarnessAgent` wraps Deep Agents, OpenCode, Claude Code, Codex, Pi |
| TypeScript-native custom agent runtime | OpenHarness or Mastra | Sessions, middleware, memory, streaming UI, AI SDK model layer |
| OpenCode Go in hosted agents | LangSmith custom provider or AI SDK OpenCode adapter | OpenCode Go exposes OpenAI-compatible Chat Completions |
| `mfz` profile rendering | Deep Agents config renderer | `agent.json`, `deepagents.toml`, `AGENTS.md`, skills, subagents |
| `mfz thread` archaeology | Keep existing pipeline | Deep Agents threads and `mfz` threads are different abstractions |

## Current `mfz thread` Baseline

`mfz thread` is currently a session archaeology and synthesis pipeline, not a
live conversation runtime. It ingests OpenCode and Claude Code sessions and
produces durable artifacts:

```text
raw transcript -> gather -> dossier -> synthesize -> session.md -> digest -> digest.md
```

Important current files:

- `src/core/manifests.ts` — `threadHarnessSchema = z.enum(["claude-code", "opencode"])`
- `src/thread/runner.ts` — `DockerAgentRunner`, harness command construction, trace parsing
- `src/thread/dispatch.ts` — one agent dispatch plus trace persistence
- `src/thread/ingest.ts` — ingest orchestration
- `src/thread/storage.ts` — thread manifests, runs, destinations, defaults
- `src/thread/personas.ts` — stage prompts for discover/gather/synthesize/digest
- `docs/tuning-thread-outputs.md` — current pipeline tuning findings

The present runner launches Docker containers with either `claude` or `opencode`
inside. The container receives read-only mounts for the source session stores,
skill directories, and credentials. The output is parsed into `AgentRunResult`
and persisted as a raw trace plus run ledger row.

That shape makes a new harness feasible if it can satisfy the same minimal
contract:

- Accept a prompt and system/persona instructions.
- Run read-only or controlled tools over mounted stores.
- Return final text, raw trace/events, usage/cost fields when available.
- Fit `AgentRunner.run(request): Promise<AgentRunResult>`.

## Terminology: Three Different "Thread" Concepts

The word "thread" is overloaded across these tools.

| System | Thread Means | Persistence |
| --- | --- | --- |
| `mfz thread` | A curated workstream of past sessions, with `session.md` and `digest.md` artifacts | Git-backed thread store |
| Deep Agents | A LangGraph conversation/checkpoint scope | SQLite/Postgres checkpointer |
| Vercel AI SDK Harness | A sandboxed harness session with detachable/resumable lifecycle state | Adapter-defined resume state plus sandbox session |
| OpenHarness | A `Session`/`Conversation` message history keyed by `sessionId` | User-provided `SessionStore` |

Future integrations should not collapse these concepts. A good bridge would map
them explicitly, for example by recording a `deepagents_thread_id` or
`harness_resume_state` in an `mfz` run artifact rather than treating it as the
same thing as an `mfz` thread slug.

## Deep Agents

Deep Agents is the strongest candidate for a first runtime prototype because it
already has the agent-harness features `mfz` would otherwise have to build:
planning, filesystem tools, subagents, skills, context management, checkpointing,
and provider-agnostic model resolution.

### Source Map

Relevant repository paths from `/tmp/opencode/deepagents`:

- `libs/deepagents/deepagents/graph.py` — core `create_deep_agent(...)`
- `libs/deepagents/deepagents/_models.py` — `resolve_model(...)`
- `libs/deepagents/deepagents/backends/protocol.py` — `BackendProtocol`, `SandboxBackendProtocol`
- `libs/deepagents/deepagents/backends/composite.py` — path-routed backend composition
- `libs/deepagents/deepagents/middleware/filesystem.py` — filesystem and shell tools
- `libs/deepagents/deepagents/middleware/skills.py` — SKILL.md loading and progressive disclosure
- `libs/deepagents/deepagents/middleware/subagents.py` — `task` tool and child-agent dispatch
- `libs/deepagents/deepagents/middleware/summarization.py` — context compaction and offload
- `libs/deepagents/deepagents/middleware/memory.py` — AGENTS.md memory loading
- `libs/deepagents/deepagents/profiles/provider/provider_profiles.py` — provider profiles
- `libs/deepagents/deepagents/profiles/harness/harness_profiles.py` — harness profiles
- `libs/code/deepagents_code/agent.py` — CLI-oriented agent assembly, `create_cli_agent(...)`
- `libs/code/deepagents_code/sessions.py` — SQLite checkpointer and thread metadata
- `libs/code/deepagents_code/resume_state.py` — resume channels and model/token metadata
- `libs/code/deepagents_code/config.py` — CLI settings, env handling, model construction
- `libs/code/deepagents_code/model_config.py` — TOML model/provider config
- `libs/cli/deepagents_cli/main.py` — deploy CLI entrypoint
- `libs/acp/deepagents_acp/server.py` — Agent Client Protocol bridge

### Agent Creation

The core SDK entrypoint is `create_deep_agent(...)` in
`libs/deepagents/deepagents/graph.py`. It accepts:

- `model` as a `provider:model` string or a prebuilt chat model.
- `system_prompt` as a string or structured prompt config.
- `tools`, `middleware`, `subagents`, `skills`, `memory`, `permissions`.
- `backend` for filesystem/sandbox operations.
- `interrupt_on` for human-in-the-loop gating.
- `checkpointer`, `store`, and `cache` for LangGraph persistence.

The assembled middleware stack includes todo/planning, skills, filesystem,
subagents, summarization, patch repair, async subagents, memory, prompt caching,
tool exclusion, harness profile middleware, and human-in-the-loop middleware.

The CLI path wraps the core SDK with `create_cli_agent(...)` in
`libs/code/deepagents_code/agent.py`. That layer adds runtime model switching,
resume state, goal/rubric tools, user-question tools, shell allow lists, local
context, optional code interpreter support, and CLI-specific skill layering.

### Session Persistence and Resume

Deep Agents uses LangGraph checkpointers. The CLI app uses SQLite through
`AsyncSqliteSaver` in `libs/code/deepagents_code/sessions.py`.

Default session database:

```text
~/.deepagents/sessions.db
```

Notable functions and concepts:

- `get_checkpointer()` returns the SQLite-backed checkpointer.
- `list_threads()` lists thread metadata.
- `thread_exists()`, `delete_thread()`, and `find_similar_threads()` support resume UX.
- `ResumeStateMiddleware` stores context token counts and model metadata in checkpoint state.
- `ConfigurableModelMiddleware` persists the effective model spec and parameters.

This is a good match for long-running execution. It is not the same as `mfz`
thread storage, but it could be referenced from `mfz` run metadata.

### Model Provider Support

Deep Agents resolves model strings through LangChain `init_chat_model()`.
Provider and harness profiles allow custom model construction and runtime
tuning.

Important capabilities:

- Native `provider:model` syntax, such as `openai:gpt-5.5` or `anthropic:claude-sonnet-4-6`.
- Provider-specific initialization through `ProviderProfile`.
- Runtime prompt/tool/middleware tuning through `HarnessProfile`.
- CLI config for custom providers in `~/.deepagents/config.toml`.
- Environment scoping with `DEEPAGENTS_CODE_` and `DEEPAGENTS_CLI_` prefixes.

This is the cleanest path for Anthropic, OpenAI, OpenRouter, and OpenCode Go as
an OpenAI-compatible provider.

### Backend and Sandbox Design

Deep Agents has a strong backend abstraction:

- `BackendProtocol` — file operations (`ls`, `read`, `write`, `edit`, `grep`, `glob`, etc.).
- `SandboxBackendProtocol` — adds command execution.
- `StateBackend` — ephemeral state-backed filesystem.
- `FilesystemBackend` — real filesystem.
- `LocalShellBackend` — filesystem plus shell.
- `CompositeBackend` — route paths to different backends.
- Remote sandbox factory support for AgentCore, Daytona, LangSmith, Modal, and Runloop.

This matters for `mfz` because a future prototype could mount session stores as
read-only backends while routing scratch paths to state or temp filesystem
backends.

### Fit for `mfz`

Best prototype:

1. Add `deep-agents` to `threadHarnessSchema`.
2. Implement `DeepAgentsRunner implements AgentRunner` beside `DockerAgentRunner`.
3. Start by shelling out to `dcode` or a small Python wrapper rather than embedding Python.
4. Save raw event streams under the existing run trace path.
5. Record Deep Agents thread/checkpoint IDs in the run ledger if available.

Benefits:

- Strong durable execution story.
- Native subagents and skills.
- Provider-agnostic models.
- Filesystem/sandbox abstraction is already built.
- LangGraph persistence is mature compared with a custom runner loop.

Risks:

- Python runtime and LangGraph dependency surface.
- LangSmith is the managed path, which may not be desirable for local-only flows.
- Need an adapter layer from Deep Agents events to `AgentRunResult` usage fields.
- Need explicit policy for read-only session store access.

## Vercel AI SDK Harness

Vercel AI SDK Harness is not a replacement for Deep Agents. It is a meta-harness
interface that wraps established agent runtimes behind one `HarnessAgent` API.

### Source Map

Relevant repository paths from `/tmp/opencode/vercel-ai`:

- `packages/harness/src/v1/harness-v1.ts` — `HarnessV1` adapter contract
- `packages/harness/src/v1/harness-v1-session.ts` — session lifecycle contract
- `packages/harness/src/v1/harness-v1-lifecycle-state.ts` — resume/continue state
- `packages/harness/src/v1/harness-v1-sandbox-provider.ts` — sandbox provider contract
- `packages/harness/src/agent/harness-agent.ts` — `HarnessAgent`
- `packages/harness/src/agent/harness-agent-session.ts` — session wrapper
- `packages/harness/src/agent/internal/translate-stream-part.ts` — event translation
- `packages/harness-opencode/` — OpenCode adapter
- `packages/harness-deepagents/` — Deep Agents adapter
- `packages/harness-claude-code/` — Claude Code adapter
- `packages/harness-codex/` — Codex adapter
- `packages/harness-pi/` — Pi adapter
- `packages/sandbox-vercel/` — Vercel sandbox provider
- `packages/sandbox-just-bash/` — in-memory bash sandbox provider

### Core Contract

The adapter interface is `HarnessV1`:

```ts
type HarnessV1 = {
  specificationVersion: "harness-v1";
  harnessId: string;
  builtinTools: ToolSet;
  supportsBuiltinToolApprovals?: boolean;
  supportsBuiltinToolFiltering?: boolean;
  lifecycleStateSchema?: FlexibleSchema<unknown>;
  getBootstrap?: () => PromiseLike<HarnessV1Bootstrap>;
  doStart(options: HarnessV1StartOptions): PromiseLike<HarnessV1Session>;
};
```

`HarnessAgent` implements the AI SDK `Agent` interface and exposes normal AI SDK
methods:

- `createSession(...)`
- `generate(...)`
- `stream(...)`
- `continueGenerate(...)`
- `continueStream(...)`

Session handles support:

- `detach()` — keep runtime and sandbox alive, return resume state.
- `stop()` — stop runtime/sandbox, return resume state.
- `destroy()` — stop and clean up.
- `suspendTurn()` — pause an in-flight turn.
- `compact()` — ask the harness to compact if supported.

### Adapters

Adapter support found in the repo:

| Adapter | Package | Notes |
| --- | --- | --- |
| Deep Agents | `@ai-sdk/harness-deepagents` | LangGraph bridge, builtin file/shell tools |
| OpenCode | `@ai-sdk/harness-opencode` | Boots OpenCode server via `@opencode-ai/sdk`, supports built-in and host approvals |
| Claude Code | `@ai-sdk/harness-claude-code` | Claude SDK bridge, built-in tools and approvals |
| Codex | `@ai-sdk/harness-codex` | Codex model/defaults, shell/web search, no compaction support |
| Pi | `@ai-sdk/harness-pi` | Runs as in-process Node library, no bridge required |

The harness layer normalizes streaming outputs into AI SDK stream parts. It can
then emit UI-compatible streams through `toUIMessageStream()`, which makes it
attractive for future `mfz` UI/TUI surfaces.

### Sandbox Integration

Bridge-backed adapters require a network-capable sandbox. `@ai-sdk/sandbox-vercel`
provides port exposure, snapshots, and network policy. `@ai-sdk/sandbox-just-bash`
is lighter but not suitable for all bridge-backed adapters.

The sandbox provider interface supports:

- `createSession(...)`
- `resumeSession(...)`
- exposed ports
- network policy
- lifecycle controls
- a restricted sandbox view for user tools

### Fit for `mfz`

Best prototype after Deep Agents runner proof-of-concept:

1. Add an experimental `ai-sdk-harness` runner outside the current Docker runner.
2. Map `mfz` harness names to AI SDK adapters:
   - `opencode` -> `@ai-sdk/harness-opencode`
   - `claude-code` -> `@ai-sdk/harness-claude-code`
   - `deep-agents` -> `@ai-sdk/harness-deepagents`
   - `codex` -> `@ai-sdk/harness-codex`
   - `pi` -> `@ai-sdk/harness-pi`
3. Persist `HarnessV1ResumeSessionState` in run metadata for resumable dispatches.
4. Translate `HarnessV1StreamPart` into `AgentRunResult` and raw trace JSONL.

Benefits:

- One API across major coding runtimes.
- Good future-proofing if `mfz` wants multi-harness orchestration.
- Existing OpenCode and Deep Agents adapters reduce custom work.
- AI SDK UI streams could feed future browser/TUI surfaces.

Risks:

- Vercel sandbox dependency for many adapters.
- Experimental API surface.
- More moving parts than adding Deep Agents directly.
- `mfz` would still need permission/profile mapping and session-store decisions.

## OpenHarness

OpenHarness is a TypeScript-native agent framework built on Vercel AI SDK. It
is not the same kind of meta-harness as Vercel AI SDK Harness. It is a custom
agent runtime with composable middleware, sessions, tools, skills, MCP, and UI
streams.

### Source Map

Relevant repository paths from `/tmp/opencode/open-harness`:

- `packages/core/src/agent.ts` — `Agent`, stateless executor
- `packages/core/src/session.ts` — `Session`, persistence/compaction/retry wrapper
- `packages/core/src/conversation.ts` — middleware-based conversation wrapper
- `packages/core/src/runner.ts` — `Runner`, `Middleware`, `apply`, `pipe`
- `packages/core/src/middleware/compaction.ts` — `withCompaction(...)`
- `packages/core/src/middleware/retry.ts` — `withRetry(...)`
- `packages/core/src/middleware/persistence.ts` — `withPersistence(...)`
- `packages/core/src/providers/types.ts` — `FsProvider`, `ShellProvider`
- `packages/core/src/providers/node.ts` — Node filesystem/shell providers
- `packages/core/src/tools/create-fs-tools.ts` — filesystem tool factory
- `packages/core/src/tools/create-bash-tool.ts` — bash tool factory
- `packages/core/src/mcp.ts` — MCP connection and tool namespacing
- `packages/core/src/skills.ts` — SKILL.md discovery
- `packages/core/src/subagents.ts` — subagent sessions and metadata
- `packages/core/src/ui-stream.ts` — AI SDK UI stream bridge
- `packages/provider-chatgpt/src/provider.ts` — ChatGPT/Codex OAuth provider
- `packages/provider-chatgpt/src/auth.ts` — OAuth PKCE and device flow
- `packages/provider-chatgpt/src/token-store.ts` — token stores, including OpenCode-compatible store

### Architecture

OpenHarness has three main layers:

- `Agent` — stateless multi-step executor around AI SDK `streamText()`.
- `Session` — stateful wrapper with messages, compaction, retry, hooks, persistence.
- `Conversation` — thinner wrapper around a middleware-composed `Runner`.

Persistence is intentionally interface-based:

```ts
type SessionStore = {
  load(sessionId: string): Promise<ModelMessage[] | undefined>;
  save(sessionId: string, messages: ModelMessage[]): Promise<void>;
  delete?(sessionId: string): Promise<void>;
};
```

That is attractive for `mfz` because `mfz` could provide a thread-store-backed
implementation without adopting a database chosen by the framework.

### Tools and Policy

OpenHarness provides filesystem and bash tools through provider interfaces:

- `FsProvider`
- `ShellProvider`
- `NodeFsProvider`
- `NodeShellProvider`
- `createFsTools(...)`
- `createBashTool(...)`

Tool approval is callback-based:

```ts
type ApproveFn = (toolCall: ToolCallInfo) => boolean | Promise<boolean>;
```

There is no built-in config-file permission model like `mfz` or OpenCode.
`mfz` would need to compile profile permissions into an `ApproveFn`.

### ChatGPT/Codex OAuth

OpenHarness has a notable `@openharness/provider-chatgpt` package. It implements
ChatGPT/Codex OAuth, including PKCE, device flow, token refresh, and a token
store compatible with OpenCode auth data.

This is useful if future `mfz` work wants subscription-backed OpenAI/Codex model
access without relying on a standard `OPENAI_API_KEY`.

### Fit for `mfz`

OpenHarness is credible if `mfz` wants a TypeScript-native runner without
LangGraph. It gives useful building blocks:

- sessions and persistence hooks
- compaction/retry middleware
- filesystem and shell tools
- MCP connections
- SKILL.md discovery
- subagents and background agents
- React/Vue/UI stream integration
- ChatGPT/Codex OAuth

Gaps:

- No durable execution engine comparable to LangGraph.
- No built-in policy file model.
- No built-in `mfz`-style references/extra-folders permission system.
- Session persistence is intentionally user-supplied.
- Bash output is not as deeply integrated as dedicated coding harnesses.

## OpenCode Go API Surface

OpenCode Go exposes a native OpenAI-compatible Chat Completions endpoint:

```text
POST https://opencode.ai/zen/go/v1/chat/completions
```

Important facts:

- It is Chat Completions-compatible.
- It does not natively expose the OpenAI Responses API as of this research.
- API keys are available from OpenCode Zen and commonly passed as `OPENCODE_GO_API_KEY`.
- Community proxies exist to bridge Responses API clients to OpenCode Go Chat Completions.

Implications:

- LangSmith custom model providers can likely use OpenCode Go directly as an OpenAI-compatible endpoint.
- Deep Agents can use it if configured through LangChain/OpenAI-compatible model routing.
- Vercel AI SDK can use it through an OpenAI-compatible provider or the OpenCode harness path.
- If a client requires Responses API specifically, a proxy is needed.

Potential LangSmith custom provider configuration:

| Field | Value |
| --- | --- |
| Provider type | OpenAI Compatible Endpoint |
| Base URL | `https://opencode.ai/zen/go/v1` |
| Endpoint | `/chat/completions` under `/v1` |
| Secret | `OPENCODE_GO_API_KEY` stored as a workspace secret |
| Model | One configured OpenCode Go model per LangSmith model configuration |

## OpenWiki

OpenWiki (`langchain-ai/openwiki`) is a concrete reference implementation of a
Deep Agents-backed documentation CLI. It is directly relevant because it shows a
small, production-shaped wrapper around Deep Agents rather than a generic SDK
example.

The repo was cloned to:

```text
/tmp/opencode/openwiki
```

### Purpose and Stack

OpenWiki generates and maintains an `openwiki/` directory inside a target
repository. The generated pages are intended for AI coding agents to reference:
quickstart, architecture, workflows, domain concepts, operations, testing, and
similar project knowledge.

Runtime stack:

- TypeScript ESM, Node >= 20.
- React/Ink terminal UI.
- Deep Agents (`deepagents`) for the agent runtime.
- LangChain chat model integrations.
- SQLite LangGraph checkpointing.
- Local filesystem/shell backend rooted at the target repo.

### Source Map

Relevant paths from `/tmp/opencode/openwiki`:

- `src/agent/index.ts` — agent runtime, model creation, Deep Agents setup, stream parsing.
- `src/agent/prompt.ts` — system and user prompt assembly.
- `src/agent/utils.ts` — git context, update metadata, content snapshots.
- `src/agent/types.ts` — run/event/context types.
- `src/constants.ts` — provider registry, model IDs, env names.
- `src/env.ts` — `~/.openwiki/.env` loading/saving and diagnostics.
- `src/credentials.tsx` — interactive credential onboarding.
- `src/commands.ts` — CLI command parsing.
- `src/cli.tsx` — Ink TUI and streaming run display.
- `examples/openwiki-update.yml` — GitHub Actions scheduled update workflow.
- `examples/openwiki-update.gitlab-ci.yml` — GitLab scheduled update workflow.

Important exported symbols:

- `runOpenWikiAgent(...)` — public runtime entrypoint.
- `runOpenWikiAgentCore(...)` — inner model/provider-specific run path.
- `createOpenWikiThreadId(cwd)` — deterministic thread ID based on repo path hash.
- `sanitizeOpenRouterResponseBody(...)` — redacts debug response bodies.
- `createSystemPrompt(...)` and `createUserPrompt(...)` — prompt assembly.
- `createRunContext(...)` — builds git/update context.
- `createOpenWikiContentSnapshot(...)` — hashes generated wiki contents.
- `getUpdateNoopStatus(...)` — skips update when repo/wiki are unchanged.
- `writeLastUpdateMetadata(...)` — writes `openwiki/.last-update.json`.
- `loadOpenWikiEnv(...)`, `saveOpenWikiEnv(...)`, `getCredentialDiagnostics(...)`.

### Deep Agents Configuration Pattern

OpenWiki creates a single Deep Agents session instead of a hand-written workflow.
The relevant shape in `src/agent/index.ts` is:

```ts
createDeepAgent({
  model,
  tools: [],
  checkpointer,
  backend: new LocalShellBackend({
    maxOutputBytes: 100_000,
    rootDir: cwd,
    timeout: 120,
    virtualMode: true,
  }),
  systemPrompt: createSystemPrompt(command),
});
```

Notable choices:

- `tools: []` means OpenWiki relies on Deep Agents' backend-provided built-ins.
- `LocalShellBackend` gives filesystem and shell access rooted at the target repo.
- `virtualMode: true` makes `/` map to the repository root, avoiding host absolute paths.
- SQLite checkpointing persists conversations under `~/.openwiki/openwiki.sqlite`.
- Thread IDs are deterministic from the repo path via `createOpenWikiThreadId(cwd)`.

This is the cleanest concrete pattern found so far for an `mfz` Deep Agents
runner spike. A minimal `DeepAgentsRunner` could mirror this structure while
changing the system prompt, backend mounts, and thread/checkpoint location.

### Provider and Credential Model

Provider config is centralized in `src/constants.ts`.

Supported providers:

| Provider | Env Key | Notes |
| --- | --- | --- |
| `openrouter` | `OPENROUTER_API_KEY` | Default path, with fallback model route |
| `baseten` | `BASETEN_API_KEY` | OpenAI-compatible base URL |
| `fireworks` | `FIREWORKS_API_KEY` | OpenAI-compatible base URL |
| `openai` | `OPENAI_API_KEY` | Standard OpenAI SDK path |
| `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | Requires `OPENAI_COMPATIBLE_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` | Optional `ANTHROPIC_BASE_URL` |

Credential storage:

```text
~/.openwiki/.env
```

The env file is written with restrictive permissions. LangSmith tracing is
optional via `LANGSMITH_API_KEY`, which enables the `openwiki` LangChain project.

The model fallback pattern is especially useful for `mfz`: OpenWiki keeps model
fallback in the harness layer, not in the agent prompt.

### Repo Discovery and Wiki Generation

OpenWiki does not build an index first. It lets the Deep Agents runtime inspect
the repository live through filesystem tools and git commands.

The prompt instructs the agent to:

1. Inspect package/config files, entrypoints, domain folders, existing docs, and git history.
2. Create a temporary `openwiki/_plan.md`.
3. Write or update markdown pages under `openwiki/`.
4. Update `/AGENTS.md` or `/CLAUDE.md` with a standardized OpenWiki reference section.
5. Delete `_plan.md` before finishing.

Source grounding is prompt-enforced rather than structurally enforced. The agent
is told to ground claims in files, docs, or git evidence it inspected, but there
is no separate citation database.

### Change Detection and Update Metadata

OpenWiki has two simple but useful durability patterns:

- `createOpenWikiContentSnapshot(cwd)` hashes the generated `openwiki/` tree,
  excluding `.last-update.json`, with deterministic sorted traversal.
- `openwiki/.last-update.json` records update metadata such as git HEAD,
  timestamp, and model.

This lets the CLI avoid writing update metadata when generated content did not
change and skip some update runs when git state is unchanged.

These patterns are relevant to `mfz` generated artifacts. `mfz` could use a
similar deterministic content snapshot for rendered docs, thread digests, or
reference indexes when git status alone is too coarse.

### UI and Automation

OpenWiki is CLI-only. There is no server or web UI.

The Ink app in `src/cli.tsx`:

- Runs `runOpenWikiAgent(...)`.
- Receives stream events through `onEvent`.
- Displays model text, tool starts, tool ends, debug messages, and errors.
- Supports slash commands such as `/provider`, `/model`, `/init`, `/update`, `/clear`, `/help`, and `/exit`.

Automation examples show scheduled GitHub/GitLab runs that execute
`openwiki --update --print` and open a PR/MR with changed `openwiki/` files.

### Relevance to `mfz`

OpenWiki is highly relevant for four reasons.

First, it is a working Deep Agents CLI wrapper. It shows how little code is
needed around `createDeepAgent(...)` when the backend, checkpointer, prompt, and
stream parsing are chosen carefully.

Second, it demonstrates repo-grounded generated documentation. `mfz` already has
reference catalogs and generated indexes; OpenWiki's `openwiki/` output is close
to an agent-facing reference pack.

Third, it uses deterministic repo-scoped thread IDs and SQLite checkpointing.
That is a useful comparison point for `mfz thread` run IDs and future external
runtime metadata.

Fourth, it demonstrates an update loop that can run in CI and open a PR. If
`mfz` ever automates thread digest refreshes or reference-doc regeneration,
OpenWiki's CI examples are a useful shape.

Recommended future uses:

- Add OpenWiki as a reference repository in `shared/refs.yml` if the local references set should include it.
- Use `src/agent/index.ts` as the first file to study before implementing a direct Deep Agents runner.
- Reuse the content snapshot idea for generated thread/reference artifacts.
- Consider an `mfz refs wiki` or `mfz docs refresh` experiment that borrows the OpenWiki prompt-plan-output pattern.

## Mastra and Other Alternatives

Mastra was not cloned in this pass, but the documentation and ecosystem research
indicate it is the strongest TypeScript-native full-stack agent framework to
watch.

Mastra provides:

- TypeScript-first agents.
- Graph workflows with `.then()`, `.branch()`, `.parallel()` style composition.
- Durable workflow suspend/resume.
- Memory, including message history, working memory, semantic recall, and observational memory.
- MCP support.
- Built-in observability and evals.
- Studio/local dev UI.
- Model routing through hundreds of providers.

It is likely a better application framework than a direct `mfz thread` runner.
If `mfz` grows an interactive UI or hosted service, Mastra becomes more relevant.

Other notable alternatives:

| Tool | Best For | Notes |
| --- | --- | --- |
| OpenAI Agents SDK | OpenAI-first, Python, guardrails, handoffs, sandbox agents | Strong harness/compute split, any Chat Completions model, TS support still evolving |
| Claude Agent SDK | Claude-native workflows, hooks, permissions, subprocess loop | Strong if Claude-only is acceptable; self-hosted API layer is on you |
| Google ADK 2.0 | GCP-native graph workflows, Python/Go | Good deterministic workflow model; less natural for local `mfz` use |
| Microsoft Agent Framework | Microsoft/Azure/.NET/Python shops | Successor to AutoGen and Semantic Kernel; enterprise-oriented |
| CrewAI | Fast role-based multi-agent prototypes | Good mental model, less precise state control |
| LlamaIndex Workflows | Document-heavy/RAG/event-driven workflows | Strong if data ingestion and retrieval dominate |
| Cline/Roo/Goose/OpenHands | IDE or local desktop/terminal agent harnesses | More product/runtime than library layer |

## Comparative Matrix

| Dimension | Deep Agents | Vercel AI SDK Harness | OpenHarness | Mastra | OpenAI Agents SDK | Claude Agent SDK |
| --- | --- | --- | --- | --- | --- | --- |
| Primary role | Agent harness | Meta-harness | TS agent framework | TS app framework | Agent SDK | Claude harness SDK |
| Primary language | Python, TS | TS | TS | TS | Python, TS evolving | Python, TS |
| Model support | Any LangChain chat model | Depends on adapter | Any AI SDK model | Any model router provider | Any Chat Completions, OpenAI-optimized | Claude only |
| Durable execution | LangGraph checkpointing | Adapter/session state | User store + sessions | Workflow storage | Sessions + sandbox snapshots | Session transcript/process state |
| Subagents | Built in | Adapter-dependent | Built in | Built in | Handoffs/agents | Built in |
| Skills | Built in | Adapter-dependent | Built in | Framework-specific | Skills API direction | Built in |
| Filesystem | Backend protocol | Adapter/sandbox | Provider interface | Workspace/tools | Sandbox manifest | Sandbox filesystem |
| Sandbox | Pluggable | Vercel/Just Bash providers | User/provider supplied | Runtime dependent | Multiple providers | Anthropic/host sandbox pattern |
| UI streams | LangGraph/SDK streams | AI SDK-native | AI SDK UI streams | Studio/app integrations | SDK tracing/streams | SDK event streams |
| `mfz` fit | Strong runner candidate | Strong future meta-runner | Strong TS component source | Strong app framework candidate | Medium runner candidate | Medium if Claude-only acceptable |

## Prototype Paths

### Prototype 1: Direct Deep Agents ThreadHarness

Goal: prove `mfz thread ingest` can use Deep Agents for gather/synthesize/digest.

Scope:

- Add `"deep-agents"` to `threadHarnessSchema`.
- Add a `DeepAgentsRunner implements AgentRunner`.
- Use a small Python wrapper or `dcode` CLI to avoid embedding Python in TS.
- Preserve existing `AgentRunRequest` and `AgentRunResult` shapes.
- Persist raw Deep Agents event output in the existing run trace directory.

Success criteria:

- `mfz thread discover` works with `deep-agents`.
- One gather dispatch can read mounted session stores read-only.
- Usage/cost fields are either parsed or explicitly null with trace retained.
- Existing `claude-code` and `opencode` behavior is unchanged.

Risk controls:

- Keep it behind a profile/default opt-in.
- Do not make Deep Agents the default until cost/quality is measured.
- Reuse `docs/tuning-thread-outputs.md` methodology for comparison.

### Prototype 2: Deep Agents Config Renderer

Goal: let `mfz apply` render Deep Agents project/config files from profiles.

Candidate rendered files:

- `configs/<profile>/deepagents/agent.json`
- `configs/<profile>/deepagents/AGENTS.md`
- `configs/<profile>/deepagents/tools.json`
- `configs/<profile>/deepagents/skills/<name>/SKILL.md`
- `configs/<profile>/deepagents/subagents/<name>/agent.json`
- `configs/<profile>/deepagents/subagents/<name>/AGENTS.md`
- `configs/<profile>/deepagents/deepagents.toml` if using the deploy path

Open questions:

- Should this renderer target Managed Deep Agents, local `dcode`, or both?
- Should Deep Agents skills reuse existing `skills/active` source directly?
- Should machine config own Deep Agents API keys and sandbox preferences?

### Prototype 3: AI SDK Harness Meta-Runner

Goal: one runner abstraction over OpenCode, Claude Code, Deep Agents, Codex, and Pi.

Scope:

- Add experimental runner package or module that constructs `HarnessAgent`.
- Pick a sandbox provider; likely Vercel Sandbox for bridge-backed adapters.
- Persist `HarnessV1ResumeSessionState` per run.
- Translate stream parts to `AgentRunResult` and raw trace JSONL.

Success criteria:

- Same prompt can run against `@ai-sdk/harness-opencode` and `@ai-sdk/harness-deepagents`.
- Session `detach()` and resume state can round-trip through JSON.
- Tool approvals can map from `mfz` profile permissions.

Risk controls:

- Keep separate from the existing Docker runner.
- Treat AI SDK Harness APIs as experimental.
- Do not require Vercel account credentials for normal `mfz thread` use.

### Prototype 4: OpenHarness Session Runner Spike

Goal: test whether a TypeScript-native agent loop is enough for thread synthesis.

Scope:

- Use `Agent`, `Session`, `SessionStore`, `createFsTools`, `createBashTool`.
- Implement `SessionStore` backed by `~/.mindframe-z/thread-runs` or temp files.
- Compile existing profile permission rules into `ApproveFn`.
- Run one stage, likely `digest`, because it is single-shot and cheap.

Success criteria:

- Existing digest prompt produces comparable output.
- Compaction/retry events are captured.
- No Python or remote sandbox dependency.

Risk controls:

- Avoid using it for gather first; gather needs careful session-store access and tool loops.
- Keep it as a spike, not production path, until output quality is measured.

## Suggested Evaluation Method

Use the existing thread tuning method:

1. Hold inputs constant.
2. Compare one variable at a time: harness, model, effort, or prompt.
3. Start with digest over a fixed `session.md` because it is cheapest and easiest to compare.
4. Move to synthesize over a fixed dossier.
5. Only then test gather over mounted session stores.
6. Judge by reading output quality, not by count metrics alone.
7. Track cost, duration, token usage, and failure modes per run.

Recommended first comparison:

| Stage | Current Baseline | Candidate |
| --- | --- | --- |
| digest | `claude-code:claude-sonnet-5@high` | Deep Agents with equivalent Claude model |
| synthesize | `claude-code:claude-sonnet-5@low` | Deep Agents with equivalent Claude model |
| gather | `opencode` or `claude-code` current profile default | Deep Agents only after digest/synthesize pass |

## Open Questions

- Does Deep Agents expose enough usage/cost metadata for `ThreadDispatchRun`, or do we need external cost estimation?
- Should `mfz` store external runtime thread IDs in `thread-runs` only, or also in `manifest.json`?
- Should `ThreadHarness` include framework runtimes (`deep-agents`, `ai-sdk-harness`) or only concrete tools (`opencode`, `claude-code`, `codex`)?
- Should model identifiers remain `harness:model@effort`, or do we need provider-qualified strings like `deep-agents:anthropic:claude-sonnet-4-6`?
- How should `mfz` permissions map to Deep Agents filesystem permissions, OpenHarness `ApproveFn`, and AI SDK Harness tool approval events?
- Is Vercel Sandbox acceptable for local/private thread work, or should local Docker remain the default isolation layer?
- Should OpenCode Go be represented as a model provider, a harness, or both?

## Recommendation

Do not start with a broad abstraction. Start with the smallest prototype that
proves or disproves value:

1. Implement direct Deep Agents dispatch for one single-shot stage.
2. Measure output quality and cost against the current runner.
3. If promising, add gather support with read-only session mounts.
4. Only after that evaluate AI SDK Harness as a unifying runner.

Deep Agents is the most natural runtime candidate for `mfz thread`. Vercel AI SDK
Harness is the most interesting future meta-harness. OpenHarness is useful as a
TypeScript-native reference and component source, but it should not be the first
production integration unless avoiding Python/LangGraph becomes the primary
constraint.
