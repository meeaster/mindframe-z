import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { MachineManifest } from "./manifests.js";
import { createRuntimePaths } from "./paths.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  ensureGitConfigInclude,
  gitIdentityFragmentPath,
  renderGitIdentityFragment,
  writeGitIdentityFragment
} from "./git-config.js";

function machine(git: MachineManifest["git"]): MachineManifest {
  return {
    references_dir: "~/references",
    extra_folders: [],
    git,
    sandbox: {},
    thread: { stores: [] },
    work: {},
    archives: [],
    claude: {}
  };
}

async function readEffectiveGitValue(configPath: string, key: string): Promise<string> {
  const result = await execa("git", ["config", "--file", configPath, "--includes", "--get", key], {
    cwd: "/tmp/opencode",
    env: {
      GIT_CEILING_DIRECTORIES: "/tmp/opencode",
      GIT_CONFIG_NOSYSTEM: "1"
    }
  });

  return result.stdout;
}

describe("git config rendering", () => {
  it("renders identity from machine config and omits missing fields", () => {
    expect(
      renderGitIdentityFragment(machine({ name: "Test User", email: "test@example.com" }))
    ).toContain('name = "Test User"\n\temail = "test@example.com"');
    expect(renderGitIdentityFragment(machine({}))).not.toContain("name =");
    expect(renderGitIdentityFragment(machine({}))).not.toContain("email =");
  });

  it("preserves host git config and exact bytes after adding one managed include", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root, home });
    const gitConfig = path.join(home, ".gitconfig");
    await mkdir(home, { recursive: true });
    await writeFile(
      gitConfig,
      ["[alias]", "\tco = checkout", "[credential]", "\thelper = store", ""].join("\n"),
      "utf8"
    );

    await ensureGitConfigInclude(paths);
    const first = await readFile(gitConfig, "utf8");
    const repeated = await ensureGitConfigInclude(paths);

    const content = await readFile(gitConfig, "utf8");
    expect(content).toBe(first);
    expect(repeated.status).toBe("unchanged");
    expect(content).toContain("\tco = checkout");
    expect(content).toContain("\thelper = store");
    expect(content.match(/\.mindframe-z\/gitconfig/g)).toHaveLength(1);
  });

  it("keeps a conditional include before the managed unconditional include effective", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root, home });
    const gitConfig = path.join(home, ".gitconfig");
    const includeLine = `\tpath = ${gitIdentityFragmentPath(paths)}`;
    await writeGitIdentityFragment(paths, machine({ name: "Host User" }));

    const original = [
      '[includeIf "gitdir:/does-not-match/"]',
      includeLine,
      "[include]",
      includeLine,
      ""
    ].join("\n");

    await writeFile(gitConfig, original, "utf8");

    const outcome = await ensureGitConfigInclude(paths);

    expect(outcome.status).toBe("unchanged");
    expect(await readFile(gitConfig, "utf8")).toBe(original);
    expect(await readEffectiveGitValue(gitConfig, "user.name")).toBe("Host User");
  });

  it("adds an unconditional include when the managed path exists only conditionally", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root, home });
    const gitConfig = path.join(home, ".gitconfig");
    const includeLine = `\tpath = ${gitIdentityFragmentPath(paths)}`;
    await writeGitIdentityFragment(paths, machine({ name: "Host User" }));
    await writeFile(
      gitConfig,
      ['[includeIf "gitdir:/does-not-match/"]', includeLine, ""].join("\n"),
      "utf8"
    );

    await ensureGitConfigInclude(paths);

    const content = await readFile(gitConfig, "utf8");
    expect(content).toBe(
      ['[includeIf "gitdir:/does-not-match/"]', includeLine, "", "[include]", includeLine, ""].join(
        "\n"
      )
    );
    expect(await readEffectiveGitValue(gitConfig, "user.name")).toBe("Host User");
  });

  it("deduplicates only managed unconditional includes and preserves other path settings", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root, home });
    const gitConfig = path.join(home, ".gitconfig");
    const includeLine = `\tpath = ${gitIdentityFragmentPath(paths)}`;
    await writeFile(
      gitConfig,
      [
        "[alias]",
        "\tco = checkout",
        '[includeIf "gitdir:/does-not-match/"]',
        includeLine,
        "[include]",
        includeLine,
        "[credential]",
        "\thelper = store",
        includeLine,
        "[include]",
        includeLine,
        ""
      ].join("\n"),
      "utf8"
    );

    await ensureGitConfigInclude(paths);

    const content = await readFile(gitConfig, "utf8");
    expect(content).toBe(
      [
        "[alias]",
        "\tco = checkout",
        '[includeIf "gitdir:/does-not-match/"]',
        includeLine,
        "[include]",
        includeLine,
        "[credential]",
        "\thelper = store",
        includeLine,
        "[include]",
        ""
      ].join("\n")
    );
  });

  it("writes identity only to the machine-local fragment", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const paths = createRuntimePaths({ root, home });

    await writeGitIdentityFragment(
      paths,
      machine({ name: "Host User", email: "host@example.com" })
    );

    const fragment = await readFile(gitIdentityFragmentPath(paths), "utf8");
    expect(fragment).toContain('name = "Host User"');
    expect(fragment).toContain('email = "host@example.com"');
  });
});
