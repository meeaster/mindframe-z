import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    jsonObjectSchema
  ])
);
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export function parseJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  const result = jsonObjectSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function parseJsonText(value: string): JsonValue | undefined {
  try {
    const result = jsonValueSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  const result = z.string().safeParse(value);
  return result.success ? result.data : undefined;
}

export function jsonNumber(value: JsonValue | undefined): number | undefined {
  const result = z.number().finite().nonnegative().safeParse(value);
  return result.success ? result.data : undefined;
}

export function jsonArray(value: JsonValue | undefined): JsonValue[] | undefined {
  const result = z.array(jsonValueSchema).safeParse(value);
  return result.success ? result.data : undefined;
}

export function jsonStringArray(value: JsonValue | undefined): string[] {
  return (
    jsonArray(value)?.flatMap((entry) => {
      const string = jsonString(entry);
      return string === undefined ? [] : [string];
    }) ?? []
  );
}
