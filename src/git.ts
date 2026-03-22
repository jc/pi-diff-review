import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  ChangeStatus,
  DiffReviewFile,
  DiffReviewWindowData,
  FileRevisionCommitNode,
  FileRevisionData,
  FileRevisionNode,
  ReviewModeData,
} from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

interface CommitMeta {
  sha: string;
  timestamp: number;
  subject: string;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "added", oldPath: null, newPath: path });
      }
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "deleted", oldPath: path, newPath: null });
      }
      continue;
    }
  }

  return changes;
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({
      status: "added" as const,
      oldPath: null,
      newPath: path,
    }));
}

function changeKey(change: ChangedPath): string {
  return `${change.oldPath ?? ""}=>${change.newPath ?? ""}`;
}

function mergeChangedPaths(primary: ChangedPath[], secondary: ChangedPath[]): ChangedPath[] {
  const seen = new Set(primary.map((change) => changeKey(change)));
  const merged = [...primary];

  for (const change of secondary) {
    const key = changeKey(change);
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }

  return merged;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function getPathCandidates(change: ChangedPath): string[] {
  return [...new Set([change.newPath, change.oldPath].filter((value): value is string => value != null && value.length > 0))];
}

function toNodeIdForCommit(sha: string): `c:${string}` {
  return `c:${sha}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

async function getHeadSha(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const result = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "HEAD"]);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function refExists(pi: ExtensionAPI, repoRoot: string, ref: string): Promise<boolean> {
  const result = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  return result.ok;
}

function candidateRefsFromEnv(): string[] {
  const raw = [process.env.PI_DIFF_REVIEW_TARGET_BRANCH, process.env.PI_REVIEW_TARGET_BRANCH]
    .map((value) => value?.trim())
    .filter((value): value is string => value != null && value.length > 0);

  const refs: string[] = [];
  for (const value of raw) {
    refs.push(value);
    if (!value.startsWith("origin/") && !value.startsWith("refs/")) {
      refs.push(`origin/${value}`);
    }
  }
  return dedupe(refs);
}

async function resolveTargetRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  for (const ref of candidateRefsFromEnv()) {
    if (await refExists(pi, repoRoot, ref)) {
      return ref;
    }
  }

  const originHead = await runGitAllowFailure(pi, repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (originHead.ok) {
    const value = originHead.stdout.trim();
    if (value.startsWith("refs/remotes/")) {
      const ref = value.replace("refs/remotes/", "");
      if (await refExists(pi, repoRoot, ref)) {
        return ref;
      }
    }
  }

  for (const fallback of ["origin/main", "origin/master"]) {
    if (await refExists(pi, repoRoot, fallback)) {
      return fallback;
    }
  }

  return null;
}

async function getCommitMetaMap(
  pi: ExtensionAPI,
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Promise<Map<string, CommitMeta>> {
  const output = await runGit(pi, repoRoot, ["log", "--reverse", "--format=%H%x1f%ct%x1f%s", `${baseSha}..${headSha}`]);
  const map = new Map<string, CommitMeta>();

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [sha, timestampRaw, subjectRaw] = line.split("\u001f");
    if (!sha) continue;
    map.set(sha, {
      sha,
      timestamp: Number(timestampRaw || "0"),
      subject: (subjectRaw || "").trim(),
    });
  }

  return map;
}

async function listFileTouchingCommits(
  pi: ExtensionAPI,
  repoRoot: string,
  baseSha: string,
  headSha: string,
  pathCandidates: string[],
): Promise<string[]> {
  if (pathCandidates.length === 0) return [];
  const output = await runGit(pi, repoRoot, [
    "log",
    "--reverse",
    "--format=%H",
    `${baseSha}..${headSha}`,
    "--",
    ...pathCandidates,
  ]);

  return dedupe(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

async function getContentAtCommit(
  pi: ExtensionAPI,
  repoRoot: string,
  sha: string,
  pathCandidates: string[],
): Promise<string> {
  for (const candidate of pathCandidates) {
    const result = await runGitAllowFailure(pi, repoRoot, ["show", `${sha}:${candidate}`]);
    if (result.ok) return result.stdout;
  }
  return "";
}

async function getWorkingTreeContent(repoRoot: string, pathCandidates: string[]): Promise<string> {
  for (const candidate of pathCandidates) {
    try {
      return await readFile(join(repoRoot, candidate), "utf8");
    } catch {}
  }
  return "";
}

function createCommitNode(meta: CommitMeta | undefined, sha: string): FileRevisionCommitNode {
  return {
    id: toNodeIdForCommit(sha),
    kind: "commit",
    sha,
    shortSha: sha.slice(0, 7),
    subject: meta?.subject ?? "",
    timestamp: meta?.timestamp ?? 0,
  };
}

interface RevisionBuildOptions {
  pi: ExtensionAPI;
  repoRoot: string;
  change: ChangedPath;
  baseSha: string | null;
  headSha: string | null;
  commitMetaBySha: Map<string, CommitMeta>;
  includeWorkingTreeNode: boolean;
}

async function buildFileRevisionData(options: RevisionBuildOptions): Promise<FileRevisionData> {
  const { pi, repoRoot, change, baseSha, headSha, commitMetaBySha, includeWorkingTreeNode } = options;
  const pathCandidates = getPathCandidates(change);
  const isWorkingOnlyAddedFile = includeWorkingTreeNode && change.status === "added" && change.oldPath == null;

  const nodes: FileRevisionNode[] = [
    {
      id: "base",
      kind: "base",
      label: "Base",
    },
  ];

  const nodeContents: Record<string, string> = {
    base: baseSha != null && !isWorkingOnlyAddedFile
      ? await getContentAtCommit(pi, repoRoot, baseSha, pathCandidates)
      : "",
  };

  let commitShas: string[] = [];
  if (!isWorkingOnlyAddedFile && baseSha && headSha && pathCandidates.length > 0) {
    commitShas = await listFileTouchingCommits(pi, repoRoot, baseSha, headSha, pathCandidates);
  }

  const shouldFallbackToHead =
    !isWorkingOnlyAddedFile &&
    headSha != null &&
    baseSha !== headSha &&
    commitShas.length === 0 &&
    change.oldPath != null;

  if (shouldFallbackToHead && headSha) {
    commitShas.push(headSha);
  }

  for (const sha of commitShas) {
    const node = createCommitNode(commitMetaBySha.get(sha), sha);
    nodes.push(node);
    nodeContents[node.id] = await getContentAtCommit(pi, repoRoot, sha, pathCandidates);
  }

  if (includeWorkingTreeNode) {
    nodes.push({
      id: "working-tree",
      kind: "working-tree",
      label: "Working tree",
    });
    nodeContents["working-tree"] = await getWorkingTreeContent(repoRoot, pathCandidates);
  }

  const commitNodes = nodes.filter((node): node is FileRevisionCommitNode => node.kind === "commit");
  const headNodeId = commitNodes.length > 0 ? commitNodes[commitNodes.length - 1].id : "base";

  return {
    nodes,
    nodeContents,
    headNodeId,
    checkpointNodeId: null,
    defaultFromNodeId: "base",
    defaultToNodeId: headNodeId,
  };
}

function toDiffReviewFile(change: ChangedPath, revision: FileRevisionData): DiffReviewFile {
  const oldContent = revision.nodeContents[revision.defaultFromNodeId] ?? "";
  const newContent = revision.nodeContents[revision.defaultToNodeId] ?? "";

  const fileKey = changeKey(change);

  return {
    id: fileKey,
    fileKey,
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    oldContent,
    newContent,
    revision,
  };
}

function createModeData(mode: "committed" | "working", defaults?: Partial<ReviewModeData>): ReviewModeData {
  return {
    mode,
    available: defaults?.available ?? true,
    notice: defaults?.notice ?? null,
    targetRef: defaults?.targetRef ?? null,
    baseSha: defaults?.baseSha ?? null,
    headSha: defaults?.headSha ?? null,
    files: defaults?.files ?? [],
  };
}

export async function getDiffReviewFiles(pi: ExtensionAPI, cwd: string): Promise<DiffReviewWindowData> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repositoryHasHead = await hasHead(pi, repoRoot);
  const headSha = repositoryHasHead ? await getHeadSha(pi, repoRoot) : null;

  let committedMode = createModeData("committed", {
    available: false,
    notice: "Committed history unavailable; using working-tree mode.",
  });
  let committedChanges: ChangedPath[] = [];

  if (!repositoryHasHead || headSha == null) {
    committedMode = createModeData("committed", {
      available: false,
      notice: "Repository has no commits yet; committed-history mode is unavailable.",
      headSha: null,
      baseSha: null,
      targetRef: null,
      files: [],
    });
  } else {
    const targetRef = await resolveTargetRef(pi, repoRoot);
    if (targetRef == null) {
      committedMode = createModeData("committed", {
        available: false,
        notice: "Could not resolve a target branch. Falling back to working-tree mode.",
        headSha,
        baseSha: null,
        targetRef: null,
        files: [],
      });
    } else {
      const mergeBaseResult = await runGitAllowFailure(pi, repoRoot, ["merge-base", targetRef, "HEAD"]);
      const mergeBaseSha = mergeBaseResult.ok ? mergeBaseResult.stdout.trim() : "";

      if (!mergeBaseSha) {
        committedMode = createModeData("committed", {
          available: false,
          notice: "Could not compute merge-base with target branch. Falling back to working-tree mode.",
          headSha,
          baseSha: null,
          targetRef,
          files: [],
        });
      } else {
        const committedOutput = await runGit(pi, repoRoot, [
          "diff",
          "--find-renames",
          "-M",
          "--name-status",
          `${mergeBaseSha}..${headSha}`,
          "--",
        ]);

        committedChanges = parseNameStatus(committedOutput);
        const commitMetaBySha = await getCommitMetaMap(pi, repoRoot, mergeBaseSha, headSha);

        const files = await Promise.all(
          committedChanges.map(async (change) => {
            const revision = await buildFileRevisionData({
              pi,
              repoRoot,
              change,
              baseSha: mergeBaseSha,
              headSha,
              commitMetaBySha,
              includeWorkingTreeNode: false,
            });
            return toDiffReviewFile(change, revision);
          }),
        );

        committedMode = createModeData("committed", {
          available: true,
          notice: null,
          targetRef,
          baseSha: mergeBaseSha,
          headSha,
          files,
        });
      }
    }
  }

  const workingTrackedOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const workingUntrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);

  const trackedWorkingChanges = parseNameStatus(workingTrackedOutput);
  const untrackedChanges = parseUntrackedPaths(workingUntrackedOutput.stdout);
  const workingChanges = mergeChangedPaths(trackedWorkingChanges, untrackedChanges);

  const allWorkingChangesByKey = new Map<string, ChangedPath>();
  for (const change of committedChanges) {
    allWorkingChangesByKey.set(changeKey(change), change);
  }
  for (const change of workingChanges) {
    allWorkingChangesByKey.set(changeKey(change), change);
  }

  const workingBaseSha = committedMode.available
    ? committedMode.baseSha
    : headSha;
  const workingHeadSha = headSha;

  const workingCommitMetaBySha =
    workingBaseSha != null && workingHeadSha != null && workingBaseSha !== workingHeadSha
      ? await getCommitMetaMap(pi, repoRoot, workingBaseSha, workingHeadSha)
      : new Map<string, CommitMeta>();

  const workingFiles = await Promise.all(
    [...allWorkingChangesByKey.values()].map(async (change) => {
      const revision = await buildFileRevisionData({
        pi,
        repoRoot,
        change,
        baseSha: workingBaseSha,
        headSha: workingHeadSha,
        commitMetaBySha: workingCommitMetaBySha,
        includeWorkingTreeNode: true,
      });
      return toDiffReviewFile(change, revision);
    }),
  );

  const workingNotice = committedMode.available
    ? null
    : committedMode.notice ?? "Committed history unavailable; working-tree mode is active.";

  const workingMode = createModeData("working", {
    available: true,
    notice: workingNotice,
    targetRef: committedMode.targetRef,
    baseSha: workingBaseSha,
    headSha: workingHeadSha,
    files: workingFiles,
  });

  const defaultMode: "committed" | "working" = committedMode.available && committedMode.files.length > 0 ? "committed" : "working";

  return {
    repoRoot,
    defaultMode,
    modes: {
      committed: committedMode,
      working: workingMode,
    },
    diagnostics: {
      committedFiles: committedMode.files.length,
      workingFiles: workingMode.files.length,
    },
  };
}
