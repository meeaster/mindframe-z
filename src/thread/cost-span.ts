import { randomBytes } from "node:crypto";
import { encode } from "@msgpack/msgpack";
import type { ThreadHarness } from "../core/manifests.js";

export interface CostSpanContext {
  readonly model: string;
  readonly modelProvider: string;
  readonly sessionId?: string;
  readonly startTimeMs: number;
  readonly durationMs: number;
  readonly costUsd: number | null;
}

export interface CostSpanMetrics {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly non_cached_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_write_input_tokens: number;
  readonly estimated_total_cost: number;
  readonly estimated_input_cost: number;
  readonly estimated_output_cost: number;
}

const NANODOLLARS_PER_USD = 1_000_000_000;

export function modelProvider(harness: ThreadHarness, model: string): string {
  if (harness === "claude-code") return "anthropic";
  const slash = model.indexOf("/");
  return slash === -1 ? "unknown" : model.slice(0, slash);
}

export function buildClaudeMetrics(
  rawUsage: Record<string, unknown> | null,
  costUsd: number | null
): CostSpanMetrics | null {
  if (!rawUsage) return null;
  const nonCached = numberField(rawUsage.input_tokens);
  const cacheRead = numberField(rawUsage.cache_read_input_tokens);
  const cacheWrite = numberField(rawUsage.cache_creation_input_tokens);
  const output = numberField(rawUsage.output_tokens);
  if (nonCached === null && cacheRead === null && cacheWrite === null && output === null) {
    return null;
  }
  const actualNonCached = nonCached ?? 0;
  const actualCacheRead = cacheRead ?? 0;
  const actualCacheWrite = cacheWrite ?? 0;
  const actualOutput = output ?? 0;
  const inputTokens = actualNonCached + actualCacheRead + actualCacheWrite;
  return {
    input_tokens: inputTokens,
    output_tokens: actualOutput,
    total_tokens: inputTokens + actualOutput,
    non_cached_input_tokens: actualNonCached,
    cache_read_input_tokens: actualCacheRead,
    cache_write_input_tokens: actualCacheWrite,
    ...nanodollarSplit(costUsd)
  };
}

export function buildOpenCodeMetrics(
  rawUsage: Record<string, unknown> | null,
  costUsd: number | null
): CostSpanMetrics | null {
  if (!rawUsage) return null;
  const input = numberField(rawUsage.input_tokens);
  const output = numberField(rawUsage.output_tokens);
  if (input === null && output === null) return null;
  const actualInput = input ?? 0;
  const actualOutput = output ?? 0;
  return {
    input_tokens: actualInput,
    output_tokens: actualOutput,
    total_tokens: actualInput + actualOutput,
    non_cached_input_tokens: actualInput,
    cache_read_input_tokens: 0,
    cache_write_input_tokens: 0,
    ...nanodollarSplit(costUsd)
  };
}

export function buildCostSpanPayload(
  harness: ThreadHarness,
  rawUsage: Record<string, unknown> | null,
  ctx: CostSpanContext
): Uint8Array | null {
  const metrics =
    harness === "claude-code"
      ? buildClaudeMetrics(rawUsage, ctx.costUsd)
      : buildOpenCodeMetrics(rawUsage, ctx.costUsd);
  if (!metrics) return null;

  const startNs = ctx.startTimeMs * 1_000_000;
  const durationNs = Math.max(ctx.durationMs * 1_000_000, 1);
  // lapdog validates span_id/trace_id as msgpack ints; JS numbers are float64 and
  // lose precision past 2^53, so we read 4 bytes and stay in the int32 range.
  const spanId = readInt32(randomBytes(4));
  const traceId = readInt32(randomBytes(4));
  const llmobsTraceId = bytesToHex(randomBytes(16));

  const llmobsEnvelope = {
    trace_id: llmobsTraceId,
    parent_id: "undefined",
    name: `${harness}-request`,
    session_id: ctx.sessionId ?? "unknown",
    meta: {
      span: { kind: "llm" },
      input: { value: "" },
      output: { value: "" },
      model_name: ctx.model,
      model_provider: ctx.modelProvider
    },
    metrics,
    tags: [`env:${tagEnv()}`, `ml_app:${harness}`]
  };

  const span = {
    name: "cost-span",
    service: harness,
    resource: "dispatch",
    span_id: spanId,
    trace_id: traceId,
    start: startNs,
    duration: durationNs,
    error: 0,
    meta: {},
    metrics: {},
    meta_struct: {
      _llmobs: encode(llmobsEnvelope)
    }
  };

  return encode([[span]]);
}

export async function emitCostSpan(lapdogUrl: string, payload: Uint8Array): Promise<void> {
  try {
    await fetch(`${lapdogUrl}/v0.4/traces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/msgpack",
        "X-Datadog-Trace-Count": "1",
        "Datadog-Meta-Tracer-Version": "mindframe-z-1.0.0"
      },
      body: payload,
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // fail-open: a missing or slow lapdog must not affect ingest.
  }
}

function nanodollarSplit(
  costUsd: number | null
): Pick<
  CostSpanMetrics,
  "estimated_total_cost" | "estimated_input_cost" | "estimated_output_cost"
> {
  if (costUsd === null) {
    return { estimated_total_cost: 0, estimated_input_cost: 0, estimated_output_cost: 0 };
  }
  const total = Math.round(costUsd * NANODOLLARS_PER_USD);
  // The Claude API only reports a single total; we attribute all of it to output
  // and zero the input breakdown so the rendered span still shows a non-zero cost
  // while leaving the input bucket for a future split once one is available.
  return { estimated_total_cost: total, estimated_input_cost: 0, estimated_output_cost: total };
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function readInt32(bytes: Uint8Array): number {
  let result = 0;
  for (let i = 0; i < 4; i++) result = result * 256 + (bytes[i] ?? 0);
  return result;
}

function tagEnv(): string {
  return process.env.NODE_ENV ?? "dev";
}
