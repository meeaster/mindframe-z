import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { jsonFileContent, writeTextFile } from "./fs-util.js";

export type SkillOverrideTarget = "claude-code" | "codex";

export interface SkillOverrideContext {
  readonly skillNames?: ReadonlySet<string>;
  readonly skillPaths?: Readonly<Record<string, string>>;
}

type ConfigValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | undefined
  | ConfigValue[]
  | ConfigObject;

interface ConfigObject {
  [key: string]: ConfigValue;
}

const configValueSchema: z.ZodType<ConfigValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.bigint(),
    z.boolean(),
    z.date(),
    z.null(),
    z.array(configValueSchema),
    z.record(z.string(), configValueSchema)
  ])
);

const configObjectSchema: z.ZodType<ConfigObject> = z.record(z.string(), configValueSchema);

const codexEntrySchema = z.object({ path: z.string(), enabled: z.boolean() });

type SkillCodec = {
  readonly format: "json" | "jsonc" | "toml";
  readonly read: (data: ConfigObject, context: SkillOverrideContext) => Record<string, string>;
  readonly write: (
    data: ConfigObject,
    entries: Record<string, string>,
    context: SkillOverrideContext
  ) => ConfigObject;
  readonly encode: (enabled: boolean) => string;
  readonly decode: (value: string) => boolean;
};

interface SkillEntries {
  [name: string]: string;
}

function readCodexEntries(data: ConfigObject, context: SkillOverrideContext): SkillEntries {
  const skills = record(data.skills);
  const entries = Array.isArray(skills.config) ? skills.config : [];
  const result: SkillEntries = {};

  for (const entry of entries) {
    const item = codexEntrySchema.safeParse(entry);

    if (!item.success) continue;
    const name = path.basename(path.dirname(item.data.path));

    if (context.skillNames && !context.skillNames.has(name)) continue;
    result[name] = item.data.enabled ? "on" : "off";
  }

  return result;
}

function writeCodexEntries(
  data: ConfigObject,
  entries: Record<string, string>,
  context: SkillOverrideContext
) {
  const skills = record(data.skills);
  const existingConfig = Array.isArray(skills.config) ? skills.config : [];
  const managedPaths = new Set<string>();
  const nextConfig: ConfigValue[] = [];

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

    if (!isString(skillPath) || !managedPaths.has(skillPath)) nextConfig.push(entry);
  }

  return { ...data, skills: { ...skills, config: nextConfig } };
}

export async function readConfigFile(
  file: string,
  format: SkillCodec["format"]
): Promise<ConfigObject> {
  try {
    const raw = await readFile(file, "utf8");

    const parsed =
      format === "toml" ? parseToml(raw) : format === "jsonc" ? parseJsonc(raw) : JSON.parse(raw);

    const result = configObjectSchema.safeParse(parsed);

    if (!result.success) throw new Error(`${file} must contain an object`);

    return result.data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function writeConfigFile(
  file: string,
  format: SkillCodec["format"],
  data: ConfigObject
): Promise<void> {
  const content = format === "toml" ? stringifyToml(data) : jsonFileContent(data);
  await writeTextFile(file, content);
}

function stringRecord(value: ConfigValue | undefined): SkillEntries {
  if (!isMergeObject(value)) return {};
  const result: SkillEntries = {};

  for (const [key, entry] of Object.entries(value)) {
    if (isString(entry)) result[key] = entry;
  }

  return result;
}

function record(value: ConfigValue | undefined): ConfigObject {
  const parsed = configValueSchema.safeParse(value);

  return parsed.success && isMergeObject(parsed.data) ? parsed.data : {};
}

function isMergeObject(value: ConfigValue | undefined): value is ConfigObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: ConfigValue | undefined): value is string {
  return z.string().safeParse(value).success;
}

const codecs = {
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
} satisfies Record<SkillOverrideTarget, SkillCodec>;

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
  data: ConfigObject,
  context: SkillOverrideContext = {}
): Record<string, boolean> {
  const codec = codecs[target];

  return Object.fromEntries(
    Object.entries(codec.read(data, context)).map(([name, value]) => [name, codec.decode(value)])
  );
}

export function mergeSkillOverrides(
  target: SkillOverrideTarget,
  data: ConfigObject,
  state: Record<string, boolean>,
  context: SkillOverrideContext = {}
): ConfigObject {
  const codec = codecs[target];

  return codec.write(
    data,
    { ...codec.read(data, context), ...encodeOverrides(target, state) },
    context
  );
}

export function replaceSkillOverrides(
  target: SkillOverrideTarget,
  data: ConfigObject,
  state: Record<string, boolean>,
  context: SkillOverrideContext = {}
): ConfigObject {
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
  const result: Record<string, boolean> = {};

  for (const [name, enabled] of Object.entries(data)) {
    const parsed = z.boolean().safeParse(enabled);

    if (!parsed.success)
      throw new Error(`${file} must map skill names to boolean values; ${name} is invalid`);
    result[name] = parsed.data;
  }

  return result;
}
