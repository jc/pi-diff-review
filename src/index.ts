import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { clearRepoCheckpoint, loadRepoCheckpoints, saveRepoCheckpoint } from "./checkpoints.js";
import { getDiffReviewFiles } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  DiffReviewFile,
  DiffReviewWindowData,
  ReviewCancelPayload,
  ReviewCheckpointClearPayload,
  ReviewCheckpointSavePayload,
  ReviewRangeContentRequestPayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isCheckpointSavePayload(value: ReviewWindowMessage): value is ReviewCheckpointSavePayload {
  return value.type === "checkpoint-save";
}

function isCheckpointClearPayload(value: ReviewWindowMessage): value is ReviewCheckpointClearPayload {
  return value.type === "checkpoint-clear";
}

function isRangeContentRequestPayload(value: ReviewWindowMessage): value is ReviewRangeContentRequestPayload {
  return value.type === "range-content-request";
}

function collectAllFiles(data: DiffReviewWindowData): DiffReviewFile[] {
  const seen = new Set<string>();
  const files: DiffReviewFile[] = [];

  for (const mode of [data.modes.committed, data.modes.working]) {
    for (const file of mode.files) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      files.push(file);
    }
  }

  return files;
}

function applyCheckpointDefaults(data: DiffReviewWindowData, checkpoints: Map<string, string>): void {
  for (const mode of [data.modes.committed, data.modes.working]) {
    for (const file of mode.files) {
      const checkpointSha = checkpoints.get(file.fileKey) ?? null;
      const checkpointNode = file.revision.nodes.find((node) => node.kind === "commit" && node.sha === checkpointSha);
      const workingTreeNode = file.revision.nodes.find((node) => node.kind === "working-tree");

      file.revision.checkpointNodeId = checkpointNode?.id ?? null;
      file.revision.defaultFromNodeId = file.revision.checkpointNodeId ?? "base";

      if (mode.mode === "working") {
        file.revision.defaultToNodeId = workingTreeNode?.id ?? file.revision.headNodeId;
      } else {
        file.revision.defaultToNodeId = file.revision.headNodeId;
      }

      file.oldContent = file.revision.nodeContents[file.revision.defaultFromNodeId] ?? "";
      file.newContent = file.revision.nodeContents[file.revision.defaultToNodeId] ?? "";
    }
  }
}

function buildClientReviewData(fullData: DiffReviewWindowData): DiffReviewWindowData {
  const cloneMode = (mode: DiffReviewWindowData["modes"]["committed"]) => ({
    ...mode,
    files: mode.files.map((file) => {
      return {
        ...file,
        oldContent: "",
        newContent: "",
        revision: {
          ...file.revision,
          nodeContents: {},
        },
      };
    }),
  });

  return {
    repoRoot: fullData.repoRoot,
    defaultMode: fullData.defaultMode,
    modes: {
      committed: cloneMode(fullData.modes.committed),
      working: cloneMode(fullData.modes.working),
    },
    diagnostics: {
      ...(fullData.diagnostics ?? {}),
      committedFiles: fullData.modes.committed.files.length,
      workingFiles: fullData.modes.working.files.length,
    },
  };
}

function findFileByModeAndId(data: DiffReviewWindowData, mode: "committed" | "working", fileId: string): DiffReviewFile | null {
  return data.modes[mode].files.find((file) => file.id === fileId) ?? null;
}

function sendRangeContent(
  window: GlimpseWindow,
  payload: {
    requestId: number;
    mode: "committed" | "working";
    fileId: string;
    fromNodeId: string;
    toNodeId: string;
    oldContent: string;
    newContent: string;
  },
): void {
  const encoded = JSON.stringify(payload)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  window.send(`window.__piDiffReviewReceiveRangeContent?.(JSON.parse(\`${encoded}\`));`);
}

type WaitingEditorResult = "escape" | "window-settled";

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native diff review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewDiff(ctx: ExtensionCommandContext): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A diff review window is already open.", "warning");
      return;
    }

    const fullReviewData = await getDiffReviewFiles(pi, ctx.cwd);
    const checkpoints = await loadRepoCheckpoints(fullReviewData.repoRoot);
    applyCheckpointDefaults(fullReviewData, checkpoints);

    const allFiles = collectAllFiles(fullReviewData);
    if (allFiles.length === 0) {
      ctx.ui.notify("No changes to review.", "info");
      return;
    }

    const clientReviewData = buildClientReviewData(fullReviewData);
    clientReviewData.diagnostics = {
      ...(clientReviewData.diagnostics ?? {}),
      payloadBytes: Buffer.byteLength(JSON.stringify(clientReviewData), "utf8"),
      committedFiles: clientReviewData.modes.committed.files.length,
      workingFiles: clientReviewData.modes.working.files.length,
    };

    const html = buildReviewHtml(clientReviewData);
    const payloadKb = Math.round((clientReviewData.diagnostics.payloadBytes ?? 0) / 1024);
    ctx.ui.notify(
      `Review payload: working ${clientReviewData.modes.working.files.length}, committed ${clientReviewData.modes.committed.files.length}, ${payloadKb}KB`,
      "info",
    );

    const window = open(html, {
      width: 1680,
      height: 1020,
      title: "pi diff review",
    });
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);

    ctx.ui.notify("Opened native diff review window.", "info");

    try {
      const windowMessagePromise = new Promise<ReviewWindowMessage | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewWindowMessage | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;

          if (isCheckpointSavePayload(message)) {
            saveRepoCheckpoint(fullReviewData.repoRoot, message.fileKey, message.commitSha).catch((error) => {
              const text = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Failed to save checkpoint: ${text}`, "error");
            });
            return;
          }

          if (isCheckpointClearPayload(message)) {
            clearRepoCheckpoint(fullReviewData.repoRoot, message.fileKey).catch((error) => {
              const text = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Failed to clear checkpoint: ${text}`, "error");
            });
            return;
          }

          if (isRangeContentRequestPayload(message)) {
            const file = findFileByModeAndId(fullReviewData, message.mode, message.fileId);
            if (!file) return;

            sendRangeContent(window, {
              requestId: message.requestId,
              mode: message.mode,
              fileId: message.fileId,
              fromNodeId: message.fromNodeId,
              toNodeId: message.toNodeId,
              oldContent: file.revision.nodeContents[message.fromNodeId] ?? "",
              newContent: file.revision.nodeContents[message.toNodeId] ?? "",
            });
            return;
          }

          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        windowMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await windowMessagePromise.catch(() => null);
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await windowMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || isCancelPayload(message)) {
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      if (!isSubmitPayload(message)) {
        ctx.ui.notify("Diff review returned an unknown payload.", "error");
        return;
      }

      const prompt = composeReviewPrompt(allFiles, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted diff review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diff review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native diff review window and insert review feedback into the editor",
    handler: async (_args, ctx) => {
      await reviewDiff(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
