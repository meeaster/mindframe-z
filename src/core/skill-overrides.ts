import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type SkillOverrideTarget = "opencode" | "claude-code" | "codex";

export type OpenCodePermissionEffect = "allow" | "ask" | "deny";

export interface OpenCodeSkillPermission {
  effect: OpenCodePermissionEffect;
  source: "profile" | "machine" | "global" | "project" | "default";
}

export interface SkillOverrideContext {
  readonly skillNames?: ReadonlySet<string>;
  readonly skillPaths?: Readonly<Record<string, string>>;
}

type SkillCodec = {
  readonly format: "json" | "jsonc" | "toml";
  readonly read: (
    data: Record<string, unknown>,
    context: SkillOverrideContext
  ) => Record<string, string>;
  readonly write: (
    data: Record<string, unknown>,
    entries: Record<string, string>,
    context: SkillOverrideContext
  ) => Record<string, unknown>;
  readonly encode: (enabled: boolean) => string;
  readonly decode: (value: string) => boolean;
};

function readCodexEntries(
  data: Record<string, unknown>,
  context: SkillOverrideContext
): Record<string, string> {
  const skills = record(data.skills);
  const entries = Array.isArray(skills.config) ? skills.config : [];
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const item = record(entry);
    if (typeof item.path !== "string" || typeof item.enabled !== "boolean") continue;
    const name = path.basename(path.dirname(item.path));
    if (context.skillNames && !context.skillNames.has(name)) continue;
    result[name] = item.enabled ? "on" : "off";
  }
  return result;
}

function writeCodexEntries(
  data: Record<string, unknown>,
  entries: Record<string, string>,
  context: SkillOverrideContext
): Record<string, unknown> {
  const skills = record(data.skills);
  const existingConfig = Array.isArray(skills.config) ? skills.config : [];
  const managedPaths = new Set<string>();
  const nextConfig: unknown[] = [];

  for (const [name, enabled] of Object.entries(entries)) {
    const skillPath = context.skillPaths?.[name];
    if (!skillPath) {
      throw new Error(
        `Cannot toggle ${name} for codex: installed SKILL.md path could not be resolved`
      );
    }
    managedPaths.add(skillPath);
    nextConfig.push({ path: skillPath, enabled: enabled !== "off" });
  }

  for (const entry of existingConfig) {
    const skillPath = record(entry).path;
    if (typeof skillPath !== "string" || !managedPaths.has(skillPath)) nextConfig.push(entry);
  }

  return { ...data, skills: { ...skills, config: nextConfig } };
}

