import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimePaths } from "../core/paths.js";
import { makeTempDir } from "../../tests/integration/support.js";
import {
  ensureLapdogNetwork,
  isLapdogReachable,
  lapdogContainerName,
  lapdogContainerUrl,
  lapdogDashboardUrl,
  lapdogImageRef,
  lapdogNetworkName,
  lapdogPort,
  lapdogSnapshotsPath,
  lapdogUrl,
  lapdogWebUiPort,
  startLapdogContainer,
  stopLapdogContainer,
  waitForLapdog
} from "./lapdog.js";

const oldPath = process.env.PATH;
const oldStateDir = process.env.FAKE_DOCKER_STATE_DIR;

afterEach(() => {
  process.env.PATH = oldPath;
  if (oldStateDir === undefined) delete process.env.FAKE_DOCKER_STATE_DIR;
  else process.env.FAKE_DOCKER_STATE_DIR = oldStateDir;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function writeFakeDocker(home: string, _logFile: string): Promise<string> {
  const binDir = path.join(home, "bin");
  const stateDir = path.join(home, "fake-docker-state");
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const docker = path.join(binDir, "docker");
  const lines = [
    "#!/usr/bin/env sh",
    "STATE=${FAKE_DOCKER_STATE_DIR:?FAKE_DOCKER_STATE_DIR not set}",
    'log() { printf \'%s\\n\' "$*" >> "$STATE/docker.log"; }',
    'log "$*"',
    'if [ "$1" = network ] && [ "$2" = inspect ] && [ "$3" = mfz-net ]; then',
    '  [ -f "$STATE/network-exists" ] && exit 0 || exit 1',
    "fi",
    'if [ "$1" = network ] && [ "$2" = create ] && [ "$3" = mfz-net ]; then',
    '  touch "$STATE/network-exists"; exit 0',
    "fi",
    'if [ "$1" = inspect ] && [ "$2" = lapdog ]; then',
    '  [ -f "$STATE/container-exists" ] && exit 0 || exit 1',
    "fi",
    'if [ "$1" = run ]; then',
    "  shift",
    '  while [ "$1" != --name ] && [ $# -gt 0 ]; do shift; done',
    "  shift",
    '  touch "$STATE/container-exists"; exit 0',
    "fi",
    'if [ "$1" = rm ]; then',
    '  rm -f "$STATE/container-exists"; exit 0',
    "fi",
    'if [ "$1" = network ] && [ "$2" = rm ]; then',
    '  rm -f "$STATE/network-exists"; exit 0',
    "fi",
    "exit 0"
  ];
  await writeFile(docker, lines.join("\n") + "\n", "utf8");
  await chmod(docker, 0o755);
  process.env.FAKE_DOCKER_STATE_DIR = stateDir;
  // Pre-create the log file so the first test can read it without racing the docker invocation.
  await writeFile(path.join(stateDir, "docker.log"), "", "utf8");
  return stateDir;
}

async function readFakeLog(stateDir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(stateDir, "docker.log"), "utf8");
}

async function withFakeDocker(
  body: (paths: ReturnType<typeof createRuntimePaths>, stateDir: string) => Promise<void>
): Promise<void> {
  const home = await makeTempDir();
  const root = await makeTempDir();
  const stateDir = await writeFakeDocker(home, "");
  process.env.PATH = `${path.join(home, "bin")}:${oldPath ?? ""}`;
  const paths = createRuntimePaths({ root, home });
  await body(paths, stateDir);
}

describe("lapdog module constants", () => {
  it("exposes the canonical image, ports, and network names", () => {
    expect(lapdogImageRef).toBe("ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:latest");
    expect(lapdogContainerName).toBe("lapdog");
    expect(lapdogNetworkName).toBe("mfz-net");
    expect(lapdogPort).toBe(8126);
    expect(lapdogWebUiPort).toBe(8080);
    expect(lapdogUrl()).toBe("http://localhost:8126");
    expect(lapdogDashboardUrl()).toBe("http://localhost:8080");
    expect(lapdogContainerUrl()).toBe("http://lapdog:8126");
  });

  it("places snapshots under ~/.mindframe-z/lapdog/snapshots", () => {
    const paths = createRuntimePaths({ root: "/repo", home: "/home/x" });
    expect(lapdogSnapshotsPath(paths)).toBe("/home/x/.mindframe-z/lapdog/snapshots");
  });
});

describe("ensureLapdogNetwork", () => {
  it("returns 'exists' on the second call without re-creating the network", async () => {
    await withFakeDocker(async () => {
      await expect(ensureLapdogNetwork()).resolves.toBe("created");
      await expect(ensureLapdogNetwork()).resolves.toBe("exists");
    });
  });
});

describe("startLapdogContainer", () => {
  it("creates the network and the container on a cold start", async () => {
    await withFakeDocker(async (paths, stateDir) => {
      const result = await startLapdogContainer(paths);
      expect(result).toBe("started");
      const log = await readFakeLog(stateDir);
      expect(log).toContain("network create mfz-net");
      expect(log).toContain("run");
      expect(log).toContain("--name lapdog");
      expect(log).toContain("--network mfz-net");
      expect(log).toContain("--lapdog-mode");
      expect(log).toContain(`--web-ui-port=${lapdogWebUiPort}`);
      expect(log).toContain("snapshots:/snapshots");
      expect(log).toContain(lapdogImageRef);
    });
  });

  it("returns 'already_running' and does not re-run when the container exists", async () => {
    await withFakeDocker(async (paths, stateDir) => {
      await expect(startLapdogContainer(paths)).resolves.toBe("started");
      await expect(startLapdogContainer(paths)).resolves.toBe("already_running");
      const log = await readFakeLog(stateDir);
      const runCalls = log.split("\n").filter((line) => line.startsWith("run "));
      expect(runCalls).toHaveLength(1);
    });
  });
});

describe("stopLapdogContainer", () => {
  it("tolerates a missing container and network (idempotent teardown)", async () => {
    await withFakeDocker(async (_, stateDir) => {
      await expect(stopLapdogContainer()).resolves.toBeUndefined();
      const log = await readFakeLog(stateDir);
      expect(log).toContain("rm --force lapdog");
      expect(log).toContain("network rm mfz-net");
    });
  });

  it("does not throw when the container is already absent", async () => {
    await withFakeDocker(async (_, stateDir) => {
      await stopLapdogContainer();
      await expect(stopLapdogContainer()).resolves.toBeUndefined();
      const log = await readFakeLog(stateDir);
      const rmCalls = log.split("\n").filter((line) => line.startsWith("rm --force lapdog"));
      expect(rmCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("isLapdogReachable", () => {
  it("returns true when /info responds 200", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(isLapdogReachable({ url: "http://example" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example/info",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("returns false when /info responds non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    await expect(isLapdogReachable({ url: "http://example" })).resolves.toBe(false);
  });

  it("returns false on connection refused (fail-open classification)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await expect(isLapdogReachable({ url: "http://example" })).resolves.toBe(false);
  });
});

describe("waitForLapdog", () => {
  it("returns true on the first successful probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    );
    await expect(
      waitForLapdog({ url: "http://example", attempts: 3, intervalMs: 1 })
    ).resolves.toBe(true);
  });

  it("returns false after exhausting attempts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await expect(
      waitForLapdog({ url: "http://example", attempts: 3, intervalMs: 1 })
    ).resolves.toBe(false);
  });
});
