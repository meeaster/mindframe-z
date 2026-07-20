import { z } from "zod";
import type { ExecutorAuthenticationMethod } from "../core/manifests.js";
import type { ExecutorDesiredServer } from "./model.js";
import {
  type ExecutorAdapter,
  type ExecutorConnection,
  type ExecutorHealth,
  type ExecutorHttpAdapterOptions,
  type ExecutorIntegration,
  type ExecutorTool
} from "./adapter.js";
import { executorError } from "./errors.js";
import {
  assertExecutorConnectionIdentifier,
  encodeExecutorAuthenticationMethods,
  executorConnectionAddress,
  isExecutorConnectionIdentifier
} from "./contract.js";

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
const connectionSchema = z
  .object({
    owner: z.enum(["user", "org"]),
    name: z.string().refine(isExecutorConnectionIdentifier),
    integration: z.string(),
    template: z.string(),
    provider: z.string(),
    address: z.string(),
    identityLabel: z.string().nullable(),
    expiresAt: z.number().nullable(),
    oauthClient: z.string().nullable(),
    oauthClientOwner: z.string().nullable(),
    oauthScope: z.string().nullable(),
    missingOAuthScopes: z.array(z.string()),
    credentialBindings: z.record(z.string(), z.string()).optional(),
    lastHealth: healthSchema
      .nullable()
      .optional()
      .transform((value) => value ?? null)
  })
  .superRefine((connection, context) => {
    const expected = executorConnectionAddress(
      connection.owner,
      connection.integration,
      connection.name
    );
    if (connection.address !== expected) {
      context.addIssue({
        code: "custom",
        message: "connection address does not match its identity"
      });
    }
  });
const toolSchema = z
  .object({
    address: z.string(),
    owner: z.enum(["user", "org"]),
    integration: z.string(),
    connection: z.string().refine(isExecutorConnectionIdentifier),
    name: z.string(),
    pluginId: z.string(),
    description: z.string()
  })
  .superRefine((tool, context) => {
    const prefix = executorConnectionAddress(tool.owner, tool.integration, tool.connection);
    if (!tool.address.startsWith(`${prefix}.`)) {
      context.addIssue({ code: "custom", message: "tool address does not match its identity" });
    }
  });
class HttpExecutorAdapter implements ExecutorAdapter {
  constructor(
    public readonly baseUrl: string,
    private readonly token: string,
    public readonly dataDir: string,
    private readonly requestFetch: typeof globalThis.fetch,
    private readonly daemon: import("node:child_process").ChildProcess | undefined,
    private readonly timeoutMs: number
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
            authenticationTemplate: encodeExecutorAuthenticationMethods(
              config.authenticationTemplate ?? [{ slug: "none", kind: "none" }]
            ),
            slug: server.slug
          }
        : {
            transport: "stdio",
            name: server.name,
            description: server.description,
            command: config.command,
            ...(config.args ? { args: config.args } : {}),
            ...(config.env ? { env: config.env } : {}),
            authenticationTemplate: encodeExecutorAuthenticationMethods(
              config.authenticationTemplate ?? [{ slug: "none", kind: "none" }]
            ),
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
    authenticationTemplate: readonly unknown[],
    mode: "merge" | "replace"
  ): Promise<void> {
    await this.request("POST", `/mcp/servers/${encodeURIComponent(slug)}/auth`, z.unknown(), {
      authenticationTemplate: encodeExecutorAuthenticationMethods(
        authenticationTemplate as readonly ExecutorAuthenticationMethod[]
      ),
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

  async createNoAuthConnection(
    integration: string,
    name: string,
    template = "none"
  ): Promise<void> {
    assertExecutorConnectionIdentifier(name);
    await this.request("POST", "/connections", z.unknown(), {
      owner: "user",
      name,
      integration,
      template,
      values: {}
    });
  }

  async refreshConnection(integration: string, name: string): Promise<ExecutorTool[]> {
    assertExecutorConnectionIdentifier(name);
    return this.request(
      "POST",
      `/connections/user/${encodeURIComponent(integration)}/${encodeURIComponent(name)}/refresh`,
      toolSchema.array()
    );
  }

  async checkHealth(integration: string, name: string): Promise<ExecutorHealth> {
    assertExecutorConnectionIdentifier(name);
    return this.request(
      "POST",
      `/connections/user/${encodeURIComponent(integration)}/${encodeURIComponent(name)}/health`,
      healthSchema
    );
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
    options.fetch ?? globalThis.fetch,
    options.daemon,
    options.requestTimeoutMs ?? requestTimeoutMs
  );
}
