import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readJsonObject } from "../core/fs-util.js";
import {
  planRemovePathOutcome,
  removePathOutcome,
  writeJsonAtomicOutcome
} from "../core/file-operations.js";
import type { OperationCompletion } from "../core/operations.js";
import type { RenderResult } from "../core/render.js";
import { createLink, verifyLink, type LinkPlan } from "../core/symlinks.js";

const registrySchema = z.object({
  version: z.literal(1),
  links: z.array(z.object({ name: z.string(), target: z.string() }))
});

async function requireRealDirectory(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);

    if (stat.isDirectory()) return;
    throw new Error(
      `OpenCode plugin directory ${directory} is not a real directory; move the existing MFZ directory symlink aside and preserve its contents before applying`
    );
  } catch (error) {
    // SAFETY: filesystem errors from lstat expose a stable errno code.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function assertOpenCodePluginDirectories(directory: string): Promise<void> {
  for (const candidate of [path.dirname(directory), directory]) {
    await requireRealDirectory(candidate);
  }
}

function ownedLink(directory: string, name: string, target: string, configsDir: string): LinkPlan {
  const relative = path.relative(configsDir, target);

  if (
    name !== path.basename(name) ||
    name === "." ||
    name === ".." ||
    path.basename(target) !== name ||
    !relative.includes(`${path.sep}opencode${path.sep}plugins${path.sep}tui${path.sep}`) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Invalid OpenCode plugin link ownership record for ${name}`);
  }

  return { linkPath: path.join(directory, name), targetPath: target };
}

export async function reconcileOpenCodePluginLinks(
  plan: NonNullable<RenderResult["pluginLinks"]>,
  configsDir: string,
  dryRun: boolean,
  onComplete: OperationCompletion
): Promise<void> {
  await assertOpenCodePluginDirectories(plan.directory);

  if (!dryRun) await mkdir(plan.directory, { recursive: true });

  const saved = await readJsonObject(plan.registryPath);
  const previous = Object.keys(saved).length === 0 ? [] : registrySchema.parse(saved).links;

  const recorded = previous.map(({ name, target }) =>
    ownedLink(plan.directory, name, target, configsDir)
  );

  const desired = new Set(plan.links.map((link) => link.linkPath));

  for (const old of recorded) {
    if (desired.has(old.linkPath)) continue;

    if ((await verifyLink(old)).state !== "ok") continue;

    if (dryRun) await planRemovePathOutcome(old.linkPath, { category: "link", onComplete });
    else await removePathOutcome(old.linkPath, { category: "link", onComplete });
  }

  const owned: LinkPlan[] = [];

  for (const link of plan.links) {
    const old = recorded.find((entry) => entry.linkPath === link.linkPath);
    const current = await verifyLink(link);

    if (current.state === "ok") {
      if (old && (await verifyLink(old)).state === "ok") owned.push(link);
      continue;
    }

    if (current.state === "conflict") {
      if (!old || (await verifyLink(old)).state !== "ok") {
        throw new Error(
          `Refusing to replace unmanaged OpenCode plugin ${link.linkPath}: ${current.detail}`
        );
      }

      if (dryRun) await planRemovePathOutcome(link.linkPath, { category: "link", onComplete });
      else await removePathOutcome(link.linkPath, { category: "link", onComplete });
    }

    if (dryRun) {
      onComplete({
        category: "link",
        action: "link",
        status: "planned",
        target: link.linkPath,
        significance: "meaningful",
        after: link.targetPath
      });
    } else {
      await createLink(link, onComplete);
      owned.push(link);
    }
  }

  if (!dryRun && (previous.length > 0 || owned.length > 0)) {
    await writeJsonAtomicOutcome(
      plan.registryPath,
      {
        version: 1,
        links: owned.map((link) => ({
          name: path.basename(link.linkPath),
          target: link.targetPath
        }))
      },
      { category: "bookkeeping", significance: "internal", onComplete }
    );
  }
}
