/**
 * Electron implementation of the portable {@link Host} interface.
 *
 * File open (chat / openResource): revalidates containment, resolves bare
 * basenames under authorized roots, then opens **in the file panel** when the
 * type is previewable (md/json/image/text) and falls back to the OS default
 * handler (`shell.openPath`) only for non-renderable types. Missing files show
 * an in-app message — never a Windows shell "cannot find" dialog.
 * Diff / untitled text without a suggested filename: read-only internal
 * BrowserWindows (older clients, virtual-URI `openResource`, direct tests).
 * A suggested filename (session export / overlay Save As) opens the OS save
 * dialog; cancel writes nothing. The current desktop renderer routes View all
 * and proposed diffs to the in-app overlay (`previewInApp`) and does not
 * reach these windows.
 * AFK Pilot link/unlink: delegates to sidebar handlers wired after construction.
 * Device credentials: never stored by this module (see main.ts + safe-secrets).
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type {
  Host,
  HostCancellationToken,
  HostDisposable,
  HostFileSystem,
  HostFileSystemWatcher,
  HostInputBoxOptions,
  HostMessageOptions,
  HostOpenDialogOptions,
  HostProgressOptions,
  HostQuickPickItem,
  HostQuickPickOptions,
  HostSaveDialogOptions,
  HostTerminal,
  HostTerminalOptions,
  HostTextDocumentContentProvider,
  HostTextEditor,
  HostTextShowOptions,
  Uri,
} from "../host";
import { isFsPathInWorkspace } from "../host";
import {
  deliverSuggestedFileSave,
  saveDialogTitleForFilename,
  saveFiltersForFilename,
} from "./suggested-save";
import type { PanelPosition } from "../view-move";
import {
  canonicalizeSeedProjectPath,
  selectProjectsToSeed,
  shouldSeedProjectDiscovery,
} from "../project-discovery";
import {
  discoverRepos,
  indexWellFormedSessions,
  resolveGrokHome,
  type FsLike,
} from "../sessions";
import type { ConfigStore } from "./config-store";
import {
  ensureConfigToml,
  globalConfigPath,
  GLOBAL_CONFIG_STUB,
  projectConfigPath,
  PROJECT_CONFIG_STUB,
} from "../grok-config";
import {
  authorizeOpenUrl,
  desktopAuthRoots,
  resolveAuthorizedFileForOpen,
  type DesktopOpenFileContext,
} from "./desktop-policy";
import {
  buildDiffViewerHtml,
  buildTextViewerHtml,
  interpretOpenPathResult,
  resolveDocumentText,
} from "./document-view";
import {
  classifyFilePreview,
  isCanonicallyInsideRoot,
  nearestExistingAncestor,
} from "./file-tree";
import { openPathInFilePanel } from "./file-tree-ipc";
import {
  planOpenCliInTerminal,
  planRunCommandInTerminal,
  type ExternalTerminalPlan,
} from "./external-terminal";
import { findFilesUnder } from "./find-files";
import {
  buildInputBoxHtml,
  buildQuickPickHtml,
  DESKTOP_APP_SHORT_NAME,
  parseDialogSubmit,
  planMessageBoxButtons,
  resolveMessageBoxChoice,
  selectQuickPickIndex,
} from "./host-dialogs";
import { resolveExtensionRoot } from "./paths";
import { installWindowSecurityLocks } from "./window-security";

function splitMessageArgs(
  items: Array<string | HostMessageOptions>,
): { options?: HostMessageOptions; buttons: string[] } {
  if (items.length > 0 && typeof items[0] === "object" && items[0] !== null) {
    return { options: items[0] as HostMessageOptions, buttons: items.slice(1) as string[] };
  }
  return { buttons: items as string[] };
}

function parentWindow(getWindow: () => BrowserWindow | null): BrowserWindow | undefined {
  const w = getWindow();
  return w && !w.isDestroyed() ? w : undefined;
}

/**
 * Native message box with VS Code show*Message return semantics:
 * action label on click, `undefined` on Cancel / Esc / window close.
 * `modal` is accepted for API parity (Electron dialogs are always modal).
 */
async function messageBox(
  getWindow: () => BrowserWindow | null,
  kind: "info" | "warning" | "error",
  message: string,
  buttons: string[],
  modal?: boolean,
): Promise<string | undefined> {
  void modal;
  const plan = planMessageBoxButtons(buttons);
  const opts = {
    type: kind === "info" ? ("info" as const) : kind === "warning" ? ("warning" as const) : ("error" as const),
    message,
    buttons: plan.dialogButtons,
    defaultId: plan.defaultId,
    cancelId: plan.cancelId,
    noLink: true,
  };
  const win = parentWindow(getWindow);
  const result = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return resolveMessageBoxChoice(buttons, plan.dialogButtons, result.response);
}

