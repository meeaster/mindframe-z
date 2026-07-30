import { describe, expect, it } from "vitest";
import {
  parseCheckpoint,
  parseContextMap,
  parseOrientation,
  renderCheckpoint,
  renderContextMap,
  renderOrientation
} from "./authoring.js";

const orientation = {
  outcome: "Ship the work runtime.",
  direction: "Use filesystem-first authored context.",
  constraints: ["Keep mutations explicit.", "Never copy authoritative context."],
  questions: ["Which store owns delivery receipts?"],
  next_action: "Run validation."
};

describe("orientation authoring", () => {
  it("round-trips authored prose and bullet lists", () => {
    expect(parseOrientation(renderOrientation(orientation))).toEqual(orientation);
  });

  it("round-trips empty lists through the 'None.' convention", () => {
    const empty = { ...orientation, constraints: [], questions: [] };
    const authored = renderOrientation(empty)
      .replace("<!-- Add Markdown bullets, or leave this section empty. -->", "None.")
      .replace("<!-- Add Markdown bullets, or leave this section empty. -->", "none");
    expect(parseOrientation(authored)).toEqual(empty);
  });

  it("rejects the unedited template, because placeholder comments are not content", () => {
    // renderOrientation() with no argument is the scaffold written at `mfz work
    // create`. Its guidance lives in HTML comments, which the parser strips, so
    // an untouched template must fail validation rather than register as authored.
    expect(() => parseOrientation(renderOrientation())).toThrow(/Outcome must not be empty/);
  });

  it("rejects a dropped section and a list section that is not bullets", () => {
    const missing = renderOrientation(orientation).replace("## Next Action", "## Follow Up");
    expect(() => parseOrientation(missing)).toThrow(/Missing required section: Next Action/);

    const prose = renderOrientation(orientation).replace(
      "- Keep mutations explicit.",
      "Keep mutations explicit."
    );
    expect(() => parseOrientation(prose)).toThrow(/Constraints must contain Markdown bullets/);
  });
});

describe("context map authoring", () => {
  const repositories = [
    { target: "mindframe-z", role: "implementation", status: "active" },
    { target: "personal-knowledge", role: "context", status: "read-only" }
  ];
  const context = [{ target: "threads/index.md", role: "continuity", status: "current" }];

  it("round-trips both pointer tables, including empty ones", () => {
    expect(parseContextMap(renderContextMap({ repositories, context }))).toEqual({
      repositories,
      context
    });
    expect(parseContextMap(renderContextMap())).toEqual({ repositories: [], context: [] });
  });

  it("round-trips a cell containing the column delimiter", () => {
    // The pointer columns are free text, so a target may legitimately contain a
    // pipe. Rendering escapes it and parsing unescapes it; if the two ever drift
    // apart the row silently gains or loses a column instead of failing loudly.
    const piped = [{ target: "repo|fork", role: "implementation", status: "active" }];
    const rendered = renderContextMap({ repositories: piped });
    expect(rendered).toContain("| repo\\|fork |");
    expect(parseContextMap(rendered).repositories).toEqual(piped);
  });

  it("flattens newlines so a multi-line value cannot break the table", () => {
    const rendered = renderContextMap({
      context: [{ target: "notes", role: "why\nit matters", status: "current" }]
    });
    expect(parseContextMap(rendered).context).toEqual([
      { target: "notes", role: "why it matters", status: "current" }
    ]);
  });

  it("rejects a renamed header, a broken separator, and a malformed row", () => {
    const base = renderContextMap({ repositories, context });

    expect(() => parseContextMap(base.replace("| Target | Role | Status |", "| Repo |"))).toThrow(
      /must use the Target, Role, Status Markdown table/
    );
    expect(() => parseContextMap(base.replace("| --- | --- | --- |", "| -- | -- |"))).toThrow(
      /invalid Markdown table separator/
    );
    expect(() =>
      parseContextMap(base.replace("| mindframe-z | implementation | active |", "| only-target |"))
    ).toThrow(/rows require target, role, and status values/);
  });
});

describe("checkpoint authoring", () => {
  const checkpoint = {
    id: "first-cut",
    session: { source: "opencode", id: "ses-abc" },
    boundary: "compaction",
    created_at: "2026-07-30T00:00:00.000Z",
    text: "Decided to keep the authored files hand-editable."
  };

  it("round-trips a checkpoint and binds it to the requested unit", () => {
    expect(parseCheckpoint(renderCheckpoint(checkpoint), "work-runtime")).toEqual({
      ...checkpoint,
      unit: "work-runtime"
    });
  });

  it("splits the source-qualified session on its first colon only", () => {
    // Harness session ids are opaque and may themselves contain colons; only the
    // leading `<source>:` is structural.
    const colonised = { ...checkpoint, session: { source: "claude-code", id: "ses:abc:1" } };
    expect(parseCheckpoint(renderCheckpoint(colonised), "work-runtime").session).toEqual(
      colonised.session
    );
  });

  it("rejects missing, duplicated, unknown, and unparseable frontmatter", () => {
    const rendered = renderCheckpoint(checkpoint);

    expect(() => parseCheckpoint(checkpoint.text, "work-runtime")).toThrow(
      /must start with YAML-style frontmatter/
    );
    expect(() =>
      parseCheckpoint(rendered.replace("boundary: compaction\n", ""), "work-runtime")
    ).toThrow(/Missing checkpoint frontmatter field: boundary/);
    expect(() =>
      parseCheckpoint(
        rendered.replace("id: first-cut", "id: first-cut\nid: first-cut"),
        "work-runtime"
      )
    ).toThrow(/Duplicate checkpoint frontmatter field: id/);
    expect(() =>
      parseCheckpoint(
        rendered.replace("id: first-cut", "id: first-cut\nauthor: someone"),
        "work-runtime"
      )
    ).toThrow(/Unexpected checkpoint frontmatter field: author/);
    expect(() =>
      parseCheckpoint(rendered.replace(checkpoint.created_at, "not-a-timestamp"), "work-runtime")
    ).toThrow(/Invalid checkpoint created_at/);
  });
});
