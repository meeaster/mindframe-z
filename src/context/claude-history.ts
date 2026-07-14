import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline/promises";
import type { RuntimePaths } from "../core/paths.js";
import {
  HistoryCollector,
  addClaudeUsage,
  numberField,
  objectField,
  unavailableHistory
} from "./history.js";
import { isPathWithin } from "./repository.js";
import type { ContextHistory } from "./model.js";

interface TranscriptFile {
  path: string;
  sessionId: string;
  child: boolean;
}

async function transcriptFiles(paths: RuntimePaths): Promise<TranscriptFile[] | undefined> {
  const projectsDir = path.join(paths.claudeDir, "projects");
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return undefined;
  }
  const files: TranscriptFile[] = [];
  for (const project of projects) {
    const projectDir = path.join(projectsDir, project);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({
          path: path.join(projectDir, entry.name),
          sessionId: entry.name.slice(0, -".jsonl".length),
          child: false
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const subagentsDir = path.join(projectDir, entry.name, "subagents");
      let subagents: string[];
      try {
        subagents = await readdir(subagentsDir);
      } catch {
        continue;
      }
      for (const subagent of subagents) {
        if (!subagent.endsWith(".jsonl")) continue;
        files.push({
          path: path.join(subagentsDir, subagent),
          sessionId: entry.name,
          child: true
        });
      }
    }
  }
  return files;
}

