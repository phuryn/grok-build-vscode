/**
 * Electron window trust-boundary locks.
 *
 * VS Code's webview sandbox blocked navigation and window.open; a raw Electron
 * BrowserWindow does not. These handlers restore the property:
 *   - setWindowOpenHandler → never open a child window; http(s) → shell.openExternal
 *   - will-navigate → refuse navigation away from the app document
 *   - IPC sender must be the main window **main frame** (not an iframe)
 *
 * Pure helpers + installers so unit tests can assert policy without a window.
 */
import type { BrowserWindow, HandlerDetails, IpcMainEvent, IpcMainInvokeEvent } from "electron";

/** URL schemes the app document itself may use (initial load + reload). */
export function isAllowedAppNavigationUrl(url: string): boolean {
  if (typeof url !== "string" || !url) return false;
  // Main chat document + static/registry assets share the privileged scheme.
  if (url.startsWith("app-resource:")) return true;
  // Secondary viewers/dialogs still load as data:text/html (no localStorage need).
  if (url.startsWith("data:text/html")) return true;
  // about:blank can appear during teardown — allow, nothing sensitive.
  if (url === "about:blank") return true;
  return false;
}

/**
 * Whether a window.open / target=_blank URL should be handed to the OS browser
 * or mail client. Everything else is denied (no child BrowserWindow).
 */
export function shouldOpenExternally(url: string): boolean {
  if (typeof url !== "string") return false;
  return url.startsWith("https:") || url.startsWith("http:") || url.startsWith("mailto:");
}

/** Decision for setWindowOpenHandler. */
export function windowOpenDecision(
  details: Pick<HandlerDetails, "url">,
): { action: "deny"; openExternal?: string } {
  if (shouldOpenExternally(details.url)) {
    return { action: "deny", openExternal: details.url };
  }
  return { action: "deny" };
}

/** True when will-navigate must be cancelled. */
export function shouldBlockNavigation(url: string): boolean {
  return !isAllowedAppNavigationUrl(url);
}

/**
 * IPC sender is the main BrowserWindow's main frame (not a child frame / other window).
 */
export function isTrustedMainFrameIpc(
  event: Pick<IpcMainEvent | IpcMainInvokeEvent, "sender"> & {
    senderFrame?: { url?: string } | null;
  },
  getMainWindow: () => BrowserWindow | null,
): boolean {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  if (event.sender.isDestroyed()) return false;
  if (event.sender.id !== win.webContents.id) return false;

  // Prefer explicit main-frame identity when Electron exposes it.
  const mainFrame = (
    win.webContents as { mainFrame?: { processId?: number; routingId?: number } }
  ).mainFrame;
  const senderFrame = event.senderFrame as
    | { processId?: number; routingId?: number; parent?: unknown }
    | null
    | undefined;

  if (senderFrame && mainFrame) {
    // Same process + routing id → main frame. Child frames have a parent.
    if (
      typeof senderFrame.processId === "number" &&
      typeof mainFrame.processId === "number" &&
      typeof senderFrame.routingId === "number" &&
      typeof mainFrame.routingId === "number"
    ) {
      if (
        senderFrame.processId !== mainFrame.processId ||
        senderFrame.routingId !== mainFrame.routingId
      ) {
        return false;
      }
    } else if (senderFrame.parent) {
      // Has a parent frame → not main.
      return false;
    }
  }

  return true;
}

/**
 * Attach navigation / window-open locks to a BrowserWindow.
 * `openExternal` is injected so tests need not import electron.shell.
 */
export function installWindowSecurityLocks(
  win: Pick<BrowserWindow, "webContents">,
  opts: {
    log: (line: string) => void;
    openExternal: (url: string) => void | Promise<void>;
    allowNavigation?: (url: string) => boolean;
  },
): void {
  win.webContents.setWindowOpenHandler((details) => {
    const decision = windowOpenDecision(details);
    if (decision.openExternal) {
      void Promise.resolve(opts.openExternal(decision.openExternal)).catch((e) => {
        opts.log(`openExternal failed: ${(e as Error).message}`);
      });
    } else {
      opts.log(`blocked window.open: ${details.url}`);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (opts.allowNavigation ? !opts.allowNavigation(url) : shouldBlockNavigation(url)) {
      event.preventDefault();
      opts.log(`blocked navigation to ${url}`);
    }
  });
}
