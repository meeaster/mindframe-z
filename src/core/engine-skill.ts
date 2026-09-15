import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillEntry } from "./manifests.js";
import { pathExists, readTextFile } from "./fs-util.js";
import type { RuntimePaths } from "./paths.js";
import { assertNoSymlinkAncestors } from "../skills/tree.js";
import { writeFileOutcome } from "./file-operations.js";
import type { WriteFileOptions } from "./file-operations.js";
import type { OperationCompletion, OperationOutcome } from "./operations.js";

// The engine-owned skill and the home guidance block both ship inside the
// binary so their content upgrades with the engine instead of rotting as
// per-home scaffold copies. A home that declares its own `mindframe-z` skill
// overrides the engine's (user content wins).

export const engineSkillName = "mindframe-z";

const engineSkillMarkdown = `---
name: mindframe-z
description: "Configure the user's AI-tool setup from a Mindframe-Z home repository: profiles, skills, agent instructions, MCP servers, machine configuration, or recurring OpenCode jobs. Use for home and configuration changes even when the request does not name mfz, and for mfz CLI usage."
---

Mindframe-Z renders AI tool configuration from a home repository. Before changing MFZ configuration, run \`mfz guide\` and follow its topic routing. For CLI command discovery, run \`mfz --help\`.
`;

export function engineSkillRoot(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "engine-skills");
}

// Write the engine skill under <root>/skills/<name>/SKILL.md and return its
// snapshot source entry.
export async function materializeEngineSkill(
  paths: RuntimePaths
): Promise<SkillEntry & { sourceRoot: string }> {
  const root = engineSkillRoot(paths);
  const dir = path.join(root, "skills", engineSkillName);
  await assertNoSymlinkAncestors(paths.home, dir);
  await mkdir(dir, { recursive: true });
  await writeTrustedFile(path.join(dir, "SKILL.md"), engineSkillMarkdown);

  return {
    name: engineSkillName,
    source: "local",
    skill: engineSkillName,
    description: "Operate the mfz CLI or change mindframe-z configuration.",
    sourceRoot: root
  };
}

async function writeTrustedFile(file: string, content: string): Promise<void> {
  try {
    const stat = await lstat(file);

    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Engine skill path is not a regular file: ${file}`);
    }
  } catch (error) {
    // SAFETY: lstat rejects with an ErrnoException carrying the filesystem error code.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await writeFile(file, content, "utf8");
}

const guidanceBegin = "<!-- mfz:home-guidance:begin -->";

const guidanceEnd = "<!-- mfz:home-guidance:end -->";

const homeGuidance = `${guidanceBegin}
This repository is a Mindframe-Z home, the source for AI tool configuration rendered by \`mfz\`. Before changing configuration here, run \`mfz guide\` and follow its topic routing. This block is managed by \`mfz apply\`.
${guidanceEnd}
`;

// Ensure the home's root AGENTS.md carries the current guidance block —
// appended when absent, refreshed in place when stale — preserving user
// content outside the markers, and that CLAUDE.md exists so Claude Code reads
// it too. Deleting the block is harmless: the next apply restores it.
export async function ensureHomeGuidance(
  homeRoot: string,
  onComplete?: OperationCompletion
): Promise<OperationOutcome[]> {
  const agentsPath = path.join(homeRoot, "AGENTS.md");
  const existing = (await readTextFile(agentsPath)) ?? "";
  const begin = existing.indexOf(guidanceBegin);
  const end = existing.indexOf(guidanceEnd);

  const next =
    begin !== -1 && end !== -1 && end > begin
      ? existing.slice(0, begin) + homeGuidance.trimEnd() + existing.slice(end + guidanceEnd.length)
      : existing === ""
        ? homeGuidance
        : `${existing.trimEnd()}\n\n${homeGuidance}`;

  const writeOptions: WriteFileOptions = { category: "guidance" };

  if (onComplete) writeOptions.onComplete = onComplete;
  const outcomes = [await writeFileOutcome(agentsPath, next, writeOptions)];
  const claudePath = path.join(homeRoot, "CLAUDE.md");

  if (await pathExists(claudePath)) {
    const outcome: OperationOutcome = {
      category: "guidance",
      action: "write",
      status: "unchanged",
      target: claudePath,
      significance: "meaningful",
      detail: "preserved existing file"
    };

    outcomes.push(outcome);
    onComplete?.(outcome);
  } else {
    outcomes.push(await writeFileOutcome(claudePath, "@AGENTS.md\n", writeOptions));
  }

  return outcomes;
}

export async function hasHomeGuidance(homeRoot: string): Promise<boolean> {
  const agentsPath = path.join(homeRoot, "AGENTS.md");

  return ((await readTextFile(agentsPath)) ?? "").includes(guidanceBegin);
}
