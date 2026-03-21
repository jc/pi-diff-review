const dataScript = document.getElementById("diff-review-data");
const rawPayloadText = dataScript?.textContent || "{}";
let rawReviewData = {};
let payloadParseError = null;

try {
  rawReviewData = JSON.parse(rawPayloadText);
} catch (error) {
  payloadParseError = error instanceof Error ? error.message : String(error);
  rawReviewData = {};
}

const MODES = ["committed", "working"];

function normalizeReviewData(data) {
  if (data && data.modes && data.modes.committed && data.modes.working) {
    return data;
  }

  const legacyFiles = Array.isArray(data?.files) ? data.files.map((file, index) => ({
    ...file,
    fileKey: file.fileKey || file.id || `${index}:${file.newPath || file.oldPath || file.displayPath || "file"}`,
    revision: {
      nodes: [
        { id: "base", kind: "base", label: "Base" },
        { id: "c:legacy-head", kind: "commit", sha: "legacy-head", shortSha: "HEAD", subject: "Current diff", timestamp: 0 },
      ],
      nodeContents: {
        base: file.oldContent || "",
        "c:legacy-head": file.newContent || "",
      },
      headNodeId: "c:legacy-head",
      checkpointNodeId: null,
      defaultFromNodeId: "base",
      defaultToNodeId: "c:legacy-head",
    },
  })) : [];

  return {
    repoRoot: data?.repoRoot || "",
    defaultMode: "working",
    diagnostics: {
      ...(data?.diagnostics || {}),
      payloadBytes: typeof data?.diagnostics?.payloadBytes === "number" ? data.diagnostics.payloadBytes : rawPayloadText.length,
      committedFiles: 0,
      workingFiles: legacyFiles.length,
    },
    modes: {
      committed: {
        mode: "committed",
        available: false,
        notice: "Committed history mode unavailable in this payload.",
        targetRef: null,
        baseSha: null,
        headSha: null,
        files: [],
      },
      working: {
        mode: "working",
        available: true,
        notice: null,
        targetRef: null,
        baseSha: null,
        headSha: null,
        files: legacyFiles,
      },
    },
  };
}

const reviewData = normalizeReviewData(rawReviewData);
reviewData.diagnostics = {
  ...(reviewData.diagnostics || {}),
  payloadBytes: typeof reviewData.diagnostics?.payloadBytes === "number" ? reviewData.diagnostics.payloadBytes : rawPayloadText.length,
  committedFiles: typeof reviewData.diagnostics?.committedFiles === "number" ? reviewData.diagnostics.committedFiles : (reviewData.modes?.committed?.files?.length || 0),
  workingFiles: typeof reviewData.diagnostics?.workingFiles === "number" ? reviewData.diagnostics.workingFiles : (reviewData.modes?.working?.files?.length || 0),
};

if (payloadParseError) {
  console.error("diff-review payload parse failed", { payloadParseError, payloadBytes: rawPayloadText.length });
}

function modeData(mode) {
  return reviewData.modes?.[mode] ?? { files: [], available: false, notice: null };
}

function firstFileId(mode) {
  return modeData(mode).files[0]?.id ?? null;
}

const state = {
  mode: reviewData.defaultMode ?? "working",
  activeFileIdByMode: {
    committed: firstFileId("committed"),
    working: firstFileId("working"),
  },
  comments: [],
  overallComment: "",
  hideUnchanged: false,
  wrapLines: true,
  collapsedDirsByMode: {
    committed: {},
    working: {},
  },
  scrollPositions: {},
  selections: {},
  contentCache: {},
  nextRangeRequestId: 1,
  pendingRangeRequestId: 0,
  hunkCursorKey: null,
  hunkCursorIndex: -1,
  lastRangeSwitchMs: null,
};

for (const mode of MODES) {
  for (const file of modeData(mode).files ?? []) {
    const key = `${mode}:${file.id}`;
    const workingTreeNode = file.revision.nodes.find((node) => node.kind === "working-tree");
    const isUnreviewedWorkingMode = mode === "working" && file.revision.checkpointNodeId == null && workingTreeNode != null;

    state.selections[key] = {
      from: isUnreviewedWorkingMode ? "base" : file.revision.defaultFromNodeId,
      to: isUnreviewedWorkingMode ? workingTreeNode.id : file.revision.defaultToNodeId,
    };

    state.contentCache[key] = {
      ...(file.revision.nodeContents || {}),
    };
  }
}

