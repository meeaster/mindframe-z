import path from "node:path";
import { pathExists, type RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  projectOverrides,
  readOverrideStore,
  writeProjectOverrideDelta
} from "../core/override-store.js";
import {
  mergeSkillOverridesIntoFile,
  readSkillOverridesFile,
  readSkillOverridesFromFile,
  replaceSkillOverridesInFile,
  type SkillOverrideContext,
  writeSkillOverridesFile
} from "../core/skill-overrides.js";
import {
  resolveSkillConfigPaths,
  type SkillConfigPaths,
  type SkillToggleTarget
} from "./skill-config-paths.js";

export type SkillToggleState = Record<string, boolean>;
type GlobalSkillConfigPaths = Extract<SkillConfigPaths, { scope: "global" }>;
type RepoSkillConfigPaths = Extract<SkillConfigPaths, { scope: "repo" }>;

export async function readActiveSkillOverrides(
  configPaths: GlobalSkillConfigPaths,
  target: SkillToggleTarget,
  context: SkillOverrideContext = {}
): Promise<SkillToggleState> {
  return readSkillOverridesFromFile(target, configPaths.active[target], context);
}

export async function readLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  const configPaths = await resolveSkillConfigPaths(paths);
  if (configPaths.scope === "repo") {
    return projectOverrides(
      await readOverrideStore(paths.home),
      configPaths.repoRoot,
      target,
      "skills"
    );
  }
  return readActiveSkillOverrides(configPaths, target);
}

export async function writeLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<void> {
  const configPaths = await resolveSkillConfigPaths(paths);
  if (configPaths.scope === "repo") {
    throw new Error("Project-scoped skill writes require a resolved profile");
  }
  await mergeSkillOverridesIntoFile(
    target,
    configPaths.active[target],
    state,
    await writeContext(configPaths, target, state)
  );
  await mergeGlobalSkillState(configPaths, target, state);
}

export async function setLocalSkillState(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget,
  skillName: string,
  enabled: boolean
): Promise<void> {
  const configPaths = await resolveSkillConfigPaths(paths);
  if (configPaths.scope === "repo") {
    const base = await resolveSkillToggleBaseState(configPaths, profile, target);
    await writeProjectOverrideDelta(
      paths,
      profile,
      configPaths.repoRoot,
      target,
      "skills",
      {
        [skillName]: enabled
      },
      base
    );
    return;
  }
  const base = await resolveSkillToggleBaseState(configPaths, profile, target);
  await writeSkillOverrideDelta(configPaths, target, base, { [skillName]: enabled });
}

export async function writeChangedSkillOverrides(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget,
  next: SkillToggleState
): Promise<void> {
  const configPaths = await resolveSkillConfigPaths(paths);
  await writeChangedSkillOverridesForConfigPaths(paths, configPaths, profile, target, next);
}

export async function writeChangedSkillOverridesForConfigPaths(
  paths: RuntimePaths,
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget,
  next: SkillToggleState
): Promise<void> {
  if (configPaths.scope === "repo") {
    const base = await resolveSkillToggleBaseState(configPaths, profile, target);
    await writeProjectOverrideDelta(
      paths,
      profile,
      configPaths.repoRoot,
      target,
      "skills",
      next,
      base
    );
    return;
  }
  const base = await resolveSkillToggleBaseState(configPaths, profile, target);
  await writeSkillOverrideDelta(configPaths, target, base, next);
}

export async function writeChangedSkillOverridesForTargets(
  paths: RuntimePaths,
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  states: Record<SkillToggleTarget, SkillToggleState>
): Promise<void> {
  await writeChangedSkillOverridesForConfigPaths(
    paths,
    configPaths,
    profile,
    "opencode",
    states.opencode
  );
  await writeChangedSkillOverridesForConfigPaths(
    paths,
    configPaths,
    profile,
    "claude-code",
    states["claude-code"]
  );
  await writeChangedSkillOverridesForConfigPaths(
    paths,
    configPaths,
    profile,
    "codex",
    states.codex
  );
}

export async function resolveSkillToggleState(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  const configPaths = await resolveSkillConfigPaths(paths);
  return resolveSkillToggleStateForConfigPaths(configPaths, profile, target);
}

export async function resolveSkillToggleStateForConfigPaths(
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  const defaults = profileDefaults(profile, target);
  const [globalOverrides, localOverrides] = await Promise.all([
    readSkillOverridesFile(configPaths.state[target]),
    configPaths.scope === "repo" ? readOverrideStoreForConfigPaths(configPaths, target) : {}
  ]);
  return { ...defaults, ...globalOverrides, ...localOverrides };
}

export function profileDefaults(
  profile: ResolvedProfile,
  target: SkillToggleTarget
): SkillToggleState {
  const defaults: SkillToggleState = {};
  for (const skill of profile.enabledSkills) {
    const enabled = skill.agents[target];
    if (enabled !== undefined) defaults[skill.name] = enabled;
  }
  return defaults;
}

async function resolveSkillToggleBaseState(
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  const defaults = profileDefaults(profile, target);
  if (configPaths.scope === "global") return defaults;
  return {
    ...defaults,
    ...(await readSkillOverridesFile(configPaths.state[target]))
  };
}

async function writeSkillOverrideDelta(
  configPaths: GlobalSkillConfigPaths,
  target: SkillToggleTarget,
  base: SkillToggleState,
  next: SkillToggleState
): Promise<void> {
  const overrides = await readActiveSkillOverrides(configPaths, target, {
    skillNames: new Set(Object.keys(base))
  });
  let changed = false;
  for (const [name, enabled] of Object.entries(next)) {
    if (base[name] === enabled) {
      changed ||= name in overrides;
      delete overrides[name];
    } else {
      changed ||= overrides[name] !== enabled;
      overrides[name] = enabled;
    }
  }
  if (!changed) return;
  await replaceLocalSkillOverrides(configPaths, target, overrides);
}

async function replaceLocalSkillOverrides(
  configPaths: GlobalSkillConfigPaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<void> {
  await replaceSkillOverridesInFile(
    target,
    configPaths.active[target],
    state,
    await writeContext(configPaths, target, state)
  );
  await writeSkillOverridesFile(configPaths.state[target], state);
}

async function mergeGlobalSkillState(
  configPaths: GlobalSkillConfigPaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<void> {
  await writeSkillOverridesFile(configPaths.state[target], {
    ...(await readSkillOverridesFile(configPaths.state[target])),
    ...state
  });
}

async function readOverrideStoreForConfigPaths(
  configPaths: RepoSkillConfigPaths,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  return projectOverrides(
    await readOverrideStore(configPaths.home),
    configPaths.repoRoot,
    target,
    "skills"
  );
}

async function writeContext(
  configPaths: GlobalSkillConfigPaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<SkillOverrideContext> {
  if (target !== "codex") return {};
  const skillPaths = Object.fromEntries(
    await Promise.all(
      Object.keys(state).map(async (name) => [name, await resolveCodexSkillPath(configPaths, name)])
    )
  );
  return { skillPaths };
}

async function resolveCodexSkillPath(
  configPaths: GlobalSkillConfigPaths,
  skillName: string
): Promise<string> {
  const skillPath = path.join(configPaths.home, ".agents", "skills", skillName, "SKILL.md");
  if (await pathExists(skillPath)) return skillPath;
  throw new Error(
    `Cannot toggle ${skillName} for codex: installed SKILL.md path could not be resolved`
  );
}
