import { randomBytes } from "node:crypto";
import { encode } from "@msgpack/msgpack";
import type { ThreadHarness } from "../core/manifests.js";

export interface TokenBreakdown {
  nonCachedInput: number;
  cacheReadInput: number;
  cacheWriteInput: number;
  output: number;
}

export interface CostSpanContext {
  readonly model: string;
  readonly modelProvider: string;
  readonly sessionId?: string | undefined;
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

export function buildMetrics(
  breakdown: TokenBreakdown,
  costUsd: number | null
): CostSpanMetrics | null {
  const { nonCachedInput, cacheReadInput, cacheWriteInput, output } = breakdown;
  if (nonCachedInput === 0 && cacheReadInput === 0 && cacheWriteInput === 0 && output === 0) {
    return null;
  }
  const inputTokens = nonCachedInput + cacheReadInput + cacheWriteInput;
  return {
    input_tokens: inputTokens,
    output_tokens: output,
    total_tokens: inputTokens + output,
    non_cached_input_tokens: nonCachedInput,
    cache_read_input_tokens: cacheReadInput,
    cache_write_input_tokens: cacheWriteInput,
    ...nanodollarSplit(costUsd)
  };
}

export function buildCostSpanPayload(
  harness: ThreadHarness,
  breakdown: TokenBreakdown,
  ctx: CostSpanContext
): Uint8Array | null {
  const metrics = buildMetrics(breakdown, ctx.costUsd);
  if (!metrics) return null;

  const startNs = ctx.startTimeMs * 1_000_000;
  const durationNs = Math.max(ctx.durationMs * 1_000_000, 1);
  // lapdog validates span_id/trace_id as msgpack ints; JS numbers are float64 and
  // lose precision past 2^53, so we read 4 bytes big-endian producing a uint32.
  const spanId = readUint32(randomBytes(4));
  const traceId = readUint32(randomBytes(4));
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function readUint32(bytes: Uint8Array): number {
  let result = 0;
  for (let i = 0; i < 4; i++) result = result * 256 + (bytes[i] ?? 0);
  return result;
}

function tagEnv(): string {
  return process.env.NODE_ENV ?? "dev";
}
