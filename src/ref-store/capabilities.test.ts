import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { machineSchema, profileSchema, type LoadedManifests } from "../core/manifests.js";
import {
  capabilitiesDir,
  capabilityGroupPath,
  capabilityIndexPath,
  createRuntimePaths
} from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  activeCapabilityGroups,
  capabilityIndexContent,
  writeCapabilityIndexes
} from "./capabilities.js";

describe("workspace capability indexes", () => {
  it("renders compact awareness separately from detailed routing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-capabilities-"));
    const paths = createRuntimePaths({ home });
    const profile = groupedProfile(home);

    const awareness = capabilityIndexContent(paths, profile);
    expect(awareness).toContain("**Agent Tooling**");
    expect(awareness).toContain("OpenCode, Mindframe-Z");
    expect(awareness).toContain("Signals: OpenCode, Mindframe-Z");
    expect(awareness).toContain(capabilityGroupPath(paths, "agent-tooling"));
    expect(awareness).not.toContain("Full OpenCode implementation description");
    expect(awareness).not.toContain("/workspace/mindframe-z");

    await writeCapabilityIndexes(paths, profile);
    const details = await readFile(capabilityGroupPath(paths, "agent-tooling"), "utf8");
    expect(details).toContain("Full OpenCode implementation description");
    expect(details).toContain(path.join(home, "references", "opencode"));
    expect(details).toContain(path.join(home, "workspace", "mindframe-z"));
    expect(details).toContain("Permissions: read allow, edit allow");
  });

  it("rejects missing metadata and unknown groups", () => {
    const missing = groupedProfile("/tmp/home");
    missing.enabledReferences[0] = {
      name: "opencode",
      url: "https://example.test/opencode.git",
      description: "Missing metadata"
    };
    expect(() => activeCapabilityGroups(missing)).toThrow(
      "Enabled reference opencode must declare group, summary, and at least one signal"
    );

    const unknown = groupedProfile("/tmp/home");
    unknown.extraFolders[0] = { ...unknown.extraFolders[0]!, group: "missing-group" };
    expect(() => activeCapabilityGroups(unknown)).toThrow(
      "Extra folder ~/workspace/mindframe-z uses unknown group missing-group"
    );
  });

  it("removes stale generated group files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mfz-capabilities-"));
    const paths = createRuntimePaths({ home });
    await mkdir(capabilitiesDir(paths), { recursive: true });
    const stale = path.join(capabilitiesDir(paths), "stale.md");
    await writeFile(stale, "stale\n");

    const written = await writeCapabilityIndexes(paths, groupedProfile(home));

    expect(written).toMatchObject([
      { target: stale, status: "removed" },
      { target: capabilityIndexPath(paths), status: "created" },
      { target: capabilityGroupPath(paths, "agent-tooling"), status: "created" }
    ]);
    await expect(readFile(stale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function groupedProfile(home: string): ResolvedProfile {
  const profile = profileSchema.parse({
    name: "personal",
    capability_groups: [
      { name: "agent-tooling", summary: "Agent harness and configuration sources." }
    ]
  });

  return {
    name: "personal",
    agents: [],
    profile,
    manifests: {
      homeManifest: {},
      root: home,
      aliasPath: [],
      references: [],
      skills: [],
      mcpServers: {},
      profiles: new Map(),
      miseFiles: new Map(),
      machine: machineSchema.parse({})
    } satisfies LoadedManifests,
    sources: {
      references: new Map(),
      skills: new Map(),
      mcp: new Map(),
      instructions: new Map(),
      plugins: new Map(),
      commands: new Map(),
      agents: new Map()
    },
    instructionFiles: [],
    instructionReferences: [],
    referencesDir: path.join(home, "references"),
    enabledReferences: [
      {
        name: "opencode",
        url: "https://example.test/opencode.git",
        description: "Full OpenCode implementation description.",
        group: "agent-tooling",
        summary: "OpenCode",
        signals: ["OpenCode", "agent configuration"]
      }
    ],
    enabledSkills: [],
    enabledOpenCodeCommands: [],
    enabledOpenCodeAgents: [],
    mcpServers: [],
    extraFolders: [
      {
        path: "~/workspace/mindframe-z",
        description: "Full Mindframe-Z engine description.",
        read: "allow",
        edit: "allow",
        group: "agent-tooling",
        summary: "Mindframe-Z",
        signals: ["Mindframe-Z", "agent configuration"]
      }
    ],
    miseLayers: []
  };
}
