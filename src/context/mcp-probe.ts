import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "../core/manifests.js";
import { expandHome, type RuntimePaths } from "../core/paths.js";
import { effectiveProjectState, readOverrideStore } from "../core/override-store.js";
import {
  executorBridgeName,
  filterMcpForTarget,
  requiresExecutorBridge,
  type ResolvedProfile
} from "../core/profile.js";
import type { ContextHarness, ContextMcpProbe } from "./model.js";
import { measureText } from "./measurement.js";
import { executorBridgeArgs } from "../renderers/executor.js";
import {
  jsonString,
  parseJsonObject,
  parseJsonText,
  type JsonObject,
  type JsonValue
} from "../core/json.js";

const protocolVersion = "2025-06-18";
const clientVersion = "mfz-context-probe";
const requestTimeoutMs = 30_000;
const maxToolPages = 100;

interface McpConnection {
  request(method: string, params: JsonObject, id: number): Promise<JsonValue>;
  notify(method: string, params: JsonObject): Promise<void>;
  close(): Promise<void>;
}

function probeError(): Error {
  return new Error("MCP probe failed; the server response or transport was unavailable");
}

function temporaryEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: directory,
    MFZ_HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "state"),
    OPENCODE_CONFIG_DIR: path.join(directory, "opencode"),
    CLAUDE_CONFIG_DIR: path.join(directory, "claude")
  };
}

function parseResponse(response: JsonValue): JsonValue {
  const message = parseJsonObject(response);
  if (!message || message.error !== undefined || message.result === undefined) throw probeError();
  return message.result;
}

function parseSseResponse(body: string): JsonValue {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) throw probeError();
  try {
    const parsed = parseJsonText(data);
    if (parsed === undefined) throw probeError();
    return parsed;
  } catch {
    throw probeError();
  }
}

class HttpConnection implements McpConnection {
  private sessionId: string | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> | undefined
  ) {}

  async request(method: string, params: JsonObject, id: number): Promise<JsonValue> {
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    return parseResponse(response);
  }

  async notify(method: string, params: JsonObject): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {}

  private async post(message: JsonObject): Promise<JsonValue> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const headers = {
        ...this.headers,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      };
      if (this.sessionId) Object.assign(headers, { "Mcp-Session-Id": this.sessionId });
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal
      });
      this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
      if (!response.ok) throw probeError();
      const body = await response.text();
      if (!body.trim()) return {};
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) return parseSseResponse(body);
      try {
        const parsed = parseJsonText(body);
        if (parsed === undefined) throw probeError();
        return parsed;
      } catch {
        throw probeError();
      }
    } catch {
      throw probeError();
    } finally {
      clearTimeout(timer);
    }
  }
}

