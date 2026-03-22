import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface CheckpointRecord {
  commitSha: string;
  updatedAt: string;
}

interface CheckpointStore {
  version: 1;
  updatedAt: string;
  files: Record<string, CheckpointRecord>;
}

const VERSION = 1;

function repoHash(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

function checkpointFilePath(repoRoot: string): string {
  return join(homedir(), ".pi-diff-review", "checkpoints", `${repoHash(repoRoot)}.json`);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

function emptyStore(): CheckpointStore {
  return {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    files: {},
  };
}

function sanitizeStore(value: unknown): CheckpointStore {
  if (typeof value !== "object" || value == null) return emptyStore();
  const maybeStore = value as Partial<CheckpointStore>;
  const files: Record<string, CheckpointRecord> = {};

  if (typeof maybeStore.files === "object" && maybeStore.files != null) {
    for (const [fileKey, record] of Object.entries(maybeStore.files)) {
      if (typeof record !== "object" || record == null) continue;
      const commitSha = (record as { commitSha?: unknown }).commitSha;
      const updatedAt = (record as { updatedAt?: unknown }).updatedAt;
      if (typeof commitSha !== "string" || commitSha.length === 0) continue;
      files[fileKey] = {
        commitSha,
        updatedAt: typeof updatedAt === "string" && updatedAt.length > 0 ? updatedAt : new Date().toISOString(),
      };
    }
  }

  return {
    version: VERSION,
    updatedAt: typeof maybeStore.updatedAt === "string" && maybeStore.updatedAt.length > 0
      ? maybeStore.updatedAt
      : new Date().toISOString(),
    files,
  };
}

async function readStore(repoRoot: string): Promise<CheckpointStore> {
  const path = checkpointFilePath(repoRoot);
  try {
    const raw = await readFile(path, "utf8");
    return sanitizeStore(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStore();
    }

    try {
      const corruptPath = `${path}.corrupt-${Date.now()}`;
      await rename(path, corruptPath);
    } catch {}

    return emptyStore();
  }
}

async function writeStore(repoRoot: string, store: CheckpointStore): Promise<void> {
  const path = checkpointFilePath(repoRoot);
  await ensureDir(path);

  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify(store, null, 2)}\n`;
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, path);
}

function lockPath(repoRoot: string): string {
  return `${checkpointFilePath(repoRoot)}.lock`;
}

async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const path = checkpointFilePath(repoRoot);
  const lock = lockPath(repoRoot);
  await ensureDir(path);

  const startedAt = Date.now();
  while (true) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch {
      if (Date.now() - startedAt > 1500) {
        throw new Error("Checkpoint store is busy; please try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

export async function loadRepoCheckpoints(repoRoot: string): Promise<Map<string, string>> {
  const store = await readStore(repoRoot);
  const entries = Object.entries(store.files).map(([fileKey, record]) => [fileKey, record.commitSha] as const);
  return new Map(entries);
}

export async function saveRepoCheckpoint(repoRoot: string, fileKey: string, commitSha: string): Promise<void> {
  await withRepoLock(repoRoot, async () => {
    const store = await readStore(repoRoot);
    store.files[fileKey] = {
      commitSha,
      updatedAt: new Date().toISOString(),
    };
    store.updatedAt = new Date().toISOString();
    await writeStore(repoRoot, store);
  });
}

export async function clearRepoCheckpoint(repoRoot: string, fileKey: string): Promise<void> {
  await withRepoLock(repoRoot, async () => {
    const store = await readStore(repoRoot);
    delete store.files[fileKey];
    store.updatedAt = new Date().toISOString();
    await writeStore(repoRoot, store);
  });
}
