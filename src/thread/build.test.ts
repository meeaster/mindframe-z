import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimePaths } from "../core/paths.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  ensureThreadToolsImage,
  materializeThreadToolsGeneratedFiles,
  threadToolsBuildHashLabel,
  threadToolsClaudeSettingsPath,
  threadToolsGeneratedDir,
  threadToolsImageBuildPlan
} from "./build.js";

async function writeThreadImageFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "src", "thread"), { recursive: true });
  await writeFile(path.join(root, "Dockerfile.tools"), "FROM scratch\n", "utf8");
  await writeFile(path.join(root, "src", "thread", "opencode.thread.json"), "{}\n", "utf8");
  await writeFile(
    path.join(root, "src", "thread", "lapdog-plugin.ts"),
    "export default async () => ({});\n",
    "utf8"
  );
}

describe("thread tools image build", () => {
  it("hashes the Dockerfile and container OpenCode config", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const packageRoot = await makeTempDir();
    await writeThreadImageFixture(packageRoot);

    const first = await threadToolsImageBuildPlan(createRuntimePaths({ root, home }), packageRoot);
    await writeFile(
      path.join(packageRoot, "src", "thread", "opencode.thread.json"),
      '{"changed":true}\n',
      "utf8"
    );
    const second = await threadToolsImageBuildPlan(createRuntimePaths({ root, home }), packageRoot);

    expect(first.hash).not.toBe(second.hash);
    expect(first.label).toBe(`${threadToolsBuildHashLabel}=${first.hash}`);
    expect(first.root).toBe(packageRoot);
  });

  it("materializes a claude-settings.json under .generated/thread-tools", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const packageRoot = await makeTempDir();
    await writeThreadImageFixture(packageRoot);
    const plan = await threadToolsImageBuildPlan(createRuntimePaths({ root, home }), packageRoot);

    const rel = await materializeThreadToolsGeneratedFiles(plan);
    expect(rel).toBe(path.join(threadToolsGeneratedDir, threadToolsClaudeSettingsPath));

    const settings = await readFile(path.join(packageRoot, rel), "utf8");
    const parsed = JSON.parse(settings) as { hooks: Record<string, unknown> };
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      "Notification",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit"
    ]);
    for (const [event, entry] of Object.entries(parsed.hooks)) {
      const block = (entry as Array<{ hooks: Array<{ command: string; async: boolean }> }>)[0]!;
      expect(block.hooks[0]!.command).toContain("${LAPDOG_URL}/claude/hooks");
      // Terminal lifecycle events must run synchronously so the close event
      // reaches lapdog before the `docker run --rm` container is reaped;
      // every other event stays async (fire-and-forget) to avoid blocking.
      const isTerminal = event === "Stop" || event === "SessionEnd";
      expect(block.hooks[0]!.async).toBe(!isTerminal);
    }
  });

  it("skips current images and builds stale images", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const packageRoot = await makeTempDir();
    await writeThreadImageFixture(packageRoot);
    const plan = await threadToolsImageBuildPlan(createRuntimePaths({ root, home }), packageRoot);
    const binDir = path.join(home, "bin");
    const logFile = path.join(home, "docker.log");
    await mkdir(binDir, { recursive: true });
    const docker = path.join(binDir, "docker");
    await writeFile(
      docker,
      [
        "#!/usr/bin/env sh",
        `printf '%s\n' "$@" >> ${JSON.stringify(logFile)}`,
        `if [ "$1" = image ]; then printf '%s\n' ${JSON.stringify(plan.hash)}; fi`,
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(docker, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    try {
      await expect(ensureThreadToolsImage(plan)).resolves.toBe("current");
      await expect(ensureThreadToolsImage(plan, { force: true })).resolves.toBe("built");
    } finally {
      process.env.PATH = oldPath;
    }

    const log = await readFile(logFile, "utf8");
    expect(log).toContain("image\ninspect");
    expect(log).toContain("build\n-t\nmindframe-z-thread-tools:latest");
    expect(log).toContain(`--label\n${threadToolsBuildHashLabel}=${plan.hash}`);
  });
});
