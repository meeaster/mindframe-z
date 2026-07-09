import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillEntry } from "./manifests.js";
import { pathExists, type RuntimePaths } from "./paths.js";

// The engine-owned skill and the home guidance block both ship inside the
// binary so their content upgrades with the engine instead of rotting as
// per-home scaffold copies. A home that declares its own `mindframe-z` skill
// overrides the engine's (user content wins).

export const engineSkillName = "mindframe-z";

const engineSkillMarkdown = `---
name: mindframe-z
description: Operate the mfz CLI or change mindframe-z configuration — any request naming mfz or mindframe-z, its homes, profiles, skills, or machine config, from any directory.
---

mindframe-z renders AI tool configuration from a home repo onto this machine.
Run \`mfz guide\` for home layout and editing conventions, and \`mfz guide skills\`
before adding or changing skills; \`mfz --help\` lists commands. Edit home source
files, then run \`mfz apply --target all --agent all\`. Never edit rendered
output (\`~/.mindframe-z/configs/\` or globally linked tool config) — if that
already happened, run \`mfz sync\` to promote the edits back into the home.
`;

export function engineSkillRoot(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "engine-skills");
}

// Write the engine skill under <root>/skills/<name>/SKILL.md — the local-skill
// layout buildSkillsCommand expects — and return its sync entry.
export async function materializeEngineSkill(
  paths: RuntimePaths
): Promise<SkillEntry & { sourceRoot: string }> {
  const root = engineSkillRoot(paths);
  const dir = path.join(root, "skills", engineSkillName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), engineSkillMarkdown, "utf8");
  return {
    name: engineSkillName,
    source: "local",
    skill: engineSkillName,
    description: "Operate the mfz CLI or change mindframe-z configuration.",
    installer: "skills",
    sourceRoot: root
  };
}

const guidanceBegin = "<!-- mfz:home-guidance:begin -->";
const guidanceEnd = "<!-- mfz:home-guidance:end -->";

const homeGuidance = `${guidanceBegin}
This repo is a mindframe-z home: the source of truth for the AI tool
configuration rendered onto this machine by the \`mfz\` CLI. This block is
managed by \`mfz apply\` and rewritten on every run.

- Before configuring anything here (profiles, catalog entries, skills, MCP,
  instructions, dotfiles), run \`mfz guide\`; before adding or changing skills,
  run \`mfz guide skills\`.
- Edit source files in this repo, then run \`mfz apply --target all --agent all\`
  (plus \`mfz skills sync\` when skills changed).
- Never edit rendered output (\`~/.mindframe-z/configs/\` or globally linked
  tool config). If rendered files were already edited, run \`mfz sync\` to
  promote the edits back.
${guidanceEnd}
`;

// Ensure the home's root AGENTS.md carries the current guidance block —
// appended when absent, refreshed in place when stale — preserving user
// content outside the markers, and that CLAUDE.md exists so Claude Code reads
// it too. Deleting the block is harmless: the next apply restores it.
export async function ensureHomeGuidance(homeRoot: string): Promise<"ok" | "wrote"> {
  const agentsPath = path.join(homeRoot, "AGENTS.md");
  const existing = (await pathExists(agentsPath)) ? await readFile(agentsPath, "utf8") : "";
  const begin = existing.indexOf(guidanceBegin);
  const end = existing.indexOf(guidanceEnd);
  const next =
    begin !== -1 && end !== -1 && end > begin
      ? existing.slice(0, begin) + homeGuidance.trimEnd() + existing.slice(end + guidanceEnd.length)
      : existing === ""
        ? homeGuidance
        : `${existing.trimEnd()}\n\n${homeGuidance}`;
  let changed = false;
  if (next !== existing) {
    await writeFile(agentsPath, next, "utf8");
    changed = true;
  }
  const claudePath = path.join(homeRoot, "CLAUDE.md");
  if (!(await pathExists(claudePath))) {
    await writeFile(claudePath, "@AGENTS.md\n", "utf8");
    changed = true;
  }
  return changed ? "wrote" : "ok";
}

export async function hasHomeGuidance(homeRoot: string): Promise<boolean> {
  const agentsPath = path.join(homeRoot, "AGENTS.md");
  if (!(await pathExists(agentsPath))) return false;
  return (await readFile(agentsPath, "utf8")).includes(guidanceBegin);
}
