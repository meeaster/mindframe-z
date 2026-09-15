import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { profileSchema } from "../core/manifests.js";
import { createRuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { renderDotfiles } from "./dotfiles.js";

function profile(dotfiles: Record<string, string>): ResolvedProfile {
  const manifest = profileSchema.parse({
    name: "personal",
    agents: ["opencode"],
    dotfiles
  });

  return {
    name: "personal",
    agents: ["opencode"],
    profile: manifest,
    // SAFETY: this fixture exercises only the dotfile renderer and never reads manifest metadata.
    manifests: {} as ResolvedProfile["manifests"],
    // SAFETY: this fixture exercises only the dotfile renderer and never reads source metadata.
    sources: {} as ResolvedProfile["sources"],
    instructionFiles: [],
    instructionReferences: [],
    referencesDir: path.join("/tmp", "mfz-dotfiles-references"),
    enabledReferences: [],
    enabledSkills: [],
    enabledOpenCodeCommands: [],
    enabledOpenCodeAgents: [],
    mcpServers: [],
    extraFolders: [],
    miseLayers: []
  };
}

describe("dotfiles renderer", () => {
  it("renders wrappers, nested files, executable files, and managed paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-dotfiles-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-dotfiles-home-"));

    const dotfiles = {
      ".zshrc": "alias gs='git status'\n",
      ".bashrc": "alias ll='ls -la'\n",
      ".npmrc": "minimum-release-age=4320\n",
      ".config/ccstatusline/settings.json": '{"version":3}\n',
      ".local/bin/example": "#!/bin/sh\nexit 0\n"
    };

    const paths = createRuntimePaths({ root, home });
    const result = await renderDotfiles(paths, profile(dotfiles));
    const configsDotfiles = path.join(paths.configsDir, "personal", "dotfiles");
    const secretsPath = path.join(home, ".mindframe-z", "secrets", "zsh.env");
    const localZshPath = path.join(home, ".mindframe-z", ".zshrc");

    expect(result.files.map((file) => [file.path, file.mode])).toEqual([
      [path.join(configsDotfiles, ".zshrc"), undefined],
      [path.join(configsDotfiles, ".bashrc"), undefined],
      [path.join(configsDotfiles, ".npmrc"), undefined],
      [path.join(configsDotfiles, ".config", "ccstatusline", "settings.json"), undefined],
      [path.join(configsDotfiles, ".local", "bin", "example"), 0o755]
    ]);
    expect(result.links).toEqual([
      {
        linkPath: path.join(home, ".zshrc"),
        targetPath: path.join(configsDotfiles, ".zshrc")
      },
      {
        linkPath: path.join(home, ".bashrc"),
        targetPath: path.join(configsDotfiles, ".bashrc")
      },
      {
        linkPath: path.join(home, ".npmrc"),
        targetPath: path.join(configsDotfiles, ".npmrc")
      },
      {
        linkPath: path.join(home, ".config", "ccstatusline", "settings.json"),
        targetPath: path.join(configsDotfiles, ".config", "ccstatusline", "settings.json")
      },
      {
        linkPath: path.join(home, ".local", "bin", "example"),
        targetPath: path.join(configsDotfiles, ".local", "bin", "example")
      }
    ]);
    expect(result.staleFiles).toEqual([path.join(configsDotfiles, ".local", "bin", "opencode2")]);
    expect(result.staleLinks).toEqual([
      {
        linkPath: path.join(home, ".local", "bin", "opencode2"),
        targetPath: path.join(configsDotfiles, ".local", "bin", "opencode2")
      }
    ]);

    const zsh = result.files.find((file) => file.path === path.join(configsDotfiles, ".zshrc"));
    expect(zsh?.content).toContain("alias gs='git status'");
    expect(zsh?.content).toContain(`source ${JSON.stringify(secretsPath)}`);
    expect(zsh?.content).toContain(`source ${JSON.stringify(localZshPath)}`);

    const bash = result.files.find((file) => file.path === path.join(configsDotfiles, ".bashrc"));
    expect(bash?.content).toContain("alias ll='ls -la'");
    expect(bash?.content).toContain(path.join(home, ".local", "bin"));
    expect(
      result.files.find((file) => file.path === path.join(configsDotfiles, ".npmrc"))?.content
    ).toBe(dotfiles[".npmrc"]);
    expect(
      result.files.find(
        (file) =>
          file.path === path.join(configsDotfiles, ".config", "ccstatusline", "settings.json")
      )?.content
    ).toBe(dotfiles[".config/ccstatusline/settings.json"]);
  });

  it("creates a zsh secrets local file only for profiles that manage zsh", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mfz-dotfiles-secrets-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-dotfiles-secrets-home-"));
    const paths = createRuntimePaths({ root, home });
    const secretsPath = path.join(home, ".mindframe-z", "secrets", "zsh.env");

    const withZsh = await renderDotfiles(paths, profile({ ".zshrc": "export TEST_ZSH=1\n" }));
    expect(withZsh.localFiles).toEqual([{ path: secretsPath, content: "", ifMissing: true }]);

    const withoutZsh = await renderDotfiles(paths, profile({ ".bashrc": "export TEST_BASH=1\n" }));
    expect(withoutZsh.localFiles).toBeUndefined();
  });
});
