import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execa } from "execa";
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  assertNoSymlinkAncestors,
  comparePosixBytes,
  decodePathBytes,
  type SkillFileRecord,
  sha256,
  validatePortablePath
} from "./tree.js";
import { skillCacheRoot, type RuntimePaths } from "../core/paths.js";

const execFile = promisify(execFileCallback);
const fullCommitPattern = /^[0-9a-f]{40}$/;

export function normalizedRepository(value: string): string {
  if (value.trim() !== value || /\s/u.test(value)) {
    throw new Error(`Repository must not contain whitespace: ${value}`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid repository URL: ${value}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error(`Repository must use HTTPS without credentials: ${value}`);
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

/**
 * Report whether a revision is safe to hand to Git as a positional argument.
 * This is the canonical guard behind every place a caller-supplied ref reaches
 * the Git command line: a leading `-` would be read as an option rather than a
 * revision, and space or control characters are rejected so a ref cannot smuggle
 * extra shell- or Git-visible tokens. It says nothing about whether the revision
 * resolves — {@link fetchCommit} rejects unsafe refs before fetching, while the
 * vendor lock schema pairs it with a non-empty check, so an empty string is left
 * for those callers to reject.
 */
export function safeGitRevision(value: string): boolean {
  return !value.startsWith("-") && [...value].every((character) => character.charCodeAt(0) > 32);
}

function cachePath(paths: RuntimePaths, repository: string): string {
  return path.join(skillCacheRoot(paths), sha256(repository));
}

function gitEnv(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TZ"
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => allowed.has(key) && process.env[key] !== undefined
    )
  );
  return {
    ...env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: ""
  };
}

async function gitText(cache: string, args: string[]): Promise<string> {
  const result = await execa("git", ["--git-dir", cache, ...args], {
    env: gitEnv(),
    timeout: 120_000
  });
  return result.stdout.trim();
}

function safeCacheConfig(config: string): boolean {
  const sections = new Map<string, Set<string>>([
    ["core", new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates"])],
    ['remote "origin"', new Set(["url", "fetch"])]
  ]);
  let section: Set<string> | undefined;
  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const header = trimmed.match(/^\[([^\]]+)\]$/u);
    if (header) {
      section = sections.get(header[1] ?? "");
      if (!section) return false;
      continue;
    }
    const key = trimmed.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=/u)?.[1]?.toLowerCase();
    if (!section || !key || !section.has(key)) return false;
  }
  return true;
}

async function cacheIsSafe(cache: string): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(cache);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (error instanceof Error && error.message.startsWith("Unsafe Git cache path:")) throw error;
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`Unsafe Git cache path: ${cache}`);
  try {
    const configStat = await lstat(path.join(cache, "config"));
    if (configStat.isSymbolicLink() || !configStat.isFile()) {
      throw new Error(`Unsafe Git cache path: ${path.join(cache, "config")}`);
    }
    const config = await readFile(path.join(cache, "config"), "utf8");
    return safeCacheConfig(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof Error && error.message.startsWith("Unsafe Git cache path:")) throw error;
    return false;
  }
}

async function ensureBareCache(paths: RuntimePaths, repository: string): Promise<string> {
  const cache = cachePath(paths, repository);
  await assertNoSymlinkAncestors(paths.home, cache);
  await mkdir(skillCacheRoot(paths), { recursive: true });
  if (!(await cacheIsSafe(cache))) await rm(cache, { recursive: true, force: true });
  try {
    await lstat(path.join(cache, "HEAD"));
  } catch {
    await execa("git", ["init", "--bare", cache], { env: gitEnv(), timeout: 30_000 });
  }
  try {
    const current = await gitText(cache, ["remote", "get-url", "origin"]);
    if (current !== repository) await gitText(cache, ["remote", "set-url", "origin", repository]);
  } catch {
    await gitText(cache, ["remote", "add", "origin", repository]);
  }
  return cache;
}

