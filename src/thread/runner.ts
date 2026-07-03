import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SandboxCredentialMode, ThreadHarness } from "../core/manifests.js";
import { pathExists, type RuntimePaths } from "../core/paths.js";
import type { ThreadDispatchRun } from "./schema.js";
import {
  bedrockContainerEnv,
  readBedrockHostSettings,
  refreshBedrockCredentials,
  writeScopedBedrockCredentials
} from "./bedrock.js";
import { ensureThreadToolsImage, threadToolsImageBuildPlan } from "./build.js";
import { backfillClaudeTranscript } from "./claude-backfill.js";
import {
  buildCostSpanPayload,
  emitCostSpan,
  modelProvider,
  type TokenBreakdown
} from "./cost-span.js";
import { isLapdogReachable, lapdogContainerUrl, lapdogNetworkName, lapdogUrl } from "./lapdog.js";

// Container HOME is /home/sandbox; Claude writes transcripts under
// ~/.claude/projects. We bind a fresh host dir here per dispatch so the
// transcript survives `docker run --rm` teardown and can be replayed through
// lapdog's backfill endpoint.
const CONTAINER_CLAUDE_PROJECTS = "/home/sandbox/.claude/projects";

// Where the read-only host session store is mounted inside the dispatch container —
// distinct from the container's own writable ~/.claude. The claude-code-sessions
// skill resolves its store root from this (via CLAUDE_SESSIONS_DIR), and ingest
// builds the exact transcript path it hands gather from the same root.
export const CONTAINER_SESSION_STORE = "/mnt/claude-sessions";

// Where the read-only archive-cache is visible inside the dispatch container — a
// subtree of the existing whole-~/.mindframe-z RO mount below, so hydrated sessions
// need no dedicated volume. Shared by both harnesses; the cached artifact's own
// filename (<id>.jsonl or <id>.json) disambiguates format.
export const CONTAINER_ARCHIVE_CACHE = "/home/sandbox/.mindframe-z/archive-cache";

export interface AgentRunRequest {
  role: ThreadDispatchRun["role"];
  harness: ThreadHarness;
  model: string;
  effort?: string | undefined;
  persona: string;
  skills: string[];
  prompt: string;
  files?: string[] | undefined;
}

export interface AgentRunResult {
  text: string;
  rawTrace: string;
  usage: Omit<ThreadDispatchRun, "role" | "harness" | "model" | "duration_ms">;
  durationMs: number;
  // Harness-reported session id, used to attribute the cost span to the same
  // session the hook channel records. Undefined for harnesses that don't
  // surface one (e.g. OpenCode), in which case the cost span falls back to
  // "unknown".
  sessionId?: string | undefined;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

interface BedrockDispatchContext {
  readonly env: Record<string, string>;
  readonly credsDir: string;
}

export class DockerAgentRunner implements AgentRunner {
  // Bedrock prep (SSO refresh + scoped credential write + OTEL header resolution)
  // is shared across every dispatch in a batch: the first run primes it, the
  // rest reuse it. Refreshing per-agent would stampede the credential process's
  // :8400 port-lock and risk a redundant browser prompt.
  private bedrockContext: Promise<BedrockDispatchContext> | undefined;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly credentialMode: SandboxCredentialMode = "subscription",
    private readonly image = process.env.MFZ_THREAD_TOOLS_IMAGE ?? "mindframe-z-thread-tools:latest"
  ) {}