class StdioConnection implements McpConnection {
  private buffer = Buffer.alloc(0);
  private readonly messages: JsonValue[] = [];
  private readonly waiters: Array<{
    resolve: (message: JsonValue) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.drain();
    });
    child.stderr.on("data", () => {});
    child.on("error", () => this.fail());
    child.on("close", () => this.fail());
  }

  async request(method: string, params: JsonObject, id: number): Promise<JsonValue> {
    this.write({ jsonrpc: "2.0", id, method, params });
    while (true) {
      const message = await this.next();
      const response = parseJsonObject(message);
      if (!response || response.id !== id) continue;
      return parseResponse(message);
    }
  }

  async notify(method: string, params: JsonObject): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!this.child.killed) this.child.kill();
    if (await exited) return;
    const killed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    this.child.kill("SIGKILL");
    await killed;
  }

  private write(message: JsonObject): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async next(): Promise<JsonValue> {
    const message = this.messages.shift();
    if (message !== undefined) return message;
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(probeError());
      }, requestTimeoutMs);
      this.waiters.push({
        resolve: (message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private drain(): void {
    while (true) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const body = this.buffer.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(lineEnd + 1);
      if (!body.trim()) continue;
      try {
        const message = parseJsonText(body);
        if (message === undefined) throw probeError();
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.messages.push(message);
      } catch {
        this.fail();
        return;
      }
    }
  }

  private fail(): void {
    if (this.failure) return;
    this.failure = probeError();
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }
}

function createConnection(
  server: McpServer,
  paths: RuntimePaths,
  inspectedDirectory: string,
  environment: NodeJS.ProcessEnv
): McpConnection {
  if (server.type === "remote") return new HttpConnection(server.url, server.headers);
  const [command, ...args] = server.command.map((part) => expandHome(part, paths.home));
  if (!command) throw probeError();
  const protectedEnvironment = {
    HOME: environment.HOME,
    MFZ_HOME: environment.MFZ_HOME,
    XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
    XDG_DATA_HOME: environment.XDG_DATA_HOME,
    XDG_CACHE_HOME: environment.XDG_CACHE_HOME,
    XDG_STATE_HOME: environment.XDG_STATE_HOME,
    OPENCODE_CONFIG_DIR: environment.OPENCODE_CONFIG_DIR,
    CLAUDE_CONFIG_DIR: environment.CLAUDE_CONFIG_DIR
  };
  const child = spawn(command, args, {
    cwd: inspectedDirectory,
    env: { ...environment, ...server.env, ...protectedEnvironment },
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new StdioConnection(child);
}

async function collectTools(
  connection: McpConnection
): Promise<{ tools: JsonValue[]; pages: number }> {
  const tools: JsonValue[] = [];
  let cursor: string | undefined;
  for (let pages = 1; pages <= maxToolPages; pages += 1) {
    const result = await connection.request("tools/list", cursor ? { cursor } : {}, pages + 1);
    const page = parseJsonObject(result);
    const pageTools = page ? page.tools : undefined;
    if (!Array.isArray(pageTools)) throw probeError();
    tools.push(...pageTools);
    const nextCursor = page ? jsonString(page.nextCursor) : undefined;
    if (!nextCursor) return { tools, pages };
    cursor = nextCursor;
  }
  throw probeError();
}

export async function probeMcpServer(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  harness: ContextHarness,
  serverName: string,
  inspectedDirectory: string,
  projectRoot: string | undefined
): Promise<ContextMcpProbe> {
  const target = filterMcpForTarget(profile, harness).find((entry) => entry.name === serverName);
  const sharedExecutor = serverName === executorBridgeName && requiresExecutorBridge(profile);
  const overrides = await readOverrideStore(paths.home);
  const effective = effectiveProjectState(overrides, projectRoot, profile, harness, "mcp");
  if ((!target && !sharedExecutor) || (!sharedExecutor && effective[serverName] !== true)) {
    throw new Error(
      `MCP server ${serverName} is not enabled for ${harness} in profile ${profile.name}`
    );
  }
  if (target?.server.type === "remote" && target.server.transport === "sse") {
    throw new Error("MCP probe does not support remote SSE transport; no connection was made");
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mfz-context-mcp-"));
  let connection: McpConnection | undefined;
  try {
    if (sharedExecutor) {
      const child = spawn("executor", executorBridgeArgs(profile), {
        env: temporaryEnvironment(temporaryDirectory),
        stdio: ["pipe", "pipe", "pipe"]
      });
      connection = new StdioConnection(child);
    } else {
      connection = createConnection(
        target!.server,
        paths,
        inspectedDirectory,
        temporaryEnvironment(temporaryDirectory)
      );
    }
    const initialized = await connection.request(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: clientVersion, version: "0.1.0" }
      },
      1
    );
    const initializedObject = parseJsonObject(initialized);
    if (!initializedObject) throw probeError();
    const instructions = jsonString(initializedObject.instructions) ?? "";
    await connection.notify("notifications/initialized", {});
    const collected = await collectTools(connection);
    return {
      harness,
      server: serverName,
      instructions: measureText(instructions),
      toolSchemas: measureText(JSON.stringify(collected.tools)),
      toolCount: collected.tools.length,
      pages: collected.pages
    };
  } catch {
    throw probeError();
  } finally {
    await connection?.close().catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
