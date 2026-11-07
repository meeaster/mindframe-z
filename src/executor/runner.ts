import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { parseJsonText } from "../core/json.js";
import type { AppFile, ExistingApp } from "./apps.js";

// The executor CLI owns the local server's address and API key; MFZ only runs its commands.
const executorBinary = "executor";

const deployMessage = "mfz executor apply";

const failureSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const frameworkSchema = z.object({ version: z.string().min(1) });

const appListSchema = z.array(
  z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    activeVersion: z.string().nullable()
  })
);

const sourceSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string().optional() }))
});

const createdSchema = z.object({ id: z.string() });

const deploySchema = z.object({});

// Failures where the CLI could not reach or start the local server.
const unreachableCodes = new Set(["LocalServerUnavailable", "HostUnreachable"]);

async function executorApps<T extends z.ZodType>(
  args: readonly string[],
  schema: T
): Promise<z.infer<T>> {
  const command = `executor apps ${args[0] ?? ""}`;
  const result = await execa(executorBinary, ["apps", ...args], { reject: false });

  if (result.exitCode === undefined) {
    throw new Error(`Could not run ${command}: ${result.shortMessage}`);
  }

  const output = parseJsonText(result.stdout);

  if (result.exitCode !== 0) {
    const failure = failureSchema.safeParse(output).data?.error;

    if (failure !== undefined && unreachableCodes.has(failure.code)) {
      throw new Error(
        `Executor is not reachable (${failure.message}); start it with systemctl --user start executor`
      );
    }

    throw new Error(
      `${command} failed: ${failure?.message ?? (result.stderr.trim() || `exit ${result.exitCode}`)}`
    );
  }

  const parsed = schema.safeParse(output);

  if (!parsed.success) throw new Error(`${command} printed unexpected output`);

  return parsed.data;
}

export async function frameworkVersion(): Promise<string> {
  return (await executorApps(["framework"], frameworkSchema)).version;
}

export async function existingApps(): Promise<ExistingApp[]> {
  const apps = await executorApps(["list"], appListSchema);

  return Promise.all(
    apps.map(async (app) => ({
      ...app,
      files: (await executorApps(["source", "--app", app.id], sourceSchema)).files
    }))
  );
}

async function withSourceDirectory(
  files: readonly AppFile[],
  action: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mfz-executor-app-"));

  try {
    for (const file of files) {
      const location = path.join(directory, file.path);

      await mkdir(path.dirname(location), { recursive: true });
      await writeFile(location, file.content);
    }

    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function deployApp(id: string, files: readonly AppFile[]): Promise<void> {
  await withSourceDirectory(files, async (directory) => {
    await executorApps(
      ["deploy", "--app", id, "--files", directory, "--message", deployMessage],
      deploySchema
    );
  });
}

// Creating only saves source, so the new app is deployed straight away to make it run.
export async function createApp(name: string, files: readonly AppFile[]): Promise<void> {
  await withSourceDirectory(files, async (directory) => {
    const { id } = await executorApps(
      ["create", "--name", name, "--files", directory],
      createdSchema
    );

    await executorApps(
      ["deploy", "--app", id, "--files", directory, "--message", deployMessage],
      deploySchema
    );
  });
}
