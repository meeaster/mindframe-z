// PROTOTYPE: answers whether the proposed context report shape is readable.
// Keep this module pure enough to lift into the real analyzer after the shape
// is exercised. It intentionally uses synthetic contributors, not real stores.

export type HarnessName = "opencode" | "claude-code";
export type LoadingClass =
  | "startup"
  | "per-step"
  | "conditional:path"
  | "conditional:invocation"
  | "deferred"
  | "unknown";

export interface TextSize {
  characters: number;
  bytes: number;
  estimatedTokens: number;
}

export interface Contributor {
  category: string;
  name: string;
  loading: LoadingClass;
  size?: TextSize;
  note?: string;
}

export interface ConditionalPath {
  path: string;
  contributorNames: string[];
  estimatedTokens: number;
}

export interface CapabilityObservation {
  name: string;
  kind: "skill" | "mcp";
  current: boolean;
  calls: number;
}

export interface HistorySummary {
  windowDays: number;
  sessions: number;
  childSessions: number;
  modelRequests: number;
  usageBearingRequests: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  maxPromptInputTokens?: number;
  outputTokens: number;
  compactions: number;
  capabilities: CapabilityObservation[];
}

export type HistoryMode = { kind: "not-requested" } | { kind: "requested"; days: number };

export interface HarnessReport {
  harness: HarnessName;
  scopeNotes: string[];
  contributors: Contributor[];
  conditionalPathMax?: ConditionalPath;
  history?: HistorySummary;
}

export interface ContextReport {
  scenario: string;
  profile: string;
  inspectedDirectory: string;
  projectRoot?: string;
  historyMode: HistoryMode;
  harnesses: HarnessReport[];
}

const loadingOrder: LoadingClass[] = [
  "startup",
  "per-step",
  "conditional:path",
  "conditional:invocation",
  "deferred",
  "unknown"
];

export function measureText(text: string): TextSize {
  const characters = text.length;
  const bytes = new TextEncoder().encode(text).byteLength;
  return {
    characters,
    bytes,
    estimatedTokens: Math.max(0, Math.round(characters / 4))
  };
}

export function promptInput(history: HistorySummary): number {
  return history.uncachedInputTokens + history.cacheReadTokens + history.cacheWriteTokens;
}

function knownTokens(contributors: Contributor[], loading: LoadingClass): number {
  return contributors
    .filter((contributor) => contributor.loading === loading)
    .reduce((total, contributor) => total + (contributor.size?.estimatedTokens ?? 0), 0);
}

function unknownCount(contributors: Contributor[], loading: LoadingClass): number {
  return contributors.filter((contributor) => contributor.loading === loading && !contributor.size)
    .length;
}

function formatSize(size: TextSize | undefined): string {
  if (!size) return "unknown size";
  return `~${size.estimatedTokens} est tok; ${size.characters} chars; ${size.bytes} B`;
}

function formatLoadingClass(report: HarnessReport, loading: LoadingClass): string[] {
  const contributors = report.contributors
    .filter((contributor) => contributor.loading === loading)
    .sort((left, right) => {
      const tokenDelta = (right.size?.estimatedTokens ?? -1) - (left.size?.estimatedTokens ?? -1);
      return tokenDelta || left.name.localeCompare(right.name);
    });
  if (contributors.length === 0) return [];

  const total = knownTokens(report.contributors, loading);
  const unknown = unknownCount(report.contributors, loading);
  const subtotal = unknown
    ? total === 0
      ? `${unknown} unknown`
      : `${total} est tok + ${unknown} unknown`
    : `${total} est tok`;
  const lines = [`  ${loading}  [${subtotal}]`];
  for (const contributor of contributors) {
    const note = contributor.note ? ` - ${contributor.note}` : "";
    lines.push(
      `    ${contributor.category}: ${contributor.name} (${formatSize(contributor.size)})${note}`
    );
  }
  return lines;
}

function formatHistory(history: HistorySummary): string[] {
  const prompt = promptInput(history);
  const average =
    history.usageBearingRequests === 0 ? undefined : prompt / history.usageBearingRequests;
  const maximum =
    history.maxPromptInputTokens === undefined ? "unknown" : `${history.maxPromptInputTokens} tok`;
  const lines = [
    `  history: last ${history.windowDays} days; ${history.sessions} sessions; ${history.childSessions} child/subagent sessions`,
    `    requests: ${history.modelRequests} observed model steps; usage-bearing: ${history.usageBearingRequests}`,
    `    prompt input window total (traffic): ${prompt} tok`,
    `    prompt input/request (usage-bearing): avg ${average === undefined ? "unknown" : `${average.toFixed(1)} tok`}; max observed input occupancy (including cached): ${maximum}`,
    `    input components (window totals): uncached ${history.uncachedInputTokens}, cache read ${history.cacheReadTokens}, cache write/create ${history.cacheWriteTokens}`,
    `    output: ${history.outputTokens} tok; compactions: ${history.compactions}`,
    "    capability observations:"
  ];
  for (const capability of history.capabilities) {
    const status = !capability.current
      ? "historical only; not in current profile"
      : capability.calls === 0
        ? "no use observed in this window"
        : `${capability.calls} call${capability.calls === 1 ? "" : "s"}`;
    lines.push(`      ${capability.kind} ${capability.name}: ${status}`);
  }
  return lines;
}