  private prepareBedrock(): Promise<BedrockDispatchContext> {
    this.bedrockContext ??= (async () => {
      const settings = await readBedrockHostSettings(this.paths);
      await refreshBedrockCredentials(settings);
      const credsDir = await writeScopedBedrockCredentials(this.paths, settings);
      return { env: await bedrockContainerEnv(settings), credsDir };
    })();
    return this.bedrockContext;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const bedrock = this.credentialMode === "bedrock" ? await this.prepareBedrock() : undefined;
    if (!bedrock) assertSubscriptionAuth(request.harness);
    await ensureThreadToolsImage(await threadToolsImageBuildPlan(this.paths));
    const probeReachable = await isLapdogReachable();
    const started = Date.now();
    const { tool, args, env } = buildHarnessCommand(request);
    // Capture the transcript only when lapdog is up and the harness writes one
    // we can replay (Claude Code). The dir is removed in `finally` regardless.
    const transcriptDir =
      probeReachable && request.harness === "claude-code"
        ? await mkdtemp(path.join(os.tmpdir(), "mfz-claude-projects-"))
        : undefined;
    try {
      const rawTrace = await runProcess(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          ...dockerEnvArgs({ ...env, ...bedrock?.env }),
          ...(await credentialMountArgs(this.paths, request.harness, bedrock?.credsDir)),
          ...(await sessionStoreMountArgs(this.paths)),
          ...skillMountArgs(this.paths, request.skills),
          "--volume",
          `${this.paths.home}/.mindframe-z:/home/sandbox/.mindframe-z:ro`,
          ...(transcriptDir ? ["--volume", `${transcriptDir}:${CONTAINER_CLAUDE_PROJECTS}`] : []),
          ...lapdogDockerArgs(probeReachable),
          this.image,
          tool,
          ...args
        ],
        request.prompt
      );
      const durationMs = Date.now() - started;
      const parsed = parseHarnessResult(request.harness, rawTrace, durationMs);
      if (probeReachable) {
        void emitLapdogCostSpan(
          request,
          parsed.breakdown,
          parsed.result.usage.cost_usd,
          started,
          durationMs,
          parsed.result.sessionId
        );
        // Replay the transcript before returning (and before `finally` removes
        // the dir) so the per-inference span tree lands under the real session.
        if (transcriptDir && parsed.result.sessionId) {
          await backfillClaudeTranscript(lapdogUrl(), transcriptDir, parsed.result.sessionId);
        }
      }
      return parsed.result;
    } finally {
      if (transcriptDir) await rm(transcriptDir, { recursive: true, force: true });
    }
  }
}

export function buildHarnessCommand(request: AgentRunRequest): {
  tool: "claude" | "opencode";
  args: string[];
  env: Record<string, string>;
} {
  if (request.harness === "claude-code") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", request.model];
    if (request.effort) args.push("--effort", request.effort);
    args.push(
      "--allowedTools",
      "Read",
      "Bash(jq:*)",
      "Bash(ls:*)",
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(sqlite3:*)",
      "--disallowedTools",
      "Edit",
      "Write",
      "--system-prompt",
      skillPrompt(request.persona, request.skills),
      "--add-dir",
      "/mnt/claude-sessions",
      "--add-dir",
      "/mnt/opencode-data",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}'
    );
    // Point the claude-code-sessions skill at the read-only store mount instead of
    // the container's own writable ~/.claude (which holds only this dispatch's
    // transcript). A separate var from CLAUDE_CONFIG_DIR so Claude Code's own runtime
    // home stays writable while the skill reads the mounted host store.
    return { tool: "claude", args, env: { CLAUDE_SESSIONS_DIR: CONTAINER_SESSION_STORE } };
  }

  const args = ["run", "--format", "json", "--agent", "thread-readonly", "--model", request.model];
  if (request.effort) args.push("--variant", request.effort);
  for (const file of request.files ?? []) args.push("-f", file);
  args.push(skillPrompt(request.persona, request.skills));
  return { tool: "opencode", args, env: { OPENCODE_DISABLE_AUTOCOMPACT: "true" } };
}

interface ParsedHarnessResult {
  result: AgentRunResult;
  breakdown: TokenBreakdown;
}

export function parseHarnessResult(
  harness: ThreadHarness,
  rawTrace: string,
  durationMs: number
): ParsedHarnessResult {
  const events = parseEvents(rawTrace);
  return harness === "claude-code"
    ? parseClaudeResult(events, rawTrace, durationMs)
    : parseOpenCodeResult(events, rawTrace, durationMs);
}

