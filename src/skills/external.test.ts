import { describe, expect, it } from "vitest";
import { skillSchema, type CapabilityAgentName } from "../core/manifests.js";
import type { ResolvedExternalSkill } from "../core/profile.js";
import {
  externalOwner,
  externalSkillDiagnostics,
  externalSkillSelection,
  type ExternalSkillProfile
} from "./external.js";
import type { OtherGlobalSkill } from "./global-inventory.js";

function external(
  name: string,
  options: { select?: string[]; owns?: string[]; targets?: CapabilityAgentName[] } = {}
): ResolvedExternalSkill {
  const entry = skillSchema.parse({
    name,
    source: "external",
    tool: `npm:${name}`,
    sync: `mise run ${name}:sync`,
    owns: options.owns
  });

  if (entry.source !== "external") throw new Error("expected an external entry");
  const targets = options.targets ?? ["opencode", "claude-code"];

  const skill: ResolvedExternalSkill = {
    ...entry,
    agents: Object.fromEntries(targets.map((target) => [target, true])),
    toggleable: true,
    targets,
    sourceRoot: "/home-root"
  };

  if (options.select !== undefined) skill.select = options.select;

  return skill;
}

function profileOf(...externalSkills: ResolvedExternalSkill[]): ExternalSkillProfile {
  const declared = skillSchema.parse({
    name: "declared-only",
    source: "external",
    tool: "npm:x",
    sync: "x"
  });

  return { manifests: { skills: [...externalSkills, declared] }, externalSkills };
}

const installed: OtherGlobalSkill[] = [
  { name: "cloud-cdk", targets: ["agents", "claude-code"] },
  { name: "cloud-iam", targets: ["agents"] },
  { name: "twg-jira", targets: ["agents", "claude-code"] },
  { name: "hand-made", targets: ["agents"] }
];

describe("external skill selection", () => {
  it("prints the profile's skills and agents, and nothing for an entry it does not enable", () => {
    const profile = profileOf(external("cloud", { select: ["cloud-cdk", "cloud-iam"] }));

    expect(externalSkillSelection(profile, "cloud")).toEqual({
      skills: ["cloud-cdk", "cloud-iam"],
      agents: ["opencode", "claude-code"]
    });
    expect(externalSkillSelection(profile, "declared-only")).toEqual({ skills: [], agents: [] });
    expect(() => externalSkillSelection(profile, "unknown")).toThrow(
      "Not an external skill in the catalog: unknown"
    );
  });
});

describe("external skill ownership", () => {
  it("claims installed skills by selection or name pattern", () => {
    const profile = profileOf(
      external("cloud", { select: ["cloud-cdk"] }),
      external("twg", { owns: ["twg", "twg-*"] })
    );

    expect(installed.map((skill) => externalOwner(profile, skill.name)?.name)).toEqual([
      "cloud",
      undefined,
      "twg",
      undefined
    ]);
  });
});

describe("external skill diagnostics", () => {
  it("names skills an agent cannot see, missing tools, and healthy entries", async () => {
    const profile = profileOf(
      external("cloud", { select: ["cloud-cdk", "cloud-iam"] }),
      external("twg", { owns: ["twg-*"] }),
      external("gone", { owns: ["gone-*"] }),
      external("absent", { select: ["x"] })
    );

    const versions = new Map([
      ["npm:cloud", "2.0.0"],
      ["npm:twg", "1.0.0"],
      ["npm:gone", "1.0.0"]
    ]);

    expect(
      await externalSkillDiagnostics(profile, installed, async (tool) => versions.get(tool))
    ).toEqual([
      "external-skill:missing\tcloud\tcloud-iam (claude-code)\trun mise run cloud:sync",
      "external-skill:ok\ttwg\tnpm:twg@1.0.0\ttwg-jira",
      "external-skill:missing\tgone\tno skills installed\trun mise run gone:sync",
      "external-skill:missing\tabsent\tnpm:absent is not installed"
    ]);
  });
});
