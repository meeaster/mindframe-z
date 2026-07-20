import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPlainObject,
  jsonFileContent,
  parseTomlObject,
  readJsonObject,
  readTomlObject
} from "./fs-util.js";

describe("isPlainObject", () => {
  it("accepts a non-null, non-array object", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ name: "personal" })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject("personal")).toBe(false);
    expect(isPlainObject(3)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("jsonFileContent", () => {
  it("pretty-prints with two-space indentation and a trailing newline", () => {
    expect(jsonFileContent({ a: 1, b: { c: 2 } })).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n'
    );
  });

  it("ends with exactly one trailing newline", () => {
    const content = jsonFileContent({ ok: true });
    expect(content.endsWith("}\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });

  it("round-trips through readJsonObject", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "config.json");
    const value = { name: "personal", nested: { count: 3 } };
    await writeFile(file, jsonFileContent(value), "utf8");
    expect(await readJsonObject(file)).toEqual(value);
  });
});

describe("parseTomlObject", () => {
  it("parses a TOML table into a plain object", () => {
    expect(parseTomlObject('name = "personal"\n[tools]\njq = "latest"\n')).toEqual({
      name: "personal",
      tools: { jq: "latest" }
    });
  });

  it("returns an empty object for empty content", () => {
    expect(parseTomlObject("")).toEqual({});
  });
});

describe("readTomlObject", () => {
  it("reads a config.toml from disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "config.toml");
    await writeFile(file, '[settings]\nminimum_release_age = "3d"\n', "utf8");
    expect(await readTomlObject(file)).toEqual({ settings: { minimum_release_age: "3d" } });
  });

  it("defaults to an empty object when the file is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    expect(await readTomlObject(path.join(dir, "absent.toml"))).toEqual({});
  });

  it("defaults to an empty object on malformed TOML", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "broken.toml");
    await writeFile(file, "this is = = not valid toml", "utf8");
    expect(await readTomlObject(file)).toEqual({});
  });
});
