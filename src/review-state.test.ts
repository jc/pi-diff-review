import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffReviewFile } from "./types.js";
import {
  createWorkingTreeReviewState,
  hashContent,
  resolveReviewState,
  type ReviewStateRecord,
} from "./review-state.js";

const currentScope = {
  baseRef: "origin/main",
  baseSha: "base-main",
};

function buildFile(overrides: Partial<DiffReviewFile> = {}): DiffReviewFile {
  return {
    id: "src/a.ts=>src/a.ts",
    fileKey: "src/a.ts=>src/a.ts",
    status: "modified",
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    displayPath: "src/a.ts",
    oldContent: "",
    newContent: "",
    revision: {
      nodes: [
        { id: "base", kind: "base", label: "Base" },
        { id: "c:c3", kind: "commit", sha: "c3", shortSha: "c3", subject: "c3", timestamp: 3 },
        { id: "working-tree", kind: "working-tree", label: "Working tree" },
      ],
      nodeContents: {
        base: "base\n",
        "c:c3": "commit-c3\n",
        "working-tree": "working-tree\n",
      },
      headNodeId: "c:c3",
      checkpointNodeId: null,
      reviewedNodeId: null,
      defaultFromNodeId: "base",
      defaultToNodeId: "working-tree",
      baseMismatch: false,
      baseRefChanged: false,
      savedBaseRef: null,
      savedBaseSha: null,
    },
    ...overrides,
  };
}

test("createWorkingTreeReviewState captures the current head commit and working-tree hash", () => {
  const file = buildFile();

  const state = createWorkingTreeReviewState(file, currentScope);

  assert.equal(state.commitSha, "c3");
  assert.equal(state.workingTree?.contentHash, hashContent("working-tree\n"));
  assert.equal(state.workingTree?.oldPath, "src/a.ts");
  assert.equal(state.workingTree?.newPath, "src/a.ts");
  assert.equal(state.baseRef, "origin/main");
  assert.equal(state.baseSha, "base-main");
});

test("resolveReviewState marks unchanged reviewed working-tree snapshots as reviewed", () => {
  const file = buildFile();
  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: {
      status: "modified",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      contentHash: hashContent("working-tree\n"),
    },
    baseRef: "origin/main",
    baseSha: "base-main",
  };

  const resolved = resolveReviewState(file, "working", new Map([[file.fileKey, record]]), currentScope);

  assert.equal(resolved.checkpointNodeId, "c:c3");
  assert.equal(resolved.reviewedNodeId, "working-tree");
  assert.equal(resolved.defaultFromNodeId, "c:c3");
  assert.equal(resolved.defaultToNodeId, "working-tree");
  assert.equal(resolved.baseMismatch, false);
  assert.equal(resolved.baseRefChanged, false);
});

test("resolveReviewState promotes matching reviewed snapshots to the latest matching commit", () => {
  const file = buildFile({
    revision: {
      nodes: [
        { id: "base", kind: "base", label: "Base" },
        { id: "c:c3", kind: "commit", sha: "c3", shortSha: "c3", subject: "c3", timestamp: 3 },
        { id: "c:c4", kind: "commit", sha: "c4", shortSha: "c4", subject: "c4", timestamp: 4 },
        { id: "working-tree", kind: "working-tree", label: "Working tree" },
      ],
      nodeContents: {
        base: "base\n",
        "c:c3": "commit-c3\n",
        "c:c4": "reviewed-state\n",
        "working-tree": "reviewed-state\n",
      },
      headNodeId: "c:c4",
      checkpointNodeId: null,
      reviewedNodeId: null,
      defaultFromNodeId: "base",
      defaultToNodeId: "working-tree",
      baseMismatch: false,
      baseRefChanged: false,
      savedBaseRef: null,
      savedBaseSha: null,
    },
  });

  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: {
      status: "modified",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      contentHash: hashContent("reviewed-state\n"),
    },
    baseRef: "origin/main",
    baseSha: "base-main",
  };

  const resolved = resolveReviewState(file, "working", new Map([[file.fileKey, record]]), currentScope);

  assert.equal(resolved.checkpointNodeId, "c:c4");
  assert.equal(resolved.reviewedNodeId, "c:c4");
  assert.equal(resolved.defaultFromNodeId, "c:c4");
});