const repoRootEl = document.getElementById("repo-root");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const rangeSummaryEl = document.getElementById("range-summary");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const shortcutsButton = document.getElementById("shortcuts-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");
const modeCommittedButton = document.getElementById("mode-committed-button");
const modeWorkingButton = document.getElementById("mode-working-button");
const reviewNoticeEl = document.getElementById("review-notice");
const revisionStripEl = document.getElementById("revision-strip");

repoRootEl.textContent = reviewData.repoRoot || "";

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;

function activeModeData() {
  return modeData(state.mode);
}

function filesForMode() {
  return activeModeData().files ?? [];
}

function activeFileId() {
  return state.activeFileIdByMode[state.mode];
}

function setActiveFileId(fileId) {
  state.activeFileIdByMode[state.mode] = fileId;
}

function activeFile() {
  const id = activeFileId();
  if (!id) return null;
  return filesForMode().find((file) => file.id === id) ?? null;
}

function selectionKey(file) {
  return `${state.mode}:${file.id}`;
}

function fileSelection(file) {
  const key = selectionKey(file);
  if (!state.selections[key]) {
    state.selections[key] = {
      from: file.revision.defaultFromNodeId,
      to: file.revision.defaultToNodeId,
    };
  }
  return state.selections[key];
}

function fileContentCache(file) {
  const key = selectionKey(file);
  if (!state.contentCache[key]) {
    state.contentCache[key] = {
      ...(file.revision.nodeContents || {}),
    };
  }
  return state.contentCache[key];
}

function getNodeContent(file, nodeId) {
  return fileContentCache(file)[nodeId];
}

function requestRangeContent(file, fromNodeId, toNodeId) {
  const requestId = state.nextRangeRequestId++;
  state.pendingRangeRequestId = requestId;

  window.glimpse.send({
    type: "range-content-request",
    mode: state.mode,
    fileId: file.id,
    fromNodeId,
    toNodeId,
    requestId,
  });
}

function nodeIndex(file, nodeId) {
  return file.revision.nodes.findIndex((node) => node.id === nodeId);
}

function nodeById(file, nodeId) {
  return file.revision.nodes.find((node) => node.id === nodeId) ?? null;
}

function workingTreeNode(file) {
  return file.revision.nodes.find((node) => node.kind === "working-tree") ?? null;
}

function clampSelection(file, draft) {
  const nodes = file.revision.nodes;
  let from = draft.from;
  let to = draft.to;

  if (!nodeById(file, from)) from = file.revision.defaultFromNodeId;
  if (!nodeById(file, to)) to = file.revision.defaultToNodeId;

  if (nodeById(file, from)?.kind === "working-tree") {
    from = file.revision.headNodeId;
  }

  let fromIndex = nodeIndex(file, from);
  let toIndex = nodeIndex(file, to);

  if (fromIndex === -1) fromIndex = 0;
  if (toIndex === -1) toIndex = Math.max(0, nodes.length - 1);

  if (toIndex < fromIndex) {
    toIndex = fromIndex;
  }

  return {
    from: nodes[fromIndex]?.id ?? "base",
    to: nodes[toIndex]?.id ?? "base",
  };
}

function setFileSelection(file, selection) {
  state.selections[selectionKey(file)] = clampSelection(file, selection);
}

function floorNodes(file) {
  return file.revision.nodes.filter((node) => node.kind !== "working-tree");
}

function ceilingNodes(file) {
  return file.revision.nodes;
}

function applyFloorSelection(file, nextFromNodeId) {
  const selection = fileSelection(file);
  setFileSelection(file, { ...selection, from: nextFromNodeId });
  renderAll({ preserveScroll: true });
}

function applyCeilingSelection(file, nextToNodeId) {
  const selection = fileSelection(file);
  setFileSelection(file, { ...selection, to: nextToNodeId });
  renderAll({ preserveScroll: true });
}

function humanizeNode(node) {
  if (!node) return "Unknown";
  if (node.kind === "base") return "Base";
  if (node.kind === "working-tree") return "Working tree";
  return node.shortSha;
}

