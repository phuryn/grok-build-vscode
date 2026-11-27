/**
 * Preload: expose an `acquireVsCodeApi()`-compatible surface so unmodified
 * `media/chat.js` boots under Electron (contextIsolation, no nodeIntegration).
 *
 * Host → webview messages are re-dispatched as `window` MessageEvents so
 * chat.js's existing `window.addEventListener("message", …)` keeps working.
 *
 * File drops are registered host-side from real OS File objects (webUtils) and
 * posted as opaque handles — the page never supplies a free-form path that
 * `dropFile` will honor.
 *
 * Note: preload runs in a DOM context but our package tsconfig has no "DOM" lib
 * (extension host is Node). Use minimal ambient typing instead of adding DOM
 * globally to every module.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_CONVERSATIONS_ARG, DESKTOP_CONVERSATION_PANE_ARG,
  type DesktopMainCloseSnapshot, type DesktopPaneCloseSnapshot,
} from "./conversation-layout";

declare const window: {
  dispatchEvent(event: { type: string; data?: unknown }): boolean;
  addEventListener(
    type: string,
    listener: (ev: unknown) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  document?: {
    addEventListener(
      type: string,
      listener: (ev: unknown) => void,
      options?: boolean | { capture?: boolean },
    ): void;
  };
};

// Minimal stand-in — preload only needs type + data for chat.js.
class PreloadMessageEvent {
  type = "message";
  constructor(public data: unknown) {}
}

let state: unknown;

const api = {
  postMessage(message: unknown): void {
    ipcRenderer.send("webview-to-host", message);
  },
  getState(): unknown {
    return state;
  },
  setState(newState: unknown): unknown {
    state = newState;
    return newState;
  },
};

contextBridge.exposeInMainWorld("acquireVsCodeApi", () => api);

/**
 * Marks the Electron desktop shell for shared chat.js (font scale, etc.).
 * Deliberately separate from the file-tree bridge so chat.js never imports
 * path-listing APIs — only this capability flag.
 */
contextBridge.exposeInMainWorld("grokDesktopShell", true);

const isConversationPane = process.argv.includes(DESKTOP_CONVERSATION_PANE_ARG);
if (isConversationPane) {
  contextBridge.exposeInMainWorld("grokDesktopConversations", {
    close: (draft: DesktopPaneCloseSnapshot) => ipcRenderer.invoke("desk-conversations:close", draft),
    filePanelChanged: (open: boolean) => ipcRenderer.send("desk-conversations:files-open", open),
  });
} else if (process.argv.includes(DESKTOP_CONVERSATIONS_ARG)) {
  contextBridge.exposeInMainWorld("grokDesktopConversations", {
    openBeside: (id: string, cwd?: string) => ipcRenderer.send("desk-conversations:open", id, cwd, true),
    open: (id: string, cwd?: string) => ipcRenderer.send("desk-conversations:open", id, cwd, false),
    setBounds: (bounds: unknown, zoom: number, filesOpen: boolean) => ipcRenderer.send("desk-conversations:bounds", bounds, zoom, filesOpen),
    setCovered: (covered: boolean) => ipcRenderer.send("desk-conversations:covered", covered),
    close: (draft: DesktopMainCloseSnapshot) => ipcRenderer.invoke("desk-conversations:close-main", draft),
    saveMainDraft: (id: string | null, text: string, chipIds: string[]) =>
      ipcRenderer.send("desk-conversations:main-draft", id, text, chipIds),
  });
}

/**
 * Desktop-only file-tree bridge (not used by chat.js). Paths are re-validated
 * in the main process — the renderer is not trusted for containment.
 */
