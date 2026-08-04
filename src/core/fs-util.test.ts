import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPlainObject,
  jsonFileContent,
  parseFrontmatter,
  parseJsonlObjects,
  parseTomlObject,
  pathExists,
  readDirEntries,
  readJsoncObject,
  readJsonObject,
  readTextFile,
  readTomlObject,
  writeJsonFileAtomic,
  writeTextFile
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

describe("readDirEntries", () => {
  it("lists entries with the file-or-directory distinction intact", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    await writeFile(path.join(dir, "AGENTS.md"), "# agents\n", "utf8");
    await mkdir(path.join(dir, "skills"));

    const entries = (await readDirEntries(dir)).sort((a, b) => a.name.localeCompare(b.name));

    expect(entries.map((entry) => entry.name)).toEqual(["AGENTS.md", "skills"]);
    expect(entries.map((entry) => entry.isDirectory())).toEqual([false, true]);
  });

  it("reads a missing directory as empty instead of throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));

    expect(await readDirEntries(path.join(dir, "absent"))).toEqual([]);
    expect(await readDirEntries(path.join(dir, "no", "such", "parent"))).toEqual([]);
  });

  it("reads an existing but empty directory as empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));

    expect(await readDirEntries(dir)).toEqual([]);
  });

  it("propagates a failure other than a missing directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "opencode.json");
    await writeFile(file, "{}\n", "utf8");

    await expect(readDirEntries(file)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("follows a symlink to a directory rather than reading the link itself", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const target = path.join(dir, "target");
    await mkdir(target);
    await writeFile(path.join(target, "SKILL.md"), "# skill\n", "utf8");
    await symlink(target, path.join(dir, "link"));

    const entries = await readDirEntries(path.join(dir, "link"));

    expect(entries.map((entry) => entry.name)).toEqual(["SKILL.md"]);
  });

  it("reads a dangling symlink as a missing directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    await symlink(path.join(dir, "gone"), path.join(dir, "dangling"));

    expect(await readDirEntries(path.join(dir, "dangling"))).toEqual([]);
  });
});

