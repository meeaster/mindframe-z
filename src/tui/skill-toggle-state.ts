import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import {
  mergeSkillOverridesIntoFile,
  readSkillOverridesFile,
  readSkillOverridesFromFile,
  replaceSkillOverridesInFile,
  writeSkillOverridesFile
} from "../core/skill-overrides.js";
import {
  readCodexSkillOverrides,
  readCodexSkillOverridesForNames,
  replaceCodexSkillOverrides
} from "./codex-skill-overrides.js";
import {
  ensureActiveGitExcluded,
  resolveSkillConfigPaths,
  type SkillConfigPaths,
  type SkillToggleTarget
} from "./skill-config-paths.js";

export type SkillToggleState = Record<string, boolean>;

export async function readActiveSkillOverrides(
  configPaths: SkillConfigPaths,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  if (target === "codex") throw new Error("Codex skill overrides require profile context");
  return readSkillOverridesFromFile(target, configPaths.active[target]);
}

export async function readLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget
): Promise<SkillToggleState> {
  if (target === "codex") throw new Error("Codex skill overrides require profile context");
  const configPaths = await resolveSkillConfigPaths(paths);
  return readActiveSkillOverrides(configPaths, target);
}

export async function writeLocalSkillOverrides(
  paths: RuntimePaths,
  target: SkillToggleTarget,
  state: SkillToggleState
): Promise<void> {
  const configPaths = await resolveSkillConfigPaths(paths);
  if (target === "codex") {
    await replaceCodexSkillOverrides(configPaths, state);
    return;
  }
  await mergeSkillOverridesIntoFile(target, configPaths.active[target], state);
  if (configPaths.scope === "global") {
    await mergeGlobalSkillState(configPaths, target, state);
  }
  await ensureActiveGitExcluded(configPaths, target);
}

export async function setLocalSkillState(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget,
  skillName: string,
  enabled: boolean
): Promise<void> {
  const configPaths = await resolveSkillConfigPaths(paths);
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
  await writeChangedSkillOverridesForConfigPaths(configPaths, profile, target, next);
}

export async function writeChangedSkillOverridesForConfigPaths(
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  target: SkillToggleTarget,
  next: SkillToggleState
): Promise<void> {
  const base = await resolveSkillToggleBaseState(configPaths, profile, target);
  await writeSkillOverrideDelta(configPaths, target, base, next);
}

export async function writeChangedSkillOverridesForTargets(
  configPaths: SkillConfigPaths,
  profile: ResolvedProfile,
  states: Record<SkillToggleTarget, SkillToggleState>
): Promise<void> {
  await Promise.all([
    writeChangedSkillOverridesForConfigPaths(configPaths, profile, "opencode", states.opencode),
    writeChangedSkillOverridesForConfigPaths(
      configPaths,
      profile,
      "claude-code",
      states["claude-code"]
    ),
    writeChangedSkillOverridesForConfigPaths(configPaths, profile, "codex", states.codex)
  ]);
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
  if (target === "codex") {
    const [globalOverrides, localOverrides] = await Promise.all([
      readSkillOverridesFile(configPaths.state.codex),
      configPaths.scope === "repo" ? readCodexSkillOverrides(configPaths.active.codex, profile) : {}
    ]);
    return { ...defaults, ...globalOverrides, ...localOverrides };
  }
  const [globalOverrides, localOverrides] = await Promise.all([
    readSkillOverridesFile(configPaths.state[target]),
    configPaths.scope === "repo"
      ? readSkillOverridesFromFile(target, configPaths.active[target])
      : {}
  ]);
  return { ...defaults, ...globalOverrides, ...localOverrides };
}

export function profileDefaults(
  profile: ResolvedProfile,
  target: SkillToggleTarget
): SkillToggleState {
  return Object.fromEntries(
    profile.enabledSkills
      .filter((skill) => skill.targets.includes(target))
      .map((skill) => [skill.name, skill.enabled])
  );
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
  configPaths: SkillConfigPaths,
  target: SkillToggleTarget,
  base: SkillToggleState,
  next: SkillToggleState
): Promise<void> {
  if (target === "codex") {
    const overrides = await readCodexSkillOverridesForNames(
      configPaths.active.codex,
      new Set(Object.keys(base))
    );
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
    await replaceCodexSkillOverrides(configPaths, overrides);
    return;
  }
  const overrides = await readActiveSkillOverrides(configPaths, target);
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
  if (target === "codex") {
    await replaceCodexSkillOverrides(configPaths, state);
    return;
  }
  await replaceSkillOverridesInFile(target, configPaths.active[target], state);
  if (configPaths.scope === "global") {
    await writeSkillOverridesFile(configPaths.state[target], state);
  }
  await ensureActiveGitExcluded(configPaths, target);
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
