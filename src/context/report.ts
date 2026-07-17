import path from "node:path";
import type { ResolvedProfile } from "../core/profile.js";
import { executorMcpServers } from "../core/profile.js";
import { effectiveProjectState, readOverrideStore } from "../core/override-store.js";
import type { RuntimePaths } from "../core/paths.js";
import { readClaudeHistory } from "./claude-history.js";
import { probeMcpServer } from "./mcp-probe.js";
import {
  type ContextContributor,
  type ContextHarness,
  type ContextHistory,
  type ContextMcpProbeResult,
  type ContextReport,
  type HarnessReport,
  type TextMeasurement
} from "./model.js";
import { readOpenCodeHistory } from "./opencode-history.js";
import { findProjectRoot } from "./repository.js";
import { analyzeHarnessStatic } from "./static.js";

export interface ContextOptions {
  agent?: ContextHarness | undefined;
  probeMcp?: boolean | undefined;
}

const loadingOrder = new Map([
  ["startup", 0],
  ["per-step", 1],
  ["conditional:path", 2],
  ["conditional:invocation", 3],
  ["deferred", 4],
  ["unknown", 5]
]);

function sortContributors(contributors: ContextContributor[]): ContextContributor[] {
  return [...contributors].sort(
    (a, b) =>
      (loadingOrder.get(a.loading) ?? 99) - (loadingOrder.get(b.loading) ?? 99) ||
      (b.estimatedTokens ?? -1) - (a.estimatedTokens ?? -1) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name) ||
      (a.source ?? "").localeCompare(b.source ?? "")
  );
}

async function enrichMcpProbes(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  report: ContextReport
): Promise<ContextMcpProbeResult[]> {
  const targets = new Map<string, ContextHarness[]>();
  for (const harness of report.harnesses) {
    for (const server of harness.mcpServers) {
      if (!server.enabled) continue;
      const members = targets.get(server.name) ?? [];
      members.push(harness.harness);
      targets.set(server.name, members);
    }
  }

  const results: ContextMcpProbeResult[] = [];
  for (const [server, harnesses] of targets) {
    try {
      // The first member selects the shared server configuration; probes remain sequential.
      const probe = await probeMcpServer(
        paths,
        profile,
        harnesses[0]!,
        server,
        report.inspectedDirectory,
        report.projectRoot
      );
      for (const harness of report.harnesses) {
        if (!harnesses.includes(harness.harness)) continue;
        const contributor = harness.contributors.find(
          (entry) => entry.category === "MCP tools" && entry.name === server
        );
        if (!contributor) continue;
        contributor.characters = probe.toolSchemas.characters;
        contributor.bytes = probe.toolSchemas.bytes;
        contributor.estimatedTokens = probe.toolSchemas.estimatedTokens;
        contributor.measurement = "estimated-tokens";
      }
      results.push({ server, harnesses, probe });
    } catch {
      results.push({ server, harnesses, unavailable: "unavailable" });
    }
  }
  return results;
}

export async function buildContextReport(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  options: ContextOptions = {}
): Promise<ContextReport> {
  const inspectedDirectory = path.resolve(process.cwd());
  const projectRoot = await findProjectRoot(inspectedDirectory);
  const supported: ContextHarness[] = ["opencode", "claude-code"];
  const harnesses = supported.filter(
    (harness): harness is ContextHarness =>
      (!options.agent || options.agent === harness) && profile.agents.includes(harness)
  );
  if (options.agent && !profile.agents.includes(options.agent)) {
    throw new Error(`Agent ${options.agent} is not active in profile ${profile.name}`);
  }
  const reports: HarnessReport[] = [];
  for (const harness of harnesses) {
    const report = await analyzeHarnessStatic(
      paths,
      profile,
      harness,
      inspectedDirectory,
      projectRoot
    );
    report.contributors = sortContributors(report.contributors);
    reports.push(report);
  }
  const report: ContextReport = {
    profile: profile.name,
    inspectedDirectory,
    ...(projectRoot ? { projectRoot } : {}),
    homeDirectory: paths.home,
    harnesses: reports
  };
  return options.probeMcp
    ? { ...report, mcpProbes: await enrichMcpProbes(paths, profile, report) }
    : report;
}

