import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extraFolderSchema, profileSchema } from "../core/manifests.js";
import { createRuntimePaths, extraFoldersIndexPath, referenceIndexPath } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { renderInlinedAgents } from "./agents-doc.js";

// renderInlinedAgents is the shared seam behind both the Codex and Pi AGENTS.md
// files. The apply suite pins the happy path (indexes present, inlined into the
// document); this suite pins the branches that suite cannot reach without a
// half-written home: the dry-run tolerance for a missing index and the gate that
// only inlines the extra-folders index when the profile grants extra folders.

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: "personal",
    agents: ["codex"],
    profile: profileSchema.parse({ name: "personal" }),
    manifests: {} as ResolvedProfile["manifests"],
    sources: {} as ResolvedProfile["sources"],
    instructionFiles: [],
    referencesDir: "/tmp/references",
    enabledReferences: [],
    enabledSkills: [],
    enabledCommands: [],
    enabledAgents: [],
    mcpServers: [],
    extraFolders: [],
    ...overrides
  };
}

async function setupHome(): Promise<{
  home: string;
  instruction(content: string): Promise<string>;
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), "mindframe-z-agents-doc-"));
  await mkdir(path.join(home, ".mindframe-z"), { recursive: true });
  let seq = 0;
  return {
    home,
    async instruction(content: string): Promise<string> {
      const file = path.join(home, `AGENTS.${seq++}.md`);
      await writeFile(file, content, "utf8");
      return file;
    }
  };
}

describe("renderInlinedAgents", () => {
  it("inlines instruction files and both indexes, trimmed and blank-line joined", async () => {
    const { home, instruction } = await setupHome();
    const paths = createRuntimePaths({ home });
    const agents = await instruction("  # Agents\n\n");
    await writeFile(referenceIndexPath(paths), "# Enabled References\n", "utf8");
    await writeFile(extraFoldersIndexPath(paths), "# Extra Folders\n", "utf8");

    const rendered = await renderInlinedAgents(
      paths,
      profile({
        instructionFiles: [agents],
        extraFolders: [extraFolderSchema.parse({ path: home })]
      })
    );

    expect(rendered).toBe("# Agents\n\n# Enabled References\n\n# Extra Folders\n");
  });

  it("silently omits missing indexes so a pre-index dry run does not throw", async () => {
    const { home, instruction } = await setupHome();
    const paths = createRuntimePaths({ home });
    const agents = await instruction("# Agents\n");

    // extraFolders is non-empty, so the builder tries to read both indexes, but
    // neither has been written yet — the dry-run path must skip them.
    const rendered = await renderInlinedAgents(
      paths,
      profile({
        instructionFiles: [agents],
        extraFolders: [extraFolderSchema.parse({ path: home })]
      })
    );

    expect(rendered).toBe("# Agents\n");
  });

  it("omits the extra-folders index when the profile grants no extra folders", async () => {
    const { home, instruction } = await setupHome();
    const paths = createRuntimePaths({ home });
    const agents = await instruction("# Agents\n");
    await writeFile(referenceIndexPath(paths), "# Enabled References\n", "utf8");
    await writeFile(extraFoldersIndexPath(paths), "# Extra Folders\n", "utf8");

    const rendered = await renderInlinedAgents(
      paths,
      profile({ instructionFiles: [agents], extraFolders: [] })
    );

    expect(rendered).toContain("# Enabled References");
    expect(rendered).not.toContain("# Extra Folders");
  });

  it("drops blank instruction files from the joined document", async () => {
    const { home, instruction } = await setupHome();
    const paths = createRuntimePaths({ home });
    const blank = await instruction("   \n");
    const real = await instruction("# Agents\n");

    const rendered = await renderInlinedAgents(
      paths,
      profile({ instructionFiles: [blank, real], extraFolders: [] })
    );

    expect(rendered).toBe("# Agents\n");
  });
});
