import { describe, expect, it } from "vitest";
import { renderEventLog } from "./log.js";

const sessionA = `---
title: "Session A"
gaps: "## Decisions in frontmatter must not be parsed"
---

# Session aaa

## Decisions

- [2026-06-25 09:00] **Pick Postgres** over MySQL — the team already runs it. (aaa · turn 3)

## Learnings

- [2026-06-25 11:30] The MCP exposes no billing endpoint; derive cost from the metrics API. (aaa · turn 7)

## Intent & Vision

- [2026-06-25 09:00] "We need per-customer attribution." (aaa · turn 1)

## Sources

- Datadog rate card PDF.
`;

const sessionB = `# Session bbb

## Open Questions

- [2026-06-25 10:15] Do negotiated rates cover the new SKU, or is it list-priced? (bbb · part_01)

## Mistakes Fixed

- [2026-06-25 12:00] Dispatched on Opus first; corrected to Haiku for cost. (bbb · part_09)
`;

describe("renderEventLog", () => {
  it("merges event buckets across sessions into one strictly timestamp-ordered stream", () => {
    const log = renderEventLog([sessionA, sessionB]);
    expect(log.split("\n")).toEqual([
      "- [2026-06-25 09:00] decision (aaa · turn 3): Pick Postgres over MySQL — the team already runs it.",
      "- [2026-06-25 10:15] open_question (bbb · part_01): Do negotiated rates cover the new SKU, or is it list-priced?",
      "- [2026-06-25 11:30] learning (aaa · turn 7): The MCP exposes no billing endpoint; derive cost from the metrics API.",
      "- [2026-06-25 12:00] mistake_fixed (bbb · part_09): Dispatched on Opus first; corrected to Haiku for cost."
    ]);
  });

  it("excludes state buckets and frontmatter from the log", () => {
    const log = renderEventLog([sessionA]);
    expect(log).not.toContain("per-customer attribution");
    expect(log).not.toContain("rate card PDF");
    expect(log).not.toContain("frontmatter");
  });

  it("strips bold markers and keeps the atomic headline sentence", () => {
    const log = renderEventLog([
      `## Decisions\n\n- [2026-01-01 00:00] **Adopt X** for speed. It also reads cleaner. (z · turn 1)\n`
    ]);
    expect(log).toBe("- [2026-01-01 00:00] decision (z · turn 1): Adopt X for speed.");
  });

  it("skips bullets without a resolvable citation", () => {
    const log = renderEventLog([
      `## Decisions\n\n- [2026-01-01 00:00] A decision with no citation at all.\n`
    ]);
    expect(log).toBe("");
  });
});