const hostFs: HostFileSystem = {
  async readFile(uri) {
    return fs.promises.readFile(uri.fsPath);
  },
  async writeFile(uri, content) {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  },
  async createDirectory(uri) {
    await fs.promises.mkdir(uri.fsPath, { recursive: true });
  },
  async delete(uri, options) {
    await fs.promises.rm(uri.fsPath, {
      recursive: options?.recursive ?? false,
      force: true,
    });
  },
  async stat(uri) {
    const s = await fs.promises.stat(uri.fsPath);
    // VS Code FileType: File=1, Directory=2, SymbolicLink=64
    let type = s.isFile() ? 1 : s.isDirectory() ? 2 : 0;
    if (s.isSymbolicLink()) type |= 64;
    return {
      type,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  },
};

export interface ElectronRemoteActions {
  link: () => Promise<void>;
  unlink: () => Promise<void>;
}

export interface ElectronHostOptions {
  config: ConfigStore;
  getWindow: () => BrowserWindow | null;
  log: (line: string) => void;
  /**
   * AFK Pilot link/unlink — filled after GrokSidebar is constructed so the host
   * reuses the extension's uplink flow (no protocol reimplementation).
   */
  remoteActions?: { current?: ElectronRemoteActions };
  /**
   * Session-aware openFile roots (workspace + worktree). Wired after sidebar
   * exists; when missing, openFsPath refuses (fail closed). Same context the
   * message gate uses via ElectronWebview.getAuthContext.
   */
  getAuthContext?: () => DesktopOpenFileContext | undefined;
  /** Called when the active workspace folder changes (switch / add-as-active). */
  onWorkspaceRootChanged?: (root: string) => void;
  /** Called when the open-folder list changes (add / remove / first open). */
  onWorkspaceFoldersChanged?: (roots: string[], active: string | undefined) => void;
  /** Packaged desktop: quit and install a downloaded app update. */
  installAppUpdate?: () => void;
  /**
   * The file this app is writing its log to, once one exists.
   *
   * Absent means logging to a file could not be set up, and `showOutput` then
   * has nothing honest to offer — which is the state the whole app used to be
   * in permanently.
   */
  getLogFile?: () => string | undefined;
}

function openHtmlDocumentWindow(
  getWindow: () => BrowserWindow | null,
  title: string,
  html: string,
): BrowserWindow {
  const parent = parentWindow(getWindow);
  // Same packaging gate as the main window: no DevTools door in signed builds.
  // Deliberately do NOT auto-open DevTools here — these are ephemeral
  // diff/text viewers, not the chat surface under test.
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 400,
    minHeight: 300,
    title,
    parent: parent ?? undefined,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  installWindowSecurityLocks(win, {
    log: () => {},
    openExternal: (url) => {
      void shell.openExternal(url);
    },
  });
  // base64 data URL avoids encodeURIComponent length blow-ups for mid-size diffs.
  const dataUrl = "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
  void win.loadURL(dataUrl);
  return win;
}

/**
 * The app icon, for dialog title bars. Resolved once and cached — the lookup
 * touches the disk, and these windows open on a click.
 *
 * Same two candidates main.ts uses for the app window, in the same order. A
 * missing file is not an error worth surfacing: Electron simply falls back to
 * its own icon, which is what happened before this existed.
 */
let cachedDialogIcon: string | null | undefined;
function dialogIcon(): string | null {
  if (cachedDialogIcon !== undefined) return cachedDialogIcon;
  cachedDialogIcon = null;
  try {
    const root = resolveExtensionRoot();
    for (const name of ["grok-icon-round-512.png", "grok-icon.png"]) {
      const candidate = path.join(root, "resources", name);
      if (fs.existsSync(candidate)) {
        cachedDialogIcon = candidate;
        break;
      }
    }
  } catch {
    /* outside Electron (tests) — no icon, no failure */
  }
  return cachedDialogIcon;
}

/**
 * Modal HTML dialog window that returns a single IPC payload (or null on cancel).
 * Used for quick pick (any size) and text input — not native message-box caps.
 */
function showHtmlDialog(
  getWindow: () => BrowserWindow | null,
  title: string,
  html: string,
  size: { width: number; height: number },
): Promise<unknown> {
  return new Promise((resolve) => {
    const parent = parentWindow(getWindow);
    const dialogPreload = path.join(__dirname, "dialog-preload.js");
    // Same packaging gate as main/diff viewers. No auto-open — modal dialogs
    // are short-lived and not the rendering surface owners debug.
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      minWidth: 320,
      minHeight: 200,
      title,
      parent: parent ?? undefined,
      modal: !!parent,
      show: true,
      // Same background as the app. #252526 was VS Code's, and against a
      // #1e1e1e app it read as a window from somewhere else.
      backgroundColor: "#1e1e1e",
      // Without an icon Windows draws Electron's atom in the title bar of every
      // one of these. The main window already resolves the same file.
      icon: dialogIcon() ?? undefined,
      // A dialog that can be minimised or maximised is a window; strip both so
      // the title bar carries a close button only.
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: dialogPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        devTools: !app.isPackaged,
      },
    });
    installWindowSecurityLocks(win, {
      log: () => {},
      openExternal: (url) => {
        void shell.openExternal(url);
      },
    });
    win.setMenuBarVisibility(false);

    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("desk-dialog-result", onResult);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* best-effort */
      }
      resolve(value);
    };

    const onResult = (event: IpcMainEvent, payload: unknown) => {
      if (event.sender.id !== win.webContents.id) return;
      finish(payload);
    };
    ipcMain.on("desk-dialog-result", onResult);
    win.on("closed", () => finish(null));

    const dataUrl = "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
    void win.loadURL(dataUrl);
  });
}

/**
 * Watch `base/pattern` for create/change/delete.
 *
 * Supervises the directory chain rather than binding once: when `base` is
 * missing, walks to the nearest existing ancestor and rebinds as segments
 * appear; when `base` is deleted and recreated, re-attaches without restart.
 */
