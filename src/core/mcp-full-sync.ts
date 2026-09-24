import { z } from "zod";

/**
 * Harness user-scope MCP tables are fully owned by the rendered profile: apply
 * replaces them, so any server absent from the rendered set is removed.
 */
export const mcpServerNamesSchema = z
  .looseObject({})
  .catch({})
  .transform((table) => Object.keys(table));

export function unmanagedMcpServerNames(
  existing: Iterable<string>,
  managed: Iterable<string>
): string[] {
  const managedNames = new Set(managed);

  return [...existing].filter((name) => !managedNames.has(name)).sort();
}

export function mcpRemovalDetail(removed: readonly string[]): string {
  return `removes unmanaged MCP servers: ${removed.join(", ")}`;
}
