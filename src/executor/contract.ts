import type { ExecutorAuthenticationMethod } from "../core/manifests.js";
import { executorConnectionNameSchema } from "../core/manifests.js";

export type ExecutorOwner = "user" | "org";

export function executorConnectionAddress(
  owner: ExecutorOwner,
  integration: string,
  name: string
): string {
  return `tools.${integration}.${owner}.${name}`;
}

export function isExecutorConnectionIdentifier(value: string): boolean {
  return executorConnectionNameSchema.safeParse(value).success;
}

export function assertExecutorConnectionIdentifier(name: string, context = "connection"): void {
  if (!isExecutorConnectionIdentifier(name)) {
    throw new Error(
      `Executor ${context} ${name} must match ^[a-z][a-z0-9_]*$ so it remains lowercase and address-safe`
    );
  }
}

export function encodeExecutorAuthenticationMethod(
  method: ExecutorAuthenticationMethod
): Record<string, unknown> {
  if (method.kind !== "apikey") return { slug: method.slug, kind: method.kind };

  const headers: Record<string, unknown> = {};
  const queryParams: Record<string, unknown> = {};
  for (const placement of method.placements) {
    const parts = [
      ...(placement.prefix ? [placement.prefix] : []),
      { type: "variable", name: placement.variable }
    ];
    (placement.carrier === "header" ? headers : queryParams)[placement.name] = parts;
  }
  return {
    slug: method.slug,
    type: "apiKey",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {})
  };
}

export function encodeExecutorAuthenticationMethods(
  methods: readonly ExecutorAuthenticationMethod[]
): Record<string, unknown>[] {
  return methods.map(encodeExecutorAuthenticationMethod);
}