export function createBoundFileSystemWatcher(
  base: string,
  pattern: string,
  log: (line: string) => void,
): HostFileSystemWatcher {
  const watchPath = path.join(base, pattern.includes("*") ? "" : pattern);
  const target = pattern.includes("*") ? base : watchPath;
  const createListeners = new Set<() => void>();
  const changeListeners = new Set<() => void>();
  const deleteListeners = new Set<() => void>();
  let disposed = false;
  let baseWatcher: fs.FSWatcher | undefined;
  /** Watches the nearest existing ancestor while base (or mid-path) is missing. */
  let chainWatcher: fs.FSWatcher | undefined;
  let chainWatchPath: string | undefined;
  let rebindTimer: ReturnType<typeof setTimeout> | undefined;

  const matches = (filename: string | null): boolean => {
    if (!pattern || pattern.includes("*")) return true;
    if (!filename) return true;
    return filename === pattern || filename === path.basename(pattern);
  };

  const clearWatchers = () => {
    try {
      baseWatcher?.close();
    } catch {
      /* */
    }
    try {
      chainWatcher?.close();
    } catch {
      /* */
    }
    baseWatcher = undefined;
    chainWatcher = undefined;
    chainWatchPath = undefined;
  };

  const scheduleRebind = () => {
    if (disposed) return;
    if (rebindTimer) clearTimeout(rebindTimer);
    // Coalesce bursty rename events while a tree is being recreated.
    rebindTimer = setTimeout(() => {
      rebindTimer = undefined;
      tryStart();
    }, 50);
  };

  // A listener throw is a degraded refresh, not a dead desktop. Electron
  // surfaces uncaught FSWatcher errors as a main-process modal.
  const notify = (listeners: Set<() => void>): void => {
    for (const l of listeners) {
      try {
        l();
      } catch (e) {
        log(`[desktop] fs.watch listener failed: ${(e as Error).message}`);
      }
    }
  };

  const emitForEvent = (event: string, filename: string | null, watchTarget: string) => {
    const full = filename ? path.join(watchTarget, filename.toString()) : target;
    if (event === "rename") {
      try {
        if (fs.existsSync(full)) {
          notify(createListeners);
          notify(changeListeners);
        } else {
          notify(deleteListeners);
        }
      } catch {
        notify(changeListeners);
      }
      // Base itself may have been deleted — re-supervise the chain.
      if (!fs.existsSync(base)) {
        scheduleRebind();
      }
      return;
    }
    notify(changeListeners);
  };

  const bindBaseWatcher = () => {
    if (disposed) return;
    try {
      baseWatcher?.close();
    } catch {
      /* */
    }
    baseWatcher = undefined;
    try {
      baseWatcher = fs.watch(base, (event, filename) => {
        if (disposed) return;
        // If base vanished, fall back to chain supervision.
        if (!fs.existsSync(base)) {
          scheduleRebind();
          return;
        }
        if (filename && !matches(filename.toString())) return;
        emitForEvent(event, filename ? filename.toString() : null, base);
      });
      baseWatcher.on?.("error", () => {
        scheduleRebind();
      });
    } catch (e) {
      log(`[desktop] fs.watch failed: ${(e as Error).message}`);
      scheduleRebind();
    }
  };

  const bindChainWatcher = (watchDir: string) => {
    if (disposed) return;
    if (chainWatchPath === watchDir && chainWatcher) return;
    try {
      chainWatcher?.close();
    } catch {
      /* */
    }
    chainWatcher = undefined;
    chainWatchPath = watchDir;
    try {
      chainWatcher = fs.watch(watchDir, () => {
        if (disposed) return;
        scheduleRebind();
      });
      chainWatcher.on?.("error", () => {
        scheduleRebind();
      });
    } catch (e) {
      log(`[desktop] fs.watch chain failed on ${watchDir}: ${(e as Error).message}`);
    }
  };

  const tryStart = () => {
    if (disposed) return;
    if (fs.existsSync(base)) {
      // Base is live — drop chain watcher, bind the directory itself.
      try {
        chainWatcher?.close();
      } catch {
        /* */
      }
      chainWatcher = undefined;
      chainWatchPath = undefined;
      bindBaseWatcher();
      // If auth.json already exists when we first bind, fire create so voice
      // config refreshes without waiting for a later change event.
      if (!pattern.includes("*") && fs.existsSync(target)) {
        notify(createListeners);
      }
      return;
    }
    // Base missing: watch nearest existing ancestor so recreation is visible
    // even when intermediate parents were also removed (custom GROK_HOME, wipe).
    try {
      baseWatcher?.close();
    } catch {
      /* */
    }
    baseWatcher = undefined;
    const ancestor = nearestExistingAncestor(path.dirname(base));
    if (!ancestor) {
      log(`[desktop] fs.watch: no existing ancestor for ${base}`);
      return;
    }
    bindChainWatcher(ancestor);
  };

  tryStart();

  return {
    onDidCreate(listener) {
      createListeners.add(listener);
      return { dispose: () => createListeners.delete(listener) };
    },
    onDidChange(listener) {
      changeListeners.add(listener);
      return { dispose: () => changeListeners.delete(listener) };
    },
    onDidDelete(listener) {
      deleteListeners.add(listener);
      return { dispose: () => deleteListeners.delete(listener) };
    },
    dispose() {
      disposed = true;
      if (rebindTimer) {
        clearTimeout(rebindTimer);
        rebindTimer = undefined;
      }
      clearWatchers();
    },
  };
}

