import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RenderResult } from "../core/render.js";

export async function collectOpenCodeMarkdownFiles(
  rootByName: (name: string) => string,
  configsOpenCode: string,
  kind: "commands" | "agents",
  names: readonly string[]
): Promise<RenderResult["files"]> {
  const files: RenderResult["files"] = [];
  const label = kind === "commands" ? "command" : "agent";

  for (const name of names) {
    const sourceDir = path.join(rootByName(name), "opencode", kind);
    const fileName = `${name}.md`;
    const candidates =
      kind === "commands"
        ? [path.join(sourceDir, fileName), path.join(sourceDir, name, "COMMAND.md")]
        : [path.join(sourceDir, fileName)];
    let content: string | undefined;
    for (const filePath of candidates) {
      try {
        content = await readFile(filePath, "utf8");
        break;
      } catch (error) {
        // SAFETY: ENOENT is the only missing-file case; all other filesystem errors must propagate.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (content === undefined) throw new Error(`Unknown ${label}: ${name}`);
    files.push({
      path: path.join(configsOpenCode, kind, fileName),
      content
    });
  }

  return files;
}
