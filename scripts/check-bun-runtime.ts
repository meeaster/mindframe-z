import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readGitSkillFiles } from "../src/skills/git.ts";
import { readSkillFiles } from "../src/skills/tree.ts";

// The release binary runs under Bun, whose Node compatibility differs from the Node runtime the
// test suite uses. Bun 1.3 rejected binary child-process output, which broke tool skill refresh
// only in released binaries, so exercise the filesystem and Git readers here.
const root = await mkdtemp(path.join(os.tmpdir(), "mfz-bun-skill-"));

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

try {
  await mkdir(path.join(root, "références"));
  await writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: bun-check\ndescription: Bun runtime check.\n---\n"
  );
  await writeFile(path.join(root, "références", "notes.md"), "Bun runtime check.\n");

  const files = await readSkillFiles(root);
  assert.deepEqual(
    files.map((file) => file.path),
    ["SKILL.md", "références/notes.md"]
  );

  git("init", "-q");
  git("config", "user.email", "bun-check@example.invalid");
  git("config", "user.name", "Bun Check");
  git("add", ".");
  git("commit", "-qm", "bun check");

  const gitFiles = await readGitSkillFiles(path.join(root, ".git"), git("rev-parse", "HEAD"), ".");
  assert.deepEqual(
    gitFiles.map((file) => file.path),
    ["SKILL.md", "références/notes.md"]
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