function parseClaudeResult(
  events: Record<string, unknown>[],
  rawTrace: string,
  durationMs: number
): ParsedHarnessResult {
  const result = [...events].reverse().find((event) => event.type === "result");
  const usage: Record<string, unknown> =
    typeof result?.usage === "object" && result.usage !== null
      ? (result.usage as Record<string, unknown>)
      : {};
  const nonCached = numberField(usage.input_tokens) ?? 0;
  const cacheRead = numberField(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = numberField(usage.cache_creation_input_tokens) ?? 0;
  const output = numberField(usage.output_tokens) ?? 0;
  // Every stream-json event (system/assistant/result) carries the same
  // session_id; take the first non-empty one so cost attribution survives a
  // trace whose result event happens to omit it.
  const sessionId = events.map((event) => textField(event.session_id)).find(Boolean);
  return {
    result: {
      text: textField(result?.result),
      rawTrace,
      durationMs,
      sessionId,
      usage: {
        cost_usd: numberField(result?.total_cost_usd),
        input_tokens: nonCached + cacheRead + cacheWrite,
        output_tokens: output,
        reasoning_tokens: null
      }
    },
    breakdown: {
      nonCachedInput: nonCached,
      cacheReadInput: cacheRead,
      cacheWriteInput: cacheWrite,
      output
    }
  };
}

function parseOpenCodeResult(
  events: Record<string, unknown>[],
  rawTrace: string,
  durationMs: number
): ParsedHarnessResult {
  const text = events
    .map((event) => {
      const part = event.part;
      return typeof part === "object" && part !== null
        ? textField((part as Record<string, unknown>).text)
        : "";
    })
    .filter(Boolean)
    .join("");
  const stepFinishes = events
    .map((event) => event.part)
    .filter(
      (part): part is Record<string, unknown> =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "step-finish"
    );
  const input = sumNullable(stepFinishes.map((part) => tokenField(part, "input"))) ?? 0;
  const output = sumNullable(stepFinishes.map((part) => tokenField(part, "output"))) ?? 0;
  return {
    result: {
      text,
      rawTrace,
      durationMs,
      usage: {
        cost_usd: sumNullable(stepFinishes.map((part) => numberField(part.cost))),
        input_tokens: input,
        output_tokens: output,
        reasoning_tokens: sumNullable(stepFinishes.map((part) => tokenField(part, "reasoning")))
      }
    },
    breakdown: {
      nonCachedInput: input,
      cacheReadInput: 0,
      cacheWriteInput: 0,
      output
    }
  };
}

function parseEvents(trace: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Harnesses can emit non-JSON progress; keep it in rawTrace and ignore it for summaries.
    }
  }
  return events;
}

function skillPrompt(persona: string, skills: readonly string[]): string {
  return [
    persona,
    skills.length ? `Load skills: ${skills.join(", ")}.` : "No extra skills.",
    skills.includes("claude-code-sessions")
      ? `The Claude session store is mounted read-only at ${CONTAINER_SESSION_STORE} (holding \`projects/\`, \`history.jsonl\`, and \`transcripts/\`) — follow the claude-code-sessions skill, but use that literal path as the store root. Do not rely on expanding \`$CLAUDE_SESSIONS_DIR\`: this dispatch's bash blocks variable expansion, so a command like \`STORE="\${CLAUDE_SESSIONS_DIR:-...}"\` is denied — substitute the literal ${CONTAINER_SESSION_STORE} into every command instead. Never read \`~/.claude\` or \`/home/sandbox/.claude\`, which is only this dispatch's own writable runtime home and holds none of the sessions you are searching. Read the store with bash — \`jq\`, \`ls\`, \`grep\`, \`find\` — which is pre-authorized for this dispatch; run those commands directly instead of asking the operator for permission. Never use the \`Read\` or \`glob\` tools on the store: those are denied and will dead-end the dispatch with no dossier. If a command is denied, switch to a literal-path \`jq\`/\`bash\` form of the same read rather than giving up.`
      : "",
    skills.includes("opencode-sessions")
      ? "The OpenCode database here is a read-only file at /mnt/opencode-data/opencode/opencode.db — a non-standard location, so follow the opencode-sessions skill's non-standard-location rule and read it with sqlite3, never `opencode db` (which opens the file read-write and would fail on the read-only mount or migrate it across versions). Run: sqlite3 -json 'file:/mnt/opencode-data/opencode/opencode.db?immutable=1' \"<SELECT ...>\". These read-only queries are pre-authorized for this dispatch; run them directly instead of asking the operator for permission."
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function dockerEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

async function credentialMountArgs(
  paths: RuntimePaths,
  harness: ThreadHarness,
  bedrockCredsDir?: string
): Promise<string[]> {
  // Bedrock dispatch mounts the scoped ~/.aws DIRECTORY (not a single file) so
  // the AWS SDK follows the credential process's atomic-rename refresh and reads
  // fresh creds per request; the agent holds no static keys, only short-lived
  // session creds. Claude Code reaches Bedrock via the SDK, so the subscription
  // OAuth token is not mounted in this mode.
  if (bedrockCredsDir) {
    return ["--volume", `${bedrockCredsDir}:/home/sandbox/.aws:ro`];
  }
  if (harness === "claude-code") {
    const file = path.join(paths.claudeDir, ".credentials.json");
    await assertExists(file);
    return ["--volume", `${file}:/home/sandbox/.claude/.credentials.json:ro`];
  }
  const file = path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "opencode",
    "auth.json"
  );
  await assertExists(file);
  return ["--volume", `${file}:/home/sandbox/.local/share/opencode/auth.json:ro`];
}

export const credentialMountArgsForTest = credentialMountArgs;

async function sessionStoreMountArgs(paths: RuntimePaths): Promise<string[]> {
  const mounts: string[] = [];
  const claudeHistory = path.join(paths.claudeDir, "history.jsonl");
  if (await pathExists(claudeHistory)) {
    mounts.push("--volume", `${claudeHistory}:/mnt/claude-sessions/history.jsonl:ro`);
  }
  const claudeProjects = path.join(paths.claudeDir, "projects");
  if (await pathExists(claudeProjects)) {
    mounts.push("--volume", `${claudeProjects}:/mnt/claude-sessions/projects:ro`);
  }
  const claudeTranscripts = path.join(paths.claudeDir, "transcripts");
  if (await pathExists(claudeTranscripts)) {
    mounts.push("--volume", `${claudeTranscripts}:/mnt/claude-sessions/transcripts:ro`);
  }

  const opencodeData = path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "opencode"
  );
  if (await pathExists(opencodeData)) {
    mounts.push("--volume", `${opencodeData}:/mnt/opencode-data/opencode:ro`);
  }
  return mounts;
}

