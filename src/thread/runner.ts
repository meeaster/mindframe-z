import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ThreadHarness } from "../core/manifests.js";
import { pathExists, type RuntimePaths } from "../core/paths.js";
import type { ThreadDispatchRun } from "./schema.js";
import { ensureThreadToolsImage, threadToolsImageBuildPlan } from "./build.js";
import { buildCostSpanPayload, emitCostSpan, modelProvider } from "./cost-span.js";
import { isLapdogReachable, lapdogContainerUrl, lapdogNetworkName, lapdogUrl } from "./lapdog.js";

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
  rawUsage: Record<string, unknown> | null;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export class DockerAgentRunner implements AgentRunner {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly image = process.env.MFZ_THREAD_TOOLS_IMAGE ?? "mindframe-z-thread-tools:latest"
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    assertSubscriptionAuth(request.harness);
    await ensureThreadToolsImage(await threadToolsImageBuildPlan(this.paths));
    const probeReachable = await isLapdogReachable();
    const started = Date.now();
    const { tool, args, env } = buildHarnessCommand(request);
    const rawTrace = await runProcess(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        ...dockerEnvArgs(env),
        ...(await credentialMountArgs(this.paths, request.harness)),
        ...(await sessionStoreMountArgs(this.paths)),
        ...skillMountArgs(this.paths, request.skills),
        "--volume",
        `${this.paths.home}/.mindframe-z:/home/sandbox/.mindframe-z:ro`,
        ...lapdogDockerArgs(probeReachable),
        this.image,
        tool,
        ...args
      ],
      request.prompt
    );
    const result = parseHarnessResult(request.harness, rawTrace, Date.now() - started);
    void emitLapdogCostSpan(probeReachable, request, result, started);
    return result;
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
    return { tool: "claude", args, env: {} };
  }

  const args = ["run", "--format", "json", "--agent", "thread-readonly", "--model", request.model];
  if (request.effort) args.push("--variant", request.effort);
  for (const file of request.files ?? []) args.push("-f", file);
  args.push(skillPrompt(request.persona, request.skills));
  return { tool: "opencode", args, env: { OPENCODE_DISABLE_AUTOCOMPACT: "true" } };
}

export function parseHarnessResult(
  harness: ThreadHarness,
  rawTrace: string,
  durationMs: number
): AgentRunResult {
  const events = parseEvents(rawTrace);
  return harness === "claude-code"
    ? parseClaudeResult(events, rawTrace, durationMs)
    : parseOpenCodeResult(events, rawTrace, durationMs);
}

function parseClaudeResult(
  events: Record<string, unknown>[],
  rawTrace: string,
  durationMs: number
): AgentRunResult {
  const result = [...events].reverse().find((event) => event.type === "result");
  const usage: Record<string, unknown> =
    typeof result?.usage === "object" && result.usage !== null
      ? (result.usage as Record<string, unknown>)
      : {};
  return {
    text: textField(result?.result),
    rawTrace,
    durationMs,
    usage: {
      cost_usd: numberField(result?.total_cost_usd),
      input_tokens: sumNumbers(usage, [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens"
      ]),
      output_tokens: numberField(usage.output_tokens),
      reasoning_tokens: null
    },
    rawUsage: usage
  };
}

function parseOpenCodeResult(
  events: Record<string, unknown>[],
  rawTrace: string,
  durationMs: number
): AgentRunResult {
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
  return {
    text,
    rawTrace,
    durationMs,
    usage: {
      cost_usd: sumNullable(stepFinishes.map((part) => numberField(part.cost))),
      input_tokens: sumNullable(stepFinishes.map((part) => tokenField(part, "input"))),
      output_tokens: sumNullable(stepFinishes.map((part) => tokenField(part, "output"))),
      reasoning_tokens: sumNullable(stepFinishes.map((part) => tokenField(part, "reasoning")))
    },
    rawUsage: {
      input_tokens: sumNullable(stepFinishes.map((part) => tokenField(part, "input"))),
      output_tokens: sumNullable(stepFinishes.map((part) => tokenField(part, "output")))
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
      ? "When reading Claude Code sessions, use `/mnt/claude-sessions` as the read-only session store. Its `history.jsonl`, `projects/`, and `transcripts/` mirror the host Claude session files. Do not treat `/home/sandbox/.claude` as the host session store; it is only this dispatch's writable Claude runtime home."
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

async function credentialMountArgs(paths: RuntimePaths, harness: ThreadHarness): Promise<string[]> {
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

function sumNumbers(source: object, keys: readonly string[]): number | null {
  const values = keys.map((key) => numberField((source as Record<string, unknown>)[key]));
  return sumNullable(values);
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

export async function emitLapdogCostSpan(
  reachable: boolean,
  request: AgentRunRequest,
  result: AgentRunResult,
  startedMs: number
): Promise<void> {
  if (!reachable) return;
  const payload = buildCostSpanPayload(request.harness, result.rawUsage, {
    model: request.model,
    modelProvider: modelProvider(request.harness, request.model),
    startTimeMs: startedMs,
    durationMs: result.durationMs,
    costUsd: result.usage.cost_usd
  });
  if (payload) await emitCostSpan(lapdogUrl(), payload);
}
