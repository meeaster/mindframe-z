import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import {
  executorConfigPath,
  executorDataDir,
  executorScopeDir,
  type RuntimePaths
} from "../core/paths.js";
import type { ExecutorDesiredServer } from "./model.js";
import { createHttpExecutorAdapter } from "./http.js";
import { executorError } from "./errors.js";

const SUPPORTED_EXECUTOR_VERSION = "1.5.33";
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
  owner: string;
  name: string;
  integration: string;
  template: string;
  provider: string;
  identityLabel: string | null;
  expiresAt: number | null;
  oauthClient: string | null;
  oauthClientOwner: string | null;
  oauthScope: string | null;
  missingOAuthScopes: string[];
  lastHealth: { status: string; checkedAt: number; detail?: string | undefined } | null;
}

export interface ExecutorHealth {
  status: string;
  checkedAt: number;
  detail?: string | undefined;
  missingOAuthScopes?: string[] | undefined;
}

export interface ExecutorAdapterOptions {
  paths: RuntimePaths;
  profileName: string;
  binary?: string;
  fetch?: typeof globalThis.fetch;
  expectedVersion?: string;
}

export interface ExecutorHttpAdapterOptions {
  baseUrl: string;
  token: string;
  dataDir?: string;
  scopeDir?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  daemon?: ChildProcess | undefined;
  openExternal?: ((url: string) => Promise<void>) | undefined;
}

export interface ExecutorAdapter {
  readonly baseUrl: string;
  readonly dataDir: string;
  readonly scopeDir: string;
  getIntegration(slug: string): Promise<ExecutorIntegration | null>;
  updateIntegration(slug: string, input: { description?: string; name?: string }): Promise<void>;
  addServer(server: ExecutorDesiredServer): Promise<void>;
  configureServer(slug: string, config: Record<string, unknown>): Promise<void>;
  configureAuth(
    slug: string,
    authenticationTemplate: unknown[],
    mode: "merge" | "replace"
  ): Promise<void>;
  removeIntegration(slug: string): Promise<void>;
  listConnections(integration: string): Promise<ExecutorConnection[]>;
  createNoAuthConnection(integration: string, name: string): Promise<void>;
  refreshConnection(integration: string, name: string): Promise<void>;
  checkHealth(integration: string, name: string): Promise<ExecutorHealth>;
  authorizeOAuth(input: {
    integration: string;
    endpoint: string;
    name: string;
    template: string;
    scopes: string[];
    interactive: boolean;
  }): Promise<void>;
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

async function validateBinary(binary: string, expectedVersion: string): Promise<void> {
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
  const version = result.stdout.trim().match(/(?:v)?(\d+\.\d+\.\d+)/)?.[1];
  if (version !== expectedVersion) {
    throw executorError(
      `Unsupported Executor version ${version ?? "unknown"}; expected ${expectedVersion}`
    );
  }
}

async function startDaemon(
  binary: string,
  dataDir: string,
  scopeDir: string,
  origin: string
): Promise<ChildProcess> {
  const url = new URL(origin);
  const child = spawn(
    binary,
    [
      "daemon",
      "run",
      "--foreground",
      "--port",
      url.port,
      "--scope",
      scopeDir,
      "--log-level",
      "error"
    ],
    {
      env: { ...process.env, EXECUTOR_DATA_DIR: dataDir, EXECUTOR_SCOPE_DIR: scopeDir },
      stdio: "ignore"
    }
  );
  child.unref();
  return child;
}

async function resolveRuntime(
  binary: string,
  dataDir: string,
  scopeDir: string,
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
  const daemon = await startDaemon(binary, dataDir, scopeDir, origin);
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
  const expectedVersion = options.expectedVersion ?? SUPPORTED_EXECUTOR_VERSION;
  await validateBinary(binary, expectedVersion);
  const dataDir = executorDataDir(options.paths, options.profileName);
  const scopeDir = executorScopeDir(options.paths, options.profileName);
  await mkdir(dataDir, { recursive: true });
  await mkdir(scopeDir, { recursive: true });
  const configPath = executorConfigPath(options.paths, options.profileName);
  try {
    await readFile(configPath, "utf8");
  } catch {
    await writeFile(configPath, '{\n  "version": 1\n}\n', "utf8");
  }
  const runtime = await resolveRuntime(
    binary,
    dataDir,
    scopeDir,
    options.fetch ?? globalThis.fetch
  );
  return createHttpExecutorAdapter({
    baseUrl: runtime.origin,
    token: runtime.token,
    dataDir,
    scopeDir,
    fetch: options.fetch ?? globalThis.fetch,
    daemon: runtime.daemon,
    requestTimeoutMs
  });
}

export async function attachExecutorAdapter(options: {
  paths: RuntimePaths;
  profileName: string;
  fetch?: typeof globalThis.fetch;
}): Promise<ExecutorAdapter | null> {
  const dataDir = executorDataDir(options.paths, options.profileName);
  const scopeDir = executorScopeDir(options.paths, options.profileName);
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
    scopeDir,
    fetch: requestFetch,
    requestTimeoutMs: 2_000
  });
}

export const executorVersion = SUPPORTED_EXECUTOR_VERSION;
