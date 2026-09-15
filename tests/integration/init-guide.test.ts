import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { guide, guideTopicNames } from "../../src/cli/init.js";
import { applyConfig } from "../../src/cli/apply.js";
import {
  mcpServerSchema,
  profileSchema,
  refsManifestSchema,
  skillsManifestSchema
} from "../../src/core/manifests.js";
import { makeTempDir, projectRoot } from "./support.js";

// `mfz init --create` commits the scaffolded home and swallows a failed commit, so
// pin an identity and ignore global git config rather than depending on whatever the
// running machine happens to have set. Without this, something as ordinary as
// `commit.gpgsign=true` produces an empty home and a misleading downstream failure.
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com"
};

function mfz(home: string, args: string[], reject = true) {
  return execa(
    process.execPath,
    ["--import", "tsx", path.join(projectRoot, "src", "cli", "mfz.ts"), "--home", home, ...args],
    {
      cwd: projectRoot,
      reject,
      env: { ...process.env, ...gitEnv, MFZ_HOME: home, MFZ_ROOT: undefined }
    }
  );
}

function yamlExamples(markdown: string) {
  return Array.from(
    markdown.matchAll(/^\s*(?:```|~~~)yaml\n([\s\S]*?)^\s*(?:```|~~~)/gm),
    (match) => YAML.parse(match[1]!)
  );
}

async function captureGuide(topic?: string): Promise<string> {
  const logs: string[] = [];

  const log = vi.spyOn(console, "log").mockImplementation((value?: string) => {
    logs.push(String(value));
  });

  try {
    await guide(topic);
  } finally {
    log.mockRestore();
  }

  return logs.join("\n");
}

