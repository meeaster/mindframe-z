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
import {
  jsonArray,
  jsonString,
  jsonStringArray,
  parseJsonObject,
  parseJsonText,
  type JsonObject,
  type JsonValue
} from "../core/json.js";

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

function timestampMs(value: JsonValue | undefined): number | undefined {
  const numeric = numberField(value);
  if (numeric !== undefined) return numeric;
  const string = jsonString(value);
  if (string === undefined) return undefined;
  const parsed = Date.parse(string);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function recordInWindow(record: JsonObject, projectRoot: string, cutoff: number): boolean {
  const cwd = jsonString(record.cwd);
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
  attachment: JsonObject,
  sessionKey: string,
  invokedSkillNames: Set<string>
): void {
  const type = jsonString(attachment.type) ?? "unknown";
  const content = jsonString(attachment.content);
  collector.addActivation("attachment", type, content?.length);
  for (const name of jsonStringArray(attachment.addedNames)) {
    collector.addActivation("attachment", `${type}:${name}`);
  }
  const addedLines = jsonArray(attachment.addedLines);
  const addedLinesString = jsonString(attachment.addedLines);
  if (addedLines) {
    const lines = jsonStringArray(attachment.addedLines);
    collector.addActivationCount(
      "attachment",
      `${type}:lines`,
      lines.length,
      lines.reduce((total, line) => total + line.length, 0)
    );
  } else if (addedLinesString !== undefined) {
    collector.addActivation("attachment", `${type}:lines`, addedLinesString.length);
  }
  const addedBlocks = jsonString(attachment.addedBlocks);
  if (addedBlocks !== undefined) {
    collector.addActivation("attachment", `${type}:blocks`, addedBlocks.length);
  } else if (jsonArray(attachment.addedBlocks)) {
    const blocks = jsonStringArray(attachment.addedBlocks);
    collector.addActivationCount(
      "attachment",
      `${type}:blocks`,
      blocks.length,
      blocks.reduce((total, block) => total + block.length, 0)
    );
  }
  if (type === "invoked_skills") {
    for (const skill of jsonArray(attachment.skills) ?? []) {
      const item = objectField(skill);
      const name = jsonString(item?.name);
      if (!item || name === undefined) continue;
      const itemContent = jsonString(item.content);
      const length = itemContent?.length;
      invokedSkillNames.add(`${sessionKey}\0${name}`);
      collector.addActivation("skill", name, length, jsonString(item.path));
    }
  }
  if (type === "skill_listing") {
    for (const name of jsonStringArray(attachment.names)) {
      collector.addActivation("attachment", `${type}:${name}`);
    }
  }
  if (type === "nested_memory") {
    const source = jsonString(attachment.path) ?? jsonString(attachment.sourcePath);
    if (source) collector.addActivation("instruction", source, content?.length, source);
  }
  if (type === "compact_file_reference") {
    const source = jsonString(attachment.displayPath) ?? jsonString(attachment.path);
    if (source) collector.addActivation("attachment", `${type}:${source}`);
  }
}

function assistantActivations(
  collector: HistoryCollector,
  record: JsonObject,
  mcpNames: string[],
  sessionKey: string,
  skillTools: Map<string, { sessionKey: string; name: string; count: number }>
): void {
  const message = objectField(record.message);
  for (const item of jsonArray(message?.content) ?? []) {
    const block = objectField(item);
    const blockName = jsonString(block?.name);
    if (block?.type === "tool_use" && blockName !== undefined) {
      if (blockName === "Skill") {
        const input = objectField(block.input);
        const skillName = jsonString(input?.skill) ?? jsonString(input?.name) ?? "name unavailable";
        const key = `${sessionKey}\0${skillName}`;
        const existing = skillTools.get(key);
        skillTools.set(key, {
          sessionKey,
          name: skillName,
          count: (existing?.count ?? 0) + 1
        });
      } else {
        activationFromTool(collector, blockName, mcpNames);
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
        let record: JsonObject;
        try {
          record = parseJsonObject(parseJsonText(line) ?? {}) ?? {};
        } catch {
          continue;
        }
        if (!recordInWindow(record, projectRoot, cutoff)) continue;
        const sessionId = jsonString(record.sessionId) ?? file.sessionId;
        const transcriptKey = file.path;
        collector.addSession(
          transcriptKey,
          file.child || record.isSidechain === true,
          jsonString(record.version)
        );
        const type = record.type;
        if (type === "assistant") {
          const message = objectField(record.message);
          if (message?.role !== "assistant") continue;
          const requestId =
            jsonString(record.requestId) ?? jsonString(message.id) ?? jsonString(record.uuid);
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
