import path from "node:path";
import { pathExists } from "../core/fs-util.js";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
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

export interface SkillToggleState {
  [skill: string]: boolean;
}

export async function readActiveSkillOverrides(
  configPaths: SkillConfigPaths,
  target: SkillToggleTarget,
  context: SkillOverrideContext = {}
): Promise<SkillToggleState> {
  return readSkillOverridesFromFile(target, configPaths.active[target], context);
}

export async function readLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  return readActiveSkillOverrides(resolveSkillConfigPaths(paths), target);
}

export async function writeLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<void> {
  const configPaths = resolveSkillConfigPaths(paths);

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
  await writeChangedSkillOverrides(paths, profile, target, { [skillName]: enabled });
}

export async function writeChangedSkillOverrides(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget,
  next: SkillToggleState
): Promise<void> {
  await writeChangedSkillOverridesForConfigPaths(
    resolveSkillConfigPaths(paths),
    profile,
    target,
    next
  );
}

export async function writeChangedSkillOverridesForConfigPaths(
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget,
  next: SkillToggleState
): Promise<void> {
  await writeSkillOverrideDelta(configPaths, target, profileDefaults(profile, target), next);
}

export async function writeChangedSkillOverridesForTargets(
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  states: Record<SkillToggleTarget, SkillToggleState>
): Promise<void> {
  await writeChangedSkillOverridesForConfigPaths(
    configPaths,
    profile,
    "claude-code",
    states["claude-code"]
  );
  await writeChangedSkillOverridesForConfigPaths(configPaths, profile, "codex", states.codex);
}

export async function resolveSkillToggleState(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  return resolveSkillToggleStateForConfigPaths(resolveSkillConfigPaths(paths), profile, target);
}

export async function resolveSkillToggleStateForConfigPaths(
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  return {
    ...profileDefaults(profile, target),
    ...(await readSkillOverridesFile(configPaths.state[target]))
  };
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

async function writeSkillOverrideDelta(
  configPaths: SkillConfigPaths,
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
  configPaths: SkillConfigPaths,
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
  configPaths: SkillConfigPaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<void> {
  await writeSkillOverridesFile(configPaths.state[target], {
    ...(await readSkillOverridesFile(configPaths.state[target])),
    ...state
  });
}

async function writeContext(
  configPaths: SkillConfigPaths,
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
  configPaths: SkillConfigPaths,
  skillName: string
): Promise<string> {
  const skillPath = path.join(configPaths.home, ".agents", "skills", skillName, "SKILL.md");

  if (await pathExists(skillPath)) return skillPath;
  throw new Error(
    `Cannot toggle ${skillName} for codex: installed SKILL.md path could not be resolved`
  );
}