function isFileReviewed(file) {
  return file.revision.checkpointNodeId != null;
}

function reviewToggleState(file) {
  const selection = fileSelection(file);
  const toNode = nodeById(file, selection.to);
  const checkpointNode = nodeById(file, file.revision.checkpointNodeId);

  const toIndex = nodeIndex(file, selection.to);
  const checkpointIndex = file.revision.checkpointNodeId ? nodeIndex(file, file.revision.checkpointNodeId) : -1;

  const hasCheckpoint = checkpointNode != null;
  const canMark = toNode?.kind === "commit";
  const reviewedThroughSelectedCommit = canMark && hasCheckpoint && checkpointIndex >= toIndex;

  if (reviewedThroughSelectedCommit) {
    return {
      action: "clear",
      disabled: false,
      icon: "reviewed",
      label: "Reviewed through selected commit",
      title: "Reviewed through selected To commit. Click to clear reviewed state.",
      className: "cursor-pointer inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#2ea043]/40 bg-[#238636]/15 text-[#3fb950] hover:bg-[#238636]/25",
    };
  }

  if (hasCheckpoint && !canMark) {
    return {
      action: "clear",
      disabled: false,
      icon: "reviewed",
      label: "Checkpoint saved (click to clear)",
      title: "A checkpoint exists, but To is not a commit. Click to clear reviewed state.",
      className: "cursor-pointer inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#2ea043]/40 bg-[#238636]/15 text-[#3fb950] hover:bg-[#238636]/25",
    };
  }

  if (canMark) {
    return {
      action: "mark",
      disabled: false,
      icon: "pending",
      label: "Not reviewed through selected commit",
      title: "Click to mark reviewed through selected To commit.",
      className: "cursor-pointer inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#f85149]/40 bg-[#f85149]/15 text-[#ff7b72] hover:bg-[#f85149]/25",
    };
  }

  return {
    action: null,
    disabled: true,
    icon: "pending",
    label: "Select a commit in To to mark reviewed",
    title: "Mark reviewed is available only when To is a commit.",
    className: "cursor-not-allowed inline-flex h-8 w-8 items-center justify-center rounded-md border border-review-border bg-review-panel text-review-muted opacity-60",
  };
}

function reviewToggleIcon(icon) {
  if (icon === "reviewed") {
    return `<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.27 2.943 9.543 7-1.274 4.057-5.065 7-9.543 7-4.477 0-8.268-2.943-9.542-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>`;
  }

  return `<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M10.584 10.587A2 2 0 0012 14a2 2 0 001.414-.586" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M9.88 5.09A9.95 9.95 0 0112 5c4.478 0 8.27 2.943 9.543 7a9.97 9.97 0 01-4.132 5.112" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M6.228 6.232A9.965 9.965 0 002.458 12c1.274 4.057 5.065 7 9.543 7 1.596 0 3.106-.37 4.45-1.03" />
  </svg>`;
}

