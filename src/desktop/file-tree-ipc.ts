/**
 * Main-process IPC for the desktop file-tree panel.
 * Renderer is less trusted: every path is re-resolved and containment-checked
 * (canonical / realpath — see file-tree.ts), and only the main BrowserWindow
 * may invoke these channels.
 */
import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent, type Event as ElectronEvent } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { isExecutableOpenTarget } from "./desktop-policy";
import { interpretOpenPathResult } from "./document-view";
import {
  listTreeDir,
  readTreeFile,
  resolveTreePath,
  writeTreeFile,
  type TreeFileStamp,
} from "./file-tree";
import { fileTreePanelBootSource } from "./file-tree-panel";
import { GitRunGate, readGitFileDiff, readGitStatus, runGitPlan } from "../git-run";
import { describeGitFailure, isKnownChangedPath, planGitOp } from "../git-status";
import { isTrustedMainFrameIpc } from "./window-security";

const CH_LIST = "desk-ft:list";
const CH_OPEN = "desk-ft:open";
const CH_REVEAL = "desk-ft:reveal";
const CH_READ = "desk-ft:read";
const CH_SAVE = "desk-ft:save";
const CH_ROOT = "desk-ft:root";
const CH_GIT_STATUS = "desk-ft:git-status";
const CH_GIT_DIFF = "desk-ft:git-diff";
const CH_GIT_RUN = "desk-ft:git-run";

/** One git write at a time per repository — see GitRunGate. */
const gitRunGate = new GitRunGate();

export interface FileTreeIpcOptions {
  getWorkspaceRoot: () => string | undefined;
  log: (line: string) => void;
  /** Main window — handlers refuse invokes from any other webContents. */
  getMainWindow: () => BrowserWindow | null;
  /**
   * When set (tests), open writes the absolute path as a line instead of
   * calling the OS handler — so e2e can assert the open path without a GUI app.
   * Prefer this over any production diagnostic: a process-global last-open
   * path would leak across project switches.
   */
  openSinkPath?: string;
  /**
   * When set (tests), reveal writes the absolute path as a line instead of
   * calling showItemInFolder — same e2e rationale as openSinkPath.
   */
  revealSinkPath?: string;
}

