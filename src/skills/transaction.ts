import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

interface TransactionItem {
  destination: string;
  temporary: string;
  backup: string;
  recursive: boolean;
  hadDestination: boolean;
  oldMoved: boolean;
  newMoved: boolean;
}

interface TransactionJournal {
  version: 1;
  committed: boolean;
  items: TransactionItem[];
}

const transactionName = ".mfz-vendor-promotion.yml";
const lockName = ".mfz-vendor-promotion.lock";

function pathWithin(root: string, value: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateJournal(root: string, journal: TransactionJournal): void {
  if (
    journal.version !== 1 ||
    typeof journal.committed !== "boolean" ||
    !Array.isArray(journal.items)
  ) {
    throw new Error(`Invalid vendored promotion journal: ${journalPath(root)}`);
  }
  for (const item of journal.items) {
    if (
      !item ||
      typeof item.destination !== "string" ||
      typeof item.temporary !== "string" ||
      typeof item.backup !== "string" ||
      !path.isAbsolute(item.destination) ||
      !path.isAbsolute(item.temporary) ||
      !path.isAbsolute(item.backup) ||
      !pathWithin(root, item.destination) ||
      !pathWithin(root, item.temporary) ||
      !pathWithin(root, item.backup)
    ) {
      throw new Error(`Invalid vendored promotion journal: ${journalPath(root)}`);
    }
  }
}

function journalPath(root: string): string {
  return path.join(root, "skills", transactionName);
}

function lockPath(root: string): string {
  return path.join(root, "skills", lockName);
}

async function writeJournal(root: string, journal: TransactionJournal): Promise<void> {
  const temporary = `${journalPath(root)}.tmp`;
  await writeFile(temporary, YAML.stringify(journal), "utf8");
  await rename(temporary, journalPath(root));
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanup(journal: TransactionJournal, root: string): Promise<void> {
  for (const item of journal.items) {
    await rm(item.temporary, { recursive: item.recursive, force: true });
    await rm(item.backup, { recursive: item.recursive, force: true });
  }
  await rm(journalPath(root), { force: true });
  await rm(`${journalPath(root)}.tmp`, { force: true });
  await rm(lockPath(root), { recursive: true, force: true });
}

async function restore(journal: TransactionJournal, root: string): Promise<void> {
  for (const item of [...journal.items].reverse()) {
    const backupExists = await exists(item.backup);
    const temporaryExists = await exists(item.temporary);
    if (
      backupExists ||
      item.newMoved ||
      (!item.hadDestination && !temporaryExists && (await exists(item.destination)))
    ) {
      await rm(item.destination, { recursive: item.recursive, force: true });
    }
    if (backupExists) {
      await rename(item.backup, item.destination);
    }
    await rm(item.temporary, { recursive: item.recursive, force: true });
  }
  await cleanup(journal, root);
}

export async function recoverVendoredPromotion(root: string): Promise<void> {
  let journal: TransactionJournal;
  try {
    journal = YAML.parse(await readFile(journalPath(root), "utf8")) as TransactionJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `Invalid vendored promotion journal: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  validateJournal(root, journal);
  if (journal.committed) {
    await cleanup(journal, root);
    return;
  }
  await restore(journal, root);
}

export async function commitVendoredPromotion(
  root: string,
  items: Array<Pick<TransactionItem, "destination" | "temporary" | "backup" | "recursive">>,
  beforeCommit?: () => Promise<void>
): Promise<void> {
  await mkdir(path.join(root, "skills"), { recursive: true });
  try {
    await mkdir(lockPath(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another vendored promotion is active for ${root}`);
    }
    throw error;
  }
  const journal: TransactionJournal = {
    version: 1,
    committed: false,
    items: []
  };
  try {
    for (const item of items) {
      journal.items.push({
        ...item,
        hadDestination: await exists(item.destination),
        oldMoved: false,
        newMoved: false
      });
    }
    validateJournal(root, journal);
    await writeJournal(root, journal);
    await beforeCommit?.();
    for (const item of journal.items) {
      try {
        await rename(item.destination, item.backup);
        item.oldMoved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeJournal(root, journal);
      await rename(item.temporary, item.destination);
      item.newMoved = true;
      await writeJournal(root, journal);
    }
    journal.committed = true;
    await writeJournal(root, journal);
    await cleanup(journal, root);
  } catch (error) {
    try {
      await restore(journal, root);
    } catch (rollbackError) {
      throw new Error(
        `Vendored promotion failed and recovery is required: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      );
    }
    throw error;
  }
}