test("resolveReviewState falls back to the reviewed commit when the working-tree snapshot diverges", () => {
  const file = buildFile({
    revision: {
      nodes: [
        { id: "base", kind: "base", label: "Base" },
        { id: "c:c3", kind: "commit", sha: "c3", shortSha: "c3", subject: "c3", timestamp: 3 },
        { id: "working-tree", kind: "working-tree", label: "Working tree" },
      ],
      nodeContents: {
        base: "base\n",
        "c:c3": "commit-c3\n",
        "working-tree": "newer-working-tree\n",
      },
      headNodeId: "c:c3",
      checkpointNodeId: null,
      reviewedNodeId: null,
      defaultFromNodeId: "base",
      defaultToNodeId: "working-tree",
      baseMismatch: false,
      baseRefChanged: false,
      savedBaseRef: null,
      savedBaseSha: null,
    },
  });

  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: {
      status: "modified",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      contentHash: hashContent("reviewed-state\n"),
    },
    baseRef: "origin/main",
    baseSha: "base-main",
  };

  const resolved = resolveReviewState(file, "working", new Map([[file.fileKey, record]]), currentScope);

  assert.equal(resolved.checkpointNodeId, "c:c3");
  assert.equal(resolved.reviewedNodeId, "c:c3");
  assert.equal(resolved.defaultFromNodeId, "c:c3");
  assert.equal(resolved.defaultToNodeId, "working-tree");
});

test("resolveReviewState can recover a renamed file from a single alias match", () => {
  const file = buildFile({
    fileKey: "src/old.ts=>src/new.ts",
    oldPath: "src/old.ts",
    newPath: "src/new.ts",
    displayPath: "src/old.ts -> src/new.ts",
    status: "renamed",
  });

  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: {
      status: "renamed",
      oldPath: "src/old.ts",
      newPath: "src/newer.ts",
      contentHash: hashContent("working-tree\n"),
    },
    baseRef: "origin/main",
    baseSha: "base-main",
  };

  const resolved = resolveReviewState(file, "working", new Map([["src/old.ts=>src/newer.ts", record]]), currentScope);

  assert.equal(resolved.reviewedNodeId, "working-tree");
});

test("resolveReviewState fails closed for delete and recreate at the same path", () => {
  const file = buildFile({
    fileKey: "=>src/a.ts",
    oldPath: null,
    newPath: "src/a.ts",
    status: "added",
  });

  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: {
      status: "deleted",
      oldPath: "src/a.ts",
      newPath: null,
      contentHash: hashContent("working-tree\n"),
    },
    baseRef: "origin/main",
    baseSha: "base-main",
  };

  const resolved = resolveReviewState(file, "working", new Map([["src/a.ts=>", record]]), currentScope);

  assert.equal(resolved.reviewedNodeId, null);
  assert.equal(resolved.checkpointNodeId, null);
});

test("resolveReviewState flags changed base sha without discarding the review anchor", () => {
  const file = buildFile();
  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: null,
    baseRef: "origin/release/1.0",
    baseSha: "base-release",
  };

  const resolved = resolveReviewState(file, "committed", new Map([[file.fileKey, record]]), currentScope);

  assert.equal(resolved.checkpointNodeId, "c:c3");
  assert.equal(resolved.reviewedNodeId, "c:c3");
  assert.equal(resolved.baseMismatch, true);
  assert.equal(resolved.baseRefChanged, true);
  assert.equal(resolved.savedBaseRef, "origin/release/1.0");
  assert.equal(resolved.savedBaseSha, "base-release");
});

test("resolveReviewState keeps legacy records without base metadata compatible", () => {
  const file = buildFile();
  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: null,
    baseRef: null,
    baseSha: null,
  };

  const resolved = resolveReviewState(file, "committed", new Map([[file.fileKey, record]]), currentScope);

  assert.equal(resolved.checkpointNodeId, "c:c3");
  assert.equal(resolved.baseMismatch, false);
  assert.equal(resolved.baseRefChanged, false);
});

test("resolveReviewState treats a changed ref with the same merge-base as a softer ref change", () => {
  const file = buildFile();
  const record: ReviewStateRecord = {
    updatedAt: "2026-03-23T00:00:00.000Z",
    commitSha: "c3",
    workingTree: null,
    baseRef: "origin/release/1.0",
    baseSha: "base-main",
  };

  const resolved = resolveReviewState(file, "committed", new Map([[file.fileKey, record]]), currentScope);

  assert.equal(resolved.baseMismatch, false);
  assert.equal(resolved.baseRefChanged, true);
});
