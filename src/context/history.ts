import { isPlainObject } from "../core/fs-util.js";
import {
  buildHistory,
  type ContextActivation,
  type ContextHistory,
  type UsageComponents
} from "./model.js";

export function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function objectField(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

export function addOpenCodeUsage(value: unknown): UsageComponents | undefined {
  const tokens = objectField(value);
  if (!tokens) return undefined;
  const cache = objectField(tokens.cache);
  const input = numberField(tokens.input);
  const cacheRead = numberField(cache?.read);
  const cacheWrite = numberField(cache?.write);
  const output = numberField(tokens.output);
  if (
    input === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined
  ) {
    return undefined;
  }
  const result: UsageComponents = {};
  if (input !== undefined) result.input = input;
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite;
  if (output !== undefined) result.output = output;
  return result;
}

export function addClaudeUsage(value: unknown): UsageComponents | undefined {
  const usage = objectField(value);
  if (!usage) return undefined;
  const input = numberField(usage.input_tokens);
  const cacheRead = numberField(usage.cache_read_input_tokens);
  const cacheWrite = numberField(usage.cache_creation_input_tokens);
  const output = numberField(usage.output_tokens);
  if (
    input === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined
  ) {
    return undefined;
  }
  const result: UsageComponents = {};
  if (input !== undefined) result.input = input;
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite;
  if (output !== undefined) result.output = output;
  return result;
}

export class HistoryCollector {
  private readonly sessionsById = new Map<string, boolean>();
  private readonly requests = new Map<string, UsageComponents | undefined>();
  private readonly activations = new Map<string, ContextActivation>();
  private readonly versions = new Set<string>();
  private compactions = 0;

  addSession(id: string, child: boolean, version?: string): void {
    this.sessionsById.set(id, child);
    if (version) this.versions.add(version);
  }

  addVersion(version: string): void {
    this.versions.add(version);
  }

  addRequest(id: string, usage: UsageComponents | undefined): void {
    if (!this.requests.has(id)) {
      this.requests.set(id, usage);
      return;
    }
    const existing = this.requests.get(id);
    if (!existing) {
      this.requests.set(id, usage);
      return;
    }
    if (!usage) return;
    const merged: UsageComponents = {};
    if (existing.input === undefined && usage.input !== undefined) merged.input = usage.input;
    if (existing.cacheRead === undefined && usage.cacheRead !== undefined)
      merged.cacheRead = usage.cacheRead;
    if (existing.cacheWrite === undefined && usage.cacheWrite !== undefined)
      merged.cacheWrite = usage.cacheWrite;
    if (existing.output === undefined && usage.output !== undefined) merged.output = usage.output;
    Object.assign(merged, existing);
    this.requests.set(id, merged);
  }

  addActivation(
    category: ContextActivation["category"],
    name: string,
    characters?: number,
    source?: string
  ): void {
    this.addActivationCount(category, name, 1, characters, source);
  }

  addActivationCount(
    category: ContextActivation["category"],
    name: string,
    count: number,
    characters?: number,
    source?: string
  ): void {
    if (count <= 0) return;
    const key = `${category}:${name}:${source ?? ""}`;
    const existing = this.activations.get(key);
    if (!existing) {
      const activation: ContextActivation = {
        category,
        name,
        count
      };
      if (characters !== undefined) activation.characters = characters;
      if (source !== undefined) activation.source = source;
      this.activations.set(key, activation);
      return;
    }
    existing.count += count;
    if (characters !== undefined) existing.characters = (existing.characters ?? 0) + characters;
  }

  addCompaction(): void {
    this.compactions += 1;
  }

  finish(windowDays: number): ContextHistory {
    let uncachedInputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    let maxPromptInputTokens: number | undefined;
    let usageBearingRequests = 0;
    for (const usage of this.requests.values()) {
      if (!usage) continue;
      if (usage.output !== undefined) outputTokens += usage.output;
      if (
        usage.input === undefined &&
        usage.cacheRead === undefined &&
        usage.cacheWrite === undefined
      ) {
        continue;
      }
      usageBearingRequests += 1;
      uncachedInputTokens += usage.input ?? 0;
      cacheReadTokens += usage.cacheRead ?? 0;
      cacheWriteTokens += usage.cacheWrite ?? 0;
      const promptInput = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      maxPromptInputTokens = Math.max(maxPromptInputTokens ?? 0, promptInput);
    }
    const values: Parameters<typeof buildHistory>[1] = {
      sessions: this.sessionsById.size,
      childSessions: [...this.sessionsById.values()].filter(Boolean).length,
      modelRequests: this.requests.size,
      usageBearingRequests,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      promptInputTokensWindowTotal: uncachedInputTokens + cacheReadTokens + cacheWriteTokens,
      outputTokens,
      compactions: this.compactions,
      activations: [...this.activations.values()].sort(
        (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
      ),
      versions: [...this.versions].sort()
    };
    if (maxPromptInputTokens !== undefined) values.maxPromptInputTokens = maxPromptInputTokens;
    return buildHistory(windowDays, values);
  }
}

export function unavailableHistory(windowDays: number, reason: string): ContextHistory {
  return {
    available: false,
    unavailableReason: reason,
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
