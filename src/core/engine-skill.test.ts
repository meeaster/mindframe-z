import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureHomeGuidance,
  hasHomeGuidance,
  materializeEngineSkill,
  materializeReviewSkill
} from "./engine-skill.js";
import { createRuntimePaths } from "./paths.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mfz-engine-skill-"));
}

describe("ensureHomeGuidance", () => {
  it("creates AGENTS.md and CLAUDE.md, then is idempotent", async () => {
    const home = await tempDir();
    expect(await ensureHomeGuidance(home)).toBe("wrote");
    const agents = await readFile(path.join(home, "AGENTS.md"), "utf8");
    expect(agents).toContain("mfz:home-guidance:begin");
    expect(agents).toContain("mfz guide skills");
    expect(await readFile(path.join(home, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(await ensureHomeGuidance(home)).toBe("ok");
    expect(await hasHomeGuidance(home)).toBe(true);
  });

  it("appends to existing AGENTS.md and refreshes a stale block in place", async () => {
    const home = await tempDir();
    const agentsPath = path.join(home, "AGENTS.md");
    await writeFile(agentsPath, "# My home notes\n", "utf8");
    await ensureHomeGuidance(home);
    let agents = await readFile(agentsPath, "utf8");
    expect(agents.startsWith("# My home notes")).toBe(true);

    const stale = agents.replace("mfz guide skills", "mfz guide legacy-topic");
    await writeFile(agentsPath, stale, "utf8");
    expect(await ensureHomeGuidance(home)).toBe("wrote");
    agents = await readFile(agentsPath, "utf8");
    expect(agents).toContain("mfz guide skills");
    expect(agents).not.toContain("legacy-topic");
    expect(agents.startsWith("# My home notes")).toBe(true);
  });

  it("does not overwrite an existing CLAUDE.md", async () => {
    const home = await tempDir();
    await writeFile(path.join(home, "CLAUDE.md"), "custom\n", "utf8");
    await ensureHomeGuidance(home);
    expect(await readFile(path.join(home, "CLAUDE.md"), "utf8")).toBe("custom\n");
  });
});

describe("materializeEngineSkill", () => {
  it("writes the skill in the local-skill layout and returns its entry", async () => {
    const home = await tempDir();
    const paths = createRuntimePaths({ root: home, home });
    const entry = await materializeEngineSkill(paths);
    expect(entry).toMatchObject({ name: "mindframe-z", source: "local", skill: "mindframe-z" });
    const skillMd = await readFile(
      path.join(entry.sourceRoot, "skills", "mindframe-z", "SKILL.md"),
      "utf8"
    );
    expect(skillMd).toContain("name: mindframe-z");
    expect(skillMd).toContain("description:");
    expect(skillMd).toContain("mfz guide");
  });

  it("materializes the immutable hostile-evidence review skill", async () => {
    const home = await tempDir();
    const entry = await materializeReviewSkill(createRuntimePaths({ root: home, home }));
    expect(entry).toMatchObject({ name: "skill-update-review", source: "local" });
    const skill = await readFile(
      path.join(entry.sourceRoot, "skills", "skill-update-review", "SKILL.md"),
      "utf8"
    );
    expect(skill).toContain("hostile evidence");
    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).toContain('argument-hint: "<candidate-id>"');
    for (const term of [
      "authority escalation",
      "secret or credential access",
      "executable or binary content",
      "hidden or encoded payloads",
      "manual investigation required",
      "mfz skills promote <candidate-id>"
    ]) {
      expect(skill).toContain(term);
    }
    expect(
      await readFile(
        path.join(
          entry.sourceRoot,
          "skills",
          "skill-update-review",
          "references",
          "risk-reference.md"
        ),
        "utf8"
      )
    ).toContain("Authority escalation");
  });
});