describe("readTextFile", () => {
  it("reads a file's text verbatim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "AGENTS.md");
    await writeFile(file, "# agents\n\nguidance\n", "utf8");

    expect(await readTextFile(file)).toBe("# agents\n\nguidance\n");
  });

  it("distinguishes an empty file from a missing one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "empty.jsonl");
    await writeFile(file, "", "utf8");

    expect(await readTextFile(file)).toBe("");
    expect(await readTextFile(path.join(dir, "absent.jsonl"))).toBeUndefined();
  });

  it("reads a missing file, and one under a missing parent, as absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));

    expect(await readTextFile(path.join(dir, "absent.md"))).toBeUndefined();
    expect(await readTextFile(path.join(dir, "no", "such", "parent.md"))).toBeUndefined();
  });

  it("reads a dangling symlink as a missing file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    await symlink(path.join(dir, "gone"), path.join(dir, "dangling"));

    expect(await readTextFile(path.join(dir, "dangling"))).toBeUndefined();
  });

  it("propagates a failure other than a missing file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const nested = path.join(dir, "projects");
    await mkdir(nested);

    await expect(readTextFile(nested)).rejects.toMatchObject({ code: "EISDIR" });
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

describe("parseJsonlObjects", () => {
  it("keeps the object records in file order", () => {
    const content = '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n';

    expect(parseJsonlObjects(content)).toEqual([
      { type: "user", uuid: "u1" },
      { type: "assistant", uuid: "a1" }
    ]);
  });

  it("skips blank lines, a truncated tail, and non-object JSON", () => {
    const content = [
      '{"type":"user"}',
      "",
      "   ",
      "[1,2]",
      '"progress"',
      "17",
      "null",
      '{"typ'
    ].join("\n");

    expect(parseJsonlObjects(content)).toEqual([{ type: "user" }]);
  });

  it("reads empty text as no records", () => {
    expect(parseJsonlObjects("")).toEqual([]);
  });
});

describe("parseFrontmatter", () => {
  it("reads the mapping between the opening and closing fences", () => {
    expect(parseFrontmatter("---\nname: demo\ndescription: A demo\n---\n# Demo\n")).toEqual({
      name: "demo",
      description: "A demo"
    });
  });

  it("keeps non-scalar fields so rule globs survive the read", () => {
    expect(parseFrontmatter("---\npaths:\n  - src/**\n  - docs/*.md\n---\nbody\n")).toEqual({
      paths: ["src/**", "docs/*.md"]
    });
  });

  it("treats a document without frontmatter as carrying no metadata", () => {
    expect(parseFrontmatter("# Demo\n\nNo frontmatter here.\n")).toEqual({});
  });

  it("ignores a fence that opens partway down the document", () => {
    expect(parseFrontmatter("Note: read this\n\n---\nname: demo\n---\nbody\n")).toEqual({});
  });

  it("treats an unterminated block as carrying no metadata", () => {
    expect(parseFrontmatter("---\nname: demo\n")).toEqual({});
  });

  it.each([
    ["a sequence", "---\n- one\n- two\n---\nbody\n"],
    ["a scalar", "---\ndemo\n---\nbody\n"],
    ["empty", "---\n---\nbody\n"]
  ])("treats frontmatter that is %s rather than a mapping as no metadata", (_label, content) => {
    expect(parseFrontmatter(content)).toEqual({});
  });

  it("throws on malformed YAML so callers decide whether the file is readable", () => {
    expect(() => parseFrontmatter("---\nname: [unclosed\n---\nbody\n")).toThrow();
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

describe("writeTextFile", () => {
  it("creates missing parent directories on the way to the file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "configs", "personal", "AGENTS.md");

    await writeTextFile(file, "# agents\n");

    expect(await readFile(file, "utf8")).toBe("# agents\n");
  });

  it("writes the text verbatim as UTF-8", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "references.md");
    const content = "# Enabled References\n\n- `opencode`: — TypeScript…\n";

    await writeTextFile(file, content);

    expect(await readTextFile(file)).toBe(content);
  });

  it("replaces existing content rather than appending to it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "gitconfig");
    await writeFile(file, '[user]\n\tname = "old"\n', "utf8");

    await writeTextFile(file, '[user]\n\tname = "new"\n');

    expect(await readFile(file, "utf8")).toBe('[user]\n\tname = "new"\n');
  });

  it("replaces a symlink's target rather than the link, matching plain writeFile", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const target = path.join(dir, "target.md");
    const link = path.join(dir, "link.md");
    await writeFile(target, "original\n", "utf8");
    await symlink(target, link);

    await writeTextFile(link, "written through the link\n");

    expect(await readFile(target, "utf8")).toBe("written through the link\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});

describe("writeJsonFileAtomic", () => {
  it("writes the jsonFileContent form of the value", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "store.json");
    const value = { projects: { "/repo": { mcp: { context7: false } } } };

    await writeJsonFileAtomic(file, value);

    expect(await readFile(file, "utf8")).toBe(jsonFileContent(value));
  });

  it("creates missing parent directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "state", "executor", "managed.json");

    await writeJsonFileAtomic(file, { complete: true });

    expect(await readJsonObject(file)).toEqual({ complete: true });
  });

  it("replaces existing content and leaves no temp file behind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "manifest.json");
    await writeFile(file, jsonFileContent({ phase: "scoping" }), "utf8");

    await writeJsonFileAtomic(file, { phase: "delivering" });

    expect(await readJsonObject(file)).toEqual({ phase: "delivering" });
    expect(await readdir(dir)).toEqual(["manifest.json"]);
  });

  it("keeps concurrent writes to the same file whole", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-fs-util-"));
    const file = path.join(dir, "bindings.json");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => writeJsonFileAtomic(file, { revision: index }))
    );

    const content = await readFile(file, "utf8");
    const wholeWrites = Array.from({ length: 8 }, (_, index) =>
      jsonFileContent({ revision: index })
    );
    expect(wholeWrites).toContain(content);
    expect(await readdir(dir)).toEqual(["bindings.json"]);
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
