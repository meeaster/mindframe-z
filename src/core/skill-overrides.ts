import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export type SkillOverrideTarget = "opencode" | "claude-code";

type SkillCodec = {
  readonly jsonc: boolean;
  readonly read: (data: Record<string, unknown>) => Record<string, string>;
  readonly write: (
    data: Record<string, unknown>,
    entries: Record<string, string>
  ) => Record<string, unknown>;
  readonly encode: (enabled: boolean) => string;
  readonly decode: (value: string) => boolean;
};

export async function readJsonFile(file: string, jsonc: boolean): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = jsonc ? parseJsonc(raw) : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeJsonFile(file: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const codecs: Record<SkillOverrideTarget, SkillCodec> = {
  opencode: {
    jsonc: true,
    read: (data) => stringRecord(record(data.permission).skill),
    write: (data, entries) => ({
      ...data,
      permission: { ...record(data.permission), skill: entries }
    }),
    encode: (enabled) => (enabled ? "allow" : "deny"),
    decode: (value) => value !== "deny"
  },
  "claude-code": {
    jsonc: false,
    read: (data) => stringRecord(data.skillOverrides),
    write: (data, entries) => ({ ...data, skillOverrides: entries }),
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
  data: Record<string, unknown>
): Record<string, boolean> {
  const codec = codecs[target];
  return Object.fromEntries(
    Object.entries(codec.read(data)).map(([name, value]) => [name, codec.decode(value)])
  );
}

export function mergeSkillOverrides(
  target: SkillOverrideTarget,
  data: Record<string, unknown>,
  state: Record<string, boolean>
): Record<string, unknown> {
  const codec = codecs[target];
  return codec.write(data, { ...codec.read(data), ...encodeOverrides(target, state) });
}

export function replaceSkillOverrides(
  target: SkillOverrideTarget,
  data: Record<string, unknown>,
  state: Record<string, boolean>
): Record<string, unknown> {
  return codecs[target].write(data, encodeOverrides(target, state));
}

export async function readSkillOverridesFromFile(
  target: SkillOverrideTarget,
  file: string
): Promise<Record<string, boolean>> {
  return readSkillOverrides(target, await readJsonFile(file, codecs[target].jsonc));
}

export async function mergeSkillOverridesIntoFile(
  target: SkillOverrideTarget,
  file: string,
  state: Record<string, boolean>
): Promise<void> {
  const data = await readJsonFile(file, codecs[target].jsonc);
  await writeJsonFile(file, mergeSkillOverrides(target, data, state));
}

export async function replaceSkillOverridesInFile(
  target: SkillOverrideTarget,
  file: string,
  state: Record<string, boolean>
): Promise<void> {
  const data = await readJsonFile(file, codecs[target].jsonc);
  await writeJsonFile(file, replaceSkillOverrides(target, data, state));
}

export async function writeSkillOverridesFile(
  file: string,
  state: Record<string, boolean>
): Promise<void> {
  await writeJsonFile(file, state);
}

export async function readSkillOverridesFile(file: string): Promise<Record<string, boolean>> {
  const data = await readJsonFile(file, false);
  for (const [name, enabled] of Object.entries(data)) {
    if (typeof enabled !== "boolean") {
      throw new Error(`${file} must map skill names to boolean values; ${name} is invalid`);
    }
  }
  return data as Record<string, boolean>;
}
