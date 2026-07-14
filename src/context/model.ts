import type { AgentName } from "../core/paths.js";

export type ContextHarness = Extract<AgentName, "opencode" | "claude-code">;
export type LoadingClass =
  | "startup"
  | "per-step"
  | "conditional:path"
  | "conditional:invocation"
  | "deferred"
  | "unknown";
export type MeasurementKind = "exact-text" | "estimated-tokens" | "observed-usage" | "unknown";

export interface TextMeasurement {
  characters: number;
  bytes: number;
  estimatedTokens: number;
}

export interface ContextContributor {
  category: string;
  name: string;
  source?: string;
  loading: LoadingClass;
  characters?: number;
  bytes?: number;
  estimatedTokens?: number;
  measurement: MeasurementKind;
  note?: string;
}

export interface ContextActivation {
  category: "skill" | "mcp" | "instruction" | "compaction" | "tool" | "attachment";
  name: string;
  count: number;
  characters?: number;
  source?: string;
}

export interface ContextMcpProbe {
  harness: ContextHarness;
  server: string;
  instructions: TextMeasurement;
  toolSchemas: TextMeasurement;
  toolCount: number;
  pages: number;
}

export interface ContextMcpProbeResult {
  server: string;
  harnesses: ContextHarness[];
  probe?: ContextMcpProbe;
  unavailable?: string;
}

export interface ContextMcpMembership {
  name: string;
  enabled: boolean;
  loading: LoadingClass;
}

export interface ContextHistory {
  available: boolean;
  unavailableReason?: string;
  windowDays: number;
  sessions: number;
  childSessions: number;
  modelRequests: number;
  usageBearingRequests: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptInputTokensWindowTotal: number;
  maxPromptInputTokens?: number;
  outputTokens: number;
  compactions: number;
  activations: ContextActivation[];
  versions: string[];
}

export interface ConditionalPathSummary {
  directory: string;
  contributors: string[];
  estimatedTokens: number;
}

export interface HarnessReport {
  harness: ContextHarness;
  scopeNotes: string[];
  contributors: ContextContributor[];
  mcpServers: ContextMcpMembership[];
  visibleSkillNames?: string[];
  maxConditionalPath?: ConditionalPathSummary;
  history?: ContextHistory;
}

export interface ContextReport {
  profile: string;
  inspectedDirectory: string;
  projectRoot?: string;
  homeDirectory?: string;
  harnesses: HarnessReport[];
  mcpProbes?: ContextMcpProbeResult[];
}

export interface UsageComponents {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

export function buildHistory(
  windowDays: number,
  values: Omit<ContextHistory, "available" | "windowDays" | "maxPromptInputTokens"> & {
    maxPromptInputTokens?: number | undefined;
  }
): ContextHistory {
  const { maxPromptInputTokens, ...rest } = values;
  const history: ContextHistory = {
    available: true,
    windowDays,
    ...rest
  };
  if (maxPromptInputTokens !== undefined) history.maxPromptInputTokens = maxPromptInputTokens;
  return history;
}
