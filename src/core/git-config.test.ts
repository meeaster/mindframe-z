import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
    opencode: {}
  };
}

describe("git config rendering", () => {
  it("renders identity from machine config and omits missing fields", () => {
    expect(
      renderGitIdentityFragment(machine({ name: "Test User", email: "test@example.com" }))
    ).toContain('name = "Test User"\n\temail = "test@example.com"');
    expect(renderGitIdentityFragment(machine({}))).not.toContain("name =");
    expect(renderGitIdentityFragment(machine({}))).not.toContain("email =");
  });

  it("preserves host git config while adding one managed include", async () => {
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
    await ensureGitConfigInclude(paths);

    const content = await readFile(gitConfig, "utf8");
    expect(content).toContain("\tco = checkout");
    expect(content).toContain("\thelper = store");
    expect(content.match(/\.mindframe-z\/gitconfig/g)).toHaveLength(1);
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