contextBridge.exposeInMainWorld("grokDesktopFileTree", {
  list: (relPath: string, root?: string) => ipcRenderer.invoke("desk-ft:list", relPath, root),
  open: (relPath: string, root?: string) => ipcRenderer.invoke("desk-ft:open", relPath, root),
  reveal: (relPath: string, root?: string) => ipcRenderer.invoke("desk-ft:reveal", relPath, root),
  read: (relPath: string, expectedRoot?: string) => ipcRenderer.invoke("desk-ft:read", relPath, expectedRoot),
  save: (request: { relPath: string; text: string; stamp: { mtimeMs: number; size: number }; absPath: string }, root?: string) =>
    ipcRenderer.invoke("desk-ft:save", request, root),
  root: () => ipcRenderer.invoke("desk-ft:root"),
  /**
   * The Changes view. `gitRun` names an operation, never an argv — the main
   * process rebuilds the command from its own fresh snapshot, so nothing the
   * renderer sends becomes a git argument without passing a validator there.
   */
  gitStatus: (root?: string) => ipcRenderer.invoke("desk-ft:git-status", root),
  gitDiff: (relPath: string, root?: string) => ipcRenderer.invoke("desk-ft:git-diff", relPath, root),
  gitRun: (request: {
    op: "commit" | "push" | "newBranch" | "revertFile";
    message?: string;
    push?: boolean;
    paths?: string[];
    branch?: string;
    path?: string;
  }, root?: string) => ipcRenderer.invoke("desk-ft:git-run", request, root),
  /** Subscribe to active-project changes so the panel can rebind its tree. */
  onRootChanged: (cb: () => void) => {
    const handler = () => {
      try {
        cb();
      } catch {
        /* best-effort */
      }
    };
    ipcRenderer.on("desk-ft:root-changed", handler);
    return () => {
      ipcRenderer.removeListener("desk-ft:root-changed", handler);
    };
  },
});

// Theme preference lives in localStorage under the stable app-resource origin
// (see APP_DOCUMENT_URL). No IPC bridge — same mechanism as rail shape / file panel.

// Forward main→renderer posts into the same channel VS Code webviews use.
ipcRenderer.on("host-to-webview", (_event, message: unknown) => {
  // Prefer a real MessageEvent when the DOM constructor exists (always in Electron preload).
  try {
    // eslint-disable-next-line no-undef
    const Ev = (globalThis as { MessageEvent?: new (type: string, init: { data: unknown }) => Event }).MessageEvent;
    if (Ev) {
      window.dispatchEvent(new Ev("message", { data: message }) as unknown as { type: string; data?: unknown });
      return;
    }
  } catch {
    /* fall through */
  }
  window.dispatchEvent(new PreloadMessageEvent(message));
});

/**
 * Genuine OS file drops: read paths from Chromium File objects (not inventable
 * as free-form strings from page script), mint host handles, post dropFile with
 * handle only. Capture-phase so chat.js's path-based dropFile never runs on
 * desktop (that shape is refused by the host policy gate anyway).
 */
function wireDesktopFileDrop(): void {
  const doc = (
    globalThis as {
      document?: {
        addEventListener(
          type: string,
          listener: (ev: unknown) => void,
          options?: boolean,
        ): void;
      };
    }
  ).document;
  if (!doc || typeof doc.addEventListener !== "function") return;

  const onDragOver = (ev: unknown) => {
    const e = ev as {
      dataTransfer?: { types?: { includes?: (t: string) => boolean } | ArrayLike<string> };
      preventDefault?: () => void;
    };
    const types = e.dataTransfer?.types;
    const hasFiles =
      types &&
      (typeof (types as { includes?: (t: string) => boolean }).includes === "function"
        ? (types as { includes: (t: string) => boolean }).includes("Files")
        : Array.from(types as ArrayLike<string>).includes("Files"));
    if (hasFiles) e.preventDefault?.();
  };

  const onDrop = (ev: unknown) => {
    const e = ev as {
      dataTransfer?: { files?: ArrayLike<unknown> };
      shiftKey?: boolean;
      preventDefault?: () => void;
      stopPropagation?: () => void;
    };
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        // Electron File from a genuine OS drop — getPathForFile refuses inventable blobs.
        const p = webUtils.getPathForFile(files[i] as Parameters<typeof webUtils.getPathForFile>[0]);
        if (p) paths.push(p);
      } catch {
        /* skip unreadable */
      }
    }
    if (!paths.length) return;
    const shift = !!e.shiftKey;
    void ipcRenderer.invoke("desk-file-sel:register", paths).then((handles: unknown) => {
      if (!Array.isArray(handles)) return;
      for (const handle of handles) {
        if (typeof handle !== "string" || !handle) continue;
        ipcRenderer.send("webview-to-host", {
          type: "dropFile",
          handle,
          shift,
        });
      }
    });
  };

  doc.addEventListener("dragover", onDragOver, true);
  doc.addEventListener("drop", onDrop, true);
}

// The main-window drop bridge has no editor binding.
if (!isConversationPane) {
  try {
    const g = globalThis as {
      document?: { readyState?: string };
      addEventListener?: (type: string, fn: () => void) => void;
    };
    if (g.document?.readyState === "loading") {
      g.addEventListener?.("DOMContentLoaded", wireDesktopFileDrop);
    } else {
      wireDesktopFileDrop();
    }
  } catch {
    /* best-effort */
  }
}
