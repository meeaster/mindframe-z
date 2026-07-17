import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import type { ExecutorDesiredServer } from "./model.js";
import {
  type ExecutorAdapter,
  type ExecutorConnection,
  type ExecutorHealth,
  type ExecutorHttpAdapterOptions,
  type ExecutorIntegration
} from "./adapter.js";
import { executorError } from "./errors.js";

const requestTimeoutMs = 30_000;

const healthSchema = z.object({
  status: z.string(),
  checkedAt: z.number(),
  detail: z.string().optional(),
  missingOAuthScopes: z.array(z.string()).optional()
});
const integrationSchema = z.object({
  slug: z.string(),
  description: z.string(),
  kind: z.string(),
  canRemove: z.boolean(),
  canRefresh: z.boolean(),
  config: z.record(z.string(), z.unknown())
});
const connectionSchema = z.object({
  owner: z.string(),
  name: z.string(),
  integration: z.string(),
  template: z.string(),
  provider: z.string(),
  identityLabel: z.string().nullable(),
  expiresAt: z.number().nullable(),
  oauthClient: z.string().nullable(),
  oauthClientOwner: z.string().nullable(),
  oauthScope: z.string().nullable(),
  missingOAuthScopes: z.array(z.string()),
  lastHealth: healthSchema.nullable()
});
const oauthProbeSchema = z.object({
  issuer: z.string().nullable().optional(),
  authorizationUrl: z.string(),
  tokenUrl: z.string(),
  resource: z.string().nullable().optional(),
  scopesSupported: z.array(z.string()).optional(),
  registrationEndpoint: z.string().nullable().optional(),
  tokenEndpointAuthMethodsSupported: z.array(z.string()).optional()
});
const oauthStartSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connected"), connection: connectionSchema }),
  z.object({ status: z.literal("redirect"), authorizationUrl: z.string(), state: z.string() })
]);
const oauthRegistrationSchema = z.object({ client: z.string().min(1) });

async function defaultOpenExternal(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await execa(opener, [url], { reject: false });
  if (result.exitCode !== 0) {
    throw executorError(`Unable to open the Executor authorization handoff: ${result.stderr}`);
  }
}