export function formatReport(report: ContextReport, filter: HarnessName | "all"): string {
  const harnesses =
    filter === "all"
      ? report.harnesses
      : report.harnesses.filter((harness) => harness.harness === filter);
  const lines = [
    `scenario: ${report.scenario}`,
    `profile: ${report.profile}`,
    `directory: ${report.inspectedDirectory}`,
    `project root: ${report.projectRoot ?? "not in a Git worktree"}`,
    `history mode: ${report.historyMode.kind === "requested" ? `requested for ${report.historyMode.days} days` : "not requested; session stores not read"}`,
    `harness view: ${filter}`,
    ""
  ];

  for (const harness of harnesses) {
    lines.push(harness.harness, "=".repeat(harness.harness.length));
    for (const note of harness.scopeNotes) lines.push(`  scope: ${note}`);
    lines.push("  static contributors:");
    for (const loading of loadingOrder) lines.push(...formatLoadingClass(harness, loading));
    if (harness.conditionalPathMax) {
      const path = harness.conditionalPathMax;
      lines.push(
        `  max additional conditional path: ~${path.estimatedTokens} est tok at ${path.path}`,
        `    includes: ${path.contributorNames.join(", ")}`
      );
    }
    if (harness.history) lines.push(...formatHistory(harness.history));
    lines.push("");
  }

  if (harnesses.length === 0) lines.push("No harness selected in this scenario.", "");
  lines.push("The prototype reports evidence, not a bloat verdict.");
  return lines.join("\n");
}

function size(label: string, repetitions = 1): TextSize {
  return measureText(`${label} `.repeat(repetitions));
}

function opencodeReport(withHistory: boolean): HarnessReport {
  return {
    harness: "opencode",
    scopeNotes: [
      "mfz profile, generated indexes, enabled skills/MCP, and repository instructions",
      "built-in prompts, plugins, bundled skills, and unprobed MCP schemas are outside scope"
    ],
    contributors: [
      {
        category: "profile instructions",
        name: "base AGENTS.global.md",
        loading: "startup",
        size: size("base instruction", 18)
      },
      {
        category: "references index",
        name: "references.md",
        loading: "startup",
        size: size("reference row", 24)
      },
      {
        category: "skill catalogue",
        name: "enabled skills metadata",
        loading: "startup",
        size: size("skill metadata", 14),
        note: "always advertised"
      },
      {
        category: "MCP tools",
        name: "github",
        loading: "per-step",
        note: "schema not obtained; no implicit connection"
      },
      {
        category: "repository instruction",
        name: "src/AGENTS.md",
        loading: "conditional:path",
        size: size("nested instruction", 19)
      },
      {
        category: "repository instruction",
        name: "src/client/AGENTS.md",
        loading: "conditional:path",
        size: size("deeper instruction", 11)
      },
      {
        category: "skill body",
        name: "review",
        loading: "conditional:invocation",
        size: size("review skill body", 70)
      }
    ],
    conditionalPathMax: {
      path: "src/client",
      contributorNames: ["src/AGENTS.md", "src/client/AGENTS.md"],
      estimatedTokens:
        size("nested instruction", 19).estimatedTokens +
        size("deeper instruction", 11).estimatedTokens
    },
    ...(withHistory
      ? {
          history: {
            windowDays: 7,
            sessions: 3,
            childSessions: 1,
            modelRequests: 20,
            usageBearingRequests: 18,
            uncachedInputTokens: 2400,
            cacheReadTokens: 8800,
            cacheWriteTokens: 1100,
            maxPromptInputTokens: 1900,
            outputTokens: 1950,
            compactions: 2,
            capabilities: [
              { kind: "skill", name: "review", current: true, calls: 5 },
              { kind: "mcp", name: "github", current: true, calls: 2 },
              { kind: "skill", name: "old-planner", current: false, calls: 3 }
            ]
          }
        }
      : {})
  };
}

