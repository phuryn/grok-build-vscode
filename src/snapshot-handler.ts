import * as path from "path";
import * as fs from "fs/promises";
import { captureScreen, SnapshotResult } from "./snapshot";

export interface SnapshotHandlerDependencies {
  captureScreen: (options?: { outputPath?: string }) => Promise<SnapshotResult>;
  attachImage: (filePath: string) => Promise<void | unknown>;
  showInformationMessage: (msg: string) => void;
  showErrorMessage: (msg: string) => void;
}

export interface SnapshotSidebarTarget {
  attachSnapshot?: (filePath: string) => Promise<unknown>;
}

export async function handleTakeSnapshotCommand(
  deps?: Partial<SnapshotHandlerDependencies>,
  sidebar?: SnapshotSidebarTarget,
): Promise<void> {
  const capture = deps?.captureScreen ?? captureScreen;
  const attach = deps?.attachImage ?? (async (filePath: string) => {
    if (sidebar) {
      if (typeof sidebar.attachSnapshot === "function") {
        await sidebar.attachSnapshot(filePath);
      }
    }
  });
  const showInfo = deps?.showInformationMessage ?? ((msg: string) => {
    try {
      // Dynamic require vscode in VS Code extension context
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require("vscode");
      void vscode.window.showInformationMessage(msg);
    } catch {
      // noop in headless/test environments
    }
  });
  const showError = deps?.showErrorMessage ?? ((msg: string) => {
    try {
      // Dynamic require vscode in VS Code extension context
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require("vscode");
      void vscode.window.showErrorMessage(msg);
    } catch {
      // noop in headless/test environments
    }
  });

  let customSaveDir: string | undefined;
  let autoAttach = true;

  if (sidebar && (sidebar as any).host && typeof (sidebar as any).host.getConfiguration === "function") {
    try {
      const cfg = (sidebar as any).host.getConfiguration("grok");
      const savePathVal = cfg.get("snapshot.savePath") as string | undefined;
      if (savePathVal && typeof savePathVal === "string" && savePathVal.trim()) {
        customSaveDir = savePathVal.trim();
      }
      const autoAttachVal = cfg.get("snapshot.autoAttach") as boolean | undefined;
      if (typeof autoAttachVal === "boolean") {
        autoAttach = autoAttachVal;
      }
    } catch {
      // ignore
    }
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require("vscode");
      const cfg = vscode.workspace.getConfiguration("grok.snapshot");
      const savePathVal = cfg.get("savePath") as string | undefined;
      if (savePathVal && typeof savePathVal === "string" && savePathVal.trim()) {
        customSaveDir = savePathVal.trim();
      }
      const autoAttachVal = cfg.get("autoAttach") as boolean | undefined;
      if (typeof autoAttachVal === "boolean") {
        autoAttach = autoAttachVal;
      }
    } catch {
      // noop outside vscode runtime
    }
  }

  let outputPath: string | undefined;
  if (customSaveDir) {
    try {
      await fs.mkdir(customSaveDir, { recursive: true });
      outputPath = path.join(customSaveDir, `grok-snapshot-${Date.now()}.png`);
    } catch (err) {
      showError(`Grok Snapshot: could not create target folder '${customSaveDir}': ${(err as Error).message}`);
      return;
    }
  }

  const result = await capture(outputPath ? { outputPath } : undefined);
  if (result.success && result.filePath) {
    if (autoAttach) {
      await attach(result.filePath);
      showInfo(`Grok: Screen snapshot attached to chat (${result.filePath}).`);
    } else {
      showInfo(`Grok: Screen snapshot saved to ${result.filePath}`);
    }
  } else {
    showError(`Grok Snapshot failed: ${result.error ?? "Unknown error"}`);
  }
}