export function createElectronHost(opts: ElectronHostOptions): Host {
  const {
    config,
    getLogFile,
    getWindow,
    log,
    remoteActions,
    getAuthContext,
    onWorkspaceRootChanged,
    onWorkspaceFoldersChanged,
    installAppUpdate,
  } = opts;
  const configListeners = config; // store owns change events
  let activeEditor: HostTextEditor | undefined;

  const notifyFolders = (prevActive: string | undefined) => {
    const roots = config.getWorkspaceRoots();
    const active = config.getWorkspaceRoot();
    try {
      onWorkspaceFoldersChanged?.(roots, active);
    } catch {
      /* best-effort */
    }
    if (active && prevActive !== active) {
      try {
        onWorkspaceRootChanged?.(active);
      } catch {
        /* best-effort */
      }
    }
  };
  const editorListeners = new Set<() => void>();
  const selectionListeners = new Set<() => void>();
  const contentProviders = new Map<string, HostTextDocumentContentProvider>();

  const notYet = (feature: string) => {
    log(`[desktop] ${feature}: not available yet`);
    return messageBox(getWindow, "info", `${feature} is not available in the desktop app yet.`, ["OK"]);
  };

  /**
   * Open a path the host itself resolved or created — no workspace-root
   * containment (renderer never supplies this path). Used by typed intents
   * (global/project config) and host-owned exports.
   */
  async function openHostPath(fsPath: string): Promise<void> {
    const err = await shell.openPath(fsPath);
    const result = interpretOpenPathResult(err);
    if (!result.ok) {
      log(`[desktop] openPath failed: ${result.error}`);
      await messageBox(
        getWindow,
        "error",
        `Could not open file:\n${fsPath}\n\n${result.error}`,
        ["OK"],
      );
    }
  }

  /**
   * Open a filesystem path from chat / openResource. Revalidates containment +
   * executable policy, resolves bare basenames under authorized roots, then:
   *   - in-panel viewer when the type is previewable and the path sits under
   *     the panel's workspace root;
   *   - OS default handler only for non-renderable types;
   *   - in-app error when the file is missing (never shell.openPath on a miss).
   */
  async function openFsPath(fsPath: string): Promise<void> {
    const ctx = getAuthContext?.();
    if (!ctx || (!ctx.workspaceRoot && !(ctx.allowedRoots && ctx.allowedRoots.length))) {
      log(`[desktop] open refused: no auth context for ${fsPath}`);
      await messageBox(
        getWindow,
        "error",
        `Could not open file:\n${fsPath}\n\nNo authorized project folder is open.`,
        ["OK"],
      );
      return;
    }
    const check = resolveAuthorizedFileForOpen(fsPath, ctx);
    if (!check.ok) {
      log(`[desktop] open refused at use-time: ${check.reason} (${fsPath})`);
      const notFound = /not found/i.test(check.reason);
      await messageBox(
        getWindow,
        notFound ? "warning" : "error",
        notFound
          ? `File not found:\n${fsPath}\n\nIt is not under the open project (or no longer exists).`
          : `Could not open file:\n${fsPath}\n\n${check.reason}`,
        ["OK"],
      );
      return;
    }
    // Use only the path from the final check — never the pre-authorize string.
    const openPath = check.absPath;

    // Prefer the in-panel viewer for types the panel can render (same set as
    // tree clicks). Outside the panel's workspace root, or non-renderable
    // types, hand off to the OS.
    const kind = classifyFilePreview(openPath);
    if (kind !== "external") {
      const panelRoot = ctx.workspaceRoot || desktopAuthRoots(ctx)[0];
      if (
        panelRoot &&
        isCanonicallyInsideRoot(panelRoot, openPath, ctx.platform ?? process.platform, ctx.pathFs)
      ) {
        const rel = path
          .relative(panelRoot, openPath)
          .split(path.sep)
          .join("/");
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
          const opened = await openPathInFilePanel(getWindow(), rel);
          if (opened) {
            log(`[desktop] opened in panel: ${rel}`);
            return;
          }
          log(`[desktop] panel open failed; falling back to OS for ${rel}`);
        }
      }
    }

    const err = await shell.openPath(openPath);
    const result = interpretOpenPathResult(err);
    if (!result.ok) {
      log(`[desktop] openPath failed: ${result.error}`);
      await messageBox(
        getWindow,
        "error",
        `Could not open file:\n${openPath}\n\n${result.error}`,
        ["OK"],
      );
    }
  }

  return {
    showInformationMessage(message, ...items) {
      const buttons = items as string[];
      return messageBox(getWindow, "info", message, buttons);
    },
    showWarningMessage(message, ...items) {
      const { options, buttons } = splitMessageArgs(items);
      return messageBox(getWindow, "warning", message, buttons, options?.modal);
    },
    showErrorMessage(message, ...items) {
      const { options, buttons } = splitMessageArgs(items);
      return messageBox(getWindow, "error", message, buttons, options?.modal);
    },

    async showQuickPick<T extends HostQuickPickItem>(
      items: readonly T[],
      options?: HostQuickPickOptions,
    ): Promise<T | undefined> {
      if (!items.length) return undefined;
      // In-app HTML list scales past the native message-box button cap (model
      // selection is routinely 10–20 items).
      const html = buildQuickPickHtml({
        title: options?.title ?? "Choose",
        placeHolder: options?.placeHolder ?? "Select an item",
        items: items.map((it) => ({
          label: it.label,
          description: it.description,
          detail: it.detail,
        })),
      });
      const height = Math.min(640, 160 + items.length * 44);
      const raw = await showHtmlDialog(getWindow, options?.title ?? "Choose", html, {
        width: 480,
        height: Math.max(280, height),
      });
      if (raw === null || raw === undefined) return undefined;
      const parsed = parseDialogSubmit(raw);
      if (!parsed || parsed.kind !== "quickpick") return undefined;
      return selectQuickPickIndex(items, parsed.index);
    },

    async showInputBox(options?: HostInputBoxOptions): Promise<string | undefined> {
      const html = buildInputBoxHtml({
        title: options?.title ?? "Input",
        prompt: options?.prompt,
        placeHolder: options?.placeHolder,
        value: options?.value,
        password: options?.password,
      });
      const raw = await showHtmlDialog(
        getWindow,
        options?.title ?? "Input",
        html,
        // The card's padding grew; 220 clipped the buttons against the frame.
        { width: 440, height: 250 },
      );
      if (raw === null || raw === undefined) return undefined;
      const parsed = parseDialogSubmit(raw);
      if (!parsed || parsed.kind !== "input") return undefined;
      return parsed.value;
    },

    async showOpenDialog(options?: HostOpenDialogOptions): Promise<string[] | undefined> {
      const props: OpenDialogOptions["properties"] = [];
      const wantFiles = options?.canSelectFiles === true
        || (options?.canSelectFiles !== false && !options?.canSelectFolders);
      const wantFolders = options?.canSelectFolders === true;
      if (wantFiles) props.push("openFile");
      if (wantFolders) props.push("openDirectory");
      if (!props.length) props.push("openFile");
      if (options?.canSelectMany) props.push("multiSelections");

      const filters = options?.filters
        ? Object.entries(options.filters).map(([name, exts]) => ({
            name,
            extensions: exts.map((e) => e.replace(/^\./, "")),
          }))
        : undefined;

      const win = parentWindow(getWindow);
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: props,
            defaultPath: options?.defaultPath,
            buttonLabel: options?.openLabel,
            filters,
          })
        : await dialog.showOpenDialog({
            properties: props,
            defaultPath: options?.defaultPath,
            buttonLabel: options?.openLabel,
            filters,
          });
      if (result.canceled || !result.filePaths.length) return undefined;
      return result.filePaths;
    },

    async showSaveDialog(options?: HostSaveDialogOptions): Promise<string | undefined> {
      const filters = options?.filters
        ? Object.entries(options.filters).map(([name, exts]) => ({
            name,
            extensions: exts.map((e) => e.replace(/^\./, "")),
          }))
        : undefined;
      const win = parentWindow(getWindow);
      const result = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: options?.defaultPath,
            buttonLabel: options?.saveLabel,
            title: options?.title,
            filters,
          })
        : await dialog.showSaveDialog({
            defaultPath: options?.defaultPath,
            buttonLabel: options?.saveLabel,
            title: options?.title,
            filters,
          });
      if (result.canceled || !result.filePath) return undefined;
      return result.filePath;
    },

    getConfiguration(section?: string, resourcePath?: string) {
      return config.getConfiguration(section, resourcePath);
    },

    async openExternal(url: string) {
      // Defense in depth: chat openUrl is gated in ElectronWebview, but any
      // other Host caller must not launch arbitrary schemes either.
      const auth = authorizeOpenUrl(url);
      if (!auth.ok) {
        log(`[desktop] openExternal refused: ${auth.reason} (${url})`);
        return false;
      }
      await shell.openExternal(url);
      return true;
    },

    async openSettings(_section?: string) {
      // No settings UI on the desktop yet — everything a VS Code user adjusts in
      // the Settings editor lives in this one JSON file. This used to pop a
      // dialog saying exactly that and then leave you to find the file, which is
      // worse than having no menu item: it names the solution and withholds it.
      // Open the file. Raw, but it works, and a real panel can replace it later
      // without the entry point moving.
      const configPath = path.join(app.getPath("userData"), "config.json");
      try {
        if (!fs.existsSync(configPath)) {
          // Not written until something is changed, and openPath on a missing
          // file fails with an unhelpful message. Seed valid JSON so the editor
          // opens on an empty object rather than nothing.
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, "{}\n", "utf8");
        }
      } catch (e) {
        await messageBox(
          getWindow,
          "warning",
          `Could not create the settings file.\n\n${configPath}\n\n${(e as Error).message}`,
          ["OK"],
        );
        return;
      }
      const err = await shell.openPath(configPath);
      if (err) {
        // Usually no handler registered for .json. The path is the only
        // actionable thing left to give them.
        await messageBox(
          getWindow,
          "info",
          `Settings are stored in this file:\n\n${configPath}\n\nOpen it in any text editor.`,
          ["OK"],
        );
      }
    },

    async linkRemote() {
      const actions = remoteActions?.current;
      if (!actions?.link) {
        await notYet("AFK Pilot device linking");
        return;
      }
      await actions.link();
    },
    async unlinkRemote() {
      const actions = remoteActions?.current;
      if (!actions?.unlink) {
        await notYet("AFK Pilot device unlinking");
        return;
      }
      await actions.unlink();
    },

    createTerminal(nameOrOptions: string | HostTerminalOptions): HostTerminal {
      const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions.name;
      const opts = typeof nameOrOptions === "string" ? undefined : nameOrOptions;
      const cwd = opts?.cwd || config.getWorkspaceRoot() || process.cwd();

      const runPlan = (plan: ExternalTerminalPlan): void => {
        if (plan.kind === "unsupported") {
          log(`[desktop] createTerminal("${name}"): ${plan.reason}`);
          void messageBox(
            getWindow,
            "error",
            `Could not open a terminal for "${name}":\n${plan.reason}`,
            ["OK"],
          );
          return;
        }
        try {
          log(`[desktop] terminal: ${plan.label}`);
          const child = spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            detached: true,
            stdio: "ignore",
            shell: plan.shell,
            windowsHide: false,
          });
          // Async spawn failures (ENOENT, etc.) escape try/catch — surface them.
          child.on("error", (e) => {
            const msg = e.message;
            log(`[desktop] createTerminal spawn failed: ${msg}`);
            void messageBox(
              getWindow,
              "error",
              `Could not open a terminal for "${name}":\n${msg}`,
              ["OK"],
            );
          });
          child.unref();
        } catch (e) {
          const msg = (e as Error).message;
          log(`[desktop] createTerminal spawn failed: ${msg}`);
          void messageBox(
            getWindow,
            "error",
            `Could not open a terminal for "${name}":\n${msg}`,
            ["OK"],
          );
        }
      };

      // Login / logout / MCP: open a *visible* OS terminal running the CLI.
      // Windows .cmd shims need shell interpretation — planOpenCliInTerminal
      // routes them through `cmd /c start` (not a silent shell:false spawn).
      if (opts?.shellPath) {
        runPlan(planOpenCliInTerminal(name, opts.shellPath, opts.shellArgs ?? [], cwd));
      }

      return {
        show() {},
        sendText(text: string) {
          // Install Grok and other typed commands — open a visible terminal.
          runPlan(planRunCommandInTerminal(name, text, cwd));
        },
        dispose() {},
      };
    },

    async withProgress<T>(
      options: HostProgressOptions,
      task: (cancellationToken: HostCancellationToken) => Thenable<T>,
    ): Promise<T> {
      log(`[desktop] progress: ${options.title}`);
      const token: HostCancellationToken = { isCancellationRequested: false };
      return task(token);
    },

    append(text: string) {
      process.stdout.write(text);
    },
    appendLine(line: string) {
      log(line);
    },
    showOutput(_preserveFocus?: boolean) {
      // Opens the folder with the log selected, rather than the file itself.
      // `.log` has no reliable default application on Windows, so opening the
      // file can silently do nothing — which is the exact failure this is
      // fixing. A file manager with the file highlighted always works, and it
      // is also what somebody needs in order to attach it to an issue.
      //
      // This menu item was a no-op for the whole life of the desktop app:
      // people were asked for logs, went looking, and correctly reported that
      // the button does nothing (#131). There was no log to find.
      const file = getLogFile?.();
      if (!file) {
        log("show logs: no log file for this session");
        return;
      }
      shell.showItemInFolder(file);
    },
    toggleDevTools() {
      if (app.isPackaged) return;
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.toggleDevTools();
    },
    installAppUpdate() {
      installAppUpdate?.();
    },

    fs: hostFs,

    workspaceRoot() {
      return config.getWorkspaceRoot();
    },
    workspaceFolders() {
      return config.getWorkspaceRoots();
    },
    setActiveWorkspaceFolder(cwd: string) {
      const prev = config.getWorkspaceRoot();
      if (!config.setActiveWorkspaceRoot(cwd)) return false;
      notifyFolders(prev);
      return true;
    },
    addWorkspaceFolder(cwd: string) {
      const prev = config.getWorkspaceRoot();
      if (!config.addWorkspaceRoot(cwd, true)) return false;
      notifyFolders(prev);
      return true;
    },
    removeWorkspaceFolder(cwd: string) {
      const prev = config.getWorkspaceRoot();
      if (!config.removeWorkspaceRoot(cwd)) return false;
      notifyFolders(prev);
      return true;
    },
    asRelativePath(uri: Uri) {
      // Prefer the active root; fall through to any open folder so multi-folder
      // paths still relative-ize correctly.
      const roots = config.getWorkspaceRoots();
      if (!roots.length || uri.scheme !== "file") return uri.fsPath;
      const active = config.getWorkspaceRoot();
      const ordered = active
        ? [active, ...roots.filter((r) => path.resolve(r) !== path.resolve(active))]
        : roots;
      for (const root of ordered) {
        const rel = path.relative(root, uri.fsPath);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
      }
      return uri.fsPath;
    },
    async findFiles(include, exclude?, maxResults?) {
      const root = config.getWorkspaceRoot();
      if (!root) return [];
      if (typeof include === "string") {
        return findFilesUnder(root, exclude, maxResults);
      }
      return findFilesUnder(include.base || root, exclude, maxResults);
    },
    isInWorkspace(fsPath: string) {
      const roots = config.getWorkspaceRoots();
      if (!roots.length) return false;
      return isFsPathInWorkspace(fsPath, roots);
    },

    getActiveTextEditor() {
      return activeEditor;
    },
    async openTextFile(fsPath: string, options?: HostTextShowOptions) {
      // Open the user's real file via the OS. Line selection is not supported
      // (we are not an editor) — still open the path so the user can navigate.
      if (options?.selection) {
        log(
          `[desktop] openTextFile: line selection not supported; opening ${path.basename(fsPath)} in the OS default app`,
        );
      }
      await openFsPath(fsPath);
    },
    async openResource(target: string | Uri, _options?: HostTextShowOptions) {
      const fsPath = typeof target === "string"
        ? target
        : target.scheme === "file"
          ? target.fsPath
          : undefined;
      if (fsPath) {
        await openFsPath(fsPath);
        return;
      }
      // Virtual URI (e.g. content provider): show read-only text window.
      if (typeof target !== "string") {
        try {
          const text = resolveDocumentText(target, contentProviders, (p) =>
            fs.readFileSync(p, "utf8"),
          );
          const title = path.basename(target.path) || target.toString();
          openHtmlDocumentWindow(getWindow, title, buildTextViewerHtml(title, text));
          return;
        } catch (e) {
          await messageBox(
            getWindow,
            "error",
            `Could not open resource:\n${target.toString()}\n\n${(e as Error).message}`,
            ["OK"],
          );
          return;
        }
      }
      await messageBox(getWindow, "error", `Could not open resource:\n${String(target)}`, ["OK"]);
    },
    async showInFolder(fsPath: string) {
      const ctx = getAuthContext?.();
      if (!ctx || (!ctx.workspaceRoot && !(ctx.allowedRoots && ctx.allowedRoots.length))) {
        log(`[desktop] reveal refused: no auth context for ${fsPath}`);
        return;
      }
      const check = resolveAuthorizedFileForOpen(fsPath, ctx);
      if (!check.ok) {
        log(`[desktop] reveal refused at use-time: ${check.reason} (${fsPath})`);
        return;
      }
      shell.showItemInFolder(check.absPath);
    },
    async openGlobalConfig() {
      const p = globalConfigPath();
      ensureConfigToml(p, GLOBAL_CONFIG_STUB);
      await openHostPath(p);
    },
    async openProjectConfig(projectCwd: string) {
      const p = projectConfigPath(projectCwd);
      ensureConfigToml(p, PROJECT_CONFIG_STUB);
      await openHostPath(p);
    },
    async openHostResolvedPath(fsPath: string) {
      await openHostPath(fsPath);
    },
    async openUntitledText(content: string, language?: string, suggestedFilename?: string) {
      try {
        const outcome = await deliverSuggestedFileSave({
          suggestedFilename,
          content,
          filters: suggestedFilename ? saveFiltersForFilename(suggestedFilename) : undefined,
          title: suggestedFilename ? saveDialogTitleForFilename(suggestedFilename) : undefined,
          showSaveDialog: async (options) => {
            const filters = options.filters
              ? Object.entries(options.filters).map(([name, exts]) => ({
                  name,
                  extensions: exts.map((e) => e.replace(/^\./, "")),
                }))
              : undefined;
            const win = parentWindow(getWindow);
            const result = win
              ? await dialog.showSaveDialog(win, {
                  defaultPath: options.defaultPath,
                  buttonLabel: options.saveLabel,
                  title: options.title,
                  filters,
                })
              : await dialog.showSaveDialog({
                  defaultPath: options.defaultPath,
                  buttonLabel: options.saveLabel,
                  title: options.title,
                  filters,
                });
            if (result.canceled || !result.filePath) return undefined;
            return result.filePath;
          },
          writeFile: (filePath, data) => {
            fs.writeFileSync(filePath, data, "utf8");
          },
        });
        if (outcome !== "fallback") return;
      } catch (e) {
        await messageBox(getWindow, "error", `Export failed: ${(e as Error).message}`, ["OK"]);
        return;
      }
      const title = language ? `Untitled (${language})` : "Untitled";
      openHtmlDocumentWindow(
        getWindow,
        title,
        buildTextViewerHtml(title, content, language),
      );
    },
    async openDiff(left: Uri, right: Uri, title: string, options?: HostTextShowOptions) {
      try {
        const read = (p: string) => fs.readFileSync(p, "utf8");
        const leftText = resolveDocumentText(left, contentProviders, read);
        const rightText = resolveDocumentText(right, contentProviders, read);
        const leftLabel = path.basename(left.path) || "before";
        const rightLabel = path.basename(right.path) || "after";
        const scrollTo = options?.selection?.start?.line;
        openHtmlDocumentWindow(
          getWindow,
          title,
          buildDiffViewerHtml(title, leftLabel, leftText, rightLabel, rightText, scrollTo),
        );
      } catch (e) {
        await messageBox(
          getWindow,
          "error",
          `Could not open diff:\n${title}\n\n${(e as Error).message}`,
          ["OK"],
        );
      }
    },
    openWorkspaceTextFiles() {
      // No multi-tab editor in the desktop app.
      return [];
    },
    closeDiffTabs(_original: Uri, _modified: Uri) {
      // no-op — internal diff windows are not tracked as tabs
    },

    async setContext(_key: string, _value: unknown) {
      // VS Code when-clause context — no-op on desktop.
    },
    async relocateView(
      _viewId: string,
      _destinationId?: string | null,
      _panelPosition?: PanelPosition | null,
    ) {
      // Capability `canRelocateView` is false — gear must not offer this. Stub
      // remains for typed Host completeness; never user-reachable from the UI.
      await notYet("Move view");
    },

    async revealChatView() {
      // One window, chat always on screen — nothing to reveal. Deliberately NOT
      // `notYet`: the rail calls this on every open, and a "not supported"
      // notice on an ordinary click would be pure noise.
    },

    onDidChangeConfiguration(listener) {
      return configListeners.onDidChange(listener);
    },
    onDidChangeActiveTextEditor(listener) {
      editorListeners.add(listener);
      return {
        dispose: () => {
          editorListeners.delete(listener);
        },
      };
    },
    onDidChangeActiveTextEditorSelection(listener) {
      selectionListeners.add(listener);
      return {
        dispose: () => {
          selectionListeners.delete(listener);
        },
      };
    },
    createFileSystemWatcher(base: string, pattern: string): HostFileSystemWatcher {
      // When ~/.grok does not exist yet, watch the parent and rebind on create
      // so first login refreshes voiceConfigured (auth.json).
      return createBoundFileSystemWatcher(base, pattern, log);
    },
    registerTextDocumentContentProvider(scheme, provider) {
      contentProviders.set(scheme, provider);
      return {
        dispose: () => {
          contentProviders.delete(scheme);
        },
      };
    },

    get appName() {
      return DESKTOP_APP_SHORT_NAME;
    },
    get language() {
      return "en";
    },
    get isTelemetryEnabled() {
      return config.getValue("grok.telemetry.enabled") !== false;
    },

    webviewReloadsUnderLiveSession: true,
    remoteInstallIdSuffix: ":desktop",
    canRelocateView: false,
    // Moot while canRelocateView is false (the gear hides the whole section),
    // but false is the truthful answer: a single-window desktop app has no
    // side bars to move a view between.
    canUseSecondarySideBar: false,
    canShowOutput: false,
    // Unpackaged only — packaged builds hard-disable DevTools at webPreferences.
    get canToggleDevTools() {
      return !app.isPackaged;
    },
    canShowMcpSettings: true,
    // No editor tabs — a generated-image click must use the in-app lightbox,
    // not openFile (which would hand the file to the OS image viewer).
    canOpenInEditor: false,
    canSwitchWorkspaceFolder: true,
    canArchiveRepos: true,
    // This host owns its own app-resource:// handler, and that handler answers
    // byte ranges — see app-resource-handler.ts. No other host may claim this.
    canServeMediaRanges: true,
    canShowInFolder: true,
    // No editor tabs — View all / proposed diffs use the in-app overlay.
    canPreviewInApp: true,
    // Settings stay in the chat overlay — there is no editor-area tab here.
    canOpenSettingsEditor: false,
    openEditorWebview() {
      return undefined;
    },
  };
}

