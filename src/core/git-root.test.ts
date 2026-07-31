import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectRoot } from "./git-root.js";

describe("findProjectRoot", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mindframe-z-git-root-")));
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("resolves the repository root from inside the repository", async () => {
    await execa("git", ["init"], { cwd: root });

    await expect(findProjectRoot(root)).resolves.toBe(root);
  });

  it("resolves the repository root from a nested directory", async () => {
    const nested = path.join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    await execa("git", ["init"], { cwd: root });

    await expect(findProjectRoot(nested)).resolves.toBe(root);
  });

  it("returns undefined outside any repository", async () => {
    await expect(findProjectRoot(root)).resolves.toBeUndefined();
  });

  it("defaults to the current working directory", async () => {
    await execa("git", ["init"], { cwd: root });
    process.chdir(root);

    await expect(findProjectRoot()).resolves.toBe(root);
  });
});
