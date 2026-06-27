import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { RuntimePaths } from "../core/paths.js";
import type { ResolvedProfile } from "../core/profile.js";
import { readSandboxOperationalSecrets, sandboxSecretsFile } from "./config.js";
import { ensureBedrockProxyImage, ensureBrokerImage } from "./broker-image.js";
import type { SandboxRuntimeInputs, SandboxServiceDefinition } from "./runtime.js";

export function sandboxComposeFile(paths: RuntimePaths, profile: ResolvedProfile): string {
  return path.join(paths.home, ".mindframe-z", "sandbox", profile.name, "compose.yaml");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function renderCompose(services: readonly SandboxServiceDefinition[]): string {
  const lines = ["services:"];
  for (const service of services) {
    lines.push(`  ${service.name}:`, `    image: ${quote(service.image)}`);
    if (service.command.length > 0) {
      lines.push("    command:");
      for (const item of service.command) lines.push(`      - ${quote(item)}`);
    }
    if (Object.keys(service.environment).length > 0) {
      lines.push("    environment:");
      for (const [name, value] of Object.entries(service.environment)) {
        lines.push(`      ${name}: ${quote(value)}`);
      }
    }
    if (service.ports.length > 0) {
      lines.push("    ports:");
      for (const port of service.ports) lines.push(`      - ${quote(port)}`);
    }
    if (service.volumes.length > 0) {
      lines.push("    volumes:");
      for (const volume of service.volumes) lines.push(`      - ${quote(volume)}`);
    }
  }

  const volumes = [
    ...new Set(services.flatMap((service) => service.volumes.map((volume) => volume.split(":")[0])))
  ];
  if (volumes.length > 0) {
    lines.push("volumes:");
    for (const volume of volumes) lines.push(`  ${volume}: {}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function writeSandboxCompose(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  runtime: SandboxRuntimeInputs
): Promise<string> {
  const file = sandboxComposeFile(paths, profile);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderCompose(runtime.services), "utf8");
  return file;
}

export async function ensureSandboxServices(
  paths: RuntimePaths,
  profile: ResolvedProfile,
  runtime: SandboxRuntimeInputs
): Promise<void> {
  await ensureBrokerImage();
  if (runtime.services.some((service) => service.name === "bedrock-sigv4-proxy")) {
    await ensureBedrockProxyImage(paths.root);
  }
  const composeFile = await writeSandboxCompose(paths, profile, runtime);
  await execa(
    "docker",
    [
      "compose",
      "--env-file",
      sandboxSecretsFile(paths),
      "-f",
      composeFile,
      "up",
      "-d",
      ...runtime.services.map((service) => service.name)
    ],
    { env: { ...process.env, ...(await readSandboxOperationalSecrets(paths)) } }
  );
}
