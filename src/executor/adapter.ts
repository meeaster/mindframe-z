import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { executorDataDir } from "../core/paths.js";
import type { ExecutorAuthenticationMethod } from "../core/manifests.js";
import type { ExecutorDesiredServer } from "./model.js";
import { createHttpExecutorAdapter } from "./http.js";
import { executorError } from "./errors.js";

export {
  assertExecutorConnectionIdentifier,
  encodeExecutorAuthenticationMethod,
  encodeExecutorAuthenticationMethods,
  executorConnectionAddress,
  isExecutorConnectionIdentifier
} from "./contract.js";

const requestTimeoutMs = 30_000;

interface ExecutorServerManifest {
  connection?: { origin?: string; auth?: { token?: string } };
}

export interface ExecutorIntegration {
  slug: string;
  description: string;
  kind: string;
  canRemove: boolean;
  canRefresh: boolean;
  config: Record<string, unknown>;
}

export interface ExecutorConnection {
  owner: "user" | "org";
  name: string;
  integration: string;
  template: string;
  provider: string;
  address: string;
  identityLabel: string | null;
  expiresAt: number | null;
  oauthClient: string | null;
  oauthClientOwner: string | null;
  oauthScope: string | null;
  missingOAuthScopes: string[];
  credentialBindings?: Record<string, string> | undefined;
  lastHealth: { status: string; checkedAt: number; detail?: string | undefined } | null;
}

export interface ExecutorHealth {
  status: string;
  checkedAt: number;
  detail?: string | undefined;
  missingOAuthScopes?: string[] | undefined;
}

export interface ExecutorTool {
  address: string;
  owner: string;
  integration: string;
  connection: string;
  name: string;
  pluginId: string;
  description: string;
}

export interface ExecutorAdapterOptions {
  binary?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ExecutorHttpAdapterOptions {
  baseUrl: string;
  token: string;
  dataDir?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  daemon?: ChildProcess | undefined;
}

export interface ExecutorAdapter {
  readonly baseUrl: string;
  readonly dataDir: string;
  getIntegration(slug: string): Promise<ExecutorIntegration | null>;
  updateIntegration(slug: string, input: { description?: string; name?: string }): Promise<void>;
  addServer(server: ExecutorDesiredServer): Promise<void>;
  configureServer(slug: string, config: Record<string, unknown>): Promise<void>;
  configureAuth(
    slug: string,
    authenticationTemplate: readonly ExecutorAuthenticationMethod[],
    mode: "merge" | "replace"
  ): Promise<void>;
  removeIntegration(slug: string): Promise<void>;
  listConnections(integration: string): Promise<ExecutorConnection[]>;
  createNoAuthConnection(integration: string, name: string, template?: string): Promise<void>;
  refreshConnection(integration: string, name: string): Promise<ExecutorTool[]>;
  checkHealth(integration: string, name: string): Promise<ExecutorHealth>;
  close(): Promise<void>;
}

export { redactExecutorError } from "./errors.js";

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function canonicalLoopbackOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw executorError("Unable to allocate a local Executor port");
  return port;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw executorError("Executor daemon did not become ready before the timeout");
}

async function validateBinary(binary: string): Promise<void> {
  let result;
  try {
    result = await execa(binary, ["--version"], { reject: false });
  } catch (error) {
    throw executorError(
      `Executor is unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (result.exitCode !== 0)
    throw executorError(`Executor is unavailable: ${result.stderr || result.stdout}`);
}

async function startDaemon(binary: string, origin: string): Promise<ChildProcess> {
  const url = new URL(origin);
  const child = spawn(
    binary,
    ["daemon", "run", "--foreground", "--port", url.port, "--log-level", "error"],
    {
      env: { ...process.env },
      stdio: "ignore"
    }
  );
  child.unref();
  return child;
}

async function resolveRuntime(
  binary: string,
  dataDir: string,
  requestFetch: typeof globalThis.fetch
): Promise<{ origin: string; token: string; daemon?: ChildProcess }> {
  const manifestPath = path.join(dataDir, "server-control", "server.json");
  const tokenPath = path.join(dataDir, "server-control", "auth.json");
  const existing = await readJson<ExecutorServerManifest>(manifestPath);
  const auth = await readJson<{ token?: unknown }>(tokenPath);
  const existingOrigin = existing?.connection?.origin;
  const existingToken =
    typeof auth?.token === "string" ? auth.token : existing?.connection?.auth?.token;
  if (existingOrigin && existingToken) {
    try {
      const response = await requestFetch(`${existingOrigin}/api/integrations`, {
        headers: { authorization: `Bearer ${existingToken}` },
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok)
        return { origin: canonicalLoopbackOrigin(existingOrigin), token: existingToken };
    } catch {
      // Stale discovery data is safe to ignore; the daemon owns the real lock.
    }
  }

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const daemon = await startDaemon(binary, origin);
  return waitFor(async () => {
    const tokenRecord = await readJson<{ token?: unknown }>(tokenPath);
    const manifest = await readJson<ExecutorServerManifest>(manifestPath);
    const token =
      typeof tokenRecord?.token === "string"
        ? tokenRecord.token
        : typeof manifest?.connection?.auth?.token === "string"
          ? manifest.connection.auth.token
          : undefined;
    const advertised = manifest?.connection?.origin ?? origin;
    if (!token) return undefined;
    try {
      const response = await requestFetch(`${advertised}/api/integrations`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000)
      });
      return response.ok ? { origin: canonicalLoopbackOrigin(advertised), token } : undefined;
    } catch {
      return undefined;
    }
  }).then((runtime) => ({ ...runtime, daemon }));
}

export function createExecutorHttpAdapter(options: ExecutorHttpAdapterOptions): ExecutorAdapter {
  return createHttpExecutorAdapter(options);
}

export async function createExecutorAdapter(
  options: ExecutorAdapterOptions
): Promise<ExecutorAdapter> {
  const binary = options.binary ?? "executor";
  await validateBinary(binary);
  const dataDir = executorDataDir();
  const runtime = await resolveRuntime(binary, dataDir, options.fetch ?? globalThis.fetch);
  return createHttpExecutorAdapter({
    baseUrl: runtime.origin,
    token: runtime.token,
    dataDir,
    fetch: options.fetch ?? globalThis.fetch,
    daemon: runtime.daemon,
    requestTimeoutMs
  });
}

export async function attachExecutorAdapter(options: {
  fetch?: typeof globalThis.fetch;
}): Promise<ExecutorAdapter | null> {
  const dataDir = executorDataDir();
  const manifest = await readJson<ExecutorServerManifest>(
    path.join(dataDir, "server-control", "server.json")
  );
  const auth = await readJson<{ token?: unknown }>(
    path.join(dataDir, "server-control", "auth.json")
  );
  const origin = manifest?.connection?.origin;
  const token = typeof auth?.token === "string" ? auth.token : manifest?.connection?.auth?.token;
  if (!origin || !token) return null;

  const requestFetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await requestFetch(`${origin}/api/integrations`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) return null;
  } catch {
    return null;
  }

  return createHttpExecutorAdapter({
    baseUrl: canonicalLoopbackOrigin(origin),
    token,
    dataDir,
    fetch: requestFetch,
    requestTimeoutMs: 2_000
  });
}