function unavailableHistory(windowDays: number): ContextHistory {
  return {
    available: false,
    unavailableReason: "history requires a Git worktree",
    windowDays,
    sessions: 0,
    childSessions: 0,
    modelRequests: 0,
    usageBearingRequests: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    promptInputTokensWindowTotal: 0,
    outputTokens: 0,
    compactions: 0,
    activations: [],
    versions: []
  };
}

export async function buildContextHistoryReport(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  agent: ContextHarness | undefined,
  historyDays: number
): Promise<ContextReport> {
  const inspectedDirectory = path.resolve(process.cwd());
  const projectRoot = await findProjectRoot(inspectedDirectory);
  const harnesses = (["opencode", "claude-code"] as ContextHarness[]).filter(
    (harness) => (!agent || agent === harness) && profile.agents.includes(harness)
  );
  if (agent && !profile.agents.includes(agent)) {
    throw new Error(`Agent ${agent} is not active in profile ${profile.name}`);
  }
  const reports: HarnessReport[] = [];
  const overrides = await readOverrideStore(paths.home);
  for (const harness of harnesses) {
    const mcpNames = Object.entries(
      effectiveProjectState(overrides, projectRoot, profile, harness, "mcp")
    )
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    if (executorMcpServers(profile).length > 0) mcpNames.push("executor");
    reports.push({
      harness,
      scopeNotes: [],
      contributors: [],
      mcpServers: [],
      history: projectRoot
        ? harness === "opencode"
          ? await readOpenCodeHistory(paths, mcpNames, projectRoot, historyDays)
          : await readClaudeHistory(paths, mcpNames, projectRoot, historyDays)
        : unavailableHistory(historyDays)
    });
  }
  return {
    profile: profile.name,
    inspectedDirectory,
    ...(projectRoot ? { projectRoot } : {}),
    homeDirectory: paths.home,
    harnesses: reports
  };
}

