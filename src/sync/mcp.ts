import { readJsonObject, readTomlObject } from "../core/fs-util.js";
import { mcpServerNamesSchema, unmanagedMcpServerNames } from "../core/mcp-full-sync.js";

export interface UnmanagedMcpServers {
  target: "claude-code" | "codex";
  names: string[];
}

export async function unmanagedClaudeMcp(
  localClaudeJsonPath: string,
  snapshotMcpPath: string
): Promise<UnmanagedMcpServers> {
  const local = await readJsonObject(localClaudeJsonPath);
  const snapshot = await readJsonObject(snapshotMcpPath);

  return {
    target: "claude-code",
    names: unmanagedMcpServerNames(
      mcpServerNamesSchema.parse(local.mcpServers),
      Object.keys(snapshot)
    )
  };
}

export async function unmanagedCodexMcp(
  localConfigPath: string,
  snapshotConfigPath: string
): Promise<UnmanagedMcpServers> {
  const local = await readTomlObject(localConfigPath);
  const snapshot = await readTomlObject(snapshotConfigPath);

  return {
    target: "codex",
    names: unmanagedMcpServerNames(
      mcpServerNamesSchema.parse(local.mcp_servers),
      mcpServerNamesSchema.parse(snapshot.mcp_servers)
    )
  };
}

export function unmanagedMcpWarning({ target, names }: UnmanagedMcpServers): string {
  return `Unmanaged ${target} MCP servers: ${names.join(", ")}. The next \`mfz apply\` removes them; add them to catalog/mcp.yml and enable them in a profile to keep them.`;
}
