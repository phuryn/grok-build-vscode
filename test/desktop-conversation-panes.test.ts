import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainEvent } from "electron";

const { makeContents, showItemInFolder, openPath, loadDocument, showMessageBox } = vi.hoisted(() => ({
  makeContents: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(async () => ""),
  loadDocument: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  shell: { openExternal: vi.fn(), showItemInFolder, openPath },
  dialog: { showMessageBox },
  BrowserWindow: class extends EventEmitter {
    loadURL = loadDocument;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  },
  WebContentsView: class {
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    webContents = makeContents();
    on = vi.fn();
    getBounds = () => this.bounds;
    setVisible = vi.fn();
    setBounds = (bounds: typeof this.bounds) => { this.bounds = bounds; };
  },
}));

import { DesktopConversationPanes } from "../src/desktop/conversation-panes";
import { createElectronHost, firstChangedLine, type ElectronHostOptions } from "../src/desktop/electron-host";
import type { ConfigStore } from "../src/desktop/config-store";
import { conversationColumnCapacity, DESKTOP_CONVERSATION_LAYOUT_BOOT } from "../src/desktop/conversation-layout";
import { ElectronWebview } from "../src/desktop/electron-webview";
import { Uri } from "../src/host";

function makePaneContents(id: number) {
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { processId: 4, routingId: 7, parent: null, url: "" },
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    focus: vi.fn(),
    send: vi.fn(),
    loadURL: vi.fn(async (url: string) => { contents.mainFrame.url = url; }),
    executeJavaScript: vi.fn(async () => {}),
    setWindowOpenHandler: vi.fn(),
    setVisualZoomLevelLimits: vi.fn(async () => {}),
    setZoomFactor: vi.fn(),
    close: vi.fn(() => { contents.emit("destroyed"); }),
  });
  return contents;
}

function fixture(getAuthContext?: ElectronHostOptions["getAuthContext"], selectedRoot = process.cwd()) {
  const contents = makePaneContents(22);
  makeContents.mockReturnValue(contents);
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 40, y: 40, width: 1200, height: 800 }),
    webContents: { isDestroyed: () => false, executeJavaScript: vi.fn(async () => ({ ok: true })), focus: vi.fn() },
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  } as unknown as BrowserWindow;
  const getWindow = () => window;
  const applyCssZoom = vi.fn();
  const panes = new DesktopConversationPanes(getWindow, vi.fn(), () => ({}), applyCssZoom);
  const host = createElectronHost({
    config: { getValue: () => undefined, getWorkspaceRoot: () => selectedRoot } as unknown as ConfigStore,
    getWindow,
    log: vi.fn(),
    conversationPanes: panes,
    getAuthContext,
  });
  const open = () => host.openEditorWebview({
    viewType: "grok.conversation", title: "Second chat", column: "beside", localResourceRoots: [],
  })!;
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent);
  return { contents, window, panes, host, open, event, applyCssZoom };
}

