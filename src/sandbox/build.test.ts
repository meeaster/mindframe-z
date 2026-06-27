import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimePaths } from "../core/paths.js";
import { resolveProfile } from "../core/profile.js";
import { makeTempDir, writeFixture } from "../../tests/integration/support.js";
import { ensureSandboxImage, sandboxBuildHashLabel, sandboxImageBuildPlan } from "./build.js";

describe("sandbox image build plan", () => {
  it("hashes build inputs, not mounted rendered config", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    await writeFixture(root, home);
    await mkdir(path.join(root, "sandbox", "image"), { recursive: true });
    await mkdir(path.join(root, "sandbox", "image", "placeholders"), { recursive: true });
    await mkdir(path.join(root, "sandbox", "scripts"), { recursive: true });
    await writeFile(path.join(root, "sandbox", "image", "Dockerfile"), "FROM scratch\n", "utf8");
    await writeFile(
      path.join(root, "sandbox", "image", "placeholders", "auth.json"),
      "{}\n",
      "utf8"
    );
    await writeFile(path.join(root, "sandbox", "scripts", "helper.mjs"), "export {};\n", "utf8");

    const paths = createRuntimePaths({ root, home });
    const profile = await resolveProfile(paths, "personal");
    const first = await sandboxImageBuildPlan(paths, profile);
    const second = await sandboxImageBuildPlan(paths, profile);

    expect(first.hash).toBe(second.hash);
    expect(first.inputs.resolvedMiseToml).toContain('jq = "latest"');
    expect(first.inputs.agents).toEqual(["claude-code", "opencode"]);
    expect(first.inputs.contextFiles).toHaveProperty("sandbox/scripts/helper.mjs");
    expect(first.label).toContain(first.hash);

    await mkdir(path.join(root, "configs", "personal", "dotfiles"), { recursive: true });
    await writeFile(
      path.join(root, "configs", "personal", "dotfiles", ".zshrc"),
      "alias ok=true\n",
      "utf8"
    );
    const configOnlyChange = await sandboxImageBuildPlan(
      paths,
      await resolveProfile(paths, "personal")
    );

    expect(configOnlyChange.hash).toBe(first.hash);

    await writeFile(
      path.join(root, "profiles", "base", "mise.toml"),
      ["[tools]", 'jq = "latest"', 'node = "24"', ""].join("\n"),
      "utf8"
    );
    const changed = await sandboxImageBuildPlan(paths, await resolveProfile(paths, "personal"));

    expect(changed.hash).not.toBe(first.hash);
  });

  it("builds stale images with the computed hash label and skips current images", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    await writeFixture(root, home);
    await mkdir(path.join(root, "sandbox", "image"), { recursive: true });
    await writeFile(path.join(root, "sandbox", "image", "Dockerfile"), "FROM scratch\n", "utf8");
    const paths = createRuntimePaths({ root, home });
    const plan = await sandboxImageBuildPlan(paths, await resolveProfile(paths, "personal"));
    const binDir = path.join(home, "bin");
    const logFile = path.join(home, "docker.log");
    await mkdir(binDir, { recursive: true });
    const docker = path.join(binDir, "docker");
    await writeFile(
      docker,
      [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$@" >> ${JSON.stringify(logFile)}`,
        `if [ "$1" = image ]; then printf '%s\\n' ${JSON.stringify(plan.hash)}; fi`,
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(docker, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    try {
      await expect(ensureSandboxImage(plan)).resolves.toBe("current");
      await expect(ensureSandboxImage(plan, { force: true })).resolves.toBe("built");
    } finally {
      process.env.PATH = oldPath;
    }

    const log = await readFile(logFile, "utf8");
    expect(log).toContain("image\ninspect");
    expect(log).toContain("build\n-t\nlocal-ai-dev-sandbox-agent:latest");
    expect(log).toContain(`--label\n${sandboxBuildHashLabel}=${plan.hash}`);
    expect(await readFile(path.join(plan.contextDir, "generated", "mise.toml"), "utf8")).toContain(
      'jq = "latest"'
    );
  });
});
