import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jsonFileContent, readJsonObject } from "./fs-util.js";

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
