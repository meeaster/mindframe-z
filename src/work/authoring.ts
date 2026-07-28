import { createHash } from "node:crypto";
import {
  sourceQualifiedSessionSchema,
  workCheckpointSchema,
  type WorkCheckpoint,
  type WorkContextPointer,
  type WorkOrientation
} from "./schema.js";

export const orientationFileName = "orientation.md";
export const contextMapFileName = "context-map.md";
export const checkpointsDirectoryName = "checkpoints";

const orientationSections = [
  "Outcome",
  "Current Direction",
  "Constraints",
  "Open Questions",
  "Next Action"
] as const;

function markdownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...content.matchAll(/^##\s+(.+?)\s*$/gm)];
  for (const [index, match] of matches.entries()) {
    const title = match[1];
    if (!title || match.index === undefined) continue;
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    sections.set(
      title,
      content
        .slice(start, end)
        .replace(/<!--[^]*?-->/g, "")
        .trim()
    );
  }
  return sections;
}

function requiredSection(sections: Map<string, string>, title: string): string {
  const value = sections.get(title);
  if (value === undefined) throw new Error(`Missing required section: ${title}`);
  return value;
}

function requiredProse(sections: Map<string, string>, title: string): string {
  const value = requiredSection(sections, title);
  if (!value) throw new Error(`${title} must not be empty`);
  return value;
}

function listSection(sections: Map<string, string>, title: string): string[] {
  const value = requiredSection(sections, title);
  if (!value || /^none\.?$/i.test(value)) return [];
  const lines = value.split("\n").filter((line) => line.trim());
  const items = lines.map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]);
  if (items.some((item) => !item))
    throw new Error(`${title} must contain Markdown bullets or be empty`);
  return items as string[];
}

export function hashAuthoredFile(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function renderOrientation(orientation?: Omit<WorkOrientation, "revision">): string {
  const constraints = orientation?.constraints.map((item) => `- ${item}`).join("\n") ?? "";
  const questions = orientation?.questions.map((item) => `- ${item}`).join("\n") ?? "";
  return `# Orientation

## Outcome

${orientation?.outcome || "<!-- Describe the outcome this work unit pursues. -->"}

## Current Direction

${orientation?.direction || "<!-- Describe the currently accepted direction. -->"}

## Constraints

${constraints || "<!-- Add Markdown bullets, or leave this section empty. -->"}

## Open Questions

${questions || "<!-- Add Markdown bullets, or leave this section empty. -->"}

## Next Action

${orientation?.next_action || "<!-- Describe the next useful action. -->"}
`;
}

export function parseOrientation(content: string): Omit<WorkOrientation, "revision"> {
  const sections = markdownSections(content);
  for (const title of orientationSections) requiredSection(sections, title);
  return {
    outcome: requiredProse(sections, "Outcome"),
    direction: requiredProse(sections, "Current Direction"),
    constraints: listSection(sections, "Constraints"),
    questions: listSection(sections, "Open Questions"),
    next_action: requiredProse(sections, "Next Action")
  };
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderTable(pointers: readonly WorkContextPointer[]): string {
  return [
    "| Target | Role | Status |",
    "| --- | --- | --- |",
    ...pointers.map(
      ({ target, role, status }) =>
        `| ${escapeCell(target)} | ${escapeCell(role)} | ${escapeCell(status)} |`
    )
  ].join("\n");
}

export function renderContextMap(input?: {
  repositories?: readonly WorkContextPointer[];
  context?: readonly WorkContextPointer[];
}): string {
  return `# Context Map

Pointers route agents to authoritative context without copying it into the work unit.

## Repositories

${renderTable(input?.repositories ?? [])}

## Context

${renderTable(input?.context ?? [])}
`;
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line.slice(1, -1)) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(sections: Map<string, string>, title: string): WorkContextPointer[] {
  const lines = requiredSection(sections, title)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || lines[0]?.toLowerCase() !== "| target | role | status |") {
    throw new Error(`${title} must use the Target, Role, Status Markdown table`);
  }
  if (!/^\|\s*:?-+\s*\|\s*:?-+\s*\|\s*:?-+\s*\|$/.test(lines[1] ?? "")) {
    throw new Error(`${title} has an invalid Markdown table separator`);
  }
  return lines.slice(2).map((line) => {
    if (!line.startsWith("|") || !line.endsWith("|")) {
      throw new Error(`${title} contains an invalid Markdown table row`);
    }
    const [target, role, status, ...extra] = splitTableRow(line);
    if (!target || !role || !status || extra.length > 0) {
      throw new Error(`${title} rows require target, role, and status values`);
    }
    return { target, role, status };
  });
}

export function parseContextMap(content: string): {
  repositories: WorkContextPointer[];
  context: WorkContextPointer[];
} {
  const sections = markdownSections(content);
  return {
    repositories: parseTable(sections, "Repositories"),
    context: parseTable(sections, "Context")
  };
}

export function renderCheckpoint(checkpoint: Omit<WorkCheckpoint, "unit">): string {
  return `---
id: ${checkpoint.id}
session: ${checkpoint.session.source}:${checkpoint.session.id}
boundary: ${checkpoint.boundary}
created_at: ${checkpoint.created_at}
---

${checkpoint.text.trim()}
`;
}

export function parseCheckpoint(content: string, unit: string): WorkCheckpoint {
  const match = content.match(/^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)([^]*)$/);
  if (!match) throw new Error("Checkpoint must start with YAML-style frontmatter");
  const values = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = line.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (!field?.[1] || !field[2]) throw new Error(`Invalid checkpoint frontmatter line: ${line}`);
    if (!["id", "session", "boundary", "created_at"].includes(field[1])) {
      throw new Error(`Unexpected checkpoint frontmatter field: ${field[1]}`);
    }
    if (values.has(field[1]))
      throw new Error(`Duplicate checkpoint frontmatter field: ${field[1]}`);
    values.set(field[1], field[2]);
  }
  for (const field of ["id", "session", "boundary", "created_at"] as const) {
    if (!values.has(field)) throw new Error(`Missing checkpoint frontmatter field: ${field}`);
  }
  const sessionValue = values.get("session")!;
  const separator = sessionValue.indexOf(":");
  if (separator <= 0 || separator === sessionValue.length - 1) {
    throw new Error(`Invalid source-qualified session: ${sessionValue}`);
  }
  const createdAt = values.get("created_at")!;
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new Error(`Invalid checkpoint created_at: ${createdAt}`);
  return workCheckpointSchema.parse({
    id: values.get("id"),
    unit,
    session: sourceQualifiedSessionSchema.parse({
      source: sessionValue.slice(0, separator),
      id: sessionValue.slice(separator + 1)
    }),
    boundary: values.get("boundary"),
    created_at: createdAt,
    text: (match[2] ?? "").trim()
  });
}
