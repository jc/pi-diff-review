import { createHash } from "node:crypto";
import type { ChangeStatus, DiffReviewFile, FileRevisionCommitNode, FileRevisionNode, ReviewMode } from "./types.js";

export interface ReviewScopeSnapshot {
  baseRef: string | null;
  baseSha: string | null;
}

export interface WorkingTreeReviewSnapshot {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  contentHash: string;
}

export interface ReviewStateRecord {
  updatedAt: string;
  commitSha: string | null;
  workingTree: WorkingTreeReviewSnapshot | null;
  baseRef: string | null;
  baseSha: string | null;
}

export interface ResolvedReviewState {
  checkpointNodeId: string | null;
  reviewedNodeId: string | null;
  defaultFromNodeId: string;
  defaultToNodeId: string;
  baseMismatch: boolean;
  baseRefChanged: boolean;
  savedBaseRef: string | null;
  savedBaseSha: string | null;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createCommitReviewState(
  commitSha: string,
  scope: ReviewScopeSnapshot,
): Omit<ReviewStateRecord, "updatedAt"> {
  return {
    commitSha,
    workingTree: null,
    baseRef: scope.baseRef,
    baseSha: scope.baseSha,
  };
}

export function createWorkingTreeReviewState(
  file: Pick<DiffReviewFile, "status" | "oldPath" | "newPath" | "revision">,
  scope: ReviewScopeSnapshot,
): Omit<ReviewStateRecord, "updatedAt"> {
  const workingTreeContent = file.revision.nodeContents["working-tree"] ?? "";
  const headNode = nodeById(file.revision.nodes, file.revision.headNodeId);

  return {
    commitSha: headNode?.kind === "commit" ? headNode.sha : null,
    workingTree: {
      status: file.status,
      oldPath: file.oldPath,
      newPath: file.newPath,
      contentHash: hashContent(workingTreeContent),
    },
    baseRef: scope.baseRef,
    baseSha: scope.baseSha,
  };
}

function nodeById(nodes: FileRevisionNode[], nodeId: string): FileRevisionNode | null {
  return nodes.find((node) => node.id === nodeId) ?? null;
}

function commitNodes(nodes: FileRevisionNode[]): FileRevisionCommitNode[] {
  return nodes.filter((node): node is FileRevisionCommitNode => node.kind === "commit");
}

function pathCandidates(paths: { oldPath: string | null; newPath: string | null }): string[] {
  return [...new Set([paths.oldPath, paths.newPath].filter((value): value is string => value != null && value.length > 0))];
}

function pathsOverlap(a: { oldPath: string | null; newPath: string | null }, b: { oldPath: string | null; newPath: string | null }): boolean {
  const aCandidates = new Set(pathCandidates(a));
  return pathCandidates(b).some((candidate) => aCandidates.has(candidate));
}

function findExactOrAliasRecord(
  file: Pick<DiffReviewFile, "fileKey" | "status" | "oldPath" | "newPath">,
  records: Map<string, ReviewStateRecord>,
): ReviewStateRecord | null {
  const exact = records.get(file.fileKey);
  if (exact) return exact;

  const aliasCandidates = [...records.entries()].filter(([, record]) => {
    if (record.workingTree == null) return false;
    if (record.workingTree.status !== file.status) return false;
    return pathsOverlap(record.workingTree, file);
  });

  if (aliasCandidates.length !== 1) return null;

  return aliasCandidates[0][1];
}

function latestMatchingCommitNodeId(file: Pick<DiffReviewFile, "revision">, contentHash: string): string | null {
  const nodes = commitNodes(file.revision.nodes);

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const content = file.revision.nodeContents[node.id] ?? "";
    if (hashContent(content) === contentHash) {
      return node.id;
    }
  }

  return null;
}

function commitNodeIdForSha(file: Pick<DiffReviewFile, "revision">, commitSha: string | null): string | null {
  if (commitSha == null) return null;
  return commitNodes(file.revision.nodes).find((node) => node.sha === commitSha)?.id ?? null;
}

function normalizeScopeValue(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveScopeChange(
  record: ReviewStateRecord,
  currentScope: ReviewScopeSnapshot,
): Pick<ResolvedReviewState, "baseMismatch" | "baseRefChanged" | "savedBaseRef" | "savedBaseSha"> {
  const savedBaseRef = normalizeScopeValue(record.baseRef);
  const savedBaseSha = normalizeScopeValue(record.baseSha);
  const currentBaseRef = normalizeScopeValue(currentScope.baseRef);
  const currentBaseSha = normalizeScopeValue(currentScope.baseSha);
  const hasSavedScope = savedBaseRef != null || savedBaseSha != null;

  if (!hasSavedScope) {
    return {
      baseMismatch: false,
      baseRefChanged: false,
      savedBaseRef: null,
      savedBaseSha: null,
    };
  }

  const baseRefChanged = savedBaseRef != null && currentBaseRef != null
    ? savedBaseRef !== currentBaseRef
    : savedBaseRef !== currentBaseRef && (savedBaseRef != null || currentBaseRef != null);

  const baseMismatch = savedBaseSha != null && currentBaseSha != null
    ? savedBaseSha !== currentBaseSha
    : false;

  return {
    baseMismatch,
    baseRefChanged,
    savedBaseRef,
    savedBaseSha,
  };
}

export function resolveReviewState(
  file: Pick<DiffReviewFile, "fileKey" | "status" | "oldPath" | "newPath" | "revision">,
  mode: ReviewMode,
  records: Map<string, ReviewStateRecord>,
  currentScope: ReviewScopeSnapshot,
): ResolvedReviewState {
  const workingTreeNodeId = file.revision.nodes.find((node) => node.kind === "working-tree")?.id ?? null;
  const defaultToNodeId = mode === "working"
    ? (workingTreeNodeId ?? file.revision.headNodeId)
    : file.revision.headNodeId;

  const matched = findExactOrAliasRecord(file, records);
  if (matched == null) {
    return {
      checkpointNodeId: null,
      reviewedNodeId: null,
      defaultFromNodeId: "base",
      defaultToNodeId,
      baseMismatch: false,
      baseRefChanged: false,
      savedBaseRef: null,
      savedBaseSha: null,
    };
  }

  const scopeChange = resolveScopeChange(matched, currentScope);

  let checkpointNodeId = commitNodeIdForSha(file, matched.commitSha);
  let reviewedNodeId = checkpointNodeId;

  if (matched.workingTree != null) {
    const promotedCommitNodeId = latestMatchingCommitNodeId(file, matched.workingTree.contentHash);
    if (promotedCommitNodeId != null) {
      checkpointNodeId = promotedCommitNodeId;
      reviewedNodeId = promotedCommitNodeId;
    } else if (workingTreeNodeId != null) {
      const workingTreeContent = file.revision.nodeContents[workingTreeNodeId] ?? "";
      if (hashContent(workingTreeContent) === matched.workingTree.contentHash) {
        reviewedNodeId = workingTreeNodeId;
      }
    }
  }

  return {
    checkpointNodeId,
    reviewedNodeId,
    defaultFromNodeId: checkpointNodeId ?? "base",
    defaultToNodeId,
    ...scopeChange,
  };
}
