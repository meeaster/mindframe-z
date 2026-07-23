import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPlainObject,
  jsonFileContent,
  parseTomlObject,
  pathExists,
  readJsoncObject,
  readJsonObject,
  readTomlObject
} from "./fs-util.js";

describe("pathExists", () => {
  it("reports files and directories alike as present", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "config.json");
    const nested = path.join(dir, "skills");
    await writeFile(file, "{}\n", "utf8");
    await mkdir(nested);

    expect(await pathExists(file)).toBe(true);
    expect(await pathExists(nested)).toBe(true);
    expect(await pathExists(dir)).toBe(true);
  });

  it("reports a missing path as absent instead of throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));

    expect(await pathExists(path.join(dir, "absent.json"))).toBe(false);
    expect(await pathExists(path.join(dir, "no", "such", "parent.json"))).toBe(false);
  });

  it("resolves symlinks, so a dangling link reads as absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const target = path.join(dir, "target.json");
    const live = path.join(dir, "live.json");
    const dangling = path.join(dir, "dangling.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, live);
    await symlink(path.join(dir, "gone.json"), dangling);

    expect(await pathExists(live)).toBe(true);
    expect(await pathExists(dangling)).toBe(false);
  });
});

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

describe("readJsoncObject", () => {
  it("reads an object through comments and trailing commas", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "opencode.jsonc");
    await writeFile(file, '{\n  // the theme\n  "theme": "dim",\n}\n', "utf8");
    expect(await readJsoncObject(file)).toEqual({ theme: "dim" });
  });

  it("defaults to an empty object when the file is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    expect(await readJsoncObject(path.join(dir, "absent.jsonc"))).toEqual({});
  });

  it("defaults to an empty object when the content is not a plain object", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "array.jsonc");
    await writeFile(file, '["theme", "dim"]', "utf8");
    expect(await readJsoncObject(file)).toEqual({});
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
