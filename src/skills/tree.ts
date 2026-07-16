import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export const MAX_SKILL_FILES = 4096;
export const MAX_SKILL_BYTES = 32 * 1024 * 1024;

export interface SkillFileRecord {
  path: string;
  mode: "100644" | "100755";
  bytes: Buffer;
}

export interface SkillInventoryEntry {
  path: string;
  mode: "100644" | "100755";
  bytes: number;
  sha256: string;
}

export interface SkillFinding {
  path: string;
  kind: string;
  detail: string;
}

export const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export function frame(value: Uint8Array): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return Buffer.concat([length, Buffer.from(value)]);
}

export function comparePosixBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function relativePosix(root: string, file: string): string {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..") ||
    relative.includes("\\")
  ) {
    throw new Error(`Unsafe skill path: ${relative || file}`);
  }
  return relative;
}

export function portablePathPart(part: string): void {
  if (
    !part ||
    part.endsWith(".") ||
    part.endsWith(" ") ||
    [...part].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || '<>:"|?*'.includes(character);
    }) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part)
  ) {
    throw new Error(`Skill source contains a non-portable path component: ${part}`);
  }
}

export function validatePortablePath(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe skill path: ${value}`);
  }
  for (const part of value.split("/")) {
    portablePathPart(part);
    if (part.toLowerCase() === ".git") {
      throw new Error(`Skill source contains nested Git state: ${value}`);
    }
  }
  return value;
}

export function decodePathBytes(value: string | Buffer): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new Error("Skill source contains a path that is not valid UTF-8");
  }
  return decoded;
}

export async function assertNoSymlinkAncestors(boundary: string, target: string): Promise<void> {
  const root = path.resolve(boundary);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(root, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Managed path escapes its home: ${target}`);
  }
  try {
    if ((await lstat(root)).isSymbolicLink())
      throw new Error(`Managed path contains a symbolic link: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`Managed path contains a symbolic link: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function gitMode(statMode: number): "100644" | "100755" {
  return statMode & 0o111 ? "100755" : "100644";
}

async function walkSkillFiles(
  root: string,
  current = root,
  state: { files: SkillFileRecord[]; totalBytes: number } = { files: [], totalBytes: 0 }
): Promise<SkillFileRecord[]> {
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink())
    throw new Error(`Skill source contains a symbolic link: ${current}`);
  if (!currentStat.isDirectory()) throw new Error(`Skill source is not a directory: ${root}`);

  const entries = await readdir(current, { withFileTypes: true, encoding: "buffer" });
  const namedEntries = entries.map((entry) => decodePathBytes(entry.name)).sort(comparePosixBytes);
  for (const name of namedEntries) {
    if (name.toLowerCase() === ".git")
      throw new Error(`Skill source contains nested Git state: ${current}`);
    const fullPath = path.join(current, name);
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill source contains a symbolic link: ${relativePosix(root, fullPath)}`);
    }
    if (stat.isDirectory()) {
      await walkSkillFiles(root, fullPath, state);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Skill source contains a special file: ${relativePosix(root, fullPath)}`);
    }
    const filePath = validatePortablePath(relativePosix(root, fullPath));
    const bytes = await readFile(fullPath);
    state.totalBytes += bytes.byteLength;
    if (state.totalBytes > MAX_SKILL_BYTES)
      throw new Error("Skill source exceeds the 32 MiB size limit");
    state.files.push({ path: filePath, mode: gitMode(stat.mode), bytes });
    if (state.files.length > MAX_SKILL_FILES)
      throw new Error("Skill source exceeds the file-count limit");
  }
  return state.files.sort((a, b) => comparePosixBytes(a.path, b.path));
}

export async function readSkillFiles(root: string): Promise<SkillFileRecord[]> {
  const files = await walkSkillFiles(root);
  const aliases = new Set<string>();
  for (const file of files) {
    const alias = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (aliases.has(alias)) throw new Error(`Skill source contains colliding paths: ${file.path}`);
    aliases.add(alias);
  }
  return files;
}

export function digestSkillFiles(files: readonly SkillFileRecord[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => comparePosixBytes(a.path, b.path))) {
    hash.update(frame(Buffer.from(file.path, "utf8")));
    hash.update(frame(Buffer.from(file.mode, "ascii")));
    hash.update(frame(file.bytes));
  }
  return hash.digest("hex");
}

export async function digestSkillTree(root: string): Promise<string> {
  return digestSkillFiles(await readSkillFiles(root));
}

export function parseSkillFrontmatter(bytes: Buffer, name: string): void {
  const raw = bytes.toString("utf8");
  if (!raw.startsWith("---\n")) throw new Error(`${name} must start with YAML frontmatter`);
  const end = raw.indexOf("\n---", 4);
  if (end < 0) throw new Error(`${name} has unterminated YAML frontmatter`);
  const frontmatter = YAML.parse(raw.slice(4, end));
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`${name} frontmatter must be a mapping`);
  }
  const fields = frontmatter as Record<string, unknown>;
  if (typeof fields.name !== "string" || typeof fields.description !== "string") {
    throw new Error(`${name} frontmatter requires string name and description`);
  }
}

export function validateSkillRecords(files: readonly SkillFileRecord[]): void {
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error("Skill source must contain SKILL.md at its root");
  parseSkillFrontmatter(skill.bytes, "SKILL.md");
}

export function inventory(files: readonly SkillFileRecord[]): SkillInventoryEntry[] {
  return [...files]
    .sort((a, b) => comparePosixBytes(a.path, b.path))
    .map((file) => ({
      path: file.path,
      mode: file.mode,
      bytes: file.bytes.byteLength,
      sha256: sha256(file.bytes)
    }));
}

export function isBinary(bytes: Buffer): boolean {
  return bytes.includes(0);
}

export function staticFindings(files: readonly SkillFileRecord[]): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const skill = files.find((file) => file.path === "SKILL.md");
  if (skill) {
    try {
      parseSkillFrontmatter(skill.bytes, "SKILL.md");
      findings.push({ path: "SKILL.md", kind: "frontmatter", detail: "frontmatter is valid" });
    } catch (error) {
      findings.push({
        path: "SKILL.md",
        kind: "frontmatter",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  for (const file of files) {
    if (file.mode === "100755") {
      findings.push({
        path: file.path,
        kind: "executable",
        detail: "file has executable Git mode"
      });
    }
    if (isBinary(file.bytes)) {
      findings.push({ path: file.path, kind: "binary", detail: "file contains NUL bytes" });
    }
    if (/^(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules)$/i.test(path.basename(file.path))) {
      findings.push({
        path: file.path,
        kind: "nested-instructions",
        detail: "nested agent instruction file"
      });
    }
    const text = file.bytes.toString("utf8");
    if (/https?:\/\//i.test(text))
      findings.push({ path: file.path, kind: "url", detail: "contains a URL" });
    if (
      /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml)$/i.test(
        file.path
      ) ||
      /(^|\/)(install|setup|postinstall)\b/i.test(file.path) ||
      /\b(npm|pnpm|yarn|pip|curl|wget|child_process|exec\(|spawn\(|subprocess)\b/i.test(text)
    ) {
      findings.push({
        path: file.path,
        kind: "command-or-dependency",
        detail: "may execute commands or install dependencies"
      });
    }
  }
  return findings;
}

export async function copySkillFiles(
  files: readonly SkillFileRecord[],
  destination: string
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = path.join(destination, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: file.mode === "100755" ? 0o755 : 0o644 });
  }
}