export async function readConfigFile(
  file: string,
  format: SkillCodec["format"]
): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed =
      format === "toml" ? parseToml(raw) : format === "jsonc" ? parseJsonc(raw) : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} must contain an object`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeConfigFile(
  file: string,
  format: SkillCodec["format"],
  data: Record<string, unknown>
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const content = format === "toml" ? stringifyToml(data) : JSON.stringify(data, null, 2) + "\n";
  await writeFile(file, content, "utf8");
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function wildcardMatches(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}

function permissionEntries(value: unknown): Array<[string, OpenCodePermissionEffect]> {
  if (typeof value === "string") {
    return isOpenCodePermissionEffect(value) ? [["*", value]] : [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([pattern, effect]) =>
    isOpenCodePermissionEffect(effect) ? [[pattern, effect]] : []
  );
}

function isOpenCodePermissionEffect(value: unknown): value is OpenCodePermissionEffect {
  return value === "allow" || value === "ask" || value === "deny";
}

export function evaluateOpenCodeSkillPermission(
  skillName: string,
  profilePermission: unknown,
  globalOverrides: Record<string, boolean>,
  projectOverrides: Record<string, boolean>,
  machinePermission?: unknown
): OpenCodeSkillPermission {
  const rules: Array<
    readonly [string, OpenCodePermissionEffect, OpenCodeSkillPermission["source"]]
  > = [];
  const upsert = (
    entries: Array<[string, OpenCodePermissionEffect]>,
    source: OpenCodeSkillPermission["source"]
  ) => {
    for (const [pattern, effect] of entries) {
      const index = rules.findIndex(([existing]) => existing === pattern);
      const rule = [pattern, effect, source] as const;
      if (index < 0) rules.push(rule);
      else rules[index] = rule;
    }
  };

  upsert(
    permissionEntries(
      typeof profilePermission === "object" &&
        profilePermission !== null &&
        !Array.isArray(profilePermission)
        ? (profilePermission as Record<string, unknown>).skill
        : undefined
    ),
    "profile"
  );
  upsert(
    permissionEntries(
      typeof machinePermission === "object" &&
        machinePermission !== null &&
        !Array.isArray(machinePermission)
        ? (machinePermission as Record<string, unknown>).skill
        : undefined
    ),
    "machine"
  );
  upsert(
    Object.entries(globalOverrides).map(([name, enabled]) => [name, enabled ? "allow" : "deny"]),
    "global"
  );
  upsert(
    Object.entries(projectOverrides).map(([name, enabled]) => [name, enabled ? "allow" : "deny"]),
    "project"
  );

  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule && wildcardMatches(skillName, rule[0])) {
      return { effect: rule[1], source: rule[2] };
    }
  }
  return { effect: "ask", source: "default" };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const codecs: Record<SkillOverrideTarget, SkillCodec> = {
  opencode: {
    format: "jsonc",
    read: (data) => stringRecord(record(data.permission).skill),
    write: (data, entries) => ({
      ...data,
      permission: { ...record(data.permission), skill: entries }
    }),
    encode: (enabled) => (enabled ? "allow" : "deny"),
    decode: (value) => value !== "deny"
  },
  "claude-code": {
    format: "json",
    read: (data) => stringRecord(data.skillOverrides),
    write: (data, entries) => ({ ...data, skillOverrides: entries }),
    encode: (enabled) => (enabled ? "on" : "off"),
    decode: (value) => value !== "off"
  },
  codex: {
    format: "toml",
    read: readCodexEntries,
    write: writeCodexEntries,
    encode: (enabled) => (enabled ? "on" : "off"),
    decode: (value) => value !== "off"
  }
};

function encodeOverrides(
  target: SkillOverrideTarget,
  state: Record<string, boolean>
): Record<string, string> {
  const codec = codecs[target];
  return Object.fromEntries(
    Object.entries(state).map(([name, enabled]) => [name, codec.encode(enabled)])
  );
}

export function readSkillOverrides(
  target: SkillOverrideTarget,
  data: Record<string, unknown>,
  context: SkillOverrideContext = {}
): Record<string, boolean> {
  const codec = codecs[target];
  return Object.fromEntries(
    Object.entries(codec.read(data, context)).map(([name, value]) => [name, codec.decode(value)])
  );
}

export function mergeSkillOverrides(
  target: SkillOverrideTarget,
  data: Record<string, unknown>,
  state: Record<string, boolean>,
  context: SkillOverrideContext = {}
): Record<string, unknown> {
  const codec = codecs[target];
  return codec.write(
    data,
    { ...codec.read(data, context), ...encodeOverrides(target, state) },
    context
  );
}

export function replaceSkillOverrides(
  target: SkillOverrideTarget,
  data: Record<string, unknown>,
  state: Record<string, boolean>,
  context: SkillOverrideContext = {}
): Record<string, unknown> {
  return codecs[target].write(data, encodeOverrides(target, state), context);
}

export async function readSkillOverridesFromFile(
  target: SkillOverrideTarget,
  file: string,
  context: SkillOverrideContext = {}
): Promise<Record<string, boolean>> {
  return readSkillOverrides(target, await readConfigFile(file, codecs[target].format), context);
}

export async function mergeSkillOverridesIntoFile(
  target: SkillOverrideTarget,
  file: string,
  state: Record<string, boolean>,
  context: SkillOverrideContext = {}
): Promise<void> {
  const data = await readConfigFile(file, codecs[target].format);
  await writeConfigFile(
    file,
    codecs[target].format,
    mergeSkillOverrides(target, data, state, context)
  );
}

export async function replaceSkillOverridesInFile(
  target: SkillOverrideTarget,
  file: string,
  state: Record<string, boolean>,
  context: SkillOverrideContext = {}
): Promise<void> {
  const data = await readConfigFile(file, codecs[target].format);
  await writeConfigFile(
    file,
    codecs[target].format,
    replaceSkillOverrides(target, data, state, context)
  );
}

export async function writeSkillOverridesFile(
  file: string,
  state: Record<string, boolean>
): Promise<void> {
  await writeConfigFile(file, "json", state);
}

export async function readSkillOverridesFile(file: string): Promise<Record<string, boolean>> {
  const data = await readConfigFile(file, "json");
  for (const [name, enabled] of Object.entries(data)) {
    if (typeof enabled !== "boolean") {
      throw new Error(`${file} must map skill names to boolean values; ${name} is invalid`);
    }
  }
  return data as Record<string, boolean>;
}