function claudeReport(withHistory: boolean): HarnessReport {
  return {
    harness: "claude-code",
    scopeNotes: [
      "mfz instructions, Claude rules, enabled skills/MCP, and repository instructions",
      "built-in prompts, plugins, and unavailable attachment bodies are outside scope"
    ],
    contributors: [
      {
        category: "profile instructions",
        name: "base AGENTS.global.md",
        loading: "startup",
        size: size("base instruction", 18)
      },
      {
        category: "repository instruction",
        name: "CLAUDE.md",
        loading: "startup",
        size: size("claude instruction", 16)
      },
      {
        category: "skill listing",
        name: "enabled skills",
        loading: "startup",
        size: size("skill listing", 13),
        note: "catalogue metadata"
      },
      {
        category: "MCP tools",
        name: "github",
        loading: "deferred",
        note: "tool search listing only"
      },
      {
        category: "Claude rule",
        name: ".claude/rules/ui.md",
        loading: "conditional:path",
        size: size("ui rule", 20)
      },
      {
        category: "skill body",
        name: "review",
        loading: "conditional:invocation",
        size: size("review skill body", 70)
      }
    ],
    conditionalPathMax: {
      path: "src/ui",
      contributorNames: [".claude/rules/ui.md"],
      estimatedTokens: size("ui rule", 20).estimatedTokens
    },
    ...(withHistory
      ? {
          history: {
            windowDays: 7,
            sessions: 4,
            childSessions: 2,
            modelRequests: 8,
            usageBearingRequests: 6,
            uncachedInputTokens: 3100,
            cacheReadTokens: 8500,
            cacheWriteTokens: 700,
            maxPromptInputTokens: 5200,
            outputTokens: 2300,
            compactions: 1,
            capabilities: [
              { kind: "skill", name: "review", current: true, calls: 0 },
              { kind: "mcp", name: "github", current: true, calls: 1 },
              { kind: "skill", name: "legacy-search", current: false, calls: 2 }
            ]
          }
        }
      : {})
  };
}

export function scenarioNames(): string[] {
  return ["mixed static", "history overlay", "no repository", "unknown measurements"];
}

export function scenarioReport(index: number): ContextReport {
  const scenario = scenarioNames()[index] ?? scenarioNames()[0];
  if (scenario === "history overlay") {
    return {
      scenario,
      profile: "personal",
      inspectedDirectory: "/work/acme/app",
      projectRoot: "/work/acme/app",
      historyMode: { kind: "requested", days: 7 },
      harnesses: [opencodeReport(true), claudeReport(true)]
    };
  }
  if (scenario === "no repository") {
    const opencode = opencodeReport(false);
    const claude = claudeReport(false);
    return {
      scenario,
      profile: "personal",
      inspectedDirectory: "/tmp/loose-notes",
      historyMode: { kind: "not-requested" },
      harnesses: [
        {
          ...opencode,
          scopeNotes: [
            "mfz profile, generated indexes, enabled skills/MCP; repository instruction analysis not applicable",
            "built-in prompts, plugins, bundled skills, and unprobed MCP schemas are outside scope"
          ],
          contributors: opencode.contributors.filter(
            (contributor) => contributor.category !== "repository instruction"
          ),
          conditionalPathMax: undefined
        },
        {
          ...claude,
          scopeNotes: [
            "mfz instructions, Claude rules, enabled skills/MCP; repository instruction analysis not applicable",
            "built-in prompts, plugins, and unavailable attachment bodies are outside scope"
          ],
          contributors: claude.contributors.filter(
            (contributor) =>
              contributor.category !== "repository instruction" &&
              contributor.category !== "Claude rule"
          ),
          conditionalPathMax: undefined
        }
      ]
    };
  }
  if (scenario === "unknown measurements") {
    const opencode = opencodeReport(false);
    const claude = claudeReport(false);
    return {
      scenario,
      profile: "personal",
      inspectedDirectory: "/work/acme/app",
      projectRoot: "/work/acme/app",
      historyMode: { kind: "not-requested" },
      harnesses: [
        {
          ...opencode,
          contributors: opencode.contributors.map((contributor) =>
            contributor.name === "review"
              ? { ...contributor, size: undefined, note: "SKILL.md unavailable" }
              : contributor
          )
        },
        {
          ...claude,
          contributors: claude.contributors.map((contributor) =>
            contributor.name === "review"
              ? { ...contributor, size: undefined, note: "SKILL.md unavailable" }
              : contributor
          )
        }
      ]
    };
  }
  return {
    scenario,
    profile: "personal",
    inspectedDirectory: "/work/acme/app",
    projectRoot: "/work/acme/app",
    historyMode: { kind: "not-requested" },
    harnesses: [opencodeReport(false), claudeReport(false)]
  };
}
