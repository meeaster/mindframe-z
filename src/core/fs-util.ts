import { access, readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";

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

/** Parse TOML text into a plain object, defaulting to an empty object when the
 * content is not a table. The TOML counterpart to {@link readJsonObject}'s
 * parse step. */
export function parseTomlObject(content: string): Record<string, unknown> {
  const parsed = parseToml(content) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Read a TOML object from disk, defaulting to an empty object when the file is
 * missing, unreadable, or does not parse to a table. The TOML counterpart to
 * {@link readJsonObject}; the codex renderer and sync path use it to merge
 * managed config into a pre-existing local config.toml without failing on a
 * missing or hand-broken file.
 */
export async function readTomlObject(file: string): Promise<Record<string, unknown>> {
  try {
    return parseTomlObject(await readFile(file, "utf8"));
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
