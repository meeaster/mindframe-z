import { access, readFile } from "node:fs/promises";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

/**
 * Report whether a path is reachable on disk. This is the canonical existence
 * predicate behind every "skip when absent" branch (apply, thread storage,
 * skill overrides, executor reconcile), so the answer stays identical wherever
 * the check is made. It resolves symlinks, so a dangling link reads as absent,
 * and it does not distinguish files from directories — callers that care must
 * stat the path themselves.
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrow an unknown value to a plain object: a non-null, non-array object. This
 * is the canonical guard behind the "parse to a plain object or fall back"
 * seams (config merges and history record extraction), so the accepted shape
 * stays identical wherever renderers, sync, and context readers rely on it.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read a JSONC object from disk, defaulting to an empty object when the file is
 * missing, unreadable, or does not parse to a plain object. The comment-
 * tolerant counterpart to {@link readJsonObject}; the OpenCode sync path uses
 * it to inspect a hand-edited `opencode.jsonc` without failing on comments, a
 * missing file, or broken content.
 */
export async function readJsoncObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = parseJsonc(await readFile(filePath, "utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse TOML text into a plain object, defaulting to an empty object when the
 * content is not a table. The TOML counterpart to {@link readJsonObject}'s
 * parse step. */
export function parseTomlObject(content: string): Record<string, unknown> {
  const parsed = parseToml(content) as unknown;
  return isPlainObject(parsed) ? parsed : {};
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
