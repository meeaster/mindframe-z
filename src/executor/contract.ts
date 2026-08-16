import type { ExecutorAuthenticationMethod } from "../core/manifests.js";
import { executorConnectionNameSchema } from "../core/manifests.js";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../core/json.js";

export type ExecutorJsonValue = JsonValue;
export type ExecutorJsonObject = JsonObject;
export const executorJsonObjectSchema = jsonObjectSchema;

export type ExecutorOwner = "user" | "org";

type ExecutorAuthenticationPart = string | { type: "variable"; name: string };

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

export function encodeExecutorAuthenticationMethod(method: ExecutorAuthenticationMethod) {
  if (method.kind !== "apikey") return { slug: method.slug, kind: method.kind };

  const headers: Record<string, ExecutorAuthenticationPart[]> = {};
  const queryParams: Record<string, ExecutorAuthenticationPart[]> = {};
  for (const placement of method.placements) {
    const parts: ExecutorAuthenticationPart[] = [
      ...(placement.prefix ? [placement.prefix] : []),
      { type: "variable", name: placement.variable }
    ];
    (placement.carrier === "header" ? headers : queryParams)[placement.name] = parts;
  }
  const encoded = {
    slug: method.slug,
    type: "apiKey"
  };
  if (Object.keys(headers).length > 0) Object.assign(encoded, { headers });
  if (Object.keys(queryParams).length > 0) Object.assign(encoded, { queryParams });
  return encoded;
}

export function encodeExecutorAuthenticationMethods(
  methods: readonly ExecutorAuthenticationMethod[]
) {
  return methods.map(encodeExecutorAuthenticationMethod);
}