/**
 * Host-side discovery: folders under ~/.grok that meet the 10-in-3-months bar.
 * Uses well-formed session summaries (not mtime-only), requires a verified Git
 * root after realpath, and clamps activity to `[now−window, now]`.
 * Injectable `fs` / `grokHome` / `now` for tests.
 */
export function discoverSeedProjectPaths(opts?: {
  fs?: FsLike;
  grokHome?: string;
  tmpDir?: string;
  nowMs?: number;
  log?: (msg: string) => void;
}): string[] {
  const nodeFs = opts?.fs ?? (fs as unknown as FsLike);
  const grokHome = opts?.grokHome ?? resolveGrokHome(process.env);
  const tmpDir = opts?.tmpDir ?? os.tmpdir();
  const nowMs = opts?.nowMs ?? Date.now();
  const discovered = discoverRepos({
    fs: nodeFs,
    grokHome,
    pins: {},
    tmpDir,
    // Seeding chooses folders independently of their archive presentation.
    log: opts?.log,
  });
  const candidates = discovered.map((repo) => ({
    cwd: repo.cwd,
    // Well-formed only — empty `{}` summary files do not count.
    sessionTimestampsMs: indexWellFormedSessions({
      fs: nodeFs,
      grokHome,
      cwd: repo.cwd,
      log: opts?.log,
    }).map((e) => e.mtimeMs),
  }));
  // discoverRepos sorts newest-first; keep that order so the active root is
  // the most recently used qualifying project. Canonicalize to verified Git
  // roots so history alone cannot open an arbitrary directory.
  return selectProjectsToSeed(candidates, nowMs, {
    canonicalize: (cwd) =>
      canonicalizeSeedProjectPath(cwd, {
        existsSync: (p) => nodeFs.existsSync(p),
        realpathSync: (p) => {
          // FsLike may not expose realpath — fall through to node when needed.
          const r = (nodeFs as { realpathSync?: (p: string) => string }).realpathSync;
          return r ? r.call(nodeFs, p) : fs.realpathSync(p);
        },
        statSync: (p) => nodeFs.statSync(p),
      }),
  });
}

