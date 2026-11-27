import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { app, shell, WebContentsView } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent, Rectangle } from "electron";
import type { Host, HostEditorWebview } from "../host";
import {
  DESKTOP_CONVERSATION_PANE_ARG, type DesktopChatDraftSnapshot, type DesktopPaneCloseSnapshot,
  planResizableConversationGrid, resizeConversationGrid,
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
  filesOpen: boolean;
  bounds?: Rectangle;
};

export class DesktopConversationPanes {
  private readonly panes = new Map<number, Pane>();
  private covered = false;
  private pendingFocus?: number;
  private geometry?: string;
  private gridRevision = 0;
  private grid?: ReturnType<typeof planResizableConversationGrid>;
  private area?: Rectangle & { zoom: number; filesOpen: boolean };
  private promoting = false;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly log: (line: string) => void,
    private readonly getAuthContext: (webview: ElectronWebview) => DesktopOpenFileContext | undefined,
    private readonly applyCssZoom: (kind: "in" | "out" | "reset") => void = () => {},
    private readonly focusMain: () => void = () => {},
    private gridSizes?: unknown,
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
      if (this.pendingFocus === id) this.pendingFocus = undefined;
      if (!this.panes.size) this.covered = false;
      if (!win.isDestroyed()) win.contentView.removeChildView(view);
      for (const listener of disposeListeners) listener();
      disposeListeners.clear();
      stateListeners.clear();
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      this.refreshLayout(true);
    };
    const panes = this.panes;
    const reveal = () => {
      if (!panes.has(id) || contents.isDestroyed()) return;
      this.pendingFocus = panel.visible ? undefined : id;
      if (panel.visible) contents.focus();
    };
    let title = opts.title;
    const panel: HostEditorWebview = {
      webview,
      get title() { return title; },
      set title(value) { title = value; },
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
    const pane: Pane = { view, webview, url, panel, stateChanged, shown: false, filesOpen: false };

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
    contents.on("focus", stateChanged);
    contents.on("blur", stateChanged);
    contents.once("destroyed", dispose);
    view.setVisible(false);
    win.contentView.addChildView(view);
    this.panes.set(id, pane);
    this.refreshLayout(true);
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
    // Confirm once in the window for edits across all panes.
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
      const shown = !this.covered && !!pane.bounds && pane.bounds.width > 0 && pane.bounds.height > 0;
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

  refreshLayout(panesChanged = false): void {
    if (!this.panes.size || (panesChanged && this.grid)) this.gridSizes = undefined;
    this.gridRevision++;
    this.grid = undefined;
    this.area = undefined;
    this.geometry = undefined;
    this.runInMain(`window.__grokConversationLayout?.(${this.panes.size}); window.__grokConversationClose?.(${this.panes.size > 0})`);
  }

  private runInMain(source: string): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    void win.webContents.executeJavaScript(source).catch(() => {});
  }

  windowVisibilityChanged(): void {
    for (const pane of this.panes.values()) {
      if (pane.shown) pane.stateChanged();
    }
    this.applyVisibility();
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
    const left = Math.min(x, content.width);
    const top = Math.min(y, content.height);
    const usableWidth = Math.min(width, content.width - left);
    const usableHeight = Math.min(height, content.height - top);
    if (!Number.isFinite(Math.max(usableWidth, usableHeight) / zoom)) return;
    const previous = this.area;
    if (previous?.x !== left || previous.y !== top || previous.width !== usableWidth ||
        previous.height !== usableHeight || previous.zoom !== zoom) this.gridRevision++;
    this.area = { x: left, y: top, width: usableWidth, height: usableHeight, zoom, filesOpen: mainFilesOpen };
    this.applyGrid();
  }

  get savedGridSizes(): unknown {
    return this.gridSizes;
  }

  resizeGrid(request: unknown): void {
    if (this.covered || !this.grid || !this.area?.width || !this.area.height) return;
    const next = resizeConversationGrid(this.grid, this.gridRevision, request);
    if (!next) return;
    this.gridSizes = next.columns || next.rows.some(Boolean) ? next : undefined;
    this.applyGrid();
  }

  private applyGrid(): void {
    if (!this.area) return;
    const { x, y, width, height, zoom, filesOpen } = this.area;
    const panes = [...this.panes.values()];
    const grid = planResizableConversationGrid(width, height, [filesOpen, ...panes.map(pane => pane.filesOpen)],
      zoom, width && height ? this.gridSizes : undefined);
    this.grid = grid;
    if (width && height) this.gridSizes = grid.sizes;
    const [main, ...cells] = grid.cells;
    const geometry = JSON.stringify([main.width / zoom, main.height / zoom, {
      revision: this.gridRevision, width, height, zoom, dividers: grid.dividers,
    }]);
    if (geometry !== this.geometry) {
      this.geometry = geometry;
      this.runInMain(`window.__grokConversationGeometry?.(...${geometry})`);
    }
    for (const [i, pane] of panes.entries()) {
      const cell = cells[i];
      const left = x + cell.x;
      const top = y + cell.y;
      const before = pane.bounds;
      if (before?.x === left && before.y === top && before.width === cell.width && before.height === cell.height) continue;
      pane.bounds = { ...cell, x: left, y: top };
      pane.view.setBounds(pane.bounds);
    }
    this.applyVisibility();
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
