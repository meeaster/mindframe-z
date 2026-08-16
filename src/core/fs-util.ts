import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { jsonObjectSchema, type JsonObject } from "./json.js";

const tomlValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.bigint(),
    z.boolean(),
    z.instanceof(Date),
    z.array(tomlValueSchema),
    z.record(z.string(), tomlValueSchema)
  ])
);
const tomlObjectSchema = z.record(z.string(), tomlValueSchema);
type TomlObject = z.infer<typeof tomlObjectSchema>;
const frontmatterValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.date(),
    z.array(frontmatterValueSchema),
    z.record(z.string(), frontmatterValueSchema)
  ])
);
const frontmatterObjectSchema = z.record(z.string(), frontmatterValueSchema);
type FrontmatterObject = z.infer<typeof frontmatterObjectSchema>;

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
    // SAFETY: Node's filesystem promise rejects with an ErrnoException carrying code.
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
    // SAFETY: Node's filesystem promise rejects with an ErrnoException carrying code.
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
export function parseJsonlObjects(content: string): JsonObject[] {
  const records: JsonObject[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = jsonObjectSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // A truncated or non-JSON line is not a record; keep scanning the rest.
    }
  }
  return records;
}

async function readObjectFile<T>(
  file: string,
  format: string,
  parse: (content: string) => T,
  schema: z.ZodType<T>
): Promise<T> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    // SAFETY: Node's filesystem promise rejects with an ErrnoException carrying code.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return schema.parse({});
    throw new Error(`Failed to read ${format} object at ${file}`, { cause: error });
  }

  try {
    return schema.parse(parse(content));
  } catch (error) {
    throw new Error(`Failed to parse ${format} object at ${file}`, { cause: error });
  }
}

/** Read an optional JSON object. Only a missing file defaults to an empty object. */
export async function readJsonObject(filePath: string): Promise<JsonObject> {
  return jsonObjectSchema.parse(
    await readObjectFile(filePath, "JSON", (content) => JSON.parse(content), jsonObjectSchema)
  );
}

/** Read an optional JSONC object. Only a missing file defaults to an empty object. */
export async function readJsoncObject(filePath: string): Promise<JsonObject> {
  return readObjectFile(
    filePath,
    "JSONC",
    (content) => {
      const errors: ParseError[] = [];
      const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
      if (errors.length > 0) {
        throw new Error(errors.map((error) => printParseErrorCode(error.error)).join(", "));
      }
      return jsonObjectSchema.parse(parsed);
    },
    jsonObjectSchema
  );
}

/** Parse TOML text into a plain object, defaulting to an empty object when the
 * content is not a table. The TOML counterpart to {@link readJsonObject}'s
 * parse step. */
export function parseTomlObject(content: string): TomlObject {
  const parsed = parseToml(content);
  return tomlObjectSchema.parse(parsed);
}

/** Read an optional TOML object. Only a missing file defaults to an empty object. */
export async function readTomlObject(file: string): Promise<TomlObject> {
  return readObjectFile(file, "TOML", parseTomlObject, tomlObjectSchema);
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
export function parseFrontmatter(content: string): FrontmatterObject {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const parsed = frontmatterObjectSchema.safeParse(parseYaml(content.slice(3, end)));
  return parsed.success ? parsed.data : {};
}

/**
 * Serialize a value as the textual content of a JSON file: two-space
 * indentation plus a trailing newline. This is the canonical write-side
 * counterpart to {@link readJsonObject}, behind the pretty-printed JSON (and
 * JSONC) files `mfz` writes — rendered agent config, thread manifests, runs,
 * verdict ledgers, and run status, sandbox runtime seeds, project skill
 * overrides, and generated schemas — so one pretty-print and newline
 * convention decides how they all read on disk and diff in Git. Records that
 * are deliberately compact, such as the single-line thread lock entry, are
 * serialized at their own call site instead.
 */
export function jsonFileContent<T>(value: T): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write a file's text, creating its parent directory first. This is the
 * canonical write behind the "render one file into a directory that may not
 * exist yet" seams — rendered agent config, the reference and extra-folder
 * indexes, the Git identity fragment, the sandbox compose file, project skill
 * overrides, and session absent-markers — so the file and the tree it needs are
 * created in one step wherever a single destination path is the unit of work.
 * Writers that lay down many files under one directory still create that
 * directory once themselves. It replaces the destination outright; callers that
 * need a crash-safe swap use {@link writeJsonFileAtomic}, and callers that need
 * a non-default mode or an exclusive create pass those options themselves.
 */
export async function writeTextFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/**
 * Replace a JSON file atomically: create the parent directory, write the
 * {@link jsonFileContent} form to a uniquely named sibling, then rename it over
 * the destination. This is the canonical mutable-state write behind the
 * override store, executor snapshots, and work-unit manifests, so a concurrent
 * or interrupted `mfz` run either sees the previous file or the complete new
 * one, never a half-written record.
 */
export async function writeJsonFileAtomic<T>(file: string, value: T): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeTextFile(temp, jsonFileContent(value));
  await rename(temp, file);
}
