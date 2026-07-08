import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z, type ZodType } from "zod";
import {
  machineSchema,
  homeManifestSchema,
  mcpManifestSchema,
  profileSchema,
  refsManifestSchema,
  skillsManifestSchema
} from "./manifests.js";
import { threadManifestSchema, threadRunsSchema } from "../thread/schema.js";

const schemaFiles: Array<{ schema: ZodType; filename: string }> = [
  { schema: refsManifestSchema, filename: "references.schema.json" },
  { schema: skillsManifestSchema, filename: "skills.schema.json" },
  { schema: mcpManifestSchema, filename: "mcp.schema.json" },
  { schema: profileSchema, filename: "profile.schema.json" },
  { schema: homeManifestSchema, filename: "mfz_home.schema.json" },
  { schema: machineSchema, filename: "machine.schema.json" },
  { schema: threadManifestSchema, filename: "thread-manifest.schema.json" },
  { schema: threadRunsSchema, filename: "thread-runs.schema.json" }
];

export async function generateSchemas(root = process.cwd()): Promise<string[]> {
  const schemasDir = path.join(root, "schemas");
  await mkdir(schemasDir, { recursive: true });

  const written: string[] = [];
  for (const entry of schemaFiles) {
    const schema = z.toJSONSchema(entry.schema, { io: "input", unrepresentable: "any" });
    const outputPath = path.join(schemasDir, entry.filename);
    await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    written.push(outputPath);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of await generateSchemas()) console.log(`wrote\t${file}`);
}
