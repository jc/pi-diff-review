import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  clearRepoCheckpoint,
  loadRepoCheckpoints,
  loadRepoReviewStates,
  saveRepoCheckpoint,
  saveRepoReviewState,
} from "./checkpoints.js";

const previousCheckpointsDir = process.env.PI_DIFF_REVIEW_CHECKPOINTS_DIR;
const repoRoot = "/tmp/pi-diff-review-repo";

function repoHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function createCheckpointDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-review-checkpoints-"));
  process.env.PI_DIFF_REVIEW_CHECKPOINTS_DIR = dir;
  return dir;
}

afterEach(async () => {
  const dir = process.env.PI_DIFF_REVIEW_CHECKPOINTS_DIR;
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }

  if (previousCheckpointsDir == null) {
    delete process.env.PI_DIFF_REVIEW_CHECKPOINTS_DIR;
  } else {
    process.env.PI_DIFF_REVIEW_CHECKPOINTS_DIR = previousCheckpointsDir;
  }
});

test("saveRepoCheckpoint and loadRepoCheckpoints round-trip commit checkpoints", async () => {
  await createCheckpointDir();

  await saveRepoCheckpoint(repoRoot, "src/a.ts=>src/a.ts", "abc123");
  await saveRepoCheckpoint(repoRoot, "src/b.ts=>src/b.ts", "def456");

  const checkpoints = await loadRepoCheckpoints(repoRoot);

  assert.equal(checkpoints.get("src/a.ts=>src/a.ts"), "abc123");
  assert.equal(checkpoints.get("src/b.ts=>src/b.ts"), "def456");
  assert.equal(checkpoints.size, 2);
});

test("clearRepoCheckpoint removes only the requested checkpoint", async () => {
  await createCheckpointDir();

  await saveRepoCheckpoint(repoRoot, "src/a.ts=>src/a.ts", "abc123");
  await saveRepoCheckpoint(repoRoot, "src/b.ts=>src/b.ts", "def456");
  await clearRepoCheckpoint(repoRoot, "src/a.ts=>src/a.ts");

  const checkpoints = await loadRepoCheckpoints(repoRoot);

  assert.equal(checkpoints.has("src/a.ts=>src/a.ts"), false);
  assert.equal(checkpoints.get("src/b.ts=>src/b.ts"), "def456");
});

test("loadRepoCheckpoints reads legacy version 1 checkpoint files", async () => {
  const dir = await createCheckpointDir();
  const path = join(dir, `${repoHash(repoRoot)}.json`);

  await writeFile(path, `${JSON.stringify({
    version: 1,
    updatedAt: "2026-03-23T00:00:00.000Z",
    files: {
      "src/a.ts=>src/a.ts": {
        commitSha: "abc123",
        updatedAt: "2026-03-23T00:00:00.000Z",
      },
    },
  }, null, 2)}\n`);

  const checkpoints = await loadRepoCheckpoints(repoRoot);

  assert.equal(checkpoints.get("src/a.ts=>src/a.ts"), "abc123");
});

test("saveRepoReviewState persists version 2 dual review-state records", async () => {
  const dir = await createCheckpointDir();

  await saveRepoReviewState(repoRoot, "src/a.ts=>src/a.ts", {
    commitSha: "c3",
    workingTree: {
      status: "modified",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      contentHash: "hash-123",
    },
    baseRef: "origin/main",
    baseSha: "base-123",
  });

  const reviewStates = await loadRepoReviewStates(repoRoot);
  const persisted = reviewStates.get("src/a.ts=>src/a.ts");
  const rawStore = JSON.parse(await readFile(join(dir, `${repoHash(repoRoot)}.json`), "utf8"));

  assert.equal(rawStore.version, 2);
  assert.equal(persisted?.commitSha, "c3");
  assert.equal(persisted?.workingTree?.contentHash, "hash-123");
  assert.equal(persisted?.baseRef, "origin/main");
  assert.equal(persisted?.baseSha, "base-123");
});

test("loadRepoReviewStates treats missing base metadata as unknown legacy scope", async () => {
  const dir = await createCheckpointDir();
  const path = join(dir, `${repoHash(repoRoot)}.json`);

  await writeFile(path, `${JSON.stringify({
    version: 2,
    updatedAt: "2026-03-24T00:00:00.000Z",
    files: {
      "src/a.ts=>src/a.ts": {
        commitSha: "c3",
        updatedAt: "2026-03-24T00:00:00.000Z",
        workingTree: null,
      },
    },
  }, null, 2)}\n`);

  const reviewStates = await loadRepoReviewStates(repoRoot);
  const record = reviewStates.get("src/a.ts=>src/a.ts");

  assert.equal(record?.commitSha, "c3");
  assert.equal(record?.baseRef, null);
  assert.equal(record?.baseSha, null);
});
