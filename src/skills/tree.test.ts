import { describe, expect, it } from "vitest";
import {
  decodePathBytes,
  parseSkillFrontmatter,
  portablePathPart,
  validatePortablePath
} from "./tree.js";

describe("validatePortablePath", () => {
  it("accepts nested POSIX paths", () => {
    expect(validatePortablePath("references/deep/notes.md")).toBe("references/deep/notes.md");
  });

  it.each([
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["backslash", "references\\notes.md"],
    ["parent traversal", "references/../../etc/passwd"],
    ["current segment", "references/./notes.md"],
    ["empty segment", "references//notes.md"]
  ])("rejects %s paths", (_label, value) => {
    expect(() => validatePortablePath(value)).toThrow(/Unsafe skill path/u);
  });

  it.each([".git/config", "nested/.GIT/config"])("rejects nested Git state in %s", (value) => {
    expect(() => validatePortablePath(value)).toThrow(/nested Git state/u);
  });
});

describe("portablePathPart", () => {
  it("accepts ordinary components", () => {
    expect(() => portablePathPart("notes.md")).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["trailing dot", "notes."],
    ["trailing space", "notes "],
    ["control character", "notes\u0001.md"],
    ["reserved Windows character", 'notes"quoted".md'],
    ["Windows device name", "CON"],
    ["Windows device name with extension", "lpt9.md"]
  ])("rejects a %s component", (_label, value) => {
    expect(() => portablePathPart(value)).toThrow(/non-portable path component/u);
  });
});

describe("decodePathBytes", () => {
  it("decodes valid UTF-8 paths", () => {
    expect(decodePathBytes(Buffer.from("références/notes.md", "utf8"))).toBe("références/notes.md");
  });

  it("rejects paths that are not valid UTF-8", () => {
    expect(() => decodePathBytes(Buffer.from([0x6e, 0xff, 0x2e, 0x6d, 0x64]))).toThrow(
      /not valid UTF-8/u
    );
  });
});

describe("parseSkillFrontmatter", () => {
  const parse = (raw: string) => () => parseSkillFrontmatter(Buffer.from(raw, "utf8"), "SKILL.md");

  it("accepts frontmatter with string name and description", () => {
    expect(parse("---\nname: demo\ndescription: a demo skill\n---\nBody\n")).not.toThrow();
  });

  it("rejects content without frontmatter", () => {
    expect(parse("# Demo\n")).toThrow(/must start with YAML frontmatter/u);
  });

  it("rejects unterminated frontmatter", () => {
    expect(parse("---\nname: demo\n")).toThrow(/unterminated YAML frontmatter/u);
  });

  it.each([
    ["a sequence", "---\n- demo\n---\n"],
    ["empty", "---\n\n---\n"],
    ["a scalar", "---\ndemo\n---\n"]
  ])("rejects frontmatter that is %s rather than a mapping", (_label, raw) => {
    expect(parse(raw)).toThrow(/frontmatter must be a mapping/u);
  });

  it.each([
    ["description", "---\nname: demo\n---\n"],
    ["name", "---\ndescription: a demo skill\n---\n"]
  ])("rejects frontmatter missing a string %s", (_label, raw) => {
    expect(parse(raw)).toThrow(/frontmatter requires string name and description/u);
  });

  it("rejects frontmatter whose name is not a string", () => {
    expect(parse("---\nname: 7\ndescription: a demo skill\n---\n")).toThrow(
      /frontmatter requires string name and description/u
    );
  });
});
