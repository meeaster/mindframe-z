import { execa } from "execa";
import type { ResolvedProfile } from "./profile.js";

interface ToolRequirement {
  tool: string;
  feature: string;
}

// The home's mise.toml owns which tools are installed and at what version; the engine only knows
// which of its features call which commands. Executor is checked by its own diagnostics.
function requiredTools(profile: ResolvedProfile): ToolRequirement[] {
  const requirements: ToolRequirement[] = [
    { tool: "git", feature: "home, reference, and workspace checkouts" },
    { tool: "mise", feature: "tool installation and tool skills" }
  ];

  const pullRequestStore = profile.manifests.machine.thread.stores.find(
    (store) => store.publication !== "direct"
  );

  if (pullRequestStore) {
    requirements.push({
      tool: "gh",
      feature: `pull-request publication for thread store ${pullRequestStore.name}`
    });
  }

  return requirements;
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    const result = await execa(command, ["--version"], { reject: false });

    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function toolRequirementLines(profile: ResolvedProfile): Promise<string[]> {
  const lines: string[] = [];

  for (const requirement of requiredTools(profile)) {
    lines.push(
      (await commandAvailable(requirement.tool))
        ? `tool:✓\t${requirement.tool}`
        : `tool:missing\t${requirement.tool}\tneeded for ${requirement.feature}; add it to the home's mise.toml and run mise install`
    );
  }

  return lines;
}
