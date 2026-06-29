import { describe, expect, it, vi } from "vitest";
import { decode } from "@msgpack/msgpack";
import {
  buildCostSpanPayload,
  buildMetrics,
  emitCostSpan,
  modelProvider,
  type TokenBreakdown
} from "./cost-span.js";

const baseCtx = {
  model: "claude-sonnet-4-6",
  modelProvider: "anthropic",
  startTimeMs: 1_700_000_000_000,
  durationMs: 1234,
  costUsd: 0.0054
};

const zeroBreakdown: TokenBreakdown = {
  nonCachedInput: 0,
  cacheReadInput: 0,
  cacheWriteInput: 0,
  output: 0
};

const claudeBreakdown: TokenBreakdown = {
  nonCachedInput: 500,
  cacheReadInput: 100,
  cacheWriteInput: 50,
  output: 150
};

const opencodeBreakdown: TokenBreakdown = {
  nonCachedInput: 100,
  cacheReadInput: 0,
  cacheWriteInput: 0,
  output: 50
};

describe("modelProvider", () => {
  it("returns anthropic for claude-code regardless of model string", () => {
    expect(modelProvider("claude-code", "claude-opus-4-20250514")).toBe("anthropic");
    expect(modelProvider("claude-code", "any-string")).toBe("anthropic");
  });

  it("returns the provider segment for opencode model strings", () => {
    expect(modelProvider("opencode", "anthropic/claude-sonnet-4-6")).toBe("anthropic");
    expect(modelProvider("opencode", "openai/gpt-5")).toBe("openai");
  });

  it("returns 'unknown' when the opencode model has no slash", () => {
    expect(modelProvider("opencode", "bare-model")).toBe("unknown");
  });
});

describe("buildMetrics", () => {
  it("returns null when all token fields are zero", () => {
    expect(buildMetrics(zeroBreakdown, 0.01)).toBeNull();
  });

  it("keeps cache splits separate and reports summed input_tokens", () => {
    const metrics = buildMetrics(claudeBreakdown, null);
    expect(metrics).toEqual({
      input_tokens: 650,
      output_tokens: 150,
      total_tokens: 800,
      non_cached_input_tokens: 500,
      cache_read_input_tokens: 100,
      cache_write_input_tokens: 50,
      estimated_total_cost: 0,
      estimated_input_cost: 0,
      estimated_output_cost: 0
    });
  });

  it("converts USD cost to integer nanodollars and splits it", () => {
    const metrics = buildMetrics(
      { nonCachedInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 1 },
      0.0054
    );
    expect(metrics?.estimated_total_cost).toBe(5_400_000);
    expect(metrics?.estimated_input_cost).toBe(0);
    expect(metrics?.estimated_output_cost).toBe(5_400_000);
  });

  it("emits zero estimated_*_cost when costUsd is null", () => {
    const metrics = buildMetrics(
      { nonCachedInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 },
      null
    );
    expect(metrics?.estimated_total_cost).toBe(0);
  });

  it("emits a span for opencode breakdowns by treating all input as non-cached", () => {
    const metrics = buildMetrics(opencodeBreakdown, 0.02);
    expect(metrics).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      non_cached_input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_write_input_tokens: 0,
      estimated_total_cost: 20_000_000,
      estimated_input_cost: 0,
      estimated_output_cost: 20_000_000
    });
  });
});

describe("buildCostSpanPayload", () => {
  it("encodes a top-level traces array with one cost span and a msgpack _llmobs envelope", () => {
    const payload = buildCostSpanPayload("claude-code", claudeBreakdown, {
      ...baseCtx,
      sessionId: "sess-abc"
    });
    expect(payload).toBeInstanceOf(Uint8Array);
    const bytes = payload as Uint8Array;

    const traces = decode(bytes) as Array<Array<Record<string, unknown>>>;
    expect(traces).toHaveLength(1);
    const spans = traces[0]!;
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("cost-span");
    expect(span.service).toBe("claude-code");
    expect(span.resource).toBe("dispatch");
    expect(span.error).toBe(0);
    expect(span.start).toBe(1_700_000_000_000_000_000);
    expect(span.duration).toBe(1_234_000_000);

    const struct = span.meta_struct as Record<string, Uint8Array>;
    const envelope = decode(struct._llmobs!) as Record<string, unknown>;
    expect(envelope.name).toBe("claude-code-request");
    expect(envelope.session_id).toBe("sess-abc");
    expect(envelope.parent_id).toBe("undefined");
    expect((envelope.meta as Record<string, unknown>).model_name).toBe("claude-sonnet-4-6");
    expect((envelope.meta as Record<string, unknown>).model_provider).toBe("anthropic");
    const envMetrics = envelope.metrics as Record<string, number>;
    expect(envMetrics.estimated_total_cost).toBe(5_400_000);
    expect(envMetrics.cache_read_input_tokens).toBe(100);
  });

  it("returns null when the breakdown is zero", () => {
    expect(buildCostSpanPayload("claude-code", zeroBreakdown, baseCtx)).toBeNull();
    expect(buildCostSpanPayload("opencode", zeroBreakdown, baseCtx)).toBeNull();
  });

  it("clamps zero/negative durations to one nanosecond to satisfy lapdog's span shape", () => {
    const payload = buildCostSpanPayload(
      "claude-code",
      { nonCachedInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 1 },
      { ...baseCtx, durationMs: 0 }
    );
    const bytes = payload as Uint8Array;
    const traces = decode(bytes) as Array<Array<Record<string, unknown>>>;
    const span = traces[0]![0]!;
    expect(span.duration).toBe(1);
  });

  it("emits distinct span ids across calls", () => {
    const ids = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const payload = buildCostSpanPayload(
        "claude-code",
        { nonCachedInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 1 },
        { ...baseCtx, startTimeMs: 1_700_000_000_000 + i }
      );
      const bytes = payload as Uint8Array;
      const traces = decode(bytes) as Array<Array<Record<string, unknown>>>;
      ids.add(traces[0]![0]!.span_id as number);
    }
    expect(ids.size).toBe(10);
  });
});

describe("emitCostSpan", () => {
  it("POSTs the msgpack payload to /v0.4/traces with the required headers", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([String(input), init ?? {}]);
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = buildCostSpanPayload(
      "claude-code",
      { nonCachedInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 1 },
      baseCtx
    );
    await emitCostSpan("http://localhost:8126", payload as Uint8Array);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe("http://localhost:8126/v0.4/traces");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/msgpack",
      "X-Datadog-Trace-Count": "1",
      "Datadog-Meta-Tracer-Version": expect.stringMatching(/^mindframe-z-\d+\.\d+\.\d+$/)
    });
    expect(init.body).toBeInstanceOf(Uint8Array);

    vi.unstubAllGlobals();
  });

  it("swallows fetch errors (fail-open) and never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    const payload = buildCostSpanPayload(
      "claude-code",
      { nonCachedInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 1 },
      baseCtx
    );
    await expect(
      emitCostSpan("http://localhost:8126", payload as Uint8Array)
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
