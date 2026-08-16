import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../core/fs-util.js";
import { extraFoldersIndexContent, referenceIndexContent } from "../ref-store/references.js";
import {
  executorBridgeName,
  executorMcpServers,
  filterMcpForTarget,
  requiresExecutorBridge,
  type ResolvedProfile
} from "../core/profile.js";
import { globalSkillStatePath, type RuntimePaths } from "../core/paths.js";
import {
  effectiveProjectState,
  projectOverrides,
  readOverrideStore,
  type OverrideStore
} from "../core/override-store.js";
import {
  evaluateOpenCodeSkillPermission,
  readSkillOverridesFile
} from "../core/skill-overrides.js";
import { analyzeRepository } from "./repository.js";
import { measuredContributor, unknownContributor } from "./measurement.js";
import type {
  ContextContributor,
  ContextHarness,
  ContextMcpMembership,
  HarnessReport
} from "./model.js";
import { jsonObjectSchema, jsonString, type JsonObject } from "../core/json.js";

function openCodeMcpLoading(): "per-step" | "unknown" {
  const flag = (name: string): boolean | undefined => {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined) return undefined;
    if (["1", "true", "yes"].includes(value)) return true;
    if (["0", "false", "no"].includes(value)) return false;
    return undefined;
  };
  const codeMode =
    flag("OPENCODE_EXPERIMENTAL_CODE_MODE") ?? flag("OPENCODE_EXPERIMENTAL") ?? false;
  if (codeMode) {
    return "unknown";
  }
  return "per-step";
}

function claudeMcpLoading(): "unknown" {
  return "unknown";
}

interface SkillFile {
  path: string;
  content: string;
  metadata: JsonObject;
}

async function readSkillFile(
  paths: RuntimePaths,
  skill: ResolvedProfile["enabledSkills"][number],
  harness: ContextHarness
): Promise<SkillFile | undefined> {
  const targetRoot =
    harness === "opencode"
      ? path.join(paths.home, ".agents", "skills")
      : path.join(paths.claudeDir, "skills");
  const skillName = skill.source === "local" ? (skill.skill ?? skill.name) : skill.name;
  const candidates = [
    path.join(targetRoot, skill.name, "SKILL.md"),
    path.join(targetRoot, skillName, "SKILL.md"),
    path.join(
      skill.sourceRoot,
      "skills",
      skill.source === "vendored" ? "vendor" : "",
      skillName,
      "SKILL.md"
    )
  ];
  for (const candidate of new Set(candidates)) {
    try {
      const content = await readFile(candidate, "utf8");
      const metadata = jsonObjectSchema.safeParse(parseFrontmatter(content));
      return { path: candidate, content, metadata: metadata.success ? metadata.data : {} };
    } catch {
      // Try the next source-of-truth or installed location.
    }
  }
  return undefined;
}

function indexContributor(
  category: string,
  name: string,
  source: string,
  content: string
): ContextContributor {
  return measuredContributor({ category, name, source, loading: "startup" }, content);
}

async function skillContributors(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  harness: ContextHarness,
  projectRoot: string | undefined,
  overrideStore: OverrideStore
): Promise<{
  contributors: ContextContributor[];
  notes: string[];
  visibleSkillNames: string[];
}> {
  const contributors: ContextContributor[] = [];
  const notes: string[] = [];
  const visibleSkillNames: string[] = [];
  const globalOverrides =
    harness === "opencode"
      ? await readSkillOverridesFile(globalSkillStatePath(paths, "opencode"))
      : {};
  const projectOverridesForHarness =
    harness === "opencode" && projectRoot
      ? projectOverrides(overrideStore, projectRoot, "opencode", "skills")
      : {};
  const machinePermission = profile.manifests.machine.opencode.permission;
  for (const skill of profile.enabledSkills.filter((entry) => entry.targets.includes(harness))) {
    if (harness === "opencode") {
      const permission = evaluateOpenCodeSkillPermission(
        skill.name,
        profile.profile.opencode.config.permission,
        globalOverrides,
        projectOverridesForHarness,
        machinePermission
      );
      if (permission.effect === "deny") {
        notes.push(
          `OpenCode skill ${skill.name} excluded from model availability by the effective ${permission.source} permission override`
        );
        continue;
      }
    }
    visibleSkillNames.push(skill.name);
    const file = await readSkillFile(paths, skill, harness);
    const source = file?.path ?? path.join(skill.sourceRoot, "skills");
    const description = jsonString(file?.metadata.description) ?? skill.description;
    const catalogue = `${skill.name}\n${description}\n${file?.path ?? "mfz catalogue metadata"}`;
    const disabled =
      harness === "claude-code" && file?.metadata["disable-model-invocation"] === true;
    if (disabled) {
      contributors.push(
        unknownContributor({
          category: "skill catalogue",
          name: skill.name,
          source,
          loading: "deferred",
          note: "model invocation disabled; catalogue is not advertised"
        })
      );
    } else {
      contributors.push(
        measuredContributor(
          {
            category: "skill catalogue",
            name: skill.name,
            source,
            loading: "startup",
            note: file
              ? "catalogue serialization estimate; exact harness text unavailable"
              : "mfz catalogue metadata fallback; catalogue serialization estimate"
          },
          catalogue
        )
      );
    }
    if (file) {
      contributors.push(
        measuredContributor(
          {
            category: "skill body",
            name: skill.name,
            source: file.path,
            loading: "conditional:invocation"
          },
          file.content
        )
      );
    } else {
      contributors.push(
        unknownContributor({
          category: "skill body",
          name: skill.name,
          source,
          loading: "conditional:invocation",
          note: "SKILL.md unavailable"
        })
      );
    }
  }
  return { contributors, notes, visibleSkillNames };
}

