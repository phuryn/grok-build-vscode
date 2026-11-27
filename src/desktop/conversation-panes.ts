import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { app, shell, WebContentsView } from "electron";
import type { BrowserWindow, IpcMainEvent, Rectangle } from "electron";
import type { Host, HostEditorWebview } from "../host";
import { DESKTOP_CONVERSATION_PANE_ARG } from "./conversation-layout";
import type { DesktopOpenFileContext } from "./desktop-policy";
import { APP_DOCUMENT_URL, desktopChromeBootSource, ElectronWebview } from "./electron-webview";
import { installWindowSecurityLocks } from "./window-security";
import { installDesktopZoomHandlers } from "./window-zoom";

type Pane = {
  view: WebContentsView;
  webview: ElectronWebview;
  url: string;
  panel: HostEditorWebview;
  stateChanged: () => void;
  shown: boolean;
  inLayout: boolean;
  unread: boolean;
};

export class DesktopConversationPanes {
  private readonly panes = new Map<number, Pane>();
  private covered = false;
  private showBelow = false;
  private stacked = false;
  private preferred?: number;
  private pendingFocus?: number;
  private pickerSnapshot?: string;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly log: (line: string) => void,
    private readonly getAuthContext: (webview: ElectronWebview) => DesktopOpenFileContext | undefined,
    private readonly applyCssZoom: (kind: "in" | "out" | "reset") => void = () => {},
    private readonly focusMain: () => void = () => {},
  ) {}

  open(opts: Parameters<Host["openEditorWebview"]>[0]): HostEditorWebview | undefined {
    const win = this.getWindow();
    if (opts.viewType !== "grok.conversation" || !win || win.isDestroyed()) return;
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        additionalArguments: [DESKTOP_CONVERSATION_PANE_ARG],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    const contents = view.webContents;
    const id = contents.id;
    const url = new URL(`conversation-${randomUUID()}.html`, APP_DOCUMENT_URL).href;
    const webview = new ElectronWebview(() => contents, url);
    webview.options = { enableScripts: true, localResourceRoots: opts.localResourceRoots };
    webview.getAuthContext = () => this.getAuthContext(webview) ?? {};
    webview.onDroppedMessage = (reason) => this.log(`[desk-pane] ${reason}`);

    const disposeListeners = new Set<() => void>();
    const stateListeners = new Set<() => void>();
    const stateChanged = () => { for (const listener of stateListeners) listener(); };
    const dispose = () => {
      if (!this.panes.delete(id)) return;
      if (this.preferred === id) this.preferred = undefined;
      if (this.pendingFocus === id) this.pendingFocus = undefined;
      if (!this.panes.size) this.covered = this.showBelow = this.stacked = false;
      if (!win.isDestroyed()) win.contentView.removeChildView(view);
      for (const listener of disposeListeners) listener();
      disposeListeners.clear();
      stateListeners.clear();
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      this.refreshLayout();
    };
    const panes = this.panes;
    const reveal = () => {
      if (!panes.has(id) || contents.isDestroyed()) return;
      this.preferred = id;
      if (panel.visible) return contents.focus();
      this.pendingFocus = id;
      this.showBelow = true;
      this.refreshLayout();
    };
    let title = opts.title;
    const panel: HostEditorWebview = {
      webview,
      get title() { return title; },
      set title(value) { title = value; updatePicker(); },
      get visible() {
        return !!panes.get(id)?.shown && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
      },
      get active() { return panel.visible && !contents.isDestroyed() && contents.isFocused(); },
      reveal,
      onDidChangeViewState(listener) {
        stateListeners.add(listener);
        return { dispose: () => stateListeners.delete(listener) };
      },
      onDidDispose(listener) {
        disposeListeners.add(listener);
        return { dispose: () => disposeListeners.delete(listener) };
      },
      dispose,
    };
    const updatePicker = () => this.publishPicker();
    const pane: Pane = { view, webview, url, panel, stateChanged, shown: false, inLayout: false, unread: false };
    let sessionId: unknown;
    webview.onHostMessage = message => {
      if (!message || typeof message !== "object") return;
      const frame = message as { type?: string; sessionId?: unknown; id?: unknown; dot?: string };
      if (frame.type === "editorChatBinding" || frame.type === "session") {
        if (sessionId !== frame.sessionId) {
          sessionId = frame.sessionId;
          pane.unread = false;
          updatePicker();
        }
      } else if (frame.type === "sessionDot" && frame.id === sessionId) {
        pane.unread = frame.dot === "unread" || frame.dot === "error";
        updatePicker();
      }
    };

    installWindowSecurityLocks({ webContents: contents }, {
      log: this.log,
      openExternal: (target) => shell.openExternal(target),
      allowNavigation: (target) => target === url,
    });
    installDesktopZoomHandlers(contents, this.applyCssZoom);
    const pinZoom = () => {
      contents.setZoomFactor(1);
      void contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    };
    pinZoom();
    contents.on("did-finish-load", () => {
      pinZoom();
      void contents.executeJavaScript(desktopChromeBootSource()).catch(() => {});
    });
    contents.on("focus", () => {
      if (pane.shown) this.preferred = id;
      stateChanged();
    });
    contents.on("blur", stateChanged);
    contents.once("destroyed", dispose);
    view.setVisible(false);
    win.contentView.addChildView(view);
    this.panes.set(id, pane);
    this.refreshLayout();
    return panel;
  }

  documentHtml(url: string): string | undefined {
    for (const pane of this.panes.values()) {
      if (pane.url === url) return pane.webview.getDocumentHtml();
    }
  }

  resolveResourceUrl(url: string): string | null {
    for (const pane of this.panes.values()) {
      const resolved = pane.webview.resolveResourceUrl(url);
      if (resolved) return resolved;
    }
    return null;
  }

  private fromEvent(event: IpcMainEvent): Pane | undefined {
    const pane = this.panes.get(event.sender.id);
    if (!pane || pane.view.webContents !== event.sender || event.sender.isDestroyed()) return;
    const frame = event.senderFrame;
    const main = event.sender.mainFrame;
    if (!frame || frame.parent || frame.url !== pane.url
        || frame.processId !== main.processId || frame.routingId !== main.routingId) return;
    return pane;
  }

  dispatch(event: IpcMainEvent, message: unknown): boolean {
    return this.fromEvent(event)?.webview.dispatchConversationMessage(message) ?? false;
  }

  close(event: IpcMainEvent): boolean {
    const pane = this.fromEvent(event);
    if (!pane) return false;
    pane.panel.dispose();
    this.getWindow()?.webContents.focus();
    return true;
  }

  setCovered(covered: boolean): void {
    if (this.covered === covered || !this.panes.size) return;
    this.covered = covered;
    for (const [id, pane] of this.panes) {
      if (covered && pane.shown && pane.view.webContents.isFocused()) {
        this.pendingFocus = id;
        this.getWindow()?.webContents.focus();
      }
    }
    this.applyVisibility();
  }

  private applyVisibility(): void {
    let lostFocus = false;
    for (const pane of this.panes.values()) {
      const { width, height } = pane.view.getBounds();
      const shown = !this.covered && pane.inLayout && width > 0 && height > 0;
      if (shown === pane.shown) continue;
      lostFocus ||= !shown && pane.view.webContents.isFocused();
      pane.shown = shown;
      pane.view.setVisible(shown);
      pane.stateChanged();
    }
    const pending = this.pendingFocus === undefined ? undefined : this.panes.get(this.pendingFocus);
    if (pending?.panel.visible) {
      this.pendingFocus = undefined;
      pending.view.webContents.focus();
    } else if (lostFocus && !this.covered) {
      this.getWindow()?.webContents.focus();
      this.focusMain();
    }
  }

  refreshLayout(): void {
    this.runInMain(`window.__grokConversationLayout?.(${this.panes.size}, ${this.showBelow})`);
    this.publishPicker(true);
  }

  private runInMain(source: string): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    void win.webContents.executeJavaScript(source).catch(() => {});
  }

  private publishPicker(force = false): void {
    const hidden = [...this.panes].filter(([, pane]) => !pane.inLayout)
      .map(([id, pane]) => ({ id, title: pane.panel.title, unread: pane.unread }));
    const snapshot = JSON.stringify([hidden, this.stacked]);
    if (!force && snapshot === this.pickerSnapshot) return;
    this.pickerSnapshot = snapshot;
    this.runInMain(`window.__grokConversationPicker?.(...${snapshot})`);
  }

  webviewForPicker(id: number): HostEditorWebview["webview"] | undefined {
    return this.panes.get(id)?.webview;
  }

  preferRestoredPane(webview: HostEditorWebview["webview"]): void {
    for (const [id, pane] of this.panes) {
      if (pane.webview === webview) {
        this.preferred = id;
        return;
      }
    }
  }

  windowVisibilityChanged(): void {
    for (const pane of this.panes.values()) {
      if (pane.shown) pane.stateChanged();
    }
  }

  showMainOnly(): void {
    this.showBelow = false;
    this.pendingFocus = undefined;
    this.refreshLayout();
    this.getWindow()?.webContents.focus();
    this.focusMain();
  }

  focusedContents(): Electron.WebContents | undefined {
    return [...this.panes.values()].find(pane => pane.panel.active)?.view.webContents;
  }

  layout(raw: unknown, count: unknown, stacked: unknown): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || this.panes.size === 0 || !raw || typeof raw !== "object") return;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || typeof stacked !== "boolean") return;
    const { x, y, width, height } = raw as Rectangle;
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 0 || height < 0) return;
    const content = win.getContentBounds();
    const usableWidth = Math.max(0, Math.min(width, content.width - x));
    const usableHeight = Math.max(0, Math.min(height, content.height - y));
    const slots = Math.min(count, this.panes.size);
    this.stacked = stacked && slots === 1;
    if (slots && !this.stacked) this.showBelow = false;
    const visible = [...this.panes.keys()].slice(0, slots);
    if (slots && this.preferred !== undefined && !visible.includes(this.preferred)) visible[slots - 1] = this.preferred;
    const columnWidth = Math.max(0, usableWidth - Math.max(0, slots - 1));
    for (const [id, pane] of this.panes) {
      const column = visible.indexOf(id);
      if (column < 0 && pane.inLayout) pane.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      pane.inLayout = column >= 0;
      if (!pane.inLayout) continue;
      const start = Math.round(column * columnWidth / slots) + column;
      const end = Math.round((column + 1) * columnWidth / slots) + column;
      pane.view.setBounds({ x: x + start, y, width: end - start, height: usableHeight });
    }
    this.applyVisibility();
    this.publishPicker();
  }

  dispose(): void {
    for (const { panel } of this.panes.values()) panel.dispose();
  }
}
