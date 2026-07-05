import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  mergeSkillOverrides,
  mergeSkillOverridesIntoFile,
  readSkillOverrides,
  readSkillOverridesFile,
  readSkillOverridesFromFile,
  replaceSkillOverrides,
  replaceSkillOverridesInFile,
  writeSkillOverridesFile
} from "./skill-overrides.js";

describe("skill override codec decoding", () => {
  it("decodes opencode allow/deny and treats unknown values as enabled", () => {
    expect(
      readSkillOverrides("opencode", {
        permission: { skill: { on: "allow", off: "deny", other: "ask" } }
      })
    ).toEqual({ on: true, off: false, other: true });
  });

  it("decodes claude-code on/off and treats unknown values as enabled", () => {
    expect(
      readSkillOverrides("claude-code", {
        skillOverrides: { on: "on", off: "off", other: "sometimes" }
      })
    ).toEqual({ on: true, off: false, other: true });
  });

  it("returns an empty map when the target section is absent", () => {
    expect(readSkillOverrides("opencode", {})).toEqual({});
    expect(readSkillOverrides("claude-code", {})).toEqual({});
  });
});

describe("skill override merge vs replace", () => {
  it("merge preserves untouched skills and sibling config; replace drops unlisted skills", () => {
    const config = {
      instructions: ["/tmp/AGENTS.md"],
      permission: { bash: { "*": "ask" }, skill: { keep: "allow" } }
    };

    const merged = mergeSkillOverrides("opencode", config, { added: false }) as {
      instructions: string[];
      permission: { bash: Record<string, string>; skill: Record<string, string> };
    };
    expect(merged.instructions).toEqual(["/tmp/AGENTS.md"]);
    expect(merged.permission.bash).toEqual({ "*": "ask" });
    expect(merged.permission.skill).toEqual({ keep: "allow", added: "deny" });

    const replaced = replaceSkillOverrides("opencode", config, { added: false }) as {
      permission: { bash: Record<string, string>; skill: Record<string, string> };
    };
    expect(replaced.permission.bash).toEqual({ "*": "ask" });
    expect(replaced.permission.skill).toEqual({ added: "deny" });
  });

  it("encodes claude-code toggles under skillOverrides", () => {
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
  it("merges opencode toggles into an existing jsonc config, keeping prior skills", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "opencode.jsonc");
    await writeFile(
      file,
      ["{", "  // keep this comment", '  "permission": { "skill": { "keep": "allow" } }', "}"].join(
        "\n"
      ),
      "utf8"
    );

    await mergeSkillOverridesIntoFile("opencode", file, { added: false });

    expect(await readSkillOverridesFromFile("opencode", file)).toEqual({
      keep: true,
      added: false
    });
  });

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
