import { Buffer } from "node:buffer";
import type { ContextContributor, TextMeasurement } from "./model.js";

export function measureText(text: string): TextMeasurement {
  const characters = text.length;
  return {
    characters,
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: Math.max(0, Math.round(characters / 4))
  };
}

export function measuredContributor(
  contributor: Omit<ContextContributor, "characters" | "bytes" | "estimatedTokens" | "measurement">,
  text: string
): ContextContributor {
  const measurement = measureText(text);
  return {
    ...contributor,
    ...measurement,
    measurement: "estimated-tokens"
  };
}

export function unknownContributor(
  contributor: Omit<ContextContributor, "measurement">
): ContextContributor {
  return { ...contributor, measurement: "unknown" };
}
