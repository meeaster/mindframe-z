import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z, type ZodType } from "zod";
import { jsonFileContent } from "./fs-util.js";
import { jsonObjectSchema, jsonValueSchema, type JsonObject } from "./json.js";
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

type JsonSchemaProperties = Record<string, JsonSchemaNode>;

export type JsonSchemaNode = JsonObject & {
  type?: string | undefined;
  properties?: JsonSchemaProperties | undefined;
  additionalProperties?: boolean | JsonSchemaNode | undefined;
  propertyNames?: JsonSchemaNode | undefined;
  anyOf?: JsonSchemaNode[] | undefined;
  oneOf?: JsonSchemaNode[] | undefined;
  items?: JsonSchemaNode | undefined;
  allOf?: JsonSchemaNode[] | undefined;
  not?: JsonSchemaNode | undefined;
  if?: JsonSchemaNode | undefined;
  then?: JsonSchemaNode | undefined;
  contains?: JsonSchemaNode | undefined;
  required?: string[] | undefined;
  uniqueItems?: boolean | undefined;
  const?: string | undefined;
  enum?: string[] | undefined;
  pattern?: string | undefined;
  minLength?: number | undefined;
  minProperties?: number | undefined;
};

const validatedJsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      properties: z.record(z.string(), validatedJsonSchemaNodeSchema).optional(),
      additionalProperties: z.union([z.boolean(), validatedJsonSchemaNodeSchema]).optional(),
      propertyNames: validatedJsonSchemaNodeSchema.optional(),
      anyOf: z.array(validatedJsonSchemaNodeSchema).optional(),
      oneOf: z.array(validatedJsonSchemaNodeSchema).optional(),
      items: validatedJsonSchemaNodeSchema.optional(),
      allOf: z.array(validatedJsonSchemaNodeSchema).optional(),
      not: validatedJsonSchemaNodeSchema.optional(),
      if: validatedJsonSchemaNodeSchema.optional(),
      // JSON Schema's conditional keyword is intentionally named `then`.
      // oxlint-disable-next-line unicorn/no-thenable
      then: validatedJsonSchemaNodeSchema.optional(),
      contains: validatedJsonSchemaNodeSchema.optional(),
      required: z.array(z.string()).optional(),
      uniqueItems: z.boolean().optional(),
      const: z.string().optional(),
      enum: z.array(z.string()).optional(),
      pattern: z.string().optional(),
      minLength: z.number().optional(),
      minProperties: z.number().optional()
    })
    .catchall(jsonValueSchema)
);

export const jsonSchemaNodeSchema = jsonObjectSchema.transform((value, context): JsonSchemaNode => {
  const result = validatedJsonSchemaNodeSchema.safeParse(value);
  if (!result.success) {
    context.addIssue({ code: "custom", message: "Invalid JSON Schema document" });
    return z.NEVER;
  }
  return value;
});

function strengthenHomeManifestSchema(schema: JsonSchemaNode): void {
  const properties = schema.properties;
  if (!properties) throw new Error("mfz_home.schema.json is missing properties");
  const extension = properties.extends;
  if (!extension) throw new Error("mfz_home.schema.json is missing the extends property");
  const extensionProperties = extension.properties;
  if (!extensionProperties) throw new Error("mfz_home.schema.json is missing extends.properties");
  const upstreamPath = extensionProperties.path;
  if (!upstreamPath) throw new Error("mfz_home.schema.json is missing extends.path");
  upstreamPath.pattern = "^(?:/|~/)";
}

