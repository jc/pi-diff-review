export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";
export type ReviewMode = "committed" | "working";

export interface DiffReviewAutoBaseSelection {
  kind: "auto";
}

export interface DiffReviewRefBaseSelection {
  kind: "ref";
  ref: string;
}

export type DiffReviewBaseSelection = DiffReviewAutoBaseSelection | DiffReviewRefBaseSelection;

export interface FileRevisionBaseNode {
  id: "base";
  kind: "base";
  label: "Base";
}

export interface FileRevisionCommitNode {
  id: `c:${string}`;
  kind: "commit";
  sha: string;
  shortSha: string;
  subject: string;
  timestamp: number;
}

export interface FileRevisionWorkingTreeNode {
  id: "working-tree";
  kind: "working-tree";
  label: "Working tree";
}

export type FileRevisionNode = FileRevisionBaseNode | FileRevisionCommitNode | FileRevisionWorkingTreeNode;

export interface FileRevisionData {
  nodes: FileRevisionNode[];
  nodeContents: Record<string, string>;
  headNodeId: string;
  checkpointNodeId: string | null;
  reviewedNodeId: string | null;
  defaultFromNodeId: string;
  defaultToNodeId: string;
  baseMismatch: boolean;
  baseRefChanged: boolean;
  savedBaseRef: string | null;
  savedBaseSha: string | null;
}

export interface DiffReviewFile {
  id: string;
  fileKey: string;
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  oldContent: string;
  newContent: string;
  revision: FileRevisionData;
}

export interface ReviewModeData {
  mode: ReviewMode;
  available: boolean;
  notice: string | null;
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  files: DiffReviewFile[];
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewStateSavePayload {
  type: "review-state-save";
  mode: ReviewMode;
  fileId: string;
  toNodeId: string;
}

export interface ReviewStateClearPayload {
  type: "review-state-clear";
  fileKey: string;
}

export interface ReviewRangeContentRequestPayload {
  type: "range-content-request";
  mode: ReviewMode;
  fileId: string;
  fromNodeId: string;
  toNodeId: string;
  requestId: number;
}

export interface ReviewClipboardReadRequestPayload {
  type: "clipboard-read-request";
  requestId: number;
}

export interface ReviewClipboardWriteRequestPayload {
  type: "clipboard-write-request";
  requestId: number;
  text: string;
}

export type ReviewWindowMessage =
  | ReviewSubmitPayload
  | ReviewCancelPayload
  | ReviewStateSavePayload
  | ReviewStateClearPayload
  | ReviewRangeContentRequestPayload
  | ReviewClipboardReadRequestPayload
  | ReviewClipboardWriteRequestPayload;

export interface DiffReviewWindowData {
  repoRoot: string;
  defaultMode: ReviewMode;
  modes: {
    committed: ReviewModeData;
    working: ReviewModeData;
  };
  diagnostics?: {
    payloadBytes?: number;
    committedFiles?: number;
    workingFiles?: number;
  };
}