describe("init and guide integration", () => {
  it("prints the home guide", async () => {
    const result = await captureGuide();
    expect(result).toContain("# mindframe-z Home Guide");
    expect(result).toContain("catalog/references.yml");
    expect(result).toContain("mfz guide mcp");
    expect(result).toContain("mfz guide cron");
    expect(result).toContain("mfz guide skills");
    expect(result).toContain("mfz guide skill-review");
    expect(result).toContain("mfz guide references");
    expect(result).toContain("mfz guide extra-folders");
    expect(result).not.toContain("Declare Executor authentication structure");

    const routes = Array.from(result.matchAll(/`mfz guide ([a-z-]+)`/g), (match) => match[1]);

    expect(routes.sort()).toEqual([...guideTopicNames].sort());
    const examples = yamlExamples(result);
    expect(examples).toHaveLength(2);

    for (const example of examples) {
      expect(profileSchema.safeParse({ name: "example", ...example }).success).toBe(true);
    }
  });

  it("advertises the same topics in help and unknown-topic errors", async () => {
    const home = await makeTempDir();
    const route = await mfz(home, ["guide", "cron"]);
    expect(route.stdout).toContain("# Scheduled OpenCode Jobs Guide");
    const help = await mfz(home, ["guide", "--help"]);
    const failure = await mfz(home, ["guide", "unknown-topic"], false);
    expect(failure.exitCode).toBe(1);

    for (const topic of guideTopicNames) {
      expect(help.stdout).toContain(topic);
      expect(failure.stderr).toContain(topic);
    }
  });

  it("prints the scheduled OpenCode jobs topic guide", async () => {
    const result = await captureGuide("cron");
    expect(result).toContain("# Scheduled OpenCode Jobs Guide");
    expect(result).toContain("Persistent root plus worker");
    expect(result).toContain("Never use `--continue`");
    expect(result).toContain("New sessions and forks are durable top-level sessions");
    expect(result).toContain("OPENCODE_CONFIG_CONTENT");
    expect(result).toContain("There is no `opencode run --compact-first` flag");
    expect(result).toContain("systemctl --user enable --now");
    const [example] = yamlExamples(result);
    expect(profileSchema.safeParse({ name: "example", ...example }).success).toBe(true);
  });

  it("prints the MCP topic guide", async () => {
    const result = await captureGuide("mcp");
    expect(result).toContain("# MCP Guide");
    expect(result).toContain("executor:");
    expect(result).toContain("all connected supported harnesses");
    expect(result).toContain("Done when every declared credentialed connection");
    const examples = yamlExamples(result);
    expect(examples).toHaveLength(2);
    expect(profileSchema.safeParse({ name: "example", ...examples[0] }).success).toBe(true);
    expect(
      mcpServerSchema.safeParse({
        type: "remote",
        url: "https://example.com/mcp",
        ...examples[1]
      }).success
    ).toBe(true);
  });

  it("prints the extra folders topic guide", async () => {
    const result = await captureGuide("extra-folders");
    expect(result).toContain("# Extra Folders Guide");
    expect(result).toContain("cross-repository routing metadata");
    expect(result).toContain("domain outcome");
    expect(result).toContain("Active and upstream homes are not granted implicitly");
    expect(result).toContain("mfz doctor");
    const [example] = yamlExamples(result);
    expect(profileSchema.safeParse({ name: "example", ...example }).success).toBe(true);
  });

  it("prints the skills topic guide", async () => {
    const result = await captureGuide("skills");
    expect(result).toContain("# Skills Guide");
    expect(result).toContain("catalog/skills.yml");
    expect(result).toContain("mfz skills check");
    expect(result).toContain("mfz skills stage");
    expect(result).toContain("Done when the skill appears for its selected agents");
    const examples = yamlExamples(result);
    expect(examples).toHaveLength(2);
    expect(profileSchema.safeParse({ name: "example", ...examples[0] }).success).toBe(true);
    expect(skillsManifestSchema.safeParse(examples[1]).success).toBe(true);
  });

  it("prints the vendored skill review guide", async () => {
    const result = await captureGuide("skill-review");
    expect(result).toContain("# Vendored Skill Review Guide");
    expect(result).toContain("Hostile evidence");
    expect(result).toContain("every inventory file");
    expect(result).toContain("manual investigation required");
    expect(result).toContain("mfz skills promote <candidate-id>");
  });

  it("prints the references topic guide", async () => {
    const result = await captureGuide("references");
    expect(result).toContain("# References Guide");
    expect(result).toContain("catalog/references.yml");
    expect(result).toContain("profiles/<profile>/profile.yml");
    expect(result).toContain("mfz refs sync");
    expect(result).toContain("regenerate the local reference");
    expect(result).toContain("without activating configuration");
    expect(result).not.toContain("refs index");
    expect(result).toContain("routing metadata");
    const examples = yamlExamples(result);
    expect(examples).toHaveLength(2);
    expect(refsManifestSchema.safeParse(examples[0]).success).toBe(true);
    expect(profileSchema.safeParse({ name: "example", ...examples[1] }).success).toBe(true);
  });

  it("scaffolds a valid home and records home_path", async () => {
    const machineHome = await makeTempDir();
    const homeRoot = path.join(await makeTempDir(), "my-home");

    const result = await mfz(machineHome, ["init", "--create", homeRoot, "--agents", "opencode"]);

    expect(result.stdout).toContain(`home_path\t${homeRoot}`);
    expect(await readFile(path.join(homeRoot, "mfz-home.yml"), "utf8")).toContain(
      "mfz-home.schema.json"
    );
    expect(await readFile(path.join(homeRoot, "catalog", "skills.yml"), "utf8")).toContain(
      "skills: []"
    );
    expect(await readFile(path.join(homeRoot, "AGENTS.md"), "utf8")).toContain(
      "mfz:home-guidance:begin"
    );
    expect(await readFile(path.join(homeRoot, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(await readFile(path.join(machineHome, ".mindframe-z", "config.yml"), "utf8")).toContain(
      `home_path: ${homeRoot}`
    );

    const apply = await applyConfig({
      home: machineHome,
      agent: "all",
      target: "all",
      noLink: true
    });

    expect(
      apply.some((outcome) => outcome.category === "file" && outcome.status === "created")
    ).toBe(true);
    expect(
      await readFile(
        path.join(machineHome, ".mindframe-z", "configs", "base", "opencode", "opencode.jsonc"),
        "utf8"
      )
    ).toContain("https://opencode.ai/config.json");
  });

  it("clones a home into the managed upstream clone root and points machine config at it", async () => {
    const sourceMachineHome = await makeTempDir();
    const source = path.join(await makeTempDir(), "shared-home");
    await mfz(sourceMachineHome, ["init", "--create", source, "--agents", "opencode"]);

    const machineHome = await makeTempDir();
    const result = await mfz(machineHome, ["init", "--clone", source, "--name", "shared"]);

    // The same directory apply-time cloning and skill vendoring resolve for this alias.
    const cloneRoot = path.join(machineHome, ".mindframe-z", "homes", "shared");
    expect(result.stdout).toContain(`home_path\t${cloneRoot}`);
    expect(await readFile(path.join(cloneRoot, "mfz-home.yml"), "utf8")).toContain(
      "mfz-home.schema.json"
    );
    expect(await readFile(path.join(machineHome, ".mindframe-z", "config.yml"), "utf8")).toContain(
      `home_path: ${cloneRoot}`
    );

    const apply = await applyConfig({
      home: machineHome,
      agent: "all",
      target: "all",
      noLink: true
    });

    expect(
      apply.some((outcome) => outcome.category === "file" && outcome.status === "created")
    ).toBe(true);
    expect(
      await readFile(
        path.join(machineHome, ".mindframe-z", "configs", "base", "opencode", "opencode.jsonc"),
        "utf8"
      )
    ).toContain("https://opencode.ai/config.json");
  });
});