export const sessionStoreMountArgsForTest = sessionStoreMountArgs;

function skillMountArgs(paths: RuntimePaths, skills: readonly string[]): string[] {
  return skills.flatMap((skill) => {
    const source = path.join(paths.root, "skills", skill);
    return [
      "--volume",
      `${source}:/home/sandbox/.claude/skills/${skill}:ro`,
      "--volume",
      `${source}:/home/sandbox/.agents/skills/${skill}:ro`
    ];
  });
}

export const skillMountArgsForTest = skillMountArgs;

async function assertExists(file: string): Promise<void> {
  try {
    await access(file);
  } catch {
    throw new Error(`Missing thread runner credential file: ${file}`);
  }
}

function assertSubscriptionAuth(harness: ThreadHarness): void {
  if (harness === "claude-code" && process.env.ANTHROPIC_API_KEY) {
    throw new Error("thread runner requires Claude subscription auth; unset ANTHROPIC_API_KEY");
  }
}

function runProcess(command: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${command} exited with status ${code}`));
    });
    child.stdin.end(stdin);
  });
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumNullable(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length > 0 ? numbers.reduce((total, value) => total + value, 0) : null;
}

function tokenField(part: Record<string, unknown>, field: string): number | null {
  const tokens = part.tokens;
  return typeof tokens === "object" && tokens !== null
    ? numberField((tokens as Record<string, unknown>)[field])
    : null;
}

export function lapdogDockerArgs(reachable: boolean): string[] {
  if (!reachable) return [];
  return ["--network", lapdogNetworkName, "--env", `LAPDOG_URL=${lapdogContainerUrl()}`];
}

async function emitLapdogCostSpan(
  request: AgentRunRequest,
  breakdown: TokenBreakdown,
  costUsd: number | null,
  startedMs: number,
  durationMs: number,
  sessionId: string | undefined
): Promise<void> {
  try {
    const payload = buildCostSpanPayload(request.harness, breakdown, {
      model: request.model,
      modelProvider: modelProvider(request.harness, request.model),
      startTimeMs: startedMs,
      durationMs,
      costUsd,
      sessionId
    });
    if (payload) await emitCostSpan(lapdogUrl(), payload);
  } catch {
    // fail-open: any throw from msgpack encode or fetch must never affect a dispatch.
  }
}