describe("desktop conversation pane host", () => {
  beforeEach(() => {
    makeContents.mockReset();
    showItemInFolder.mockReset();
    openPath.mockClear();
    loadDocument.mockClear();
    showMessageBox.mockClear();
  });

  it("opens a native child and routes validated editor frames and replies to its webview", async () => {
    const { contents, window, panes, host, open, event } = fixture();
    expect(host.canOpenConversationEditor).toBe(true);
    expect(host.openEditorWebview({ viewType: "grok.settings", title: "Settings", localResourceRoots: [] })).toBeUndefined();
    const panel = open();
    const receive = vi.fn();
    panel.webview.onDidReceiveMessage(receive);
    panel.webview.html = "<html><head></head><body>Second chat</body></html>";
    expect(window.contentView.addChildView).toHaveBeenCalledOnce();
    expect(panes.documentHtml(contents.mainFrame.url)).toContain("Second chat");
    expect(panes.dispatch(event(), { type: "ready" })).toBe(true);
    const action = { type: "editorChatAction", binding: 3, message: { type: "send", text: "second only" } };
    expect(panes.dispatch(event(), action)).toBe(true);
    expect(panes.dispatch(event(), { ...action, message: { type: "send", text: 42 } })).toBe(false);
    expect(panes.dispatch(event(), { ...action, message: { type: "openUrl", url: "file:///outside" } })).toBe(false);
    expect(receive.mock.calls).toEqual([[{ type: "ready" }], [action]]);
    await panel.webview.postMessage({ type: "editorChatBound", binding: 3 });
    expect(contents.send.mock.calls).toEqual([["host-to-webview", { type: "editorChatBound", binding: 3 }]]);
  });

  it("checks a pane's file reveal against its own roots again at use time", async () => {
    const docs = path.resolve("docs");
    const mainOnly = path.resolve("CLAUDE.md");
    const getAuthContext = vi.fn((source) =>
      source ? { allowedRoots: [docs] } : { workspaceRoot: process.cwd() });
    const { open, host } = fixture(getAuthContext);
    const { webview } = open();
    await host.showInFolder(mainOnly, webview);
    expect(showItemInFolder).not.toHaveBeenCalled();
    const paneFile = path.join(docs, "desktop.md");
    await host.showInFolder(paneFile, webview);
    expect(showItemInFolder.mock.calls).toEqual([[paneFile]]);
    expect(getAuthContext.mock.calls).toEqual([[webview], [webview]]);
  });

  it("refuses unregistered senders and child frames, even with the expected document URL", () => {
    const { contents, panes, open, event } = fixture();
    const panel = open();
    panel.webview.html = "<html></html>";
    const receive = vi.fn();
    panel.webview.onDidReceiveMessage(receive);
    for (const invalid of [
      { ...event(), sender: { ...contents, id: 23 } },
      { ...event(), sender: { ...contents } },
      { ...event(), senderFrame: null },
      { ...event(), senderFrame: { ...contents.mainFrame, routingId: 8, parent: contents.mainFrame } },
      { ...event(), senderFrame: { ...contents.mainFrame, url: "about:blank" } },
    ]) {
      expect(panes.dispatch(invalid as IpcMainEvent, { type: "ready" })).toBe(false);
    }
    expect(receive).not.toHaveBeenCalled();
  });

  it("opens the selected project's files and diffs in the dock, including when the other project is nested", async () => {
    const root = process.cwd();
    const docs = path.join(root, "docs");
    let cwd = root;
    const { host, window, open } = fixture(() => ({ allowedRoots: [cwd], sessionCwd: cwd }));
    const { webview } = open();
    const file = path.join(docs, "desktop.md");
    const execute = vi.mocked(window.webContents.executeJavaScript);
    const before = Uri.from({ scheme: "test-diff", path: "/before/desktop.md" });
    const after = Uri.from({ scheme: "test-diff", path: "/after/desktop.md" });
    host.registerTextDocumentContentProvider("test-diff", {
      provideTextDocumentContent: uri => uri === before ? "Before" : "After",
    });
    const openDiff = (sourcePath: string) => host.openDiff(before, after, "Desktop diff", { sourceWebview: webview, sourcePath });
    await host.openResource(file, { sourceWebview: webview });
    await openDiff(file);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("__grokDeskFtOpen?.("), true);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("__grokDeskFtOpenDiff?.("), true);
    expect(loadDocument).not.toHaveBeenCalled();

    cwd = docs;
    execute.mockClear();
    await host.openResource(file, { sourceWebview: webview });
    await openDiff(file);
    expect(execute).not.toHaveBeenCalled();
    const viewerHtml = loadDocument.mock.calls.map(([url]) => Buffer.from(url.split(",")[1], "base64").toString());
    expect(viewerHtml).toHaveLength(2);
    expect(viewerHtml[0]).toContain("read-only");
    expect(viewerHtml[1]).toContain("After");

    await host.openResource(path.join(root, "CLAUDE.md"), { sourceWebview: webview });
    await openDiff(path.join(root, "CLAUDE.md"));
    expect(loadDocument).toHaveBeenCalledTimes(2);
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it("starts a long turn diff's dock window at its first change", async () => {
    const root = process.cwd();
    const { host, window, open } = fixture(() => ({ allowedRoots: [root], sessionCwd: root }));
    const { webview } = open();
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
    const before = Uri.from({ scheme: "long-diff", path: "/before/README.md" });
    const after = Uri.from({ scheme: "long-diff", path: "/after/README.md" });
    host.registerTextDocumentContentProvider("long-diff", {
      provideTextDocumentContent: uri => uri === before ? lines.join("\n") : [...lines.slice(0, 1999), "changed"].join("\n"),
    });
    // The turn diff names line 0 (openDiffTexts); the dock's 1,600-line window must still reach line 2,000.
    await host.openDiff(before, after, "Long diff", {
      sourceWebview: webview, sourcePath: path.join(root, "README.md"),
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('"line":1999'), true);
    expect(loadDocument).not.toHaveBeenCalled();
  });

  it("finds a diff's first changed line", () => {
    expect(firstChangedLine("a\nb\nc", "a\nb\nc")).toBe(0);
    expect(firstChangedLine("a\nb\nc", "x\na\nb\nc")).toBe(0);
    expect(firstChangedLine("a\nb\nc", "a\nb\nC")).toBe(2);
    expect(firstChangedLine("a\nb", "a\nb\nc")).toBe(2);
    // An LF blob against a CRLF working file (Windows autocrlf).
    expect(firstChangedLine("a\nb\nc", "a\r\nb\r\nC")).toBe(2);
  });

  it("hands a pane's PDF to the OS app like the main chat, never to the text viewer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pane-pdf-"));
    const pdf = path.join(root, "report.pdf");
    writeFileSync(pdf, "%PDF-1.4");
    try {
      const { host, open } = fixture(() => ({ allowedRoots: [root], sessionCwd: root }), root);
      const { webview } = open();
      await host.openResource(pdf, { sourceWebview: webview });
      expect(openPath).toHaveBeenCalledWith(realpathSync(pdf));
      expect(loadDocument).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides the native pane for overlapping main layers and restores the same pane and focus", async () => {
    const { contents, window, panes, open } = fixture();
    const panel = open();
    const native = vi.mocked(window.contentView.addChildView).mock.calls[0][0] as unknown as {
      setVisible: ReturnType<typeof vi.fn>;
    };
    const stateChanged = vi.fn();
    panel.onDidChangeViewState?.(stateChanged);
    panes.layout({ x: 500, y: 0, width: 400, height: 700 }, 1, false);
    expect(panel.visible).toBe(true);
    stateChanged.mockClear();
    contents.isFocused.mockReturnValue(true);

    const dom = new Window();
    try {
      const doc = dom.document;
      doc.body.innerHTML = '<div><div class="top-bar"></div><div><div class="desk-ft-chat"></div></div></div>';
      const setCovered = vi.fn((covered: boolean) => panes.setCovered(covered));
      const page = Object.assign(dom, {
        grokDesktopConversations: { setCovered },
        __grokConversationLayout: (_count: number) => {},
        afkpilotLayers: {
          get depth() { return doc.querySelectorAll("#settings-overlay, .image-preview-overlay:not([hidden])").length; },
        },
      });
      let notifyMutation = () => {};
      class LayerObserver {
        constructor(callback: (records: unknown[]) => void) { notifyMutation = () => callback([]); }
        observe() {}
        disconnect() {}
      }
      runInNewContext(DESKTOP_CONVERSATION_LAYOUT_BOOT, {
        window: page, document: doc, MutationObserver: LayerObserver,
        ResizeObserver: dom.ResizeObserver, requestAnimationFrame: vi.fn(), cancelAnimationFrame: vi.fn(),
      });
      page.__grokConversationLayout(1);
      const settings = doc.createElement("div");
      settings.id = "settings-overlay";
      doc.body.append(settings);
      page.dispatchEvent(new dom.CustomEvent("afkpilot-layers"));
      expect(native.setVisible).toHaveBeenLastCalledWith(false);
      expect(panel.visible).toBe(false);
      expect(window.webContents.focus).toHaveBeenCalledOnce();
      panes.layout({ x: 530, y: 0, width: 350, height: 690 }, 1, false);
      expect(native.setVisible).toHaveBeenLastCalledWith(false);

      const image = doc.createElement("div");
      image.className = "image-preview-overlay";
      doc.body.append(image);
      settings.remove();
      page.dispatchEvent(new dom.CustomEvent("afkpilot-layers"));
      expect(panel.visible).toBe(false);
      image.hidden = true;
      page.dispatchEvent(new dom.CustomEvent("afkpilot-layers"));
      expect(panel.visible).toBe(true);
      expect(native.setVisible).toHaveBeenLastCalledWith(true);
      expect(contents.focus).toHaveBeenCalledOnce();

      doc.body.classList.add("desk-ft-maximized");
      notifyMutation();
      expect(panel.visible).toBe(false);
      doc.body.classList.remove("desk-ft-maximized");
      notifyMutation();
      expect(panel.visible).toBe(true);
      expect(setCovered.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
      expect(stateChanged).toHaveBeenCalledTimes(4);
      expect(contents.close).not.toHaveBeenCalled();
    } finally {
      await dom.happyDOM.close();
    }
  });

  it("closes the renderer once, revokes IPC immediately, and only emits panel disposal", () => {
    const { contents, window, panes, open, event } = fixture();
    const panel = open();
    panel.webview.html = "<html></html>";
    const dispose = vi.fn(() => {
      expect(panes.dispatch(event(), { type: "ready" })).toBe(false);
    });
    const receive = vi.fn();
    panel.onDidDispose(dispose);
    panel.webview.onDidReceiveMessage(receive);
    expect(panes.close(event(), () => true)).toBe(true);
    panel.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(contents.close).toHaveBeenCalledOnce();
    expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(panes.documentHtml(contents.mainFrame.url)).toBeUndefined();
    expect(receive).not.toHaveBeenCalled();
  });

  it("publishes one close state to the window and panes as the number of chats changes", () => {
    const { contents, window, panes, open, event } = fixture();
    panes.refreshLayout();
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("__grokConversationClose?.(false)"));
    const panel = open();
    panel.webview.html = "<html></html>";
    contents.emit("did-finish-load");
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("__grokConversationClose?.(true)"));
    expect(contents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("__grokConversationClose?.(true)"));
    vi.mocked(window.webContents.executeJavaScript).mockClear();
    expect(panes.close(event(), () => true)).toBe(true);
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("__grokConversationClose?.(false)"));
  });
  it("reserves the main column at the minimum width and counts only columns that fit at a scaled size", () => {
    expect(conversationColumnCapacity(400)).toBe(0);
    expect(conversationColumnCapacity(720)).toBe(0);
    expect(conversationColumnCapacity(721)).toBe(1);
    expect(conversationColumnCapacity(1081)).toBe(1);
    expect(conversationColumnCapacity(1082)).toBe(2);
    expect(conversationColumnCapacity(1082 / 1.15)).toBe(1);
  });

  it("offers the picker at the window floor and only stacks a child when explicitly revealed", async () => {
    const dom = new Window();
    try {
      const { document } = dom;
      document.body.innerHTML = '<main><header class="top-bar"></header><div><div class="desk-ft-chat"></div></div></main>';
      Object.defineProperty(dom, "innerWidth", { value: 400, writable: true });
      const bridge = { setBounds: vi.fn(), setCovered: vi.fn(), showPane: vi.fn() };
      const page = Object.assign(dom, {
        grokDesktopConversations: bridge,
        __grokConversationLayout: (_count: number, _below: boolean) => {},
        __grokConversationPicker: (_hidden: { title: string; id: number; unread: boolean }[], _stacked: boolean) => {},
      });
      let measure = () => {};
      runInNewContext(DESKTOP_CONVERSATION_LAYOUT_BOOT, {
        window: page, document, ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
        getComputedStyle: () => ({ zoom: "1" }), cancelAnimationFrame: () => {},
        requestAnimationFrame: (callback: () => void) => { measure = callback; },
      });
      page.__grokConversationLayout(2, false);
      const columns = document.getElementById("desk-conversation-columns")!;
      vi.spyOn(columns, "getBoundingClientRect").mockImplementation(() =>
        new dom.DOMRect(0, 0, dom.innerWidth, 600));
      measure();
      expect(document.body.classList.contains("desk-split-compact")).toBe(true);
      expect(bridge.setBounds.mock.lastCall?.slice(1)).toEqual([0, false]);

      page.__grokConversationPicker([{ title: "Draft", id: 22, unread: true }, { title: "Review", id: 23, unread: false }], false);
      const picker = document.querySelector("select")!;
      expect(picker.options[0].textContent).toContain("1 unread");
      picker.value = "22";
      picker.dispatchEvent(new dom.Event("change"));
      expect(bridge.showPane).toHaveBeenCalledWith(22);
      page.__grokConversationLayout(2, true);
      measure();
      expect(bridge.setBounds.mock.lastCall?.slice(1)).toEqual([1, true]);

      dom.innerWidth = 1100;
      page.dispatchEvent(new dom.Event("resize"));
      measure();
      expect(document.body.classList.contains("desk-split-compact")).toBe(false);
      expect(bridge.setBounds.mock.lastCall?.slice(1)).toEqual([2, false]);
      dom.innerWidth = 400;
      page.dispatchEvent(new dom.Event("resize"));
      measure();
      expect(bridge.setBounds.mock.lastCall?.slice(1)).toEqual([0, false]);
    } finally {
      await dom.happyDOM.close();
    }
  });

  it("swaps the same native panes with the picker, shows a hidden unread finish, and grows both back", async () => {
    const { contents, window, panes, open } = fixture();
    const first = open();
    const another = makePaneContents(23);
    makeContents.mockReturnValue(another);
    const second = open();
    second.title = "A hidden conversation";
    await second.webview.postMessage({ type: "editorChatBinding", sessionId: "hidden-id" });
    const side = { x: 400, y: 0, width: 400, height: 660 };
    panes.layout(side, 1, false);
    expect(first.visible).toBe(true);
    expect(second.visible).toBe(false);
    await second.webview.postMessage({ type: "sessionDot", id: "hidden-id", dot: "unread" });
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"title":"A hidden conversation","unread":true'),
    );

    expect(panes.webviewForPicker(23)).toBe(second.webview);
    second.reveal();
    panes.layout(side, 1, false);
    expect(second.visible).toBe(true);
    expect(first.visible).toBe(false);
    expect(another.focus).toHaveBeenCalledOnce();
    panes.layout(side, 0, false);
    expect(second.visible).toBe(false);
    second.reveal();
    panes.layout({ x: 0, y: 335, width: 385, height: 335 }, 1, true);
    expect(second.visible).toBe(true);
    panes.layout({ ...side, width: 790 }, 2, false);
    expect(first.visible && second.visible).toBe(true);
    for (const child of [contents, another]) {
      expect(child.loadURL).not.toHaveBeenCalled();
      expect(child.close).not.toHaveBeenCalled();
    }
  });

  it("pins native zoom and routes a pane shortcut through the same CSS zoom action once", () => {
    const { contents, open, applyCssZoom } = fixture();
    open();
    const event = { preventDefault: vi.fn() };
    contents.emit("before-input-event", event, { type: "keyDown", control: true, key: "=" });
    contents.emit("before-input-event", event, { type: "keyUp", control: true, key: "=" });
    contents.emit("zoom-changed");
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(applyCssZoom.mock.calls).toEqual([["in"]]);
  });

  it("reports restored panes as visible when the window is shown after their layout was measured", () => {
    const { panes, open, window } = fixture();
    const windowVisible = vi.spyOn(window, "isVisible").mockReturnValue(false);
    const panel = open();
    const visibility = vi.fn(() => panel.visible);
    panel.onDidChangeViewState?.(visibility);
    panes.layout({ x: 400, y: 0, width: 400, height: 650 }, 1, false);
    expect(visibility).toHaveLastReturnedWith(false);
    windowVisible.mockReturnValue(true);
    panes.windowVisibilityChanged();
    expect(visibility).toHaveLastReturnedWith(true);
  });

  it("keeps the main document and pane in sync on system and saved theme changes", async () => {
    const docs = [new Window(), new Window()];
    const prefs = new Map<string, string>();
    const system = { matches: false, notify: [] as (() => void)[] };
    try {
      for (const [i, dom] of docs.entries()) {
        const webview = new ElectronWebview(() => null, i === 0 ? undefined : "grok-resource://local/__app__/pane.html");
        dom.document.body.innerHTML = i === 0 ? '<div id="desk-conversation-columns"></div>' : "";
        if (i === 1) dom.document.body.dataset.editorChat = "true";
        webview.html = '<html><head><meta content="script-src \'nonce-test\'"></head><body></body></html>';
        const script = webview.getDocumentHtml().match(/id="grok-desktop-theme-boot">([\s\S]*?)<\/script>/)![1];
        const matchMedia = () => ({
          get matches() { return system.matches; },
          addEventListener: (_name: string, callback: () => void) => system.notify.push(callback),
        });
        Object.assign(dom, { matchMedia });
        runInNewContext(script, {
          window: dom, document: dom.document, matchMedia,
          localStorage: { getItem: (key: string) => prefs.get(key), setItem: (key: string, value: string) => prefs.set(key, value) },
        });
      }
      system.matches = true;
      system.notify.forEach(notify => notify());
      expect(docs.map(dom => dom.document.documentElement.dataset.theme)).toEqual(["light", "light"]);
      (docs[0] as any).__toggleDesktopTheme();
      docs[1].dispatchEvent(new docs[1].StorageEvent("storage", { key: "grok-desktop-theme" }));
      expect(docs.map(dom => dom.document.documentElement.dataset.theme)).toEqual(["dark", "dark"]);
    } finally {
      await Promise.all(docs.map(dom => dom.happyDOM.close()));
    }
  });
});
