import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { app, shell, WebContentsView } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent, Rectangle } from "electron";
import type { Host, HostEditorWebview } from "../host";
import {
  DESKTOP_CONVERSATION_PANE_ARG, type DesktopChatDraftSnapshot, type DesktopPaneCloseSnapshot,
  planConversationColumns,
} from "./conversation-layout";
import type { DesktopOpenFileContext } from "./desktop-policy";
import { APP_DOCUMENT_URL, desktopChromeBootSource, ElectronWebview } from "./electron-webview";
import { installWindowSecurityLocks } from "./window-security";
import { installDesktopZoomHandlers } from "./window-zoom";
import { injectFileTreePanelLogged } from "./file-tree-ipc";

type Pane = {
  view: WebContentsView;
  webview: ElectronWebview;
  url: string;
  panel: HostEditorWebview;
  stateChanged: () => void;
  shown: boolean;
  inLayout: boolean;
  unread: boolean;
  filesOpen: boolean;
};

export class DesktopConversationPanes {
  private readonly panes = new Map<number, Pane>();
  private covered = false;
  private showBelow = false;
  private stacked = false;
  private preferred?: number;
  private pendingFocus?: number;
  private pickerSnapshot?: string;
  private geometry?: string;
  private promoting = false;

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
    const pane: Pane = { view, webview, url, panel, stateChanged, shown: false, inLayout: false, unread: false, filesOpen: false };
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
      void contents.executeJavaScript("window.__grokConversationClose?.(true)").catch(() => {});
      void injectFileTreePanelLogged(contents, this.log);
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

  private fromEvent(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): Pane | undefined {
    const pane = this.panes.get(event.sender.id);
    if (!pane || pane.view.webContents !== event.sender || event.sender.isDestroyed()) return;
    const frame = event.senderFrame;
    const main = event.sender.mainFrame;
    if (!frame || frame.parent || frame.url !== pane.url
        || frame.processId !== main.processId || frame.routingId !== main.routingId) return;
    return pane;
  }

  dispatch(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, message: unknown): boolean {
    return this.fromEvent(event)?.webview.dispatchConversationMessage(message) ?? false;
  }

  webviewFromEvent(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): ElectronWebview | undefined {
    return this.fromEvent(event)?.webview;
  }

  fileRootsChanged(): void {
    for (const { view } of this.panes.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.send("desk-ft:root-changed");
    }
  }

  filePanelChanged(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, open: boolean): void {
    const pane = this.fromEvent(event);
    if (!pane || pane.filesOpen === open) return;
    pane.filesOpen = open;
    this.runInMain("window.__grokMeasureConversationLayout?.()");
  }

  async confirmFilesClose(): Promise<boolean> {
    const contents = this.getWindow()?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    const dirty = await Promise.all([...this.panes.values()].map(({ view }) =>
      view.webContents.executeJavaScript("window.__grokDeskFilePanel?.hasDirty()").catch(() => !view.webContents.isDestroyed())));
    if (!dirty.some(Boolean)) return true;
    // A chat may be in More chats. Confirm in the visible window.
    return await contents.executeJavaScript("window.__grokDeskFtBeforeClose?.(true)") === true;
  }

  close(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    saveDraft: (webview: ElectronWebview) => boolean): boolean {
    const pane = this.fromEvent(event);
    if (!pane || this.promoting || !saveDraft(pane.webview)) return false;
    pane.panel.dispose();
    this.getWindow()?.webContents.focus();
    return true;
  }

  async closeMain(adopt: (webview: ElectronWebview, snapshot: DesktopPaneCloseSnapshot) => boolean): Promise<boolean> {
    const first = this.panes.entries().next().value;
    if (!first || this.promoting) return false;
    const [id, pane] = first;
    const contents = pane.view.webContents;
    this.promoting = true;
    try {
      const raw: unknown = await contents.executeJavaScript("window.__grokLockPaneForPromotion?.()");
      const snapshot = parsePaneCloseSnapshot(raw);
      return !!snapshot && this.panes.get(id) === pane && adopt(pane.webview, snapshot);
    } finally {
      this.promoting = false;
      if (!contents.isDestroyed()) void contents.executeJavaScript("document.body.inert = false").catch(() => {});
    }
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
    this.geometry = undefined;
    this.runInMain(`window.__grokConversationLayout?.(${this.panes.size}); window.__grokConversationClose?.(${this.panes.size > 0})`);
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

  layout(raw: unknown, zoom: unknown, mainFilesOpen: unknown): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || this.panes.size === 0 || !raw || typeof raw !== "object") return;
    if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0 || typeof mainFilesOpen !== "boolean") return;
    const { x, y, width, height } = raw as Rectangle;
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 0 || height < 0) return;
    const content = win.getContentBounds();
    const usableWidth = Math.max(0, Math.min(width, content.width - x));
    const usableHeight = Math.max(0, Math.min(height, content.height - y));
    const entries = [...this.panes];
    const preferred = entries.findIndex(([id]) => id === this.preferred) + 1;
    let columns = planConversationColumns(usableWidth, [mainFilesOpen, ...entries.map(([, pane]) => pane.filesOpen)], preferred, zoom);
    this.stacked = this.showBelow && preferred > 0 && !columns.some(column => column.index === preferred);
    if (this.stacked) columns = [{ index: 0, width: usableWidth }, { index: preferred, width: usableWidth }];
    else if (columns.length > 1) this.showBelow = false;
    const geometry = JSON.stringify([columns[0].width / zoom, this.stacked, columns.length - 1]);
    if (geometry !== this.geometry) {
      this.geometry = geometry;
      this.runInMain(`window.__grokConversationGeometry?.(...${geometry})`);
    }
    const bounds = new Map<number, Rectangle>();
    let left = x;
    for (const { index, width: pairWidth } of columns) {
      if (index > 0) {
        const top = this.stacked ? y + Math.ceil(usableHeight / 2) + 1 : y;
        bounds.set(entries[index - 1][0], { x: this.stacked ? x : left, y: top, width: pairWidth,
          height: Math.max(0, usableHeight - (top - y)) });
      }
      left += pairWidth + 1;
    }
    for (const [id, pane] of this.panes) {
      const next = bounds.get(id);
      if (next) pane.view.setBounds(next);
      else if (pane.inLayout) pane.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      pane.inLayout = !!next;
    }
    this.applyVisibility();
    this.publishPicker();
  }

  dispose(): void {
    for (const { panel } of this.panes.values()) panel.dispose();
  }
}

export function isDesktopChatDraftSnapshot(raw: unknown): raw is DesktopChatDraftSnapshot {
  if (!raw || typeof raw !== "object") return false;
  const { text, chipIds, revision } = raw as Partial<DesktopChatDraftSnapshot>;
  return (text === null || typeof text === "string") && Array.isArray(chipIds) &&
    chipIds.every(id => typeof id === "string") && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
}

export function parsePaneCloseSnapshot(raw: unknown): DesktopPaneCloseSnapshot | undefined {
  if (!isDesktopChatDraftSnapshot(raw) || !("binding" in raw) || !("scrollTop" in raw)) return;
  const { binding, scrollTop } = raw;
  if (typeof binding === "number" && Number.isSafeInteger(binding) && binding >= 0 &&
      (scrollTop === null || (typeof scrollTop === "number" && Number.isFinite(scrollTop)))) {
    return { ...raw, binding, scrollTop };
  }
}