function timestampMs(value: unknown): number | undefined {
  const numeric = numberField(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function recordInWindow(
  record: Record<string, unknown>,
  projectRoot: string,
  cutoff: number
): boolean {
  const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
  const timestamp = timestampMs(record.timestamp);
  return (
    cwd !== undefined &&
    timestamp !== undefined &&
    timestamp >= cutoff &&
    isPathWithin(projectRoot, cwd)
  );
}

function activationFromTool(collector: HistoryCollector, name: string, mcpNames: string[]): void {
  const server = mcpNames.find(
    (candidate) => name.startsWith(`mcp__${candidate}__`) || name.startsWith(`${candidate}__`)
  );
  collector.addActivation(server ? "mcp" : "tool", server ?? name);
}

function attachmentActivation(
  collector: HistoryCollector,
  attachment: Record<string, unknown>,
  sessionKey: string,
  invokedSkillNames: Set<string>
): void {
  const type = typeof attachment.type === "string" ? attachment.type : "unknown";
  const content = typeof attachment.content === "string" ? attachment.content : undefined;
  collector.addActivation("attachment", type, content?.length);
  if (Array.isArray(attachment.addedNames)) {
    for (const name of attachment.addedNames) {
      if (typeof name === "string") collector.addActivation("attachment", `${type}:${name}`);
    }
  }
  if (Array.isArray(attachment.addedLines)) {
    const lines = attachment.addedLines.filter((line): line is string => typeof line === "string");
    collector.addActivationCount(
      "attachment",
      `${type}:lines`,
      lines.length,
      lines.reduce((total, line) => total + line.length, 0)
    );
  } else if (typeof attachment.addedLines === "string") {
    collector.addActivation("attachment", `${type}:lines`, attachment.addedLines.length);
  }
  if (typeof attachment.addedBlocks === "string") {
    collector.addActivation("attachment", `${type}:blocks`, attachment.addedBlocks.length);
  } else if (Array.isArray(attachment.addedBlocks)) {
    const blocks = attachment.addedBlocks.filter(
      (block): block is string => typeof block === "string"
    );
    collector.addActivationCount(
      "attachment",
      `${type}:blocks`,
      blocks.length,
      blocks.reduce((total, block) => total + block.length, 0)
    );
  }
  if (type === "invoked_skills" && Array.isArray(attachment.skills)) {
    for (const skill of attachment.skills) {
      const item = objectField(skill);
      if (!item || typeof item.name !== "string") continue;
      const length = typeof item.content === "string" ? item.content.length : undefined;
      invokedSkillNames.add(`${sessionKey}\0${item.name}`);
      collector.addActivation(
        "skill",
        item.name,
        length,
        typeof item.path === "string" ? item.path : undefined
      );
    }
  }
  if (type === "skill_listing" && Array.isArray(attachment.names)) {
    for (const name of attachment.names) {
      if (typeof name === "string") collector.addActivation("attachment", `${type}:${name}`);
    }
  }
  if (type === "nested_memory") {
    const source =
      typeof attachment.path === "string"
        ? attachment.path
        : typeof attachment.sourcePath === "string"
          ? attachment.sourcePath
          : undefined;
    if (source) collector.addActivation("instruction", source, content?.length, source);
  }
  if (type === "compact_file_reference") {
    const source =
      typeof attachment.displayPath === "string"
        ? attachment.displayPath
        : typeof attachment.path === "string"
          ? attachment.path
          : undefined;
    if (source) collector.addActivation("attachment", `${type}:${source}`);
  }
}

function assistantActivations(
  collector: HistoryCollector,
  record: Record<string, unknown>,
  mcpNames: string[],
  sessionKey: string,
  skillTools: Map<string, { sessionKey: string; name: string; count: number }>
): void {
  const message = objectField(record.message);
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const item of content) {
    const block = objectField(item);
    if (block?.type === "tool_use" && typeof block.name === "string") {
      if (block.name === "Skill") {
        const input = objectField(block.input);
        const skillName =
          typeof input?.skill === "string"
            ? input.skill
            : typeof input?.name === "string"
              ? input.name
              : "name unavailable";
        const key = `${sessionKey}\0${skillName}`;
        const existing = skillTools.get(key);
        skillTools.set(key, {
          sessionKey,
          name: skillName,
          count: (existing?.count ?? 0) + 1
        });
      } else {
        activationFromTool(collector, block.name, mcpNames);
      }
    }
  }
}

export async function readClaudeHistory(
  paths: RuntimePaths,
  mcpNames: string[],
  projectRoot: string,
  windowDays: number
): Promise<ContextHistory> {
  const files = await transcriptFiles(paths);
  if (!files) return unavailableHistory(windowDays, "Claude projects directory not found");

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const collector = new HistoryCollector();
  const invokedSkillNames = new Set<string>();
  const skillTools = new Map<string, { sessionKey: string; name: string; count: number }>();
  const seenAssistantRequests = new Set<string>();
  for (const file of files) {
    let input;
    try {
      input = createReadStream(file.path, { encoding: "utf8" });
    } catch {
      continue;
    }
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record: Record<string, unknown>;
        try {
          record = objectField(JSON.parse(line)) ?? {};
        } catch {
          continue;
        }
        if (!recordInWindow(record, projectRoot, cutoff)) continue;
        const sessionId = typeof record.sessionId === "string" ? record.sessionId : file.sessionId;
        const transcriptKey = file.path;
        collector.addSession(
          transcriptKey,
          file.child || record.isSidechain === true,
          typeof record.version === "string" ? record.version : undefined
        );
        const type = record.type;
        if (type === "assistant") {
          const message = objectField(record.message);
          if (message?.role !== "assistant") continue;
          const requestId =
            typeof record.requestId === "string"
              ? record.requestId
              : typeof message.id === "string"
                ? message.id
                : typeof record.uuid === "string"
                  ? record.uuid
                  : undefined;
          if (!requestId) continue;
          const requestKey = `${sessionId}:${requestId}`;
          collector.addRequest(requestKey, addClaudeUsage(message.usage));
          if (!seenAssistantRequests.has(requestKey)) {
            seenAssistantRequests.add(requestKey);
            assistantActivations(collector, record, mcpNames, transcriptKey, skillTools);
          }
          continue;
        }
        if (type === "attachment") {
          const attachment = objectField(record.attachment);
          if (attachment)
            attachmentActivation(collector, attachment, transcriptKey, invokedSkillNames);
          continue;
        }
        if (type === "system" && record.subtype === "compact_boundary") {
          collector.addCompaction();
        }
      }
    } catch {
      // A disappearing or malformed transcript should not fail other files.
    } finally {
      lines.close();
    }
  }
  for (const event of skillTools.values()) {
    if (invokedSkillNames.has(`${event.sessionKey}\0${event.name}`)) continue;
    for (let index = 0; index < event.count; index += 1) {
      collector.addActivation("skill", event.name);
    }
  }
  return collector.finish(windowDays);
}
