import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { RuntimePaths } from "../core/paths.js";

export const lapdogImageRef = "ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:latest";
export const lapdogContainerName = "lapdog";
export const lapdogNetworkName = "mfz-net";
export const lapdogPort = 8126;
export const lapdogWebUiPort = 8080;
export const lapdogSnapshotDirInContainer = "/snapshots";

export function lapdogUrl(): string {
  return `http://localhost:${lapdogPort}`;
}

export function lapdogDashboardUrl(): string {
  return `http://localhost:${lapdogWebUiPort}`;
}

export function lapdogContainerUrl(): string {
  return `http://${lapdogContainerName}:${lapdogPort}`;
}

export function lapdogSnapshotsPath(paths: RuntimePaths): string {
  return path.join(paths.home, ".mindframe-z", "lapdog", "snapshots");
}

export async function ensureLapdogNetwork(): Promise<"created" | "exists"> {
  try {
    await execa("docker", ["network", "inspect", lapdogNetworkName]);
    return "exists";
  } catch {
    await execa("docker", ["network", "create", lapdogNetworkName]);
    return "created";
  }
}

interface LapdogContainerInspect {
  State?: { Running?: boolean };
  Config?: { Image?: string };
  NetworkSettings?: { Networks?: Record<string, unknown> };
}

async function inspectLapdogContainer(): Promise<LapdogContainerInspect | undefined> {
  try {
    const result = await execa("docker", [
      "inspect",
      lapdogContainerName,
      "--format",
      "{{json .}}"
    ]);
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as LapdogContainerInspect;
  } catch {
    return undefined;
  }
}

async function isLapdogContainerUsable(): Promise<boolean> {
  const info = await inspectLapdogContainer();
  if (!info) return false;
  if (info.State?.Running !== true) return false;
  if (info.Config?.Image !== lapdogImageRef) return false;
  const networks = info.NetworkSettings?.Networks;
  if (!networks || !(lapdogNetworkName in networks)) return false;
  return true;
}

async function removeLapdogContainer(): Promise<void> {
  await execa("docker", ["rm", "--force", lapdogContainerName], { reject: false });
}

export async function startLapdogContainer(
  paths: RuntimePaths
): Promise<"started" | "already_running"> {
  await ensureLapdogNetwork();
  const snapshotsDir = lapdogSnapshotsPath(paths);
  await mkdir(snapshotsDir, { recursive: true });

  if (await isLapdogContainerUsable()) {
    return "already_running";
  }
  await removeLapdogContainer();

  await execa("docker", [
    "run",
    "--rm",
    "--detach",
    "--name",
    lapdogContainerName,
    "--network",
    lapdogNetworkName,
    "--publish",
    `${lapdogPort}:${lapdogPort}`,
    "--publish",
    `${lapdogWebUiPort}:${lapdogWebUiPort}`,
    "--volume",
    `${snapshotsDir}:${lapdogSnapshotDirInContainer}`,
    lapdogImageRef,
    "ddapm-test-agent",
    "--lapdog-mode",
    "--disable-llmobs-data-forwarding",
    `--web-ui-port=${lapdogWebUiPort}`
  ]);
  return "started";
}

export async function stopLapdogContainer(): Promise<void> {
  await removeLapdogContainer();
  await execa("docker", ["network", "rm", lapdogNetworkName], { reject: false });
}

export interface LapdogStatus {
  reachable: boolean;
  dashboardUrl: string;
  containerUrl: string;
}

export async function lapdogStatus(options?: { url?: string }): Promise<LapdogStatus> {
  return {
    reachable: await isLapdogReachable(options),
    dashboardUrl: lapdogDashboardUrl(),
    containerUrl: lapdogContainerUrl()
  };
}

export async function isLapdogReachable(options?: {
  url?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const url = options?.url ?? lapdogUrl();
  const timeoutMs = options?.timeoutMs ?? 2000;
  try {
    const response = await fetch(`${url}/info`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForLapdog(options?: {
  attempts?: number;
  intervalMs?: number;
  url?: string;
}): Promise<boolean> {
  const attempts = options?.attempts ?? 30;
  const intervalMs = options?.intervalMs ?? 1000;
  const probeOptions = options?.url !== undefined ? { url: options.url } : {};
  for (let i = 1; i <= attempts; i++) {
    if (await isLapdogReachable(probeOptions)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