async function openOAuthHandoff(
  authorizationUrl: string,
  openExternal: (url: string) => Promise<void>
): Promise<() => Promise<void>> {
  const nonce = randomUUID();
  const endpoint = `/oauth/${nonce}`;
  const server = createHttpServer((request, response) => {
    if (request.url !== endpoint) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(302, {
      location: authorizationUrl,
      "cache-control": "no-store"
    });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    server.close();
    throw executorError("Unable to allocate the browser handoff port");
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    await openExternal(`http://127.0.0.1:${port}${endpoint}`);
  } catch (error) {
    await close();
    throw executorError(error instanceof Error ? error.message : String(error));
  }
  return close;
}

function isHealthy(connection: ExecutorConnection): boolean {
  return connection.lastHealth?.status === "healthy";
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

class HttpExecutorAdapter implements ExecutorAdapter {
  constructor(
    public readonly baseUrl: string,
    private readonly token: string,
    public readonly dataDir: string,
    public readonly scopeDir: string,
    private readonly requestFetch: typeof globalThis.fetch,
    private readonly daemon: import("node:child_process").ChildProcess | undefined,
    private readonly timeoutMs: number,
    private readonly openExternal: (url: string) => Promise<void>
  ) {}

  private async request<T>(
    method: string,
    endpoint: string,
    schema: z.ZodType<T>,
    body?: unknown
  ): Promise<T> {
    try {
      const response = await this.requestFetch(`${this.baseUrl}/api${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const text = await response.text();
      if (!response.ok)
        throw executorError(
          `Executor API ${method} ${endpoint} failed: ${response.status} ${text}`
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw executorError(`Executor API ${method} ${endpoint} returned malformed JSON`);
      }
      try {
        return schema.parse(parsed);
      } catch {
        throw executorError(`Executor API ${method} ${endpoint} returned an invalid response`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Executor API")) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw executorError(`Executor API ${method} ${endpoint} unavailable: ${message}`);
    }
  }

  async getIntegration(slug: string): Promise<ExecutorIntegration | null> {
    return this.request(
      "GET",
      `/mcp/servers/${encodeURIComponent(slug)}`,
      integrationSchema.nullable()
    );
  }

  async updateIntegration(
    slug: string,
    input: { description?: string; name?: string }
  ): Promise<void> {
    await this.request("PATCH", `/integrations/${encodeURIComponent(slug)}`, z.unknown(), input);
  }

  async addServer(server: ExecutorDesiredServer): Promise<void> {
    const config = server.config;
    const body =
      config.transport === "remote"
        ? {
            transport: "remote",
            name: server.name,
            description: server.description,
            endpoint: config.endpoint,
            remoteTransport: config.remoteTransport,
            slug: server.slug,
            authenticationTemplate: config.authenticationTemplate
          }
        : {
            transport: "stdio",
            name: server.name,
            description: server.description,
            command: config.command,
            ...(config.args ? { args: config.args } : {}),
            ...(config.env ? { env: config.env } : {}),
            slug: server.slug
          };
    await this.request("POST", "/mcp/servers", z.unknown(), body);
  }

  async configureServer(slug: string, config: Record<string, unknown>): Promise<void> {
    await this.request("POST", `/mcp/servers/${encodeURIComponent(slug)}/config`, z.unknown(), {
      config
    });
  }

  async configureAuth(
    slug: string,
    authenticationTemplate: unknown[],
    mode: "merge" | "replace"
  ): Promise<void> {
    await this.request("POST", `/mcp/servers/${encodeURIComponent(slug)}/auth`, z.unknown(), {
      authenticationTemplate,
      mode
    });
  }

  async removeIntegration(slug: string): Promise<void> {
    await this.request("DELETE", `/mcp/servers/${encodeURIComponent(slug)}`, z.unknown());
  }

  async listConnections(integration: string): Promise<ExecutorConnection[]> {
    return this.request(
      "GET",
      `/connections?integration=${encodeURIComponent(integration)}`,
      connectionSchema.array()
    );
  }

  async createNoAuthConnection(integration: string, name: string): Promise<void> {
    await this.request("POST", "/connections", z.unknown(), {
      owner: "user",
      name,
      integration,
      template: "none",
      values: {}
    });
  }

  async refreshConnection(integration: string, name: string): Promise<void> {
    await this.request(
      "POST",
      `/connections/user/${encodeURIComponent(integration)}/${encodeURIComponent(name)}/refresh`,
      z.unknown()
    );
  }

  async checkHealth(integration: string, name: string): Promise<ExecutorHealth> {
    return this.request(
      "POST",
      `/connections/user/${encodeURIComponent(integration)}/${encodeURIComponent(name)}/health`,
      healthSchema
    );
  }

  async authorizeOAuth(input: {
    integration: string;
    endpoint: string;
    name: string;
    template: string;
    scopes: string[];
    interactive: boolean;
  }): Promise<void> {
    if (!input.interactive) {
      throw executorError(
        `Executor OAuth authorization is required for ${input.integration}; rerun interactively`
      );
    }
    const probed = await this.request("POST", "/oauth/probe", oauthProbeSchema, {
      url: input.endpoint
    });
    if (!probed.registrationEndpoint) {
      throw executorError(
        `Executor OAuth for ${input.integration} requires an explicit client registration`
      );
    }
    const clientSlug = `${input.integration}-mfz`;
    const registered = await this.request(
      "POST",
      "/oauth/clients/register-dynamic",
      oauthRegistrationSchema,
      {
        owner: "user",
        slug: clientSlug,
        issuer: probed.issuer ?? null,
        registrationEndpoint: probed.registrationEndpoint,
        authorizationUrl: probed.authorizationUrl,
        tokenUrl: probed.tokenUrl,
        resource: probed.resource ?? null,
        scopes: input.scopes,
        tokenEndpointAuthMethodsSupported: probed.tokenEndpointAuthMethodsSupported,
        clientName: "mindframe-z",
        originIntegration: input.integration
      }
    );
    const started = await this.request("POST", "/oauth/start", oauthStartSchema, {
      client: registered.client,
      clientOwner: "user",
      owner: "user",
      name: input.name,
      integration: input.integration,
      template: input.template
    });
    if (started.status === "connected") return;
    const closeHandoff = await openOAuthHandoff(started.authorizationUrl, this.openExternal);
    try {
      await waitFor(async () => {
        const connections = await this.listConnections(input.integration);
        const connection = connections.find((item) => item.name === input.name);
        return connection && isHealthy(connection) ? connection : undefined;
      }, 120_000);
    } finally {
      await closeHandoff();
    }
  }

  async close(): Promise<void> {
    if (!this.daemon || this.daemon.exitCode !== null) return;
    this.daemon.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      this.daemon?.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export function createHttpExecutorAdapter(options: ExecutorHttpAdapterOptions): ExecutorAdapter {
  return new HttpExecutorAdapter(
    options.baseUrl,
    options.token,
    options.dataDir ?? "",
    options.scopeDir ?? "",
    options.fetch ?? globalThis.fetch,
    options.daemon,
    options.requestTimeoutMs ?? requestTimeoutMs,
    options.openExternal ?? defaultOpenExternal
  );
}
