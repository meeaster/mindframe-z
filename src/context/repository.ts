import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import YAML from "yaml";
import { findProjectRoot } from "../core/override-store.js";
import type { ContextContributor, ContextHarness, ConditionalPathSummary } from "./model.js";
import { measuredContributor } from "./measurement.js";

export { findProjectRoot };

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface RepositoryAnalysis {
  contributors: ContextContributor[];
  maxConditionalPath?: ConditionalPathSummary;
}

async function trackedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "buffer" }
    );
    return Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function frontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const parsed = YAML.parse(content.slice(3, end));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function isAncestorOrSame(ancestor: string, candidate: string): boolean {
  return isPathWithin(ancestor, candidate);
}

function instructionKind(
  relative: string,
  harness: ContextHarness
): { category: string } | undefined {
  const normalized = relative.split(path.sep).join("/");
  if (harness === "claude-code" && normalized.startsWith(".claude/rules/")) {
    return { category: "Claude rule" };
  }
  const name = path.basename(relative);
  const allowed =
    harness === "opencode"
      ? new Set(["AGENTS.md", "CLAUDE.md", "CONTEXT.md"])
      : new Set(["CLAUDE.md", "CLAUDE.local.md"]);
  return allowed.has(name) ? { category: "repository instruction" } : undefined;
}

function instructionRank(relative: string): number {
  switch (path.basename(relative)) {
    case "AGENTS.md":
      return 0;
    case "CLAUDE.md":
      return 1;
    case "CLAUDE.local.md":
      return 2;
    default:
      return 3;
  }
}

function globPattern(pattern: string): RegExp | undefined {
  if (pattern.startsWith("!") || /[\\[\]]/.test(pattern)) return undefined;
  const normalized = pattern.replace(/^\.?[/\\]/, "").replace(/[/\\]/g, "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === undefined) continue;
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "{") {
      const end = normalized.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = normalized
          .slice(index + 1, end)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        source += `(?:${alternatives})`;
        index = end;
      } else {
        source += "\\{";
      }
    } else {
      source += character.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matchesPattern(pattern: string, relative: string): boolean {
  return globPattern(pattern)?.test(relative.split(path.sep).join("/")) ?? false;
}

export async function analyzeRepository(
  projectRoot: string | undefined,
  inspectedDirectory: string,
  harness: ContextHarness
): Promise<RepositoryAnalysis> {
  if (!projectRoot) return { contributors: [] };

  const contributors: ContextContributor[] = [];
  const repositoryFiles = await trackedFiles(projectRoot);
  const conditional: Array<{
    contributor: ContextContributor;
    directory: string;
    patterns: string[];
  }> = [];
  const candidates = repositoryFiles
    .map((relative) => ({
      relative,
      absolute: path.resolve(projectRoot, relative),
      kind: instructionKind(relative, harness)
    }))
    .filter(
      (candidate): candidate is typeof candidate & { kind: { category: string } } =>
        candidate.kind !== undefined && isPathWithin(projectRoot, candidate.absolute)
    )
    .filter((candidate, _index, all) => {
      if (harness !== "opencode" || candidate.kind.category !== "repository instruction")
        return true;
      const directory = path.dirname(candidate.absolute);
      return !all.some(
        (other) =>
          other.kind?.category === "repository instruction" &&
          path.dirname(other.absolute) === directory &&
          instructionRank(other.relative) < instructionRank(candidate.relative)
      );
    });

  for (const { absolute, kind } of candidates) {
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      contributors.push({
        category: kind.category,
        name: kind.category,
        source: absolute,
        loading: "unknown",
        measurement: "unknown",
        note: "file could not be read"
      });
      continue;
    }

    const metadata = frontmatter(content);
    const rulePaths =
      kind.category === "Claude rule" && Array.isArray(metadata.paths)
        ? metadata.paths.filter((entry): entry is string => typeof entry === "string")
        : [];
    const isRulePathScoped = rulePaths.length > 0;
    const unsupportedRuleGlob = rulePaths.some((pattern) => globPattern(pattern) === undefined);
    const directory = path.dirname(absolute);
    const startup =
      kind.category === "Claude rule"
        ? !isRulePathScoped
        : !isRulePathScoped && isAncestorOrSame(directory, inspectedDirectory);
    const contributor = unsupportedRuleGlob
      ? {
          ...measuredContributor(
            {
              category: kind.category,
              name: kind.category,
              source: absolute,
              loading: "unknown"
            },
            content
          ),
          note: "unsupported Claude rule glob; conditional path cost unavailable"
        }
      : measuredContributor(
          {
            category: kind.category,
            name: kind.category,
            source: absolute,
            loading: startup ? "startup" : "conditional:path"
          },
          content
        );
    contributors.push(contributor);
    if (!startup && !unsupportedRuleGlob) {
      conditional.push({
        contributor,
        directory,
        patterns: rulePaths
      });
    }
  }

  let maxConditionalPath: ConditionalPathSummary | undefined;
  for (const relativeCandidate of repositoryFiles) {
    const candidate = path.resolve(projectRoot, relativeCandidate);
    const directory = path.dirname(candidate);
    const entries = conditional.filter((entry) =>
      entry.patterns.length > 0
        ? entry.patterns.some((pattern) => matchesPattern(pattern, relativeCandidate))
        : isAncestorOrSame(entry.directory, candidate)
    );
    if (entries.length === 0) continue;
    const estimatedTokens = entries.reduce(
      (total, entry) => total + (entry.contributor.estimatedTokens ?? 0),
      0
    );
    if (!maxConditionalPath || estimatedTokens > maxConditionalPath.estimatedTokens) {
      maxConditionalPath = {
        directory,
        contributors: entries.map((entry) => entry.contributor.source ?? entry.contributor.name),
        estimatedTokens
      };
    }
  }

  return { contributors, ...(maxConditionalPath ? { maxConditionalPath } : {}) };
}
