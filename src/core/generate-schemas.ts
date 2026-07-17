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
    const outputPath = path.join(schemasDir, entry.filename);
    await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    written.push(outputPath);
  }
  return written;
}
