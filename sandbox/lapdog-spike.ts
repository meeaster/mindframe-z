#!/usr/bin/env tsx
// PROTOTYPE v3 — lapdog cost-span spike.
// Question: how to inject cost into lapdog dashboard without the BUN proxy?

import process from "node:process";
import { execa } from "execa";

const LAPDOG_PORT = "8126";

async function main() {
  console.log("=== lapdog cost-span spike v3 ===\n");

  const sessionId = randomHex(16);

  // 1. SessionStart via hooks
  await postHook({ hook_event_name: "SessionStart", session_id: sessionId, model: "claude-sonnet-4-6-20250514" });
  console.log("  SessionStart");

  // 2. PostToolUse with cost in the usage field (try exact Claude API field names)
  await postHook({
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    tool_response: "hello",
    tool_use_id: "tool_001",
    model: "claude-sonnet-4-6-20250514",
    // Try the real Claude API usage field names
    usage: {
      input_tokens: 500,
      output_tokens: 150,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0
    },
    total_cost_usd: 0.0054
  });
  console.log("  PostToolUse (with usage/cost)");

  // 3. SessionEnd
  await postHook({ hook_event_name: "SessionEnd", session_id: sessionId });
  console.log("  SessionEnd");

  // Check spans
  const spans = await (await fetch(`http://localhost:${LAPDOG_PORT}/claude/hooks/spans`)).json() as any;
  console.log("\n[spans]");
  console.log(JSON.stringify(spans, null, 2));

  // Check if metrics populated
  const toolSpan = spans.spans.find((s: any) => s.name === "Bash");
  console.log(`\n  tool span metrics: ${JSON.stringify(toolSpan?.metrics)}`);

  // 4. Try injecting cost via /evp_proxy/v4/api/v2/llmobs/update
  // (update the root span with cost)
  const rootSpan = spans.spans.find((s: any) => s.parent_id === "undefined");
  if (rootSpan) {
    console.log("\n[cost injection attempt via /evp_proxy/v4/api/v2/llmobs/update]");
    const updateBody = {
      span_id: rootSpan.span_id,
      trace_id: rootSpan.trace_id,
      session_id: sessionId,
      ml_app: "claude-code",
      service: "claude-code",
      metrics: {
        input_tokens: 500,
        output_tokens: 150,
        total_tokens: 650,
        estimated_total_cost: 5_400_000
      }
    };
    const res = await fetch(`http://localhost:${LAPDOG_PORT}/evp_proxy/v4/api/v2/llmobs/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updateBody)
    });
    console.log(`  status: ${res.status}`);
    console.log(`  body: ${await res.text()}`);
  }

  // 5. Check if the list now has cost
  console.log("\n[post-update list check]");
  const list = await (await fetch(`http://localhost:${LAPDOG_PORT}/api/v1/logs-analytics/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: "claude-code", from: "now-1h", to: "now", size: 5 })
  })).json() as any;
  for (const event of list.result?.events ?? []) {
    const c = event.event.custom;
    console.log(`  ${c.name}: cost=${c.metrics.estimated_total_cost} tokens=${c.metrics.input_tokens}/${c.metrics.output_tokens}`);
  }

  // 6. Try posting a separate cost span with same session_id
  console.log("\n[separate cost span via /evp_proxy/v4/api/v2/llmobs]");
  const nowNs = Date.now() * 1_000_000;
  const costSpan = {
    trace_id: rootSpan?.trace_id ?? randomHex(32),
    span_id: randomHex(16),
    parent_id: rootSpan?.span_id ?? "0000000000000000",
    session_id: sessionId,
    name: "cost_estimate",
    kind: "llm",
    ml_app: "claude-code",
    service: "claude-code",
    env: "dev",
    start_ns: nowNs,
    duration: 1,
    status: "ok",
    meta: {
      model_name: "claude-sonnet-4-6-20250514",
      model_provider: "anthropic"
    },
    metrics: {
      input_tokens: 500,
      output_tokens: 150,
      total_tokens: 650,
      estimated_total_cost: 5_400_000
    }
  };
  const costRes = await fetch(`http://localhost:${LAPDOG_PORT}/evp_proxy/v4/api/v2/llmobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(costSpan)
  });
  console.log(`  status: ${costRes.status} ${await costRes.text()}`);

  // Re-check
  console.log("\n[post-cost-span list]");
  const list2 = await (await fetch(`http://localhost:${LAPDOG_PORT}/api/v1/logs-analytics/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: "claude-code", from: "now-1h", to: "now", size: 10 })
  })).json() as any;
  console.log(`  hitCount: ${list2.hitCount}`);
  for (const event of list2.result?.events ?? []) {
    const c = event.event.custom;
    console.log(`  ${c.name}: cost=${c.metrics.estimated_total_cost} tokens=${c.metrics.input_tokens}/${c.metrics.output_tokens} kind=${c.kind}`);
  }

  console.log("\n=== spike complete ===");
}

async function postHook(body: Record<string, unknown>): Promise<void> {
  await fetch(`http://localhost:${LAPDOG_PORT}/claude/hooks`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

main().catch((err) => {
  console.error("spike failed:", err);
  process.exit(1);
});
