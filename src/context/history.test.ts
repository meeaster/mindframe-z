import { describe, expect, it } from "vitest";
import { addClaudeUsage, addOpenCodeUsage, HistoryCollector } from "./history.js";

describe("context history accounting", () => {
  it("treats omitted cache fields as zero and explicit zero as usage-bearing", () => {
    expect(addOpenCodeUsage({ input: 4, output: 2 })).toEqual({ input: 4, output: 2 });
    expect(addClaudeUsage({ input_tokens: 0, output_tokens: 1 })).toEqual({
      input: 0,
      output: 1
    });
  });

  it("keeps output-only telemetry without using it as a prompt denominator", () => {
    const collector = new HistoryCollector();
    collector.addSession("session", false);
    collector.addRequest("missing-prompt", { output: 9 });
    collector.addRequest("zero-input", { input: 0, output: 2 });
    collector.addRequest("cached", { cacheRead: 6 });

    expect(collector.finish(7)).toMatchObject({
      modelRequests: 3,
      usageBearingRequests: 2,
      promptInputTokensWindowTotal: 6,
      maxPromptInputTokens: 6,
      outputTokens: 11
    });
  });

  it("deduplicates logical requests while filling missing fields from duplicate records", () => {
    const collector = new HistoryCollector();
    collector.addRequest("request", { input: 4 });
    collector.addRequest("request", { cacheRead: 8, output: 3 });

    expect(collector.finish(1)).toMatchObject({
      modelRequests: 1,
      usageBearingRequests: 1,
      promptInputTokensWindowTotal: 12,
      outputTokens: 3
    });
  });

  it("keeps equal traffic totals distinct from request distributions", () => {
    const oneRequest = new HistoryCollector();
    oneRequest.addRequest("one", { input: 10 });
    const twoRequests = new HistoryCollector();
    twoRequests.addRequest("first", { input: 5 });
    twoRequests.addRequest("second", { input: 5 });

    expect(oneRequest.finish(1)).toMatchObject({
      promptInputTokensWindowTotal: 10,
      usageBearingRequests: 1,
      maxPromptInputTokens: 10
    });
    expect(twoRequests.finish(1)).toMatchObject({
      promptInputTokensWindowTotal: 10,
      usageBearingRequests: 2,
      maxPromptInputTokens: 5
    });
  });
});