/**
 * Establish the open-folder set before the sidebar starts.
 *
 * - `--workspace=` / forced path: open that folder (test / CLI launch).
 * - Existing prefs: keep the user's open set.
 * - Empty set on first seed: run host-side discovery — **no folder picker**.
 *   If discovery finds nothing, provision the default chat folder
 *   (`provisionDefaultProject`) so first run is connect-agent → chat.
 * - Empty after seed completed: stay empty (user-owned). The default is
 *   never re-created — it is an ordinary row they can remove.
 *
 * Returns the active root when one exists; undefined when the rail is empty.
 * Never blocks on a dialog. Seeding runs before the window is needed.
 */
export function ensureWorkspaceRoot(
  config: ConfigStore,
  _getWindow: () => BrowserWindow | null,
  forced?: string,
  seed?: {
    /** Override discovery (tests). Default: {@link discoverSeedProjectPaths}. */
    runDiscoverySeed?: () => string[];
    /**
     * First-run empty catalog: create `~/Grok Build` (or userData).
     * Production main always supplies this. Tests omit it to stay off $HOME.
     */
    provisionDefaultProject?: () => string | undefined;
  },
): string | undefined {
  if (forced && fs.existsSync(forced)) {
    config.setWorkspaceRoot(path.resolve(forced));
    // Forced open is user/test intent — never follow with a discovery overwrite.
    config.markDiscoverySeedCompleted();
    return path.resolve(forced);
  }

  const open = config.getWorkspaceRoots();
  if (open.length > 0) {
    // Restored prefs (or a prior seed) already own the set. Mark complete so a
    // later deliberate empty list is not re-seeded on the next launch.
    if (!config.isDiscoverySeedCompleted()) config.markDiscoverySeedCompleted();
    const existing = config.getWorkspaceRoot();
    if (existing && fs.existsSync(existing)) return existing;
    return open[0];
  }

  // Empty open set. Seed only when the one-shot flag says we never have.
  if (
    shouldSeedProjectDiscovery({
      discoverySeedCompleted: config.isDiscoverySeedCompleted(),
      openFolderCount: 0,
    })
  ) {
    const seeded = (seed?.runDiscoverySeed ?? (() => discoverSeedProjectPaths()))();
    for (const cwd of seeded) {
      config.addWorkspaceRoot(cwd, false);
    }
    if (seeded.length) {
      if (!config.setActiveWorkspaceRoot(seeded[0])) {
        config.setWorkspaceRoot(seeded[0]);
      }
    } else {
      // Nothing already in use on this machine. A default folder is the
      // first-run chat home — not a hidden project, and not re-created
      // after the user removes it (the seed flag is marked below).
      const provisioned = seed?.provisionDefaultProject?.();
      if (provisioned) {
        config.setWorkspaceRoot(path.resolve(provisioned));
      }
    }
    config.markDiscoverySeedCompleted();
  }

  const root = config.getWorkspaceRoot();
  if (root && fs.existsSync(root)) return root;
  const roots = config.getWorkspaceRoots();
  return roots[0];
}
