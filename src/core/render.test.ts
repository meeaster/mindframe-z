import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../tests/integration/support.js";
import { writeLocalFiles } from "./render.js";

describe("local file writes", () => {
  it("creates missing parent directories for a new local file", async () => {
    const home = await makeTempDir();
    const target = path.join(home, ".pi", "agent", "extensions", "subagent", "config.json");

    await writeLocalFiles([{ path: target, content: '{"a":1}\n' }]);

    expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
  });

  it("leaves an existing ifMissing file untouched", async () => {
    const home = await makeTempDir();
    const secrets = path.join(home, ".mindframe-z", "secrets", "zsh.env");
    await mkdir(path.dirname(secrets), { recursive: true });
    await writeFile(secrets, "export API_TOKEN=hunter2\n", "utf8");

    await writeLocalFiles([{ path: secrets, content: "", ifMissing: true }]);

    expect(await readFile(secrets, "utf8")).toBe("export API_TOKEN=hunter2\n");
  });

  it("creates an ifMissing file when it does not exist yet", async () => {
    const home = await makeTempDir();
    const secrets = path.join(home, ".mindframe-z", "secrets", "zsh.env");

    await writeLocalFiles([{ path: secrets, content: "", ifMissing: true }]);

    expect(await readFile(secrets, "utf8")).toBe("");
  });

  it("overwrites an existing local file when ifMissing is not set", async () => {
    const home = await makeTempDir();
    const settings = path.join(home, ".claude", "settings.local.json");
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, '{"stale":true}\n', "utf8");

    await writeLocalFiles([{ path: settings, content: '{"merged":true}\n' }]);

    expect(await readFile(settings, "utf8")).toBe('{"merged":true}\n');
  });

  it("replaces a symlinked local path instead of writing through it", async () => {
    const home = await makeTempDir();
    const managed = path.join(home, ".mindframe-z", "configs", "personal", "codex", "config.toml");
    await mkdir(path.dirname(managed), { recursive: true });
    await writeFile(managed, 'model = "managed"\n', "utf8");
    const local = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(local), { recursive: true });
    await symlink(managed, local);

    await writeLocalFiles([{ path: local, content: 'model = "local"\n' }]);

    expect((await lstat(local)).isSymbolicLink()).toBe(false);
    expect(await readFile(local, "utf8")).toBe('model = "local"\n');
    expect(await readFile(managed, "utf8")).toBe('model = "managed"\n');
  });

  it("keeps a symlinked ifMissing path as a symlink", async () => {
    const home = await makeTempDir();
    const existing = path.join(home, "elsewhere", "zsh.env");
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "export FROM_LINK=1\n", "utf8");
    const secrets = path.join(home, ".mindframe-z", "secrets", "zsh.env");
    await mkdir(path.dirname(secrets), { recursive: true });
    await symlink(existing, secrets);

    await writeLocalFiles([{ path: secrets, content: "", ifMissing: true }]);

    expect((await lstat(secrets)).isSymbolicLink()).toBe(true);
    expect(await readFile(existing, "utf8")).toBe("export FROM_LINK=1\n");
  });
});