function saveCurrentScrollPosition() {
  if (!diffEditor || !activeFileId()) return;
  const key = `${state.mode}:${activeFileId()}`;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  state.scrollPositions[key] = {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreFileScrollPosition() {
  if (!diffEditor || !activeFileId()) return;
  const key = `${state.mode}:${activeFileId()}`;
  const scrollState = state.scrollPositions[key];
  if (!scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function captureScrollState() {
  if (!diffEditor) return null;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  return {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreScrollState(scrollState) {
  if (!diffEditor || !scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function inferLanguage(path) {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  return "plaintext";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function statusLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "deleted": return "text-[#f85149]";
    case "renamed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function updateModeButtons() {
  const committedAvailable = modeData("committed").available;

  modeCommittedButton.className = [
    "px-3 py-1.5 text-xs",
    committedAvailable ? "cursor-pointer" : "cursor-not-allowed opacity-50",
    state.mode === "committed" ? "bg-[#1f6feb] text-white" : "text-review-text hover:bg-[#21262d]",
  ].join(" ");

  modeWorkingButton.className = [
    "border-l border-review-border px-3 py-1.5 text-xs cursor-pointer",
    state.mode === "working" ? "bg-[#1f6feb] text-white" : "text-review-text hover:bg-[#21262d]",
  ].join(" ");
}

function buildTree(files) {
  const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
  for (const file of files) {
    const path = file.newPath || file.oldPath || file.displayPath;
    const parts = path.split("/");
    let node = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: new Map(),
          file: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
      if (isLeaf) node.file = file;
    }
  }
  return root;
}

function renderTreeNode(node, depth) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indentPx = 12;
  const collapsed = state.collapsedDirsByMode[state.mode];

  for (const child of children) {
    if (child.kind === "dir") {
      const isCollapsed = collapsed[child.path] === true;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] text-[#c9d1d9] hover:bg-[#21262d]";
      row.style.paddingLeft = `${depth * indentPx + 8}px`;
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-[#8b949e] transition-transform ${isCollapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="truncate">${escapeHtml(child.name)}</span>
      `;
      row.addEventListener("click", () => {
        collapsed[child.path] = !isCollapsed;
        renderTree();
      });
      fileTreeEl.appendChild(row);
      if (!isCollapsed) {
        renderTreeNode(child, depth + 1);
      }
      continue;
    }

    const file = child.file;
    const count = state.comments.filter((comment) => comment.fileId === file.id).length;
    const reviewed = isFileReviewed(file);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[13px]",
      file.id === activeFileId() ? "bg-[#373e47] text-white" : reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
    ].join(" ");
    button.style.paddingLeft = `${(depth * indentPx) + 26}px`;
    button.innerHTML = `
      <span class="flex min-w-0 items-center gap-1.5 truncate ${file.id === activeFileId() ? "font-medium" : ""}">
        <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : "text-transparent"}">●</span>
        <span class="truncate">${escapeHtml(child.name)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        <span class="font-medium ${statusBadgeClass(file.status)}">${escapeHtml(statusLabel(file.status).charAt(0))}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      saveCurrentScrollPosition();
      setActiveFileId(file.id);
      renderAll({ restoreFileScroll: true });
    });
    fileTreeEl.appendChild(button);
  }
}

function renderTree() {
  fileTreeEl.innerHTML = "";
  const files = filesForMode();
  renderTreeNode(buildTree(files), 0);

  const comments = state.comments.length;
  const committedSuffix = state.mode === "committed" ? "commits" : "working tree";
  summaryEl.textContent = `${files.length} file(s) • ${comments} comment(s) • ${committedSuffix}${state.overallComment ? " • overall note" : ""}`;
}

function renderNotice() {
  const messages = [];

  if (payloadParseError) {
    messages.push(`Payload parse error: ${payloadParseError} (payload bytes: ${reviewData.diagnostics.payloadBytes ?? rawPayloadText.length}).`);
  }

  const modeNotice = activeModeData().notice;
  if (modeNotice) {
    messages.push(modeNotice);
  }

  if (!payloadParseError && filesForMode().length === 0) {
    const diag = reviewData.diagnostics || {};
    messages.push(
      `No files in current mode. Diagnostics: committed=${diag.committedFiles ?? 0}, working=${diag.workingFiles ?? 0}, payload=${diag.payloadBytes ?? rawPayloadText.length} bytes.`,
    );
  }

  if (messages.length > 0) {
    reviewNoticeEl.className = "rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200";
    reviewNoticeEl.textContent = messages.join(" ");
    return;
  }

  reviewNoticeEl.className = "hidden";
  reviewNoticeEl.textContent = "";
}

function renderRevisionStrip() {
  const file = activeFile();
  revisionStripEl.innerHTML = "";

  if (!file) {
    revisionStripEl.innerHTML = `<div class="text-xs text-review-muted">No file selected.</div>`;
    return;
  }

  const selection = fileSelection(file);
  const nodes = file.revision.nodes;

  const rows = [
    {
      key: "from",
      label: "From",
      nodes: nodes.filter((node) => node.kind !== "working-tree"),
      selectedId: selection.from,
    },
    {
      key: "to",
      label: "To",
      nodes,
      selectedId: selection.to,
    },
  ];

  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "flex items-center gap-2";

    const label = document.createElement("div");
    label.className = "w-8 shrink-0 text-[11px] font-semibold text-review-muted";
    label.textContent = row.label;
    rowEl.appendChild(label);

    const strip = document.createElement("div");
    strip.className = "scrollbar-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5";

    for (const node of row.nodes) {
      const isSelected = row.selectedId === node.id;
      const isCheckpoint = file.revision.checkpointNodeId === node.id;
      const isHead = file.revision.headNodeId === node.id;

      let text = humanizeNode(node);
      if (node.kind === "commit" && node.subject) {
        text = `${node.shortSha}`;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = [
        "cursor-pointer rounded border px-2 py-0.5 text-[11px] whitespace-nowrap",
        isSelected ? "border-[#1f6feb] bg-[#1f6feb]/20 text-white" : "border-review-border bg-review-panel text-review-text hover:bg-[#21262d]",
      ].join(" ");

      button.title = node.kind === "commit"
        ? `${node.shortSha}${node.subject ? ` • ${node.subject}` : ""}`
        : humanizeNode(node);

      const suffixes = [];
      if (isHead) suffixes.push("H");
      if (isCheckpoint) suffixes.push("R");
      if (suffixes.length > 0) {
        text = `${text} [${suffixes.join("")}]`;
      }

      button.textContent = text;
      button.addEventListener("click", () => {
        const start = performance.now();
        const draft = { ...fileSelection(file) };

        if (row.key === "from") {
          draft.from = node.id;
        } else {
          draft.to = node.id;
        }

        setFileSelection(file, draft);
        renderAll({ preserveScroll: true });
        state.lastRangeSwitchMs = Math.round(performance.now() - start);
        updateRangeSummary();
      });

      strip.appendChild(button);
    }

    rowEl.appendChild(strip);
    revisionStripEl.appendChild(rowEl);
  }
}

function updateRangeSummary() {
  const file = activeFile();
  if (!file) {
    rangeSummaryEl.textContent = "Select a file to review.";
    return;
  }

  const selection = fileSelection(file);
  const from = nodeById(file, selection.from);
  const to = nodeById(file, selection.to);

  const parts = [`${humanizeNode(from)} → ${humanizeNode(to)}`];
  if (file.revision.checkpointNodeId) {
    const checkpointNode = nodeById(file, file.revision.checkpointNodeId);
    parts.push(`reviewed through ${humanizeNode(checkpointNode)}`);
  } else {
    parts.push("unreviewed");
  }

  if (state.lastRangeSwitchMs != null) {
    parts.push(`${state.lastRangeSwitchMs}ms`);
  }

  rangeSummaryEl.textContent = parts.join(" • ");
}

function updateToggleButtons() {
  const file = activeFile();

  if (file) {
    const toggle = reviewToggleState(file);
    toggleReviewedButton.innerHTML = reviewToggleIcon(toggle.icon);
    toggleReviewedButton.title = toggle.title;
    toggleReviewedButton.ariaLabel = toggle.label;
    toggleReviewedButton.disabled = toggle.disabled;
    toggleReviewedButton.className = toggle.className;
  } else {
    toggleReviewedButton.innerHTML = reviewToggleIcon("pending");
    toggleReviewedButton.title = "Select a file";
    toggleReviewedButton.ariaLabel = "Select a file";
    toggleReviewedButton.disabled = true;
    toggleReviewedButton.className = "cursor-not-allowed inline-flex h-8 w-8 items-center justify-center rounded-md border border-review-border bg-review-panel text-review-muted opacity-60";
  }

  toggleUnchangedButton.textContent = state.hideUnchanged ? "Show full file" : "Show changed areas only";
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  submitButton.disabled = false;
}

function performReviewToggle(file) {
  const toggle = reviewToggleState(file);
  if (toggle.disabled || toggle.action == null) return;

  if (toggle.action === "clear") {
    const checkpointNodeId = file.revision.checkpointNodeId;
    if (!checkpointNodeId) return;

    file.revision.checkpointNodeId = null;
    file.revision.defaultFromNodeId = "base";

    const workingNode = workingTreeNode(file);
    const defaultToNodeId = state.mode === "working" && workingNode != null
      ? workingNode.id
      : file.revision.defaultToNodeId;

    setFileSelection(file, { from: "base", to: defaultToNodeId });

    window.glimpse.send({
      type: "checkpoint-clear",
      fileKey: file.fileKey,
    });

    renderAll({ preserveScroll: true });
    return;
  }

  const selection = fileSelection(file);
  const toNode = nodeById(file, selection.to);
  if (!toNode || toNode.kind !== "commit") return;

  file.revision.checkpointNodeId = toNode.id;
  file.revision.defaultFromNodeId = toNode.id;

  window.glimpse.send({
    type: "checkpoint-save",
    fileKey: file.fileKey,
    commitSha: toNode.sha,
  });

  renderAll({ preserveScroll: true });
}

function jumpToNextHunk(file) {
  if (!diffEditor || !monacoApi) return;

  const lineChanges = diffEditor.getLineChanges() || [];
  if (lineChanges.length === 0) return;

  const selection = fileSelection(file);
  const cursorKey = `${state.mode}:${file.id}:${selection.from}:${selection.to}`;

  if (state.hunkCursorKey !== cursorKey) {
    state.hunkCursorKey = cursorKey;
    state.hunkCursorIndex = -1;
  }

  const nextIndex = state.hunkCursorIndex + 1;
  if (nextIndex >= lineChanges.length) {
    return;
  }

  state.hunkCursorIndex = nextIndex;
  const change = lineChanges[nextIndex];

  const preferredLine = change.modifiedStartLineNumber > 0
    ? change.modifiedStartLineNumber
    : change.modifiedEndLineNumber > 0
      ? change.modifiedEndLineNumber
      : change.originalStartLineNumber > 0
        ? change.originalStartLineNumber
        : 1;

  const modifiedEditor = diffEditor.getModifiedEditor();
  modifiedEditor.revealLineInCenter(preferredLine);
  modifiedEditor.setPosition({ lineNumber: preferredLine, column: 1 });
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showShortcutsModal() {
  if (document.getElementById("review-shortcuts-modal")) return;

  const backdrop = document.createElement("div");
  backdrop.id = "review-shortcuts-modal";
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="text-base font-semibold text-white">Keyboard shortcuts</div>
        <button id="review-shortcuts-close" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]">Close</button>
      </div>
      <div class="space-y-2 text-sm text-review-text">
        <div class="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1">
          <div class="font-mono text-xs text-review-muted">?</div><div>Open this shortcuts dialog</div>
          <div class="font-mono text-xs text-review-muted">R</div><div>Toggle reviewed through selected <strong>To</strong> commit</div>
          <div class="font-mono text-xs text-review-muted">B</div><div>Set <strong>From</strong> to checkpoint (or Base)</div>
          <div class="font-mono text-xs text-review-muted">H</div><div>Set <strong>To</strong> to Head commit</div>
          <div class="font-mono text-xs text-review-muted">[ / ]</div><div>Move <strong>To</strong> older / newer</div>
          <div class="font-mono text-xs text-review-muted">Shift+[ / Shift+]</div><div>Move <strong>From</strong> older / newer</div>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    backdrop.remove();
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });

  backdrop.querySelector("#review-shortcuts-close").addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKeyDown, true);
}

function showOverallCommentModal() {
  showTextModal({
    title: "Overall review note",
    description: "This note is prepended to the generated prompt above the inline comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      renderTree();
    },
  });
}

function showFileCommentModal() {
  const file = activeFile();
  if (!file) return;
  showTextModal({
    title: `File comment for ${file.displayPath}`,
    description: "This comment applies to the whole file and appears above the diff.",
    initialValue: "",
    saveLabel: "Add comment",
    onSave: (value) => {
      if (!value) return;
      state.comments.push({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        fileId: file.id,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
      submitButton.disabled = false;
      updateCommentsUI();
    },
  });
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function layoutEditor() {
  if (!diffEditor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  diffEditor.layout({ width, height });
}

function clearViewZones() {
  if (!diffEditor || activeViewZones.length === 0) return;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  activeViewZones = [];
}

function renderCommentDOM(comment, onDelete) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  const title = comment.side === "file"
    ? "File comment"
    : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.startLine}`;

  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (!comment.body) {
    setTimeout(() => textarea.focus(), 50);
  }
  return container;
}

function syncViewZones() {
  clearViewZones();
  if (!diffEditor) return;
  const file = activeFile();
  if (!file) return;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = state.comments.filter((c) => c.fileId === file.id && c.side !== "file");

  inlineComments.forEach((item) => {
    const editor = item.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(item, () => {
      state.comments = state.comments.filter((c) => c.id !== item.id);
      updateCommentsUI();
    });

    editor.changeViewZones((accessor) => {
      const lineCount = typeof item.body === "string" && item.body.length > 0 ? item.body.split("\n").length : 1;
      const id = accessor.addZone({
        afterLineNumber: item.startLine,
        heightInPx: Math.max(150, lineCount * 22 + 86),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });
}

function updateDecorations() {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  const comments = file ? state.comments.filter((comment) => comment.fileId === file.id && comment.side !== "file") : [];
  const originalRanges = [];
  const modifiedRanges = [];

  for (const comment of comments) {
    const range = {
      range: new monacoApi.Range(comment.startLine, 1, comment.startLine, 1),
      options: {
        isWholeLine: true,
        className: comment.side === "original" ? "review-comment-line-original" : "review-comment-line-modified",
        glyphMarginClassName: comment.side === "original" ? "review-comment-glyph-original" : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, originalRanges);
  modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modifiedRanges);
}

function renderFileComments() {
  fileCommentsContainer.innerHTML = "";
  const file = activeFile();
  if (!file) return;

  const fileComments = state.comments.filter((c) => c.fileId === file.id && c.side === "file");

  if (fileComments.length > 0) {
    fileCommentsContainer.className = "border-b border-review-border bg-[#0d1117] px-4 py-4 space-y-4";
  } else {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileComments.forEach((comment) => {
    const dom = renderCommentDOM(comment, () => {
      state.comments = state.comments.filter((c) => c.id !== comment.id);
      updateCommentsUI();
    });
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  });
}

function mountFile(options = {}) {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  if (!file) return;

  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll ? captureScrollState() : null;

  const selection = fileSelection(file);
  let oldContent = getNodeContent(file, selection.from);
  let newContent = getNodeContent(file, selection.to);

  const needsRangeFetch = oldContent == null || newContent == null;
  if (needsRangeFetch) {
    requestRangeContent(file, selection.from, selection.to);
    if (oldContent == null) oldContent = "Loading previous revision content…";
    if (newContent == null) newContent = "Loading selected revision content…";
  }

  clearViewZones();
  currentFileLabelEl.textContent = file.displayPath;
  updateRangeSummary();
  const language = inferLanguage(file.newPath || file.oldPath || file.displayPath);

  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();

  originalModel = monacoApi.editor.createModel(oldContent, language);
  modifiedModel = monacoApi.editor.createModel(newContent, language);

  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  applyEditorOptions();

  syncViewZones();
  updateDecorations();
  renderFileComments();
  requestAnimationFrame(() => {
    layoutEditor();
    if (options.restoreFileScroll) restoreFileScrollPosition();
    if (options.preserveScroll) restoreScrollState(scrollState);
    setTimeout(() => {
      layoutEditor();
      if (options.restoreFileScroll) restoreFileScrollPosition();
      if (options.preserveScroll) restoreScrollState(scrollState);
    }, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) {
      comment.body = textarea.value;
    }
  });
}

function updateCommentsUI() {
  renderTree();
  renderRevisionStrip();
  updateToggleButtons();
  syncViewZones();
  updateDecorations();
  renderFileComments();
}

function ensureActiveFile() {
  const files = filesForMode();
  if (files.length === 0) {
    setActiveFileId(null);
    return;
  }
  if (!files.some((file) => file.id === activeFileId())) {
    setActiveFileId(files[0].id);
  }
}

function renderAll(options = {}) {
  ensureActiveFile();
  updateModeButtons();
  renderNotice();
  renderTree();
  renderRevisionStrip();
  updateToggleButtons();
  submitButton.disabled = false;
  if (diffEditor && monacoApi) {
    mountFile(options);
    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
    });
  } else {
    renderFileComments();
  }
}

window.__piDiffReviewReceiveRangeContent = function receiveRangeContent(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.requestId !== state.pendingRangeRequestId) return;
  if (payload.mode !== state.mode) return;

  const file = filesForMode().find((candidate) => candidate.id === payload.fileId);
  if (!file) return;

  const cache = fileContentCache(file);
  cache[payload.fromNodeId] = payload.oldContent ?? "";
  cache[payload.toNodeId] = payload.newContent ?? "";

  renderAll({ preserveScroll: true });
};

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    const file = activeFile();
    if (!file) return;
    state.comments.push({
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: file.id,
      side,
      startLine: line,
      endLine: line,
      body: "",
    });
    updateCommentsUI();
    editor.revealLineInCenter(line);
  }

  editor.onMouseMove((event) => {
    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [{
        range: new monacoApi.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" },
      }]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

function setupMonaco() {
  window.require.config({
    paths: {
      vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    },
  });

  window.require(["vs/editor/editor.main"], function () {
    monacoApi = window.monaco;

    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
      },
    });
    monacoApi.editor.setTheme("review-dark");

    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
    });

    createGlyphHoverActions(diffEditor.getOriginalEditor(), "original");
    createGlyphHoverActions(diffEditor.getModifiedEditor(), "modified");

    if (typeof ResizeObserver !== "undefined") {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    renderAll();
  });
}

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  const payload = {
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: state.comments.map((comment) => ({ ...comment, body: comment.body.trim() })).filter((comment) => comment.body.length > 0),
  };
  window.glimpse.send(payload);
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

shortcutsButton?.addEventListener("click", () => {
  showShortcutsModal();
});

overallCommentButton.addEventListener("click", () => {
  showOverallCommentModal();
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

modeCommittedButton.addEventListener("click", () => {
  if (!modeData("committed").available) return;
  if (state.mode === "committed") return;
  saveCurrentScrollPosition();
  state.mode = "committed";
  renderAll({ restoreFileScroll: true });
});

modeWorkingButton.addEventListener("click", () => {
  if (state.mode === "working") return;
  saveCurrentScrollPosition();
  state.mode = "working";
  renderAll({ restoreFileScroll: true });
});

toggleUnchangedButton.addEventListener("click", () => {
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(layoutEditor);
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

window.addEventListener("keydown", (e) => {
  if (isTypingTarget(e.target)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.repeat) return;

  if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
    e.preventDefault();
    showShortcutsModal();
    return;
  }

  if (document.querySelector(".review-modal-backdrop")) return;

  const file = activeFile();
  if (!file) return;

  if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    jumpToNextHunk(file);
    return;
  }

  const selection = fileSelection(file);
  const floors = floorNodes(file);
  const ceilings = ceilingNodes(file);
  const floorIndex = floors.findIndex((node) => node.id === selection.from);
  const ceilingIndex = ceilings.findIndex((node) => node.id === selection.to);

  if (e.key === "r" || e.key === "R") {
    e.preventDefault();
    performReviewToggle(file);
    return;
  }

  if (e.key === "b" || e.key === "B") {
    e.preventDefault();
    applyFloorSelection(file, file.revision.defaultFromNodeId || "base");
    return;
  }

  if (e.key === "h" || e.key === "H") {
    e.preventDefault();
    applyCeilingSelection(file, file.revision.headNodeId);
    return;
  }

  if (e.key === "[" && !e.shiftKey) {
    if (ceilingIndex <= 0) return;
    e.preventDefault();
    applyCeilingSelection(file, ceilings[ceilingIndex - 1].id);
    return;
  }

  if (e.key === "]" && !e.shiftKey) {
    if (ceilingIndex < 0 || ceilingIndex >= ceilings.length - 1) return;
    e.preventDefault();
    applyCeilingSelection(file, ceilings[ceilingIndex + 1].id);
    return;
  }

  if (e.key === "{" || (e.key === "[" && e.shiftKey)) {
    if (floorIndex <= 0) return;
    e.preventDefault();
    applyFloorSelection(file, floors[floorIndex - 1].id);
    return;
  }

  if (e.key === "}" || (e.key === "]" && e.shiftKey)) {
    if (floorIndex < 0 || floorIndex >= floors.length - 1) return;
    e.preventDefault();
    applyFloorSelection(file, floors[floorIndex + 1].id);
  }
});

toggleReviewedButton.addEventListener("click", () => {
  const file = activeFile();
  if (!file) return;
  performReviewToggle(file);
});

renderAll();
renderFileComments();
setupMonaco();
