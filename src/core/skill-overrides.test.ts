import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  mergeSkillOverrides,
  readSkillOverrides,
  readSkillOverridesFile,
  readSkillOverridesFromFile,
  replaceSkillOverrides,
  replaceSkillOverridesInFile,
  writeSkillOverridesFile
} from "./skill-overrides.js";

describe("skill override codec decoding", () => {
  it("decodes claude-code on/off and treats unknown values as enabled", () => {
    expect(
      readSkillOverrides("claude-code", {
        skillOverrides: { on: "on", off: "off", other: "sometimes" }
      })
    ).toEqual({ on: true, off: false, other: true });
  });

  it("returns an empty map when the target section is absent", () => {
    expect(readSkillOverrides("claude-code", {})).toEqual({});
  });

  it("returns an empty map when a hand-edited config holds the wrong shape", () => {
    expect(readSkillOverrides("claude-code", { skillOverrides: "off" })).toEqual({});
    expect(readSkillOverrides("codex", { skills: "off" })).toEqual({});
    expect(readSkillOverrides("codex", { skills: { config: "off" } })).toEqual({});
  });

  it("drops non-string toggle values instead of decoding them", () => {
    expect(readSkillOverrides("claude-code", { skillOverrides: { on: "on", broken: 1 } })).toEqual({
      on: true
    });
  });
});

describe("skill override merge vs replace", () => {
  it("merge preserves untouched skills and sibling config; replace drops unlisted skills", () => {
    const config = {
      instructions: ["/tmp/AGENTS.md"],
      skillOverrides: { keep: "on" }
    };

    // SAFETY: the Claude codec preserves the fixture's instructions and writes skillOverrides.
    const merged = mergeSkillOverrides("claude-code", config, { added: false }) as {
      instructions: string[];
      skillOverrides: Record<string, string>;
    };
    expect(merged.instructions).toEqual(["/tmp/AGENTS.md"]);
    expect(merged.skillOverrides).toEqual({ keep: "on", added: "off" });

    // SAFETY: the Claude codec writes the asserted skillOverrides object.
    const replaced = replaceSkillOverrides("claude-code", config, { added: false }) as {
      skillOverrides: Record<string, string>;
    };
    expect(replaced.skillOverrides).toEqual({ added: "off" });
  });

  it("encodes claude-code toggles under skillOverrides", () => {
    // SAFETY: The fixture supplies model and the codec writes skillOverrides.
    const merged = replaceSkillOverrides(
      "claude-code",
      { model: "sonnet" },
      {
        alpha: true,
        beta: false
      }
    ) as { model: string; skillOverrides: Record<string, string> };
    expect(merged.model).toBe("sonnet");
    expect(merged.skillOverrides).toEqual({ alpha: "on", beta: "off" });
  });
});

describe("skill override file round-trips", () => {
  it("replaces claude-code toggles in a plain json file", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ skillOverrides: { stale: "on" } }), "utf8");

    await replaceSkillOverridesInFile("claude-code", file, { fresh: false });

    expect(await readSkillOverridesFromFile("claude-code", file)).toEqual({ fresh: false });
  });

  it("treats a missing config file as an empty override set", async () => {
    const dir = await makeTempDir();
    const missing = path.join(dir, "does-not-exist.json");
    expect(await readSkillOverridesFromFile("claude-code", missing)).toEqual({});
  });

  it("rejects a config file whose root is not an object", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "settings.json");
    await writeFile(file, JSON.stringify(["skillOverrides"]), "utf8");
    await expect(readSkillOverridesFromFile("claude-code", file)).rejects.toThrow(
      /must contain an object/
    );
  });
});

describe("skill override state file", () => {
  it("round-trips the boolean state map", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "state.json");
    await writeSkillOverridesFile(file, { alpha: true, beta: false });
    expect(await readSkillOverridesFile(file)).toEqual({ alpha: true, beta: false });
  });

  it("rejects a state file with non-boolean values", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "state.json");
    await writeFile(file, JSON.stringify({ alpha: true, beta: "nope" }), "utf8");
    await expect(readSkillOverridesFile(file)).rejects.toThrow(/beta is invalid/);
  });
});
