import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { analyzeRepository, isPathWithin } from "./repository.js";

describe("context repository analysis", () => {
  it("does not treat a sibling text prefix as a descendant", () => {
    expect(isPathWithin("/tmp/mindframe-z", "/tmp/mindframe-z-personal-home")).toBe(false);
    expect(isPathWithin("/tmp/mindframe-z", "/tmp/mindframe-z/src")).toBe(true);
  });

  it("uses OpenCode convention precedence and Claude rule path globs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-context-repo-"));
    await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
    await mkdir(path.join(root, "src", "client"), { recursive: true });
    await writeFile(path.join(root, "src", "client", "ui.tsx"), "ui\n", "utf8");
    await writeFile(path.join(root, "src", "client", "api.js"), "api\n", "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "agents\n", "utf8");
    await writeFile(path.join(root, "CLAUDE.md"), "claude\n", "utf8");
    await writeFile(path.join(root, ".claude", "rules", "global.md"), "global\n", "utf8");
    await writeFile(
      path.join(root, ".claude", "rules", "ui.md"),
      '---\npaths: ["src/**/*.tsx"]\n---\nui\n',
      "utf8"
    );
    await writeFile(
      path.join(root, ".claude", "rules", "api.md"),
      '---\npaths: ["src/**/*.js"]\n---\napi\n',
      "utf8"
    );
    await execa("git", ["init", "-q", root]);

    const opencode = await analyzeRepository(root, root, "opencode");
    expect(opencode.contributors.map((entry) => entry.source)).toContain(
      path.join(root, "AGENTS.md")
    );
    expect(opencode.contributors.map((entry) => entry.source)).not.toContain(
      path.join(root, "CLAUDE.md")
    );

    const claude = await analyzeRepository(root, root, "claude-code");
    expect(claude.contributors.find((entry) => entry.source?.endsWith("global.md"))?.loading).toBe(
      "startup"
    );
    expect(claude.contributors.find((entry) => entry.source?.endsWith("ui.md"))?.loading).toBe(
      "conditional:path"
    );
    expect(claude.maxConditionalPath?.directory).toBe(path.join(root, "src", "client"));
    expect(claude.maxConditionalPath?.contributors).toHaveLength(1);
  });
});