export async function analyzeHarnessStatic(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  harness: ContextHarness,
  inspectedDirectory: string,
  projectRoot: string | undefined
): Promise<HarnessReport> {
  const contributors: ContextContributor[] = [];
  const scopeNotes = [
    harness === "opencode"
      ? "scope: profile instructions and indexes, model-visible skills after effective overrides, enabled MCP exposure, and repository instructions; excludes built-ins, plugins, bundled skills, and unmanaged extensions"
      : "scope: profile instructions and indexes, enabled skills and MCP exposure, and repository instructions; excludes built-ins, plugins, bundled skills, and unmanaged extensions"
  ];

  for (const instruction of profile.instructionFiles) {
    try {
      contributors.push(
        measuredContributor(
          {
            category: "profile instructions",
            name: path.basename(instruction),
            source: instruction,
            loading: "startup"
          },
          await readFile(instruction, "utf8")
        )
      );
    } catch {
      contributors.push(
        unknownContributor({
          category: "profile instructions",
          name: path.basename(instruction),
          source: instruction,
          loading: "startup",
          note: "instruction file unavailable"
        })
      );
    }
  }

  contributors.push(
    indexContributor(
      "references index",
      "references.md",
      "generated references index",
      referenceIndexContent(profile)
    )
  );
  if (profile.extraFolders.length > 0) {
    contributors.push(
      indexContributor(
        "extra-folder index",
        "extra_folders.md",
        "generated extra-folder index",
        extraFoldersIndexContent(paths, profile)
      )
    );
  }

  const overrideStore = await readOverrideStore(paths.home);
  const skills = await skillContributors(paths, profile, harness, projectRoot, overrideStore);
  contributors.push(...skills.contributors);
  scopeNotes.push(...skills.notes);
  const mcpLoading = harness === "opencode" ? openCodeMcpLoading() : claudeMcpLoading();
  const effectiveMcp = effectiveProjectState(overrideStore, projectRoot, profile, harness, "mcp");
  const mcpServers: ContextMcpMembership[] = filterMcpForTarget(profile, harness).map(
    ({ name }) => ({
      name,
      enabled: effectiveMcp[name] === true,
      loading: mcpLoading,
      route: "direct"
    })
  );
  const shared = requiresExecutorBridge(profile) ? executorMcpServers(profile) : [];
  if (shared.length > 0) {
    mcpServers.push({
      name: executorBridgeName,
      enabled: true,
      loading: mcpLoading,
      route: "executor",
      sharedIntegrations: shared.map((entry) => entry.name).sort(),
      sharedConnections: Object.fromEntries(
        shared
          .map(
            (entry) => [entry.name, Object.keys(entry.executor?.connections ?? {}).sort()] as const
          )
          .sort(([left], [right]) => left.localeCompare(right))
      )
    });
  }
  for (const server of mcpServers) {
    if (!server.enabled) continue;
    contributors.push(
      unknownContributor({
        category: "MCP tools",
        name: server.name,
        loading: server.loading
      })
    );
  }

  const repository = await analyzeRepository(projectRoot, inspectedDirectory, harness);
  contributors.push(...repository.contributors);
  if (!projectRoot) {
    scopeNotes.push("repository instruction analysis is not applicable outside a Git worktree");
  } else {
    scopeNotes.push("repository scan includes tracked and non-ignored untracked instruction files");
  }

  const report: HarnessReport = {
    harness,
    scopeNotes,
    contributors,
    mcpServers,
    visibleSkillNames: skills.visibleSkillNames
  };
  if (repository.maxConditionalPath) report.maxConditionalPath = repository.maxConditionalPath;
  return report;
}