function formatNumber(value: number): string {
  const compact = (divisor: number, suffix: string) => {
    const scaled = Math.round((value / divisor) * 10) / 10;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}${suffix}`;
  };
  if (value >= 1_000_000_000) return compact(1_000_000_000, "b");
  if (value >= 1_000_000) {
    const result = compact(1_000_000, "m");
    return result === "1000m" ? "1b" : result;
  }
  if (value >= 1_000) {
    const result = compact(1_000, "k");
    return result === "1000k" ? "1m" : result;
  }
  return String(value);
}

function formatEstimate(value: number): string {
  return `~${formatNumber(value)}`;
}

function formatMeasurement(value: TextMeasurement): string {
  return `${formatNumber(value.characters)} chars (${formatEstimate(value.estimatedTokens)})`;
}

function displayPath(value: string, report: ContextReport): string {
  const relative = (base: string, prefix: string) => {
    const result = path.relative(base, value);
    return result === ""
      ? prefix
      : result && !result.startsWith(`..${path.sep}`) && result !== ".."
        ? `${prefix}/${result}`
        : undefined;
  };
  return (
    (report.projectRoot && relative(report.projectRoot, ".")) ??
    (report.homeDirectory && relative(report.homeDirectory, "~")) ??
    value
  );
}

function totals(contributors: ContextContributor[]): { tokens: number; unmeasured: number } {
  return {
    tokens: contributors.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0),
    unmeasured: contributors.filter((item) => item.estimatedTokens === undefined).length
  };
}

function formatTotal(contributors: ContextContributor[]): string {
  const total = totals(contributors);
  return `${formatEstimate(total.tokens)}${total.unmeasured ? ` (${total.unmeasured} unmeasured)` : ""}`;
}

function formatContributor(
  contributor: ContextContributor,
  report: ContextReport,
  indent = "    "
): string {
  const name =
    contributor.name === contributor.category && contributor.source
      ? displayPath(contributor.source, report)
      : contributor.name;
  return `${indent}${contributor.category}: ${name}  ${
    contributor.estimatedTokens === undefined
      ? "unmeasured"
      : formatEstimate(contributor.estimatedTokens)
  }`;
}

function isNotAdvertisedCatalogue(contributor: ContextContributor): boolean {
  return contributor.category === "skill catalogue" && contributor.loading === "deferred";
}

function fileContributors(harness: HarnessReport): ContextContributor[] {
  return harness.contributors.filter(
    (entry) => !entry.category.startsWith("skill ") && entry.category !== "MCP tools"
  );
}

function advertisedCatalogues(contributors: ContextContributor[]): ContextContributor[] {
  return contributors.filter(
    (entry) => entry.category === "skill catalogue" && !isNotAdvertisedCatalogue(entry)
  );
}

function formatPhaseTotal(contributors: ContextContributor[]): string {
  const total = totals(contributors);
  if (total.tokens > 0) return formatTotal(contributors);
  return total.unmeasured > 0 ? `${total.unmeasured} unmeasured` : "none";
}

function formatFiles(report: ContextReport, harness: HarnessReport): string[] {
  const contributors = fileContributors(harness);
  const startup = contributors.filter((entry) => entry.loading === "startup");
  const conditional = contributors.filter((entry) => entry.loading === "conditional:path");
  const other = contributors.filter(
    (entry) => entry.loading !== "startup" && entry.loading !== "conditional:path"
  );
  const lines = [
    `    Files (${startup.length} | ${formatPhaseTotal(startup)})`,
    ...startup.map((contributor) => formatContributor(contributor, report, "      "))
  ];
  if (conditional.length > 0) {
    lines.push(
      `      Conditional/nested excluded (${conditional.length} | ${formatPhaseTotal(conditional)})`,
      ...conditional.map((contributor) => formatContributor(contributor, report, "        "))
    );
    if (harness.maxConditionalPath) {
      lines.push(
        `        Maximum path: ${formatEstimate(harness.maxConditionalPath.estimatedTokens)} at ${displayPath(harness.maxConditionalPath.directory, report)}`
      );
    }
  }
  if (other.length > 0) {
    lines.push(
      `      Other loading excluded (${other.length} | ${formatPhaseTotal(other)})`,
      ...other.map((contributor) => formatContributor(contributor, report, "        "))
    );
  }
  return lines;
}

function formatSkills(report: ContextReport, contributors: ContextContributor[]): string[] {
  const skills = new Map<
    string,
    {
      name: string;
      catalogue?: ContextContributor;
      invocation?: ContextContributor;
    }[]
  >();
  for (const contributor of contributors) {
    if (!contributor.category.startsWith("skill ")) continue;
    const sourceRoot = contributor.source?.endsWith("/SKILL.md")
      ? path.dirname(path.dirname(contributor.source))
      : (contributor.source ?? "unknown");
    const entries = skills.get(sourceRoot) ?? [];
    let entry = entries.find((candidate) => candidate.name === contributor.name);
    if (!entry) {
      entry = { name: contributor.name };
      entries.push(entry);
    }
    if (contributor.category === "skill catalogue") entry.catalogue = contributor;
    if (contributor.category === "skill body") entry.invocation = contributor;
    skills.set(sourceRoot, entries);
  }
  if (skills.size === 0) return ["    Skills (none)"];

  const catalogue = advertisedCatalogues(contributors);
  const notAdvertised = contributors.filter(isNotAdvertisedCatalogue);
  const bodies = contributors.filter((entry) => entry.category === "skill body");
  const count = [...skills.values()].reduce((total, entries) => total + entries.length, 0);
  const summary = (
    catalogues: ContextContributor[],
    unavailable: number,
    body: ContextContributor[]
  ) =>
    `${formatPhaseTotal(catalogues)} catalogue${unavailable ? `; ${unavailable} not advertised` : ""}; ${formatPhaseTotal(body)} body inventory excluded`;
  const lines = [
    `    Skills (${count} ${count === 1 ? "skill" : "skills"} | ${summary(catalogue, notAdvertised.length, bodies)})`
  ];
  for (const [sourceRoot, entries] of [...skills.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const rootContributors = entries
      .flatMap((entry) => [entry.catalogue, entry.invocation])
      .filter((entry): entry is ContextContributor => entry !== undefined);
    const rootCatalogue = advertisedCatalogues(rootContributors);
    const rootNotAdvertised = rootContributors.filter(isNotAdvertisedCatalogue);
    const rootBodies = rootContributors.filter((entry) => entry.category === "skill body");
    lines.push(
      `      ${displayPath(sourceRoot, report)}/ (${entries.length} ${entries.length === 1 ? "skill" : "skills"} | ${summary(rootCatalogue, rootNotAdvertised.length, rootBodies)})`
    );
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const catalogue = entry.catalogue;
      const invocation = entry.invocation;
      const visibility =
        !catalogue || catalogue.loading === "deferred"
          ? "not advertised catalogue"
          : catalogue.estimatedTokens === undefined
            ? "unmeasured catalogue"
            : `${formatEstimate(catalogue.estimatedTokens)} catalogue`;
      const body =
        invocation?.estimatedTokens === undefined
          ? "unmeasured body inventory on invocation"
          : `${formatEstimate(invocation.estimatedTokens)} body inventory on invocation`;
      lines.push(`        ${entry.name}  ${visibility}; ${body}`);
    }
  }
  return lines;
}

function formatMcp(report: ContextReport, harness: HarnessReport, established: boolean): string[] {
  const members = [...harness.mcpServers].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  if (members.length === 0) return ["    MCP servers (none)"];
  const enabled = members.filter((server) => server.enabled);
  const disabled = members.length - enabled.length;
  const heading = established || enabled.length === 0 ? "MCP servers" : "MCP schema inventory";
  const lines = [
    `    ${heading} (${enabled.length} enabled${disabled ? `; ${disabled} disabled` : ""}${!established && enabled.length > 0 ? " | loading unknown; excluded from Per request" : ""})`
  ];
  if (enabled.length === 0) return lines;

  const probes = new Map(report.mcpProbes?.map((entry) => [entry.server, entry]) ?? []);
  const measured = enabled
    .map((server) => probes.get(server.name)?.probe)
    .filter((probe): probe is NonNullable<typeof probe> => probe !== undefined);
  const unavailable = enabled.filter((server) => probes.get(server.name)?.unavailable).length;
  const unknownLoading = enabled.filter((server) => server.loading === "unknown").length;
  if (report.mcpProbes) {
    if (measured.length > 0) {
      const total = (key: "instructions" | "toolSchemas"): TextMeasurement =>
        measured.reduce(
          (sum, probe) => ({
            characters: sum.characters + probe[key].characters,
            bytes: sum.bytes + probe[key].bytes,
            estimatedTokens: sum.estimatedTokens + probe[key].estimatedTokens
          }),
          { characters: 0, bytes: 0, estimatedTokens: 0 }
        );
      const schemas = total("toolSchemas");
      const instructions = total("instructions");
      lines.push(
        `      totals: ${measured.length} measured${unavailable ? `; ${unavailable} unavailable` : ""}${unknownLoading ? `; ${unknownLoading} unknown loading` : ""}; schemas ${formatMeasurement(
          schemas
        )}; instructions ${formatMeasurement(instructions)}`
      );
    } else {
      lines.push(
        `      totals: 0 measured; ${unavailable} unavailable${unknownLoading ? `; ${unknownLoading} unknown loading` : ""}`
      );
    }
  } else {
    lines.push(
      `      totals: ${enabled.length} schemas unmeasured (not probed)${unknownLoading ? `; ${unknownLoading} unknown loading` : ""}`
    );
  }

  for (const server of enabled) {
    const result = probes.get(server.name);
    if (server.sharedIntegrations && server.sharedIntegrations.length > 0) {
      lines.push(`        shared inventory: ${server.sharedIntegrations.join(", ")}`);
    }
    if (!result) {
      lines.push(`      ${server.name}  enabled | schemas unmeasured (not probed)`);
      continue;
    }
    if (!result.probe) {
      lines.push(`      ${server.name}  enabled | unavailable`);
      continue;
    }
    lines.push(
      `      ${server.name}  enabled | ${formatNumber(result.probe.toolCount)} ${result.probe.toolCount === 1 ? "tool" : "tools"} | schemas ${formatMeasurement(result.probe.toolSchemas)}; instructions ${formatMeasurement(result.probe.instructions)}`
    );
  }
  if (measured.length > 0) {
    lines.push("      server instructions are probe metadata; excluded from the phase baseline");
  }
  return lines;
}

function formatStartup(report: ContextReport, harness: HarnessReport): string[] {
  const files = fileContributors(harness).filter((entry) => entry.loading === "startup");
  const catalogue = advertisedCatalogues(harness.contributors);
  return [
    `  Startup (${formatPhaseTotal([...files, ...catalogue])})`,
    ...formatFiles(report, harness),
    ...formatSkills(report, harness.contributors)
  ];
}

function formatPerRequest(report: ContextReport, harness: HarnessReport): string[] {
  const enabled = harness.mcpServers.filter((server) => server.enabled);
  const established =
    enabled.length > 0 && enabled.every((server) => server.loading === "per-step");
  const perStep = harness.contributors.filter((entry) => entry.loading === "per-step");
  const phase = established
    ? formatPhaseTotal(perStep)
    : enabled.length === 0
      ? "none"
      : "not established";
  return [`  Per request (${phase})`, ...formatMcp(report, harness, established)];
}

function formatHistory(history: ContextHistory): string[] {
  if (!history.available)
    return [`  unavailable: ${history.unavailableReason ?? "unknown reason"}`];
  const average =
    history.usageBearingRequests === 0
      ? "unavailable"
      : formatNumber(
          Math.round(history.promptInputTokensWindowTotal / history.usageBearingRequests)
        );
  const maximum =
    history.maxPromptInputTokens === undefined
      ? "unavailable"
      : formatNumber(history.maxPromptInputTokens);
  const activity = new Map<string, number>();
  for (const activation of history.activations) {
    const label =
      activation.category === "mcp"
        ? "MCP calls"
        : activation.category === "skill"
          ? "skill calls"
          : `${activation.category} events`;
    activity.set(label, (activity.get(label) ?? 0) + activation.count);
  }
  const lines = [
    `  ${history.windowDays}d | ${formatNumber(history.sessions)} sessions (${formatNumber(history.childSessions)} child/subagent) | ${formatNumber(history.modelRequests)} model steps (${formatNumber(history.usageBearingRequests)} usage-bearing)`,
    `  prompt traffic: ${formatNumber(history.promptInputTokensWindowTotal)} (${formatNumber(history.uncachedInputTokens)} uncached; ${formatNumber(history.cacheReadTokens)} cache read; ${formatNumber(history.cacheWriteTokens)} cache write); ${average} avg/request; ${maximum} max observed`,
    `  output: ${formatNumber(history.outputTokens)}; compactions: ${formatNumber(history.compactions)}`
  ];
  if (activity.size > 0)
    lines.push(
      `  activity: ${[...activity.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, count]) => `${name} ${formatNumber(count)}`)
        .join("; ")}`
    );
  if (history.versions.length > 0) lines.push(`  versions: ${history.versions.join(", ")}`);
  return lines;
}

export function formatContextReport(report: ContextReport): string {
  const lines = [
    `Context | ${report.profile} | ${report.inspectedDirectory}`,
    ...(report.projectRoot && report.projectRoot !== report.inspectedDirectory
      ? [`project: ${report.projectRoot}`]
      : []),
    "Scope: mfz-managed instructions, indexes, skills, MCP membership, and repository guidance; excludes built-ins, plugins, and unmanaged extensions.",
    ""
  ];
  for (const harness of report.harnesses) {
    lines.push(harness.harness, "=".repeat(harness.harness.length));
    lines.push(...formatStartup(report, harness));
    lines.push(...formatPerRequest(report, harness));
    lines.push("");
  }
  if (report.mcpProbes && report.mcpProbes.length > 0) {
    lines.push("Probe safety: initialize + tools/list only; contacted servers are not sandboxed.");
  }
  lines.push("~ is a local round(characters / 4) estimate; unmeasured values are not zero.");
  return lines.join("\n");
}

export function formatContextHistoryReport(report: ContextReport): string {
  const lines = [
    `Context history | ${report.profile} | ${report.inspectedDirectory}`,
    "Telemetry only: session metadata and usage aggregates; no current capability analysis or transcript content.",
    ""
  ];
  for (const harness of report.harnesses) {
    lines.push(harness.harness, "=".repeat(harness.harness.length));
    if (harness.history) lines.push(...formatHistory(harness.history));
    lines.push("");
  }
  return lines.join("\n");
}
