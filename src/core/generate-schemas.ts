import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z, type ZodType } from "zod";
import {
  machineSchema,
  homeManifestSchema,
  mcpManifestSchema,
  profileSchema,
  refsManifestSchema,
  skillsManifestSchema,
  vendorLockSchema
} from "./manifests.js";
import { threadManifestSchema, threadRunsSchema } from "../thread/schema.js";

const schemaFiles: Array<{ schema: ZodType; filename: string }> = [
  { schema: refsManifestSchema, filename: "references.schema.json" },
  { schema: skillsManifestSchema, filename: "skills.schema.json" },
  { schema: vendorLockSchema, filename: "skills-vendor-lock.schema.json" },
  { schema: mcpManifestSchema, filename: "mcp.schema.json" },
  { schema: profileSchema, filename: "profile.schema.json" },
  { schema: homeManifestSchema, filename: "mfz_home.schema.json" },
  { schema: machineSchema, filename: "machine.schema.json" },
  { schema: threadManifestSchema, filename: "thread-manifest.schema.json" },
  { schema: threadRunsSchema, filename: "thread-runs.schema.json" }
];

function strengthenProfileMcpSchema(schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const mcp = properties.mcp!;
  const entries = mcp.additionalProperties as Record<string, unknown>;
  const direct = (entries.anyOf as Record<string, unknown>[])[0]!;
  const directProperties = direct.properties as Record<string, Record<string, unknown>>;
  const agents = directProperties.agents!;
  const agentBranches = agents.anyOf as Record<string, unknown>[];
  const concise = agentBranches[0]!;
  concise.uniqueItems = true;

  const grouped = agentBranches[1]!;
  for (const variant of grouped.anyOf as Record<string, unknown>[]) {
    const groupedProperties = variant.properties as Record<string, Record<string, unknown>>;
    groupedProperties.enabled!.uniqueItems = true;
    groupedProperties.disabled!.uniqueItems = true;
  }
  grouped.not = {
    anyOf: ["opencode", "claude-code", "codex"].map((agent) => ({
      required: ["enabled", "disabled"],
      properties: {
        enabled: { contains: { const: agent } },
        disabled: { contains: { const: agent } }
      }
    }))
  };

  const executor = (entries.anyOf as Record<string, unknown>[])[1]!;
  const executorProperties = executor.properties as Record<string, Record<string, unknown>>;
  executorProperties.connections = {
    type: "object",
    minProperties: 1,
    propertyNames: {
      type: "string",
      minLength: 1,
      pattern: "^[a-z][a-z0-9_]*$"
    },
    additionalProperties: { type: "string", minLength: 1 }
  };
}

function strengthenMcpSchema(schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const servers = properties.servers;
  if (!servers) throw new Error("mcp.schema.json is missing the servers property");
  const branches = (servers.additionalProperties as Record<string, unknown> | undefined)?.anyOf;
  if (!Array.isArray(branches)) {
    throw new Error("mcp.schema.json servers must expose anyOf branches");
  }
  for (const branch of branches) {
    const branchProperties = (branch as Record<string, unknown>).properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!branchProperties) throw new Error("mcp.schema.json has a branch without properties");
    const executor = branchProperties.executor;
    if (!executor) continue;
    const executorProperties = executor.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!executorProperties) throw new Error("mcp.schema.json Executor branch lacks properties");
    const authentication = executorProperties.authentication;
    if (!authentication) continue;
    const methods = authentication.items as Record<string, unknown> | undefined;
    const methodBranches = methods?.anyOf;
    if (!Array.isArray(methodBranches)) {
      throw new Error("mcp.schema.json Executor authentication lacks method branches");
    }
    const oauth = methodBranches.find((method) => {
      const kind = (
        (method as Record<string, unknown>).properties as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.kind;
      return kind?.const === "oauth2";
    }) as Record<string, unknown> | undefined;
    if (!oauth) throw new Error("mcp.schema.json Executor authentication lacks an oauth2 branch");
    const requireWhenPresent = (field: string, required: string): Record<string, unknown> => {
      const rule: Record<string, unknown> = { if: { required: [field] } };
      // JSON Schema's conditional keyword is intentionally named `then`.
      // oxlint-disable-next-line unicorn/no-thenable
      rule.then = { required: [required] };
      return rule;
    };
    oauth.allOf = [
      requireWhenPresent("discoveryUrl", "registrationScopes"),
      requireWhenPresent("registrationScopes", "discoveryUrl")
    ];
  }
}

export async function generateSchemas(root = process.cwd()): Promise<string[]> {
  const schemasDir = path.join(root, "schemas");
  await mkdir(schemasDir, { recursive: true });

  const written: string[] = [];
  for (const entry of schemaFiles) {
    const schema = z.toJSONSchema(entry.schema, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
    if (entry.filename === "profile.schema.json") strengthenProfileMcpSchema(schema);
    if (entry.filename === "mcp.schema.json") strengthenMcpSchema(schema);
    const outputPath = path.join(schemasDir, entry.filename);
    await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    written.push(outputPath);
  }
  return written;
}
