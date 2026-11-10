const ENV_REF_PATTERN = /^\{env:(.+)\}$/;
const EMBEDDED_ENV_REF_PATTERN = /\{env:([^}]+)\}/g;

/**
 * Canonical parser for the `{env:NAME}` env-reference token used in MCP
 * configuration (see shared/mcp.yml). Returns the referenced variable name when
 * the whole value is a single env reference, or null when it is a literal value.
 */
export function parseEnvRef(value: string): string | null {
  return value.match(ENV_REF_PATTERN)?.[1] ?? null;
}

/**
 * Replaces every embedded `{env:NAME}` token with its value from `env`, for harnesses that read
 * the value literally. Throws naming the first unset variable so a missing secret fails the
 * render instead of shipping a URL that contains the token.
 */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv, context: string): string {
  return value.replaceAll(EMBEDDED_ENV_REF_PATTERN, (_token, name: string) => {
    const resolved = env[name];

    if (resolved === undefined || resolved === "") {
      throw new Error(`${context} references {env:${name}}, which is not set`);
    }

    return resolved;
  });
}
