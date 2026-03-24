import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangeStatus } from "./types.js";
import type { ReviewStateRecord, WorkingTreeReviewSnapshot } from "./review-state.js";

interface LegacyCheckpointRecord {
  commitSha: string;
  updatedAt: string;
}

interface LegacyCheckpointStore {
  version: 1;
  updatedAt: string;
  files: Record<string, LegacyCheckpointRecord>;
}

interface CheckpointStore {
  version: 2;
  updatedAt: string;
  files: Record<string, ReviewStateRecord>;
}

const VERSION = 2;
const VALID_STATUSES = new Set<ChangeStatus>(["modified", "added", "deleted", "renamed"]);

function repoHash(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

function checkpointsDir(): string {
  return process.env.PI_DIFF_REVIEW_CHECKPOINTS_DIR || join(homedir(), ".pi-diff-review", "checkpoints");
}

function checkpointFilePath(repoRoot: string): string {
  return join(checkpointsDir(), `${repoHash(repoRoot)}.json`);
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

function sanitizeWorkingTreeSnapshot(value: unknown): WorkingTreeReviewSnapshot | null {
  if (typeof value !== "object" || value == null) return null;

  const status = (value as { status?: unknown }).status;
  const oldPath = (value as { oldPath?: unknown }).oldPath;
  const newPath = (value as { newPath?: unknown }).newPath;
  const contentHash = (value as { contentHash?: unknown }).contentHash;

  if (typeof status !== "string" || !VALID_STATUSES.has(status as ChangeStatus)) return null;
  if (typeof contentHash !== "string" || contentHash.length === 0) return null;
  if (oldPath != null && typeof oldPath !== "string") return null;
  if (newPath != null && typeof newPath !== "string") return null;

  return {
    status: status as ChangeStatus,
    oldPath: typeof oldPath === "string" ? oldPath : null,
    newPath: typeof newPath === "string" ? newPath : null,
    contentHash,
  };
}

function sanitizeReviewStateRecord(value: unknown): ReviewStateRecord | null {
  if (typeof value !== "object" || value == null) return null;

  const commitSha = (value as { commitSha?: unknown }).commitSha;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  const workingTree = sanitizeWorkingTreeSnapshot((value as { workingTree?: unknown }).workingTree);

  if (commitSha != null && (typeof commitSha !== "string" || commitSha.length === 0)) return null;
  if (commitSha == null && workingTree == null) return null;

  return {
    commitSha: typeof commitSha === "string" ? commitSha : null,
    updatedAt: typeof updatedAt === "string" && updatedAt.length > 0 ? updatedAt : new Date().toISOString(),
    workingTree,
  };
}

function sanitizeLegacyStore(value: unknown): CheckpointStore | null {
  if (typeof value !== "object" || value == null) return null;
  const maybeStore = value as Partial<LegacyCheckpointStore>;
  const files: Record<string, ReviewStateRecord> = {};

  if (typeof maybeStore.files === "object" && maybeStore.files != null) {
    for (const [fileKey, record] of Object.entries(maybeStore.files)) {
      if (typeof record !== "object" || record == null) continue;
      const commitSha = (record as { commitSha?: unknown }).commitSha;
      const updatedAt = (record as { updatedAt?: unknown }).updatedAt;
      if (typeof commitSha !== "string" || commitSha.length === 0) continue;
      files[fileKey] = {
        commitSha,
        updatedAt: typeof updatedAt === "string" && updatedAt.length > 0 ? updatedAt : new Date().toISOString(),
        workingTree: null,
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

function sanitizeStore(value: unknown): CheckpointStore {
  if (typeof value !== "object" || value == null) return emptyStore();
  const version = (value as { version?: unknown }).version;

  if (version === 1) {
    return sanitizeLegacyStore(value) ?? emptyStore();
  }

  const maybeStore = value as Partial<CheckpointStore>;
  const files: Record<string, ReviewStateRecord> = {};

  if (typeof maybeStore.files === "object" && maybeStore.files != null) {
    for (const [fileKey, record] of Object.entries(maybeStore.files)) {
      const sanitized = sanitizeReviewStateRecord(record);
      if (sanitized == null) continue;
      files[fileKey] = sanitized;
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

export async function loadRepoReviewStates(repoRoot: string): Promise<Map<string, ReviewStateRecord>> {
  const store = await readStore(repoRoot);
  return new Map(Object.entries(store.files));
}

export async function saveRepoReviewState(
  repoRoot: string,
  fileKey: string,
  reviewState: Omit<ReviewStateRecord, "updatedAt">,
): Promise<void> {
  await withRepoLock(repoRoot, async () => {
    const store = await readStore(repoRoot);
    store.files[fileKey] = {
      ...reviewState,
      updatedAt: new Date().toISOString(),
    };
    store.updatedAt = new Date().toISOString();
    await writeStore(repoRoot, store);
  });
}

export async function clearRepoReviewState(repoRoot: string, fileKey: string): Promise<void> {
  await withRepoLock(repoRoot, async () => {
    const store = await readStore(repoRoot);
    delete store.files[fileKey];
    store.updatedAt = new Date().toISOString();
    await writeStore(repoRoot, store);
  });
}

export async function loadRepoCheckpoints(repoRoot: string): Promise<Map<string, string>> {
  const store = await loadRepoReviewStates(repoRoot);
  const entries = [...store.entries()]
    .filter(([, record]) => record.commitSha != null)
    .map(([fileKey, record]) => [fileKey, record.commitSha as string] as const);
  return new Map(entries);
}

export async function saveRepoCheckpoint(repoRoot: string, fileKey: string, commitSha: string): Promise<void> {
  await saveRepoReviewState(repoRoot, fileKey, {
    commitSha,
    workingTree: null,
  });
}

export async function clearRepoCheckpoint(repoRoot: string, fileKey: string): Promise<void> {
  await clearRepoReviewState(repoRoot, fileKey);
}
