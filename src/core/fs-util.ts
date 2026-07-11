import { access, readFile } from "node:fs/promises";

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON object from disk, defaulting to an empty object when the file is
 * missing, unreadable, or does not parse to a plain object. Renderers use this
 * to merge managed settings into pre-existing local config without failing on a
 * missing or hand-broken file.
 */
export async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Serialize a value as the textual content of a JSON config file: two-space
 * indentation plus a trailing newline. This is the write-side counterpart to
 * {@link readJsonObject}; renderers use it so every managed JSON (and JSONC)
 * file shares one pretty-print and newline convention.
 */
export function jsonFileContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
