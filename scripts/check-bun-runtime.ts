import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSkillFiles } from "../src/skills/tree.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "mfz-bun-skill-"));
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
} finally {
  await rm(root, { recursive: true, force: true });
}