function strengthenProfileMcpSchema(schema: JsonSchemaNode): void {
  const properties = schema.properties;
  if (!properties) throw new Error("profile.schema.json is missing properties");
  const mcp = properties.mcp;
  if (!mcp) throw new Error("profile.schema.json is missing mcp");
  const entries = jsonSchemaNodeSchema.safeParse(mcp?.additionalProperties).data;
  if (!entries?.properties) {
    throw new Error("profile.schema.json is missing mcp");
  }
  mcp.additionalProperties = entries;
  const entryProperties = entries.properties;
  const agents = entryProperties.agents;
  if (!agents?.anyOf) throw new Error("profile.schema.json is missing mcp agents");
  const agentBranches = agents.anyOf;
  const concise = agentBranches[0]!;
  concise.uniqueItems = true;

  const grouped = agentBranches[1]!;
  if (!grouped.anyOf) throw new Error("profile.schema.json is missing grouped agents");
  for (const variant of grouped.anyOf) {
    const groupedProperties = variant.properties;
    if (!groupedProperties?.enabled || !groupedProperties.disabled) {
      throw new Error("profile.schema.json grouped agents lack properties");
    }
    groupedProperties.enabled.uniqueItems = true;
    groupedProperties.disabled.uniqueItems = true;
  }
  grouped.not = {
    anyOf: ["opencode", "opencode-v2", "claude-code", "codex"].map((agent) => ({
      required: ["enabled", "disabled"],
      properties: {
        enabled: { contains: { const: agent } },
        disabled: { contains: { const: agent } }
      }
    }))
  };

  const executor = entryProperties.executor;
  if (!executor?.properties) throw new Error("profile.schema.json is missing executor properties");
  const executorProperties = executor.properties;
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

function strengthenMcpSchema(schema: JsonSchemaNode): void {
  const properties = schema.properties;
  if (!properties) throw new Error("mcp.schema.json is missing properties");
  const servers = properties.servers;
  if (!servers) throw new Error("mcp.schema.json is missing the servers property");
  const serverEntries = jsonSchemaNodeSchema.safeParse(servers.additionalProperties).data;
  const branches = serverEntries?.anyOf;
  if (!Array.isArray(branches)) {
    throw new Error("mcp.schema.json servers must expose anyOf branches");
  }
  servers.additionalProperties = serverEntries;
  for (const branch of branches) {
    const branchProperties = branch.properties;
    if (!branchProperties) throw new Error("mcp.schema.json has a branch without properties");
    const executor = branchProperties.executor;
    if (!executor) continue;
    const executorProperties = executor.properties;
    if (!executorProperties) throw new Error("mcp.schema.json Executor branch lacks properties");
    const authentication = executorProperties.authentication;
    if (!authentication) continue;
    const methods = authentication.items;
    const methodBranches = methods?.anyOf;
    if (!Array.isArray(methodBranches)) {
      throw new Error("mcp.schema.json Executor authentication lacks method branches");
    }
    const oauth = methodBranches.find((method) => method.properties?.kind?.const === "oauth2");
    if (!oauth) throw new Error("mcp.schema.json Executor authentication lacks an oauth2 branch");
    const requireWhenPresent = (field: string, required: string): JsonSchemaConditional => ({
      if: { required: [field] },
      // JSON Schema's conditional keyword is intentionally named `then`.
      // oxlint-disable-next-line unicorn/no-thenable
      then: { required: [required] }
    });
    oauth.allOf = [
      requireWhenPresent("discoveryUrl", "registrationScopes"),
      requireWhenPresent("registrationScopes", "discoveryUrl")
    ];
  }
}

type JsonSchemaConditional = JsonObject & {
  if: { required: string[] };
  then: { required: string[] };
};

function strengthenThreadManifestSchema(schema: JsonSchemaNode): void {
  const sessions = schema.properties?.sessions?.items;
  if (!sessions) throw new Error("thread-manifest.schema.json is missing sessions");
  const fields = ["message_count", "last_message_id", "last_activity_at"];
  sessions.allOf = [
    {
      anyOf: [
        { required: fields },
        { not: { anyOf: fields.map((field) => ({ required: [field] })) } }
      ]
    }
  ];
}

export async function generateSchemas(root = process.cwd()): Promise<string[]> {
  const schemasDir = path.join(root, "schemas");
  await mkdir(schemasDir, { recursive: true });

  const written: string[] = [];
  for (const entry of schemaFiles) {
    const schema = jsonSchemaNodeSchema.parse(
      z.toJSONSchema(entry.schema, { io: "input", unrepresentable: "any" })
    );
    if (entry.filename === "mfz_home.schema.json") strengthenHomeManifestSchema(schema);
    if (entry.filename === "profile.schema.json") strengthenProfileMcpSchema(schema);
    if (entry.filename === "mcp.schema.json") strengthenMcpSchema(schema);
    if (entry.filename === "thread-manifest.schema.json") strengthenThreadManifestSchema(schema);
    const outputPath = path.join(schemasDir, entry.filename);
    await writeFile(outputPath, jsonFileContent(schema), "utf8");
    written.push(outputPath);
  }
  return written;
}