/** Same-file test that tolerates separator and drive-letter case on Windows. */
function pathsEquivalent(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

let handlersRegistered = false;
let closeBoundWindow: BrowserWindow | null = null;
let closeBoundHandler: ((event: ElectronEvent) => void) | null = null;

/** True when the IPC event came from the desktop app's main window main frame. */
export function isIpcFromMainWindow(
  event: Pick<IpcMainInvokeEvent, "sender"> & {
    senderFrame?: { url?: string } | null;
  },
  getMainWindow: () => BrowserWindow | null,
): boolean {
  return isTrustedMainFrameIpc(event, getMainWindow);
}

/** Options for {@link resolveTreeOpenTarget}. */
export interface ResolveTreeOpenTargetOptions {
  /**
   * When true, accept directories as well as files (reveal in file manager).
   * Default false — open must keep refusing directories.
   */
  allowDirectory?: boolean;
}

/**
 * Shared containment + policy gate for open and reveal.
 *
 * Order is load-bearing and identical for both channels:
 * invalid path → resolve → re-resolve → isFile (or dir when opted in) →
 * executable refuse. Callers that invoke the OS must still re-resolve
 * immediately before use.
 */
export function resolveTreeOpenTarget(
  root: string,
  relPath: unknown,
  log?: (line: string) => void,
  logVerb: "open" | "reveal" = "open",
  options?: ResolveTreeOpenTargetOptions,
): { ok: true; absPath: string } | { ok: false; error: string } {
  if (typeof relPath !== "string") {
    return { ok: false, error: "invalid path" };
  }
  // Validate, then re-resolve immediately before use (cheap TOCTOU close:
  // a same-user process could swap a link between the two checks).
  const first = resolveTreePath(root, relPath);
  if (!first.ok) {
    log?.(`[desk-ft] ${logVerb} rejected: ${first.reason} (${relPath})`);
    return { ok: false, error: first.reason };
  }
  const resolved = resolveTreePath(root, relPath);
  if (!resolved.ok) {
    log?.(`[desk-ft] ${logVerb} rejected on re-check: ${resolved.reason} (${relPath})`);
    return { ok: false, error: resolved.reason };
  }
  // Open: files only. Reveal may pass allowDirectory so folders can be shown
  // in the OS file manager. resolveTreePath already refused outbound
  // symlinks/junctions; use the path the user sees (link path when it is an
  // in-tree link).
  try {
    const st = fs.statSync(resolved.absPath);
    const allowDir = options?.allowDirectory === true;
    // Sockets, FIFOs and device nodes fall through both arms — neither channel
    // has anything sensible to do with one.
    if (!st.isFile() && !(allowDir && st.isDirectory())) {
      return { ok: false, error: allowDir ? "not a file or folder" : "not a file" };
    }
  } catch {
    return { ok: false, error: "not found" };
  }
  // Same executable refusal as chat openFile (desktop-policy): extension,
  // symlink target, launcher format, and POSIX +x on the canonical file.
  // Kept on the reveal path too (narrower is safer; e.g. macOS .app bundles).
  if (isExecutableOpenTarget(resolved.absPath)) {
    log?.(`[desk-ft] ${logVerb} rejected: executable path refused (${relPath})`);
    return { ok: false, error: "executable path refused" };
  }
  return { ok: true, absPath: resolved.absPath };
}

/** Register invoke handlers once per process. */
export function registerFileTreeIpc(opts: FileTreeIpcOptions): void {
  if (handlersRegistered) {
    // Allow re-binding workspace getter when createApp restarts in the same process.
    unregisterFileTreeIpc();
  }
  handlersRegistered = true;

  const deny = (channel: string) => {
    opts.log(`[desk-ft] refused ${channel}: sender is not the main window`);
    return { ok: false as const, reason: "forbidden", error: "forbidden" };
  };

  ipcMain.handle(CH_ROOT, (e) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_ROOT);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    return {
      ok: true as const,
      root,
      name: path.basename(root) || root,
    };
  });

  ipcMain.handle(CH_LIST, (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_LIST);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    const rel = typeof relPath === "string" ? relPath : "";
    return listTreeDir(root, rel);
  });

  ipcMain.handle(CH_OPEN, async (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_OPEN);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, error: "no workspace root" };
    const target = resolveTreeOpenTarget(root, relPath, opts.log, "open");
    if (!target.ok) return { ok: false as const, error: target.error };

    const sink = opts.openSinkPath || process.env.GROK_DESKTOP_OPEN_SINK;
    if (sink) {
      try {
        fs.appendFileSync(sink, target.absPath + "\n", "utf8");
      } catch (err) {
        opts.log(`[desk-ft] open sink write failed: ${(err as Error).message}`);
        return { ok: false as const, error: "sink write failed" };
      }
      return { ok: true as const, path: target.absPath, sink: true as const };
    }

    // Final containment + executable re-check immediately before the OS open.
    const finalCheck = resolveTreePath(root, relPath as string);
    if (!finalCheck.ok || finalCheck.absPath !== target.absPath) {
      opts.log(`[desk-ft] open rejected at use-time re-resolve (${relPath})`);
      return { ok: false as const, error: "path escaped workspace" };
    }
    if (isExecutableOpenTarget(finalCheck.absPath)) {
      opts.log(`[desk-ft] open rejected at use-time: executable (${relPath})`);
      return { ok: false as const, error: "executable path refused" };
    }

    const err = await shell.openPath(finalCheck.absPath);
    const result = interpretOpenPathResult(err);
    if (!result.ok) {
      opts.log(`[desk-ft] openPath failed: ${result.error}`);
      return { ok: false as const, error: result.error };
    }
    return { ok: true as const, path: finalCheck.absPath };
  });

  /**
   * Reveal a workspace file or folder in the OS file manager
   * (Finder / Explorer / …). Same trust gates as open, plus allowDirectory
   * so tree folders can be revealed without opening them.
   */
  ipcMain.handle(CH_REVEAL, (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_REVEAL);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, error: "no workspace root" };
    const target = resolveTreeOpenTarget(root, relPath, opts.log, "reveal", {
      allowDirectory: true,
    });
    if (!target.ok) return { ok: false as const, error: target.error };

    const sink = opts.revealSinkPath || process.env.GROK_DESKTOP_REVEAL_SINK;
    if (sink) {
      try {
        fs.appendFileSync(sink, target.absPath + "\n", "utf8");
      } catch (err) {
        opts.log(`[desk-ft] reveal sink write failed: ${(err as Error).message}`);
        return { ok: false as const, error: "sink write failed" };
      }
      return { ok: true as const, path: target.absPath, sink: true as const };
    }

    // Final containment + executable re-check immediately before the OS reveal.
    const finalCheck = resolveTreePath(root, relPath as string);
    if (!finalCheck.ok || finalCheck.absPath !== target.absPath) {
      opts.log(`[desk-ft] reveal rejected at use-time re-resolve (${relPath})`);
      return { ok: false as const, error: "path escaped workspace" };
    }
    if (isExecutableOpenTarget(finalCheck.absPath)) {
      opts.log(`[desk-ft] reveal rejected at use-time: executable (${relPath})`);
      return { ok: false as const, error: "executable path refused" };
    }

    try {
      shell.showItemInFolder(finalCheck.absPath);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      opts.log(`[desk-ft] showItemInFolder failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
    return { ok: true as const, path: finalCheck.absPath };
  });

  /** In-panel read for markdown/json/image/text preview (containment-checked). */
  ipcMain.handle(CH_READ, (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_READ);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    if (typeof relPath !== "string") {
      return { ok: false as const, reason: "invalid path" };
    }
    return readTreeFile(root, relPath);
  });

  /**
   * The Changes view's read. The renderer names no path at all here — the root
   * is the desktop's own workspace root, exactly as for list and read above.
   */
  ipcMain.handle(CH_GIT_STATUS, async (e) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_GIT_STATUS);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, kind: "failed" as const, reason: "no workspace root" };
    const read = await readGitStatus(root);
    if (!read.ok) return { ok: false as const, kind: read.kind, reason: read.reason };
    return { ok: true as const, snapshot: read.snapshot, busy: gitRunGate.isBusy(root) };
  });

  /**
   * One file's patch. The path fence is the snapshot, not a string test: only
   * a path the repository is reporting as changed right now is diffable, which
   * cannot name a file outside the repository and goes stale safely.
   */
  ipcMain.handle(CH_GIT_DIFF, async (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_GIT_DIFF);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    if (typeof relPath !== "string" || !relPath) return { ok: false as const, reason: "invalid path" };
    const status = await readGitStatus(root);
    if (!status.ok) return { ok: false as const, reason: status.reason };
    if (!isKnownChangedPath(status.snapshot, relPath)) {
      return { ok: false as const, reason: "That file is no longer changed. Refresh and try again." };
    }
    const entry = status.snapshot.files.find((file) => file.path === relPath);
    const diff = await readGitFileDiff(root, relPath, { untracked: entry?.status === "?" });
    if (!diff.ok) return { ok: false as const, reason: diff.reason };
    return { ok: true as const, patch: diff.patch, truncated: diff.truncated, untracked: diff.untracked };
  });

  /**
   * Run one of the four operations. Nothing in the payload is trusted beyond
   * the operation and its inputs: the plan is rebuilt here from a fresh
   * snapshot, so a renderer showing a stale list cannot commit a file that
   * stopped being changed, and the argv that runs is produced by the same
   * function that produced the text the person confirmed.
   */
  ipcMain.handle(CH_GIT_RUN, async (e, payload: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_GIT_RUN);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    if (!payload || typeof payload !== "object") return { ok: false as const, reason: "invalid request" };
    const request = payload as {
      op?: unknown;
      message?: unknown;
      push?: unknown;
      paths?: unknown;
      branch?: unknown;
      path?: unknown;
    };
    const op = request.op;
    if (op !== "commit" && op !== "push" && op !== "newBranch" && op !== "revertFile") {
      return { ok: false as const, reason: "invalid request" };
    }
    if (!gitRunGate.tryAcquire(root)) {
      return { ok: false as const, reason: "Another git command is still running in this project." };
    }
    try {
      const status = await readGitStatus(root);
      if (!status.ok) return { ok: false as const, reason: status.reason };
      const plan = planGitOp(
        {
          op,
          message: typeof request.message === "string" ? request.message : undefined,
          push: !!request.push,
          paths: Array.isArray(request.paths)
            ? request.paths.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          branch: typeof request.branch === "string" ? request.branch : undefined,
          path: typeof request.path === "string" ? request.path : undefined,
        },
        status.snapshot,
      );
      if (!plan.ok) return { ok: false as const, reason: plan.reason, snapshot: status.snapshot };
      opts.log(`[desk-ft] git: ${plan.display.split("\n").join(" ; ")}`);
      const outcome = await runGitPlan(root, plan);
      const after = await readGitStatus(root);
      const snapshot = after.ok ? after.snapshot : undefined;
      if (!outcome.ok) {
        return {
          ok: false as const,
          reason: describeGitFailure(op, outcome.stderr, plan.steps[outcome.failedStep]?.args[0]) || "That git command failed.",
          detail: outcome.stderr,
          snapshot,
        };
      }
      if (!snapshot) {
        return {
          ok: false as const,
          reason: "The command ran, but the status could not be read afterwards. Reopen Changes to see where things stand.",
        };
      }
      return { ok: true as const, snapshot };
    } finally {
      gitRunGate.release(root);
    }
  });

  ipcMain.handle(CH_SAVE, (e, payload: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_SAVE);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    if (!payload || typeof payload !== "object") {
      return { ok: false as const, reason: "invalid save request" };
    }
    const request = payload as {
      relPath?: unknown;
      text?: unknown;
      stamp?: unknown;
      absPath?: unknown;
    };
    if (typeof request.relPath !== "string" || typeof request.text !== "string") {
      return { ok: false as const, reason: "invalid save request" };
    }
    // A save carries the absolute path it was READ at, and it must still be the
    // path this relPath resolves to under the CURRENT root.
    //
    // Without this the save carried only a relative path, and the root was read
    // fresh here — so a tab still open on repo A, saved after the active folder
    // moved to repo B, wrote A's text into B's same-named file. The mtime stamp
    // caught the common case, and then offered Overwrite, which completed the
    // loss. A path that no longer means what it meant is not a conflict to
    // resolve; it is a different file.
    if (typeof request.absPath !== "string" || !request.absPath) {
      return { ok: false as const, reason: "invalid save request" };
    }
    // The comparison itself lives in writeTreeFile, beside the stamp check, so
    // it is decidable from arguments and cannot be skipped by a caller.
    const stamp = request.stamp as Partial<TreeFileStamp> | undefined;
    if (
      !stamp ||
      typeof stamp.mtimeMs !== "number" ||
      typeof stamp.size !== "number"
    ) {
      return { ok: false as const, reason: "invalid version stamp" };
    }
    const result = writeTreeFile(root, request.relPath, request.text, stamp as TreeFileStamp, {
      expectedAbsPath: request.absPath,
    });
    if (!result.ok) {
      opts.log(`[desk-ft] save rejected: ${result.reason} (${request.relPath})`);
    }
    return result;
  });

  const win = opts.getMainWindow();
  if (win && !win.isDestroyed()) {
    let closePending = false;
    const onClose = (event: ElectronEvent) => {
      if (closePending) {
        event.preventDefault();
        return;
      }
      closePending = true;
      event.preventDefault();
      void win.webContents
        .executeJavaScript(
          `(function(){try{var f=window.__grokDeskFtBeforeClose;if(typeof f!=="function")return Promise.resolve(true);return Promise.resolve(f()).then(Boolean);}catch(_){return false;}})()`,
          true,
        )
        .then((ok) => {
          closePending = false;
          if (!ok || win.isDestroyed()) return;
          if (closeBoundWindow === win && closeBoundHandler) {
            win.removeListener("close", closeBoundHandler);
            closeBoundWindow = null;
            closeBoundHandler = null;
          }
          win.close();
        })
        .catch(() => {
          closePending = false;
        });
    };
    closeBoundWindow = win;
    closeBoundHandler = onClose;
    win.on("close", onClose);
  }
}

export function unregisterFileTreeIpc(): void {
  if (!handlersRegistered) return;
  for (const ch of [CH_LIST, CH_OPEN, CH_REVEAL, CH_READ, CH_SAVE, CH_ROOT, CH_GIT_STATUS, CH_GIT_DIFF, CH_GIT_RUN]) {
    ipcMain.removeHandler(ch);
  }
  if (closeBoundWindow && closeBoundHandler) {
    closeBoundWindow.removeListener("close", closeBoundHandler);
    closeBoundWindow = null;
    closeBoundHandler = null;
  }
  handlersRegistered = false;
}

/**
 * Inject (or re-inject) the file-tree panel into the chat document.
 * Safe to call on every did-finish-load.
 */
export async function injectFileTreePanel(win: BrowserWindow | null): Promise<void> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const src = fileTreePanelBootSource();
  try {
    await win.webContents.executeJavaScript(src, true);
  } catch (e) {
    // Log-only: chat still works without the panel.
    // Callers pass log separately; swallow here if injection races dispose.
    void e;
  }
}

/**
 * Open a workspace-relative path in the in-panel file viewer (chat openFile
 * for renderable types). Returns true when the renderer accepted the path.
 * Containment is re-checked by the panel's read IPC — this only delivers the
 * relative path string.
 */
export async function openPathInFilePanel(
  win: BrowserWindow | null,
  relPath: string,
): Promise<boolean> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  if (typeof relPath !== "string" || !relPath || relPath.includes("\0")) return false;
  // Escape for a single-quoted JS string literal.
  const lit = relPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r|\n/g, "");
  try {
    const result = await win.webContents.executeJavaScript(
      `(function(){try{var fn=window.__grokDeskFtOpen;if(typeof fn!=="function")return{ok:false,reason:"no panel"};return Promise.resolve(fn('${lit}')).then(function(r){return r&&r.ok!==false?{ok:true}:r||{ok:true};});}catch(e){return{ok:false,reason:String(e&&e.message||e)};}})()`,
      true,
    );
    if (result && result.ok === false) return false;
    return true;
  } catch {
    return false;
  }
}

export async function injectFileTreePanelLogged(
  win: BrowserWindow | null,
  log: (line: string) => void,
): Promise<void> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    const result = await win.webContents.executeJavaScript(fileTreePanelBootSource(), true);
    if (result && result.ok === false) {
      log(`[desk-ft] inject: ${result.reason || "failed"}`);
    }
  } catch (e) {
    log(`[desk-ft] inject failed: ${(e as Error).message}`);
  }
}