export async function fetchCommit(
  paths: RuntimePaths,
  repository: string,
  revision: string
): Promise<{ cache: string; commit: string }> {
  const normalized = normalizedRepository(repository);
  if (!safeGitRevision(revision)) throw new Error(`Unsafe Git revision: ${revision}`);
  const cache = await ensureBareCache(paths, normalized);
  await gitText(cache, [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.git.allow=never",
    "-c",
    "protocol.ssh.allow=never",
    "-c",
    "credential.helper=",
    "fetch",
    "--no-tags",
    "--force",
    "origin",
    revision
  ]);
  const commit = await gitText(cache, ["rev-parse", "FETCH_HEAD^{commit}"]);
  if (!fullCommitPattern.test(commit)) throw new Error(`Git returned an invalid commit: ${commit}`);
  return { cache, commit };
}

interface GitTreeEntry {
  mode: "100644" | "100755";
  object: string;
  path: string;
}

function nulRecords(bytes: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0) continue;
    if (index > start) records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function safeGitRelative(value: string): string {
  return validatePortablePath(value);
}

async function listGitTree(
  cache: string,
  commit: string,
  subtree: string
): Promise<GitTreeEntry[]> {
  if (!fullCommitPattern.test(commit))
    throw new Error(`Git tree requires a full commit SHA: ${commit}`);
  const output = await execa(
    "git",
    [
      "--git-dir",
      cache,
      "-c",
      "protocol.allow=never",
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      "--",
      subtree
    ],
    { env: gitEnv(), encoding: "buffer", timeout: 30_000 }
  );
  const bytes = Buffer.isBuffer(output.stdout) ? output.stdout : Buffer.from(output.stdout);
  const prefix = `${subtree}/`;
  const entries: GitTreeEntry[] = [];
  for (const record of nulRecords(bytes)) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("Malformed Git tree entry");
    const [mode, type, object] = record.subarray(0, tab).toString("ascii").split(" ");
    const fullPath = decodePathBytes(record.subarray(tab + 1));
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(
        `Vendored subtree contains unsupported Git entry: ${fullPath} (${mode} ${type})`
      );
    }
    const exactFile = fullPath === subtree;
    if (!exactFile && !fullPath.startsWith(prefix))
      throw new Error(`Git entry escaped selected subtree: ${fullPath}`);
    const relativePath = exactFile
      ? fullPath.slice(fullPath.lastIndexOf("/") + 1)
      : fullPath.slice(prefix.length);
    entries.push({
      mode,
      object: object ?? "",
      path: safeGitRelative(relativePath)
    });
  }
  if (entries.length === 0) throw new Error(`Selected subtree does not exist: ${subtree}`);
  return entries.sort((a, b) => comparePosixBytes(a.path, b.path));
}

async function gitBlob(cache: string, object: string): Promise<Buffer> {
  const result = await execFile("git", ["--git-dir", cache, "cat-file", "blob", object], {
    env: gitEnv(),
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

export async function readGitSkillFiles(
  cache: string,
  commit: string,
  subtree: string
): Promise<SkillFileRecord[]> {
  const entries = await listGitTree(cache, commit, subtree);
  if (entries.length > MAX_SKILL_FILES)
    throw new Error("Skill source exceeds the file-count limit");
  const aliases = new Set<string>();
  let totalBytes = 0;
  const files: SkillFileRecord[] = [];
  for (const entry of entries) {
    const bytes = await gitBlob(cache, entry.object);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SKILL_BYTES) throw new Error("Skill source exceeds the 32 MiB size limit");
    const alias = entry.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (aliases.has(alias)) throw new Error(`Skill source contains colliding paths: ${entry.path}`);
    aliases.add(alias);
    files.push({ path: entry.path, mode: entry.mode, bytes });
  }
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error("Skill source must contain SKILL.md at its root");
  }
  return files;
}
