import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

/**
 * Report whether a path is reachable on disk. This is the canonical async
 * existence predicate behind the "skip when absent" branches in apply, thread
 * storage, skill overrides, and executor reconcile, so the answer stays
 * identical wherever the check is made. It resolves symlinks, so a dangling
 * link reads as absent, and it does not distinguish files from directories —
 * callers that need that distinction stat the path themselves.
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
 * List a directory's entries, reading a directory that does not exist as empty.
 * This is the canonical scan behind the "walk this directory if it is there"
 * branches in skill link reconciliation, work-unit checkpoints, and command
 * sync, so an absent directory means "nothing to do" wherever the scan happens.
 * Every other failure — a path that is a file, an unreadable directory — still
 * propagates, so a broken tree surfaces instead of reading as empty.
 */
export async function readDirEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Read a file's text, reading a file that does not exist as absent. This is the
 * canonical read behind the "use this file if it is there" branches in session
 * watermarks and home guidance, so an absent file means "nothing to read"
 * wherever the read happens — and it stays one syscall path, so a file removed
 * mid-run reads as absent rather than throwing between a separate existence
 * check and the read. Every other failure — an unreadable file, a directory —
 * still propagates, so a broken path surfaces instead of reading as absent.
 */
export async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
 * Scan JSONL text for its plain-object records, skipping blank lines and any
 * line that does not parse to one. This is the canonical scan behind the "read
 * a line-delimited harness stream" seams (thread run traces and Claude
 * transcripts), so a truncated final line, an interleaved non-JSON progress
 * line, and a bare array all read as "not a record" wherever the scan happens
 * instead of failing the whole read. Records keep their file order.
 */
export function parseJsonlObjects(content: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isPlainObject(parsed)) records.push(parsed);
    } catch {
      // A truncated or non-JSON line is not a record; keep scanning the rest.
    }
  }
  return records;
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
 * Parse the leading YAML frontmatter block of a Markdown document into a plain
 * object, defaulting to an empty object when the document has no `---` opener,
 * no closing `---`, or frontmatter that is not a mapping. This is the canonical
 * lenient frontmatter reader behind the context scanners, so a SKILL.md and a
 * Claude rule describe themselves the same way wherever they are read.
 * Malformed YAML inside a well-delimited block still throws; callers that treat
 * an unreadable file as absent catch that themselves.
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const parsed = parseYaml(content.slice(3, end)) as unknown;
  return isPlainObject(parsed) ? parsed : {};
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

/**
 * Replace a JSON file atomically: create the parent directory, write the
 * {@link jsonFileContent} form to a uniquely named sibling, then rename it over
 * the destination. This is the canonical mutable-state write behind the
 * override store, executor snapshots, and work-unit manifests, so a concurrent
 * or interrupted `mfz` run either sees the previous file or the complete new
 * one, never a half-written record.
 */
export async function writeJsonFileAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, jsonFileContent(value), "utf8");
  await rename(temp, file);
}
