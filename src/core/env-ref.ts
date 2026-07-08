const ENV_REF_PATTERN = /^\{env:(.+)\}$/;

/**
 * Canonical parser for the `{env:NAME}` env-reference token used in MCP
 * configuration (see shared/mcp.yml). Returns the referenced variable name when
 * the whole value is a single env reference, or null when it is a literal value.
 */
export function parseEnvRef(value: string): string | null {
  return value.match(ENV_REF_PATTERN)?.[1] ?? null;
}
