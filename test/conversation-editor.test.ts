import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { Uri } from "../src/host";
import { createFileMemento } from "../src/desktop/memento";
import { encodeSessionCatalogLeaf } from "../src/sessions";
import type { DeskAlert } from "../src/desk-alerts";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
// @ts-expect-error Standalone QA fixture builder has no declarations.
import { buildQaFixture } from "../scripts/qa-fixture.mjs";
import { bootWebview, click, dispatch, type Posted } from "./webview-harness";

function makeSession(id: string) {
  return Object.assign(new Session(), {
    activeSessionId: id,
    cwd: "/repo",
    hasHistory: true,
    client: { sessionId: id, cancel: vi.fn() },
    buffer: [{ type: "messageChunk", text: `Transcript ${id}` }],
  });
}

function panelFixture(title: string) {
  let receive: (frame: unknown) => void;
  let close: () => void;
  let changeViewState: (() => void) | undefined;
  return {
    title,
    visible: true,
    active: true,
    webview: {
      html: "",
      postMessage: vi.fn(async (_message: unknown) => true),
      onDidReceiveMessage: (listener: typeof receive) => {
        receive = listener;
        return { dispose: vi.fn() };
      },
    },
    onDidDispose: (listener: typeof close) => { close = listener; },
    onDidChangeViewState: (listener: () => void) => {
      changeViewState = listener;
      return { dispose: vi.fn() };
    },
    focus: () => changeViewState?.(),
    changeViewState: () => changeViewState?.(),
    reveal: vi.fn(),
    dispose: () => close(),
    receive: (frame: unknown) => receive(frame),
  };
}

function setup(capable = true) {
  const sidebar = makeSession("sidebar");
  const first = makeSession("one");
  const second = makeSession("two");
  const pool = new Set([sidebar, first, second]);
  const panels: ReturnType<typeof panelFixture>[] = [];
  const railPost = vi.fn();
  const messages: Record<string, unknown> = {};
  const sound = { enabled: true };
  const settings = { openConversationIn: "lastUsed" };
  const configListeners = new Set<(event: { affectsConfiguration(key: string): boolean }) => void>();
  const host = {
    canOpenConversationEditor: capable,
    openEditorWebview: vi.fn(({ title }: { title: string }) => {
      const panel = panelFixture(title);
      panels.push(panel);
      return panel;
    }),
    revealChatView: vi.fn(),
    getActiveTextEditor: vi.fn(),
    getConfiguration: () => ({ get: (key: string) => {
      if (key === "openConversationIn") return settings.openConversationIn;
      return key === "soundNotifications" ? sound.enabled : true;
    } }),
    onDidChangeConfiguration(listener: (event: { affectsConfiguration(key: string): boolean }) => void) {
      configListeners.add(listener);
      return { dispose: () => { configListeners.delete(listener); } };
    },
    workspaceRoot: () => "/repo",
    appendLine: vi.fn(),
  };
  const controller = Object.assign(Object.create(GrokSidebar.prototype), {
    host,
    context: { extensionUri: Uri.file("/extension") },
    pool,
    focused: sidebar,
    editorChats: new Set(),
    editorDrafts: new Map(),
    projectsRail: { webview: { postMessage: railPost } },
    state: {
      get: (key: string, fallback: unknown) => messages[key] ?? fallback,
      update: (key: string, value: unknown) => { messages[key] = value; },
    },
    sessionCache: new Map(),
    worktreeCache: [],
    allAdapterCatalogs: () => [],
    adapterHistory: () => undefined,
    sessionDisplayName: (session: Session) => (messages["grok.sessionMeta"] as
      Record<string, { customName?: string }> | undefined)?.[session.activeSessionId ?? ""]?.customName
      ?? session.activeSessionId,
    getHtml: (_: unknown, editor: boolean) => editor ? "full chat" : "",
    chatLocalResourceRoots: () => [],
    reserveBehindInFlightLoad: async () => ({ reservation: {} }),
    releaseSessionLoad: vi.fn(),
    noteSessionOpened: vi.fn(),
    markRead: vi.fn(),
    remoteClients: { clients: () => [] },
    sendRemoteSession: vi.fn(),
    postRepoCatalog: vi.fn(),
    postSessionsList: vi.fn(),
    resolveLocalRepoTarget: () => undefined,
    refreshWorkflowCompletions: vi.fn(),
    restorePersistedDraft: vi.fn(),
    postRemoteStatus: vi.fn(),
    voiceSetting: (_cwd: string, _key: string, fallback: unknown) => fallback,
    voiceBackendState: () => ({ backend: "xai" }),
    watchActiveEditor: vi.fn(),
    buildInitialStateMsg: () => ({ type: "initialState", soundNotifications: sound.enabled }),
    providerStateMessage: () => ({ type: "providerState" }),
    modelPinsMessage: () => ({ type: "modelPins" }),
    displayMode: () => "agent",
    sessionIdentityFrame: (session: Session) => ({ type: "session", sessionId: session.activeSessionId }),
    handleSend: vi.fn(),
    openSession: vi.fn(async (id: string) => {
      controller.focused = [...pool].find(session => session.activeSessionId === id);
    }),
  });
  const beside = (id: string) => controller.onProjectsRailMessage({ type: "openConversationBeside", id, cwd: "/repo" });
  const plain = (id: string) => controller.onProjectsRailMessage({ type: "resumeSession", id, cwd: "/repo", claim: true });
  const binding = (panel: ReturnType<typeof panelFixture>) =>
    panel.webview.postMessage.mock.calls.map(call => call[0] as any).filter(msg => msg.type === "editorChatBound").at(-1)?.binding;
  return { controller, host, panels, railPost, sidebar, first, second, pool, beside, plain, binding, configListeners, sound, settings };
}

function editorWorkspaceState() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

function editorPanelState(panel: ReturnType<typeof panelFixture>) {
  const frame = panel.webview.postMessage.mock.calls.map(([value]) => value as Posted)
    .find(message => message.type === "editorChatBinding");
  return { editorChatRestoreKey: frame?.restoreKey };
}

describe("VS Code conversation editor", () => {
  it.each(["saved", "new", "missing", "failed load"])("restores a %s panel in place with its draft and starts only when shown", async scenario => {
    const firstWindow = setup();
    const workspace = editorWorkspaceState();
    firstWindow.controller.context.workspaceState = workspace;
    if (scenario === "new") {
      firstWindow.controller.newLocalSession = () => Object.assign(new Session(), { activeSessionId: "unsent-provider-id" });
      firstWindow.controller.defaultProviderForProject = () => "codex";
      firstWindow.controller.startSession = vi.fn();
      firstWindow.controller.sweepEmptySessions = vi.fn();
      firstWindow.controller.resolveLocalRepoTarget = () => ({ cwd: "/other-project" });
      await firstWindow.controller.onProjectsRailMessage({ type: "newConversationBeside", cwd: "/other-project" });
    } else {
      await firstWindow.beside("one");
    }
    const original = firstWindow.panels[0];
    original.receive({ type: "ready" });
    const draft = "  typed before reload\n下一行\n";
    const chip = { id: "restored-chip", path: "/repo/file.ts", relPath: "file.ts", hidden: false };
    firstWindow.controller.lastEditorChat.session.restoredChips = [chip];
    original.receive({ type: "editorChatDraft", binding: firstWindow.binding(original), text: draft, chipIds: [chip.id] });
    const serialized = editorPanelState(original);
    expect(serialized.editorChatRestoreKey).toEqual(expect.any(String));

    const restored = setup();
    restored.pool.delete(restored.first);
    restored.controller.context.workspaceState = workspace;
    restored.controller.newLocalSession = () => new Session();
    restored.controller.resolveLocalRepoTarget = (cwd: string) => ({ cwd });
    restored.controller.configureLocalResumeSession = (session: Session, id: string, cwd: string) => {
      if (scenario === "missing") return false;
      expect(id).toBe("one");
      session.cwd = cwd;
      return true;
    };
    restored.controller.bindSessionLoad = vi.fn();
    restored.controller.startSession = vi.fn(async (id: string | undefined, session: Session) => {
      if (scenario === "failed load") {
        session.activeSessionId = undefined;
        return;
      }
      session.activeSessionId = id ?? "new-provider-id";
      return { sessionId: session.activeSessionId };
    });
    const nativePanel = panelFixture(original.title);
    nativePanel.visible = nativePanel.active = false;
    restored.controller.restoreEditorConversation(nativePanel, { ...serialized, cwd: "/untrusted", sessionId: "two" });
    nativePanel.receive({ type: "ready" });
    expect(restored.host.openEditorWebview).not.toHaveBeenCalled();
    expect(nativePanel.webview).toHaveProperty("options.enableScripts", true);
    expect(nativePanel.reveal).not.toHaveBeenCalled();
    expect(restored.controller.startSession).not.toHaveBeenCalled();
    expect(nativePanel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "restoreComposer", text: draft, chips: [chip],
    }));

    nativePanel.visible = true;
    nativePanel.changeViewState();
    nativePanel.changeViewState();
    if (scenario === "missing" || scenario === "failed load") {
      await vi.waitFor(() => expect(nativePanel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })));
      expect(restored.controller.startSession).toHaveBeenCalledTimes(scenario === "missing" ? 0 : 1);
      expect(nativePanel.webview.postMessage).toHaveBeenCalledWith({ type: "setBusy", value: false });
      await restored.controller.onEditorChatMessage([...restored.controller.editorChats][0], {
        type: "editorChatAction", binding: restored.binding(nativePanel), message: { type: "send", text: draft },
      });
      expect(restored.controller.handleSend).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(restored.controller.startSession).toHaveBeenCalledOnce());
      const [id, session] = restored.controller.startSession.mock.calls[0];
      expect(id).toBe(scenario === "new" ? undefined : "one");
      expect(session.cwd).toBe(scenario === "new" ? "/other-project" : "/repo");
      if (scenario === "new") expect(session.provider).toBe("codex");
    }
  });

  it.each(["navigates away", "closes"])("keeps a parked draft across a reload when a tab %s", async (gesture) => {
    const firstWindow = setup();
    const workspace = editorWorkspaceState();
    firstWindow.controller.context.workspaceState = workspace;
    await firstWindow.beside("one");
    const panel = firstWindow.panels[0];
    panel.receive({ type: "ready" });
    panel.receive({ type: "editorChatDraft", binding: firstWindow.binding(panel), text: "Parked draft for one" });
    if (gesture === "closes") panel.dispose();
    await firstWindow.plain("two");
    // A plain click falls back to the sidebar after closing the only tab.
    if (gesture === "closes") await firstWindow.beside("two");
    const kept = firstWindow.panels.at(-1)!;
    kept.receive({ type: "ready" });
    kept.receive({ type: "editorChatDraft", binding: firstWindow.binding(kept), text: "Open draft for two" });

    const restored = setup();
    restored.controller.context.workspaceState = workspace;
    restored.controller.restoreEditorConversation(panelFixture("two"), editorPanelState(kept));
    await restored.beside("one");
    const reopened = restored.panels[0];
    reopened.receive({ type: "ready" });
    expect(reopened.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "restoreComposer", text: "Parked draft for one",
    }));
    expect(reopened.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Open draft for two" }));
  });

  it("publishes every open conversation through focus, replacement, and a background tab closing", async () => {
    const { beside, plain, panels, controller, railPost, sidebar, pool } = setup();
    pool.add(makeSession("three"));
    await beside("one");
    await beside("two");
    panels[0].focus();
    await plain("three");
    expect(railPost).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", editor: true, sessionId: "three",
      openSessionIds: expect.arrayContaining(["sidebar", "three", "two"]),
    }));
    panels[1].dispose();
    expect(railPost.mock.lastCall?.[0]).toMatchObject({
      type: "projectsRailChatTarget", sessionId: "three", openSessionIds: ["sidebar", "three"],
    });
    controller.setLastEditorChat(undefined);
    expect(railPost).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", editor: false,
      openSessionIds: expect.arrayContaining([sidebar.activeSessionId, "three"]),
    }));
  });

  it("retargets the rail when the sidebar warm-switches to a live conversation", () => {
    const { controller, railPost, first } = setup();
    controller.focused = first;
    controller.mirrorToProjectsRail({ type: "sessionName", sessionId: "one", name: "one" });
    expect(railPost).toHaveBeenCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", editor: false, sessionId: "one",
    }));
  });

  it.each([
    { status: "done", dot: "unread" },
    { status: "error", dot: "error" },
  ])("marks a covered tab $dot and clears it when visible without focus", async ({ status, dot }) => {
    const { beside, panels, controller, first, railPost } = setup();
    delete controller.markRead;
    controller.remoteClients.isActiveValueVisible = () => false;
    controller.refreshKeepAwake = vi.fn();
    controller.refreshSessionOrderAfterTurn = vi.fn();
    await beside("one");
    const panel = panels[0];
    panel.active = panel.visible = false;
    panel.changeViewState();
    controller.setStatus(first, status);
    expect(controller.state.get("grok.sessionMeta", {}).one?.unread).toBe(true);
    expect(railPost).toHaveBeenLastCalledWith({ type: "sessionDot", id: "one", dot });

    panel.visible = true;
    panel.changeViewState();
    expect(controller.state.get("grok.sessionMeta", {}).one?.unread).toBeUndefined();
    expect(railPost).toHaveBeenLastCalledWith({ type: "sessionDot", id: "one", dot: "none" });
  });

  it.each(["editor", "sidebar", "remote", "unsplit sidebar"])("counts a conversation as watched by its %s", async (viewer) => {
    const { beside, panels, controller, sidebar } = setup();
    controller.view = { visible: viewer === "sidebar", webview: { postMessage: vi.fn() } };
    controller.remoteClients.isActiveValueVisible = () => viewer === "remote";
    controller.refreshKeepAwake = vi.fn();
    controller.refreshSessionOrderAfterTurn = vi.fn();
    if (viewer !== "unsplit sidebar") {
      await beside("sidebar");
      panels[0].active = false;
      panels[0].visible = viewer === "editor";
    }
    controller.setStatus(sidebar, "done");
    expect(controller.state.get("grok.sessionMeta", {}).sidebar).toBeUndefined();
  });

  it("routes editor-preferred clicks to a new, existing, or last-used tab even after sidebar focus", async () => {
    const { beside, plain, panels, controller, settings } = setup();
    settings.openConversationIn = "editor";
    await plain("one");
    expect(panels).toHaveLength(1);
    await beside("two");
    panels[0].focus();
    controller.setLastEditorChat(undefined);
    await plain("sidebar");
    expect(panels).toHaveLength(2);
    expect(panels[0].title).toBe("sidebar");
    await plain("two");
    expect(panels[1].reveal).toHaveBeenCalledOnce();
    expect(controller.openSession).not.toHaveBeenCalled();
  });

  it("updates the rail when the setting changes and routes sidebar-preferred clicks to the sidebar", async () => {
    const { beside, plain, controller, host, settings, configListeners, railPost, panels } = setup();
    controller.getProjectsRailHtml = () => "";
    controller.resolveProjectsRailView({ webview: { postMessage: railPost, onDidReceiveMessage: vi.fn() } });
    await beside("one");
    settings.openConversationIn = "sidebar";
    for (const listener of configListeners) listener({ affectsConfiguration: key => key === "grok.openConversationIn" });
    expect(railPost).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", editor: false, revealActive: true,
    }));
    await plain("two");
    expect(controller.openSession).toHaveBeenCalledWith("two", "/repo");
    expect(host.revealChatView).toHaveBeenCalledOnce();
    expect(panels[0].title).toBe("one");
  });

  it.each(["newSession", "resumeSession"])("parks a saved tab draft on accepted %s and restores it on return", async type => {
    const { controller, first, second, beside, panels, binding } = setup();
    const fresh = new Session();
    controller.newLocalSession = () => fresh;
    controller.defaultProviderForProject = () => "grok";
    controller.startSession = vi.fn();
    controller.sweepEmptySessions = vi.fn();
    await beside("one");
    const panel = panels[0];
    panel.receive({ type: "ready" });
    panel.receive({ type: "editorChatDraft", binding: binding(panel), text: "Draft for A" });
    controller.editorDrafts.set("two", { text: "Draft for B", chips: [] });
    await controller.onEditorChatMessage(controller.lastEditorChat, { type: "editorChatAction", binding: binding(panel),
      message: { type, id: "two", cwd: "/repo" },
    });
    expect(controller.lastEditorChat.session).toBe(type === "newSession" ? fresh : second);
    expect(controller.editorDrafts.has(first)).toBe(false);
    expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "editorChatBinding", switchDraft: true }));
    if (type === "resumeSession") {
      expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "restoreComposer", text: "Draft for B" }));
    }
    await controller.openEditorConversation("one", "/repo", controller.lastEditorChat);
    expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "restoreComposer", text: "Draft for A" }));
    expect(controller.editorDrafts.get(first)?.text).toBe("Draft for A");
  });

  it.each([
    { alreadyOpen: false, id: undefined },
    { alreadyOpen: false, id: "unsaved-provider-id" },
    { alreadyOpen: true, id: undefined },
  ])("keeps a never-sent tab beside the rail destination ($alreadyOpen, $id)", async ({ alreadyOpen, id }) => {
    const { controller, second, beside, plain, panels, host, binding } = setup();
    if (alreadyOpen) await beside("two");
    await beside("one");
    const tab = controller.lastEditorChat;
    const panel = panels.at(-1)!;
    const fresh = Object.assign(new Session(), { activeSessionId: id });
    controller.newLocalSession = () => fresh;
    controller.defaultProviderForProject = () => "grok";
    controller.startSession = vi.fn();
    controller.sweepEmptySessions = vi.fn();
    panel.receive({ type: "ready" });
    await controller.onEditorChatMessage(tab, { type: "editorChatAction", binding: binding(panel), message: { type: "newSession" } });
    panel.receive({ type: "editorChatDraft", binding: binding(panel), text: "Never sent" });
    await plain("two");
    expect(panels).toHaveLength(2);
    expect(tab.session).toBe(fresh);
    expect(controller.editorDrafts.get(fresh)?.text).toBe("Never sent");
    expect(controller.lastEditorChat.session).toBe(second);
    expect(host.openEditorWebview).toHaveBeenLastCalledWith(expect.objectContaining({ column: "beside" }));
    if (alreadyOpen) expect(panels[0].reveal).toHaveBeenCalledOnce();
  });

  it("keeps the same bound draft through a new provider id and a webview reload", async () => {
    const { controller, first, beside, panels, binding } = setup();
    await beside("one");
    first.hasHistory = false;
    const panel = panels[0];
    panel.receive({ type: "ready" });
    panel.receive({ type: "editorChatDraft", binding: binding(panel), text: "Draft before first send" });
    controller.connectedProviders = () => ["grok", "codex"];
    controller.detachClient = vi.fn();
    controller.rememberProjectProvider = vi.fn();
    controller.discardRestartedEmptySession = vi.fn();
    controller.startSession = async (_id: undefined, session: Session) => {
      session.activeSessionId = "new-provider-id";
      controller.emitEditorSession(session, { type: "session", sessionId: session.activeSessionId, models: [], provider: "codex" });
    };
    await controller.switchModel("codex-model", first, undefined, "codex");
    expect(first.activeSessionId).toBe("new-provider-id");
    expect(controller.editorDrafts.get(first)?.text).toBe("Draft before first send");
    panel.receive({ type: "ready" });
    expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "restoreComposer", text: "Draft before first send" }));
  });

  it("names the last-used tab's worktree in the Command Palette confirmation", async () => {
    const { controller, sidebar, first, beside } = setup();
    first.worktree = { label: "tab A", path: "/worktree-a" } as typeof first.worktree;
    sidebar.worktree = { label: "sidebar B", path: "/worktree-b" } as typeof sidebar.worktree;
    controller.host.showWarningMessage = vi.fn();
    await beside("one");
    await controller.removeFocusedWorktree();
    expect(controller.host.showWarningMessage).toHaveBeenLastCalledWith(expect.stringContaining("tab A"), { modal: true }, "Remove");
    controller.setLastEditorChat(undefined);
    await controller.removeFocusedWorktree();
    expect(controller.host.showWarningMessage).toHaveBeenLastCalledWith(expect.stringContaining("sidebar B"), { modal: true }, "Remove");
  });

  it.each([true, false])("reveals and focuses the existing alert tab (ready at click: %s)", async ready => {
    const { controller, host, panels, beside, first } = setup();
    const show = vi.fn((_alert: DeskAlert) => {});
    controller.host.deskAlerts = { isAway: (shown: boolean) => !shown, show };
    await beside("one");
    const panel = panels[0];
    panel.visible = panel.active = false;
    if (ready) panel.receive({ type: "ready" });
    const webview = bootWebview({ vscode: true, beforeScripts: window => {
      window.document.body.dataset.editorChat = "true";
    } });
    const input = webview.doc.querySelector<HTMLTextAreaElement>("#input")!;
    input.blur();
    panel.webview.postMessage.mockImplementation(async frame => {
      dispatch(webview.window, frame as Posted);
      return true;
    });
    controller.showDeskAlert(first, "done");
    await show.mock.calls[0][0].open();

    expect(panel.reveal).toHaveBeenCalledOnce();
    expect(controller.openSession).not.toHaveBeenCalled();
    expect(host.revealChatView).not.toHaveBeenCalled();
    expect(panel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "focusInput" }));
    panel.visible = panel.active = true;
    panel.focus();
    if (!ready) {
      expect(webview.doc.activeElement).not.toBe(input);
      panel.receive({ type: "ready" });
    }
    expect(webview.doc.activeElement).toBe(input);
    panel.focus();
    expect(panel.webview.postMessage.mock.calls.filter(([frame]) => (frame as Posted).type === "focusInput")).toHaveLength(1);
  });

  it.each([{ type: "agentEnd" }, { type: "agentError", text: "Failed" }])(
    "assigns a shared conversation's $type sound to exactly one local webview", async message => {
      const { controller, panels, sidebar, beside } = setup();
      const sidebarPost = vi.fn();
      controller.view = { visible: true, webview: { postMessage: sidebarPost } };
      await beside("sidebar");
      const panel = panels[0];
      panel.receive({ type: "ready" });
      expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: "initialState", soundNotifications: true,
      }));

      controller.emit(sidebar, message);
      expect(panel.webview.postMessage).toHaveBeenLastCalledWith(message);
      expect(sidebarPost).toHaveBeenLastCalledWith({ ...message, suppressTurnSound: true });
      expect(controller.sendRemoteSession).toHaveBeenLastCalledWith(sidebar, message);
      expect(sidebar.buffer.at(-1)).toEqual(message);

      controller.setLastEditorChat(undefined);
      controller.emit(sidebar, message);
      expect(panel.webview.postMessage).toHaveBeenLastCalledWith({ ...message, suppressTurnSound: true });
      expect(sidebarPost).toHaveBeenLastCalledWith(message);

      panel.visible = false;
      controller.setLastEditorChat(controller.editorChatFor(sidebar));
      controller.emit(sidebar, message);
      expect(panel.webview.postMessage).toHaveBeenLastCalledWith({ ...message, suppressTurnSound: true });
      expect(sidebarPost).toHaveBeenLastCalledWith(message);
    },
  );

  it("keeps a hidden tab's turn chime preference current without a sidebar", async () => {
    const { controller, configListeners, panels, first, beside, sound } = setup();
    await beside("one");
    const panel = panels[0];
    panel.receive({ type: "ready" });
    panel.visible = panel.active = false;
    controller.emit(first, { type: "agentEnd" });
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith({ type: "agentEnd" });
    sound.enabled = false;
    for (const listen of configListeners) listen({ affectsConfiguration: key => key === "grok.soundNotifications" });
    expect(panel.webview.postMessage).toHaveBeenLastCalledWith({ type: "soundNotifications", value: false });
    panel.dispose();
    expect(configListeners.size).toBe(0);
  });

  it("finishes a cold replay when a side gesture leaves an editor and the new tab becomes ready mid-load", async () => {
    const { beside, panels, controller, first, second } = setup();
    await beside("one");
    panels[0].receive({ type: "ready" });
    panels[0].receive({ type: "localChatFocus" });
    expect(controller.lastEditorChat.session).toBe(first);

    const h = bootWebview({ vscode: true, beforeScripts: window => {
      window.document.body.dataset.editorChat = "true";
    } });
    const resumeClient = second.client;
    (second as Session).client = undefined;
    second.buffer = [];
    controller.bindSessionLoad = vi.fn();
    controller.startSession = async () => {
      second.client = resumeClient;
      second.replaying = true;
      controller.emit(second, { type: "historyReplay", active: true });
      controller.emit(second, { type: "userMessageChunk", text: "CSV export request" });
      const panel = panels[1];
      panel.webview.postMessage.mockImplementation(async message => {
        dispatch(h.window, message as Posted);
        return true;
      });
      panel.receive({ type: "ready" });
      controller.emit(second, { type: "messageChunk", text: "CSV export transcript" });
      second.replaying = false;
      controller.emit(second, { type: "historyReplay", active: false });
      controller.emit(second, { type: "setBusy", value: false });
    };
    // The rail's Ctrl-click and middle-click both post this action as focus leaves A.
    await beside("two");
    const messages = h.doc.getElementById("messages")!;
    expect(messages.textContent).toContain("CSV export transcript");
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "Add a CSV header";
    click(h.window, h.doc.getElementById("send-btn")!);
    const send = h.posted.find(frame => frame.type === "editorChatAction" && (frame.message as Posted).type === "send");
    expect(send).toBeDefined();
    controller.handleSend = vi.fn(async (text, _bare, session) => {
      controller.emit(session, { type: "userMessage", text });
      controller.emit(session, { type: "agentStart" });
      controller.emit(session, { type: "messageChunk", text: "CSV header added" });
      controller.emit(session, { type: "agentEnd" });
    });
    panels[1].receive(send);
    await vi.waitFor(() => expect(controller.handleSend).toHaveBeenCalledTimes(1));
    expect(controller.handleSend.mock.calls[0][2]).toBe(second);
    await vi.waitFor(() => expect(messages.textContent).toContain("CSV header added"));
    expect(messages.textContent).not.toContain("Transcript one");
  });

  it("binds the desktop pane on ready during a cold load and keeps the loaded fixture's title", async () => {
    const qa = buildQaFixture(mkdtempSync(join(tmpdir(), "grok-pane-replay-")), encodeSessionCatalogLeaf);
    const picked = qa.sessions[2];
    const { controller, panels, second, sidebar } = setup();
    Object.assign(second, { activeSessionId: picked.id, cwd: qa.project, client: undefined, buffer: [] });
    const fakeCli = new URL("./fixtures/fake-grok-acp.cjs", import.meta.url);
    const fakeRequire = createRequire(fakeCli);
    const stdin = new EventEmitter();
    const replies: { id?: number; result?: { sessionId: string }; method?: string; params?: { sessionId: string } }[] = [];
    const previousGrokHome = process.env.GROK_HOME;
    try {
      process.env.GROK_HOME = qa.grokHome;
      runInNewContext(readFileSync(fakeCli, "utf8"), {
        require: (id: string) => id === "readline" ? { createInterface: () => stdin } : fakeRequire(id),
        process: {
          argv: ["node", "fake-grok-acp.cjs", "agent", "stdio"],
          env: { GROK_HOME: qa.grokHome },
          stdout: { write: (line: string) => replies.push(JSON.parse(line)) },
        },
      });
      controller.sessionDisplayName = (GrokSidebar.prototype as any).sessionDisplayName;
      controller.sessionCwd = (session: Session) => session.cwd;
      controller.bindSessionLoad = vi.fn();
      controller.sendRemoteHistorySnapshot = vi.fn();
      controller.startSession = vi.fn(async (id: string, session: Session) => {
        // A cold startup clears the live id while the panel already exists.
        session.activeSessionId = undefined;
        await controller.replayLoadedHistory(session, async () => {
          stdin.emit("line", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: {
            cwd: qa.project, sessionId: id,
          } }));
          // Deliver the queued ACP replay after the pane announces ready.
          panels[0].receive({ type: "ready" });
          expect(panels[0].webview.postMessage).toHaveBeenCalledWith({ type: "editorChatBound", binding: 0 });
          expect(replies.find(reply => reply.id === 1)?.result?.sessionId).toBe(id);
          session.historyEventCount = replies.filter(reply => reply.method === "session/update" && reply.params?.sessionId === id).length;
        }, id);
        session.activeSessionId = id;
        controller.postSessionName(session);
      });
      await controller.openDesktopConversationBeside(picked.id, qa.project);
      expect(controller.startSession).toHaveBeenCalledOnce();
      expect(controller.focused).toBe(sidebar);
      expect(panels[0].webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "sessionName", sessionId: picked.id, name: picked.title,
      }));
    } finally {
      if (previousGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previousGrokHome;
      qa.cleanup();
    }
  });

  it("binds the chat and replays its transcript without moving the sidebar", async () => {
    const { beside, panels, host, controller, sidebar } = setup();
    await beside("one");
    expect(host.openEditorWebview).toHaveBeenCalledWith(expect.objectContaining({ column: "beside", title: "one" }));
    expect(host.openEditorWebview.mock.calls[0][0]).toMatchObject({ icon: { path: "/extension/resources/grok-icon.png" } });
    expect(panels[0].webview.html).toBe("full chat");
    panels[0].receive({ type: "ready" });
    expect(panels[0].webview.postMessage).toHaveBeenCalledWith({ type: "messageChunk", text: "Transcript one" });
    expect(panels[0].webview.postMessage).not.toHaveBeenCalledWith({ type: "messageChunk", text: "Transcript sidebar" });
    expect(controller.focused).toBe(sidebar);
  });

  it("keeps the last file and selected lines in the editor chat for the owning project", async () => {
    const { beside, panels, controller, host, first, second, sidebar } = setup();
    const cwd = mkdtempSync(join(tmpdir(), "split-chip-"));
    const file = join(cwd, "notes.txt");
    try {
      first.cwd = cwd;
      sidebar.cwd = cwd;
      writeFileSync(file, "sample content");
      host.getActiveTextEditor.mockReturnValue({
        document: { uri: Uri.file(file) },
        selection: { isEmpty: false, start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
      });
      controller.host.isConversationEditorActive = () => true;
      await beside("one");
      host.getActiveTextEditor.mockReturnValue(undefined);
      panels[0].receive({ type: "ready" });
      await beside("two");
      panels[1].receive({ type: "ready" });
      controller.refreshImplicitChips();
      expect(first.chips).toMatchObject([{ path: file, relPath: "notes.txt", selectionStart: 2, selectionEnd: 4 }]);
      expect(second.chips).toEqual([]);
      expect(sidebar.chips).toEqual([]);
    } finally {
      rmSync(file, { force: true });
      rmdirSync(cwd);
    }
  });

  it("requests a separate editor group for a tab's file and diff without changing sidebar opens", async () => {
    const { beside, controller, first } = setup();
    controller.host.openTextFile = vi.fn();
    controller.host.openResource = vi.fn();
    controller.host.openDiff = vi.fn();
    controller.resolveChatOpenPath = () => ({ ref: { startLine: 3 }, path: "/repo/a.ts" });
    controller.diffProvider = { set: vi.fn() };
    controller.diffSeq = 0;
    await beside("one");
    const tab = controller.lastEditorChat;
    const open = { type: "openFile", path: "a.ts:3" };
    await controller.onAdmittedMessage(open, "local", undefined, tab);
    expect(controller.host.openTextFile).toHaveBeenLastCalledWith("/repo/a.ts", expect.objectContaining({ besideConversation: true }));
    await controller.onAdmittedMessage(open, "local");
    expect(controller.host.openTextFile.mock.calls.at(-1)[1]).not.toHaveProperty("besideConversation");
    await controller.openDiffTexts(first, "a.ts", "before", "after", "Proposed change");
    expect(controller.host.openDiff.mock.calls.at(-1)[3]).toMatchObject({ besideConversation: true, preserveFocus: true });
  });

  it("protects an idle editor session from reaping and a phone's delete", async () => {
    const { beside, controller, first, second, pool, panels } = setup();
    await beside("one");
    panels[0].active = panels[0].visible = false;
    first.lastActiveAt = second.lastActiveAt = 0;
    controller.remoteClients.isActiveValueVisible = () => false;
    controller.remoteClients.clientsForActiveValue = () => [];
    controller.disposeSession = vi.fn();
    controller.reapPool();
    expect(controller.disposeSession.mock.calls).toEqual([[second]]);
    pool.delete(first); // the editor still owns it if its ACP process has exited
    controller.remoteSessionTarget = () => ({ cwd: "/repo" });
    controller.isSessionLoadReserved = () => false;
    controller.reportProtectedSession = vi.fn();
    await controller.deleteSession("one", "one", "remote", "phone", "/repo");
    expect(controller.reportProtectedSession).toHaveBeenCalledWith("remote", "phone", "delete");
    expect(controller.disposeSession.mock.calls).toEqual([[second]]);
  });

  it("returns the phone link only to the requesting editor tab", async () => {
    const { beside, panels, controller, binding } = setup();
    controller.readDeviceToken = async () => "linked";
    controller.relayUrl = () => "wss://relay.example.test";
    controller.remoteDeviceId = () => "desk";
    controller.resolveLocalRepoTarget = () => ({ cwd: "/repo" });
    controller.reportHandoffEvent = vi.fn();
    controller.postLocal = vi.fn();
    await beside("one");
    await beside("two");
    panels.forEach(panel => panel.receive({ type: "ready" }));
    panels[0].receive({ type: "editorChatAction", binding: binding(panels[0]), message: {
      type: "remoteHandoff", requestId: 1, source: "topbar", sessionId: "sidebar", action: "show",
    } });
    panels[0].receive({ type: "editorChatAction", binding: binding(panels[0]), message: {
      type: "remoteHandoff", requestId: 2, source: "topbar", sessionId: "one", action: "show",
    } });
    await vi.waitFor(() => expect(panels[0].webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "remoteHandoff", requestId: 2, url: expect.stringContaining("#session=one&repo="), title: "one",
    })));
    expect(panels[0].webview.postMessage.mock.calls.flat().filter((frame: any) => frame.type === "remoteHandoff")).toHaveLength(1);
    expect(panels[1].webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "remoteHandoff" }));
    expect(controller.postLocal).not.toHaveBeenCalled();
  });

  it("opens a new conversation in the project named by the side gesture", async () => {
    const { controller, sidebar, panels } = setup();
    controller.resolveLocalRepoTarget = (cwd: string) => cwd === "/another-project" ? { cwd } : undefined;
    controller.newLocalSession = () => new Session();
    controller.defaultProviderForProject = () => "grok";
    controller.startSession = vi.fn();
    controller.sweepEmptySessions = vi.fn();
    await controller.onProjectsRailMessage({ type: "newConversationBeside", cwd: "/another-project" });
    expect(panels).toHaveLength(1);
    expect(controller.startSession).toHaveBeenCalledWith(undefined,
      expect.objectContaining({ cwd: "/another-project" }), "replace", undefined, undefined);
    expect(controller.focused).toBe(sidebar);
  });

  it("reveals an existing editor and updates its title on rename", async () => {
    const { beside, panels, host, controller } = setup();
    await beside("sidebar");
    await beside("one");
    const reveals = panels[0].reveal.mock.calls.length;
    await beside("sidebar");
    expect(host.openEditorWebview).toHaveBeenCalledTimes(2);
    expect(panels[0].reveal.mock.calls).toHaveLength(reveals + 1);
    await controller.onProjectsRailMessage({ type: "renameSession", id: "sidebar", name: "Renamed" });
    expect(panels[0].title).toBe("Renamed");
  });

  it("routes a plain click to the last chat surface", async () => {
    const { beside, plain, panels, controller, sidebar, railPost } = setup();
    await plain("sidebar");
    expect(controller.openSession).toHaveBeenCalledWith("sidebar", "/repo");
    await beside("one");
    await beside("two");
    panels[0].receive({ type: "localChatFocus" });
    await plain("sidebar");
    expect(controller.openSession).toHaveBeenCalledTimes(1);
    expect(panels[0].title).toBe("sidebar");
    expect(panels[1].title).toBe("two");
    expect(controller.focused).toBe(sidebar);
    expect(railPost).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", editor: true, sessionId: "sidebar",
    }));
    controller.setLastEditorChat(undefined); // sidebar focus notification
    await plain("two");
    expect(controller.openSession).toHaveBeenCalledWith("two", "/repo");
  });

  it("keeps duration frames with their session and shares the display preference", async () => {
    const { beside, panels, controller, first, second } = setup();
    controller.sendRemoteSession = vi.fn();
    await beside("one");
    await beside("two");
    panels.forEach(panel => panel.receive({ type: "ready" }));
    const end = { type: "agentEnd", durationMs: 5_000, stopped: false };
    controller.emit(first, end);
    expect(panels[0].webview.postMessage).toHaveBeenCalledWith(end);
    expect(panels[1].webview.postMessage).not.toHaveBeenCalledWith(end);
    expect(first.buffer).toContainEqual(end);
    expect(second.buffer).not.toContainEqual(end);
    const preference = { type: "showTurnDuration", value: true };
    controller.post(preference);
    for (const panel of panels) expect(panel.webview.postMessage).toHaveBeenCalledWith(preference);
    expect(controller.handleSend).not.toHaveBeenCalled();
  });

  it("does not route an editor star action to the sidebar", async () => {
    const { beside, panels, controller, binding } = setup();
    controller.handleStarPromptAction = vi.fn();
    await beside("sidebar");
    panels[0].receive({ type: "ready" });
    const action = { type: "starPromptAction", id: "sidebar-card", action: "star" };
    panels[0].receive({ type: "editorChatAction", binding: binding(panels[0]), message: action });
    await controller.onAdmittedMessage(action, "local", undefined, controller.lastEditorChat);
    expect(controller.handleStarPromptAction).not.toHaveBeenCalled();
    await controller.onAdmittedMessage(action, "local");
    expect(controller.handleStarPromptAction).toHaveBeenCalledWith(action, "local");
  });

  it("sends through the tab's bound session and refuses an obsolete binding", async () => {
    const { beside, plain, panels, controller, first, second, sidebar, binding } = setup();
    await beside("one");
    const panel = panels[0];
    panel.receive({ type: "ready" });
    const previous = binding(panel);
    const send = (key: number, text: string) => panel.receive({
      type: "editorChatAction", binding: key, message: { type: "send", text },
    });
    send(previous, "For one");
    await vi.waitFor(() => expect(controller.handleSend).toHaveBeenCalledTimes(1));
    expect(controller.handleSend.mock.calls[0].slice(0, 4)).toEqual(["For one", false, first, "local"]);
    await plain("two");
    send(previous, "Obsolete");
    send(binding(panel), "For two");
    await vi.waitFor(() => expect(controller.handleSend).toHaveBeenCalledTimes(2));
    expect(controller.handleSend.mock.calls[1][2]).toBe(second);
    expect(controller.handleSend.mock.calls.some((args: unknown[]) => args[2] === sidebar)).toBe(false);
  });

  it.each(["Projects view", "desktop rail"])("keeps the session running after a pane opened by the %s closes", async entry => {
    const { beside, panels, controller, first, pool, binding } = setup();
    const open = entry === "desktop rail"
      ? (id: string) => controller.openDesktopConversationBeside(id, "/repo")
      : beside;
    first.status = "working";
    await open("one");
    panels[0].receive({ type: "ready" });
    panels[0].receive({ type: "editorChatDraft", binding: binding(panels[0]), text: "Unsent text" });
    panels[0].dispose();
    expect(controller.lastEditorChat).toBeUndefined();
    expect(pool.has(first)).toBe(true);
    expect(first.status).toBe("working");
    expect(first.client.cancel).not.toHaveBeenCalled();
    await open("one");
    panels[1].receive({ type: "ready" });
    expect(panels[1].webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "restoreComposer", text: "Unsent text" }));
  });

  it("restores a parked tab draft when the sidebar opens that conversation", async () => {
    const { beside, plain, panels, controller, first, binding } = setup();
    await beside("one");
    panels[0].receive({ type: "ready" });
    panels[0].receive({ type: "editorChatDraft", binding: binding(panels[0]), text: "Unsent from one" });
    await plain("two");
    expect(panels[0].webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "restoreComposer" }));

    const postMessage = vi.fn();
    controller.view = { webview: { postMessage } };
    controller.sessionMetaWrites = Promise.resolve();
    controller.setLastEditorChat(undefined);
    await plain("one");
    const restore = (GrokSidebar.prototype as any).restorePersistedDraft;
    restore.call(controller, first, "local");
    restore.call(controller, first, "local");
    expect(postMessage.mock.calls.filter(([frame]) => frame.type === "restoreComposer")).toEqual([[
      { type: "restoreComposer", text: "Unsent from one", sessionId: "one", chips: [], draft: true },
    ]]);
  });

  it("keeps desktop rail actions on the existing path", async () => {
    const { beside, plain, host, railPost, controller } = setup(false);
    await controller.onProjectsRailMessage({ type: "ready" });
    await beside("one");
    expect(railPost.mock.calls.flat().some(frame => frame.type === "conversationEditorAvailable")).toBe(false);
    expect(host.openEditorWebview).not.toHaveBeenCalled();
    await plain("one");
    expect(controller.openSession).toHaveBeenCalledWith("one", "/repo");
  });
});

describe("desktop Projects routing", () => {
  function desktop() {
    const h = setup();
    const main = vi.fn();
    h.controller.projectsRail = undefined;
    h.controller.view = { webview: { postMessage: main }, visible: true };
    Object.assign(h.host, { canSwitchWorkspaceFolder: true });
    return { ...h, main };
  }

  it("moves the surviving conversation and its draft to the window without stopping either agent", async () => {
    const { controller, panels, binding, first, sidebar, pool, main } = desktop();
    const stored = editorWorkspaceState();
    controller.context.workspaceState = stored;
    controller.chatReadyForHandoff = true;
    controller.postMode = vi.fn();
    await controller.openDesktopConversationBeside("one", "/repo");
    const pane = panels[0];
    pane.receive({ type: "ready" });
    const closing = { sessionId: "sidebar", text: "Draft from closed chat", chipIds: [], revision: 0 };
    const survivor = { binding: binding(pane), text: "  Draft from surviving chat\n", chipIds: [], revision: 0, scrollTop: 45 };
    expect(controller.closeDesktopMainChat(pane.webview, closing, survivor)).toBe(true);
    expect(controller.focused).toBe(first);
    expect(controller.desktopEditorSession(pane.webview)).toBeUndefined();
    expect(pool.has(sidebar)).toBe(true);
    expect(sidebar.client.cancel).not.toHaveBeenCalled();
    expect(first.client.cancel).not.toHaveBeenCalled();
    expect(stored.get("grok.editorChatDraft.sidebar")).toMatchObject({ text: closing.text });
    expect(stored.get("grok.editorChatDraft.one")).toBeUndefined();
    expect(stored.get("grok.desktopMainDraft")).toMatchObject({ sessionId: "one", text: survivor.text });
    expect(main.mock.calls.filter(([msg]) => msg.type === "restoreComposer")).toEqual([
      [expect.objectContaining({ sessionId: "one", text: survivor.text })],
    ]);
    expect(controller.hasSavedDesktopPanes()).toBe(false);
  });

  it("rejects a promotion whose renderer binding has changed and leaves both drafts in place", async () => {
    const { controller, panels, binding, sidebar } = desktop();
    const stored = editorWorkspaceState();
    controller.context.workspaceState = stored;
    await controller.openDesktopConversationBeside("one", "/repo");
    const pane = panels[0];
    pane.receive({ type: "ready" });
    const token = binding(pane);
    pane.receive({ type: "editorChatDraft", binding: token, text: "Still in the pane" });
    expect(controller.closeDesktopMainChat(pane.webview,
      { sessionId: "sidebar", text: "Still in the window", chipIds: [], revision: 0 },
      { binding: token + 1, text: "", chipIds: [], revision: 0, scrollTop: null },
    )).toBe(false);
    expect(controller.focused).toBe(sidebar);
    expect(controller.hasSavedDesktopPanes()).toBe(true);
    expect(stored.get("grok.editorChatDraft.sidebar")).toBeUndefined();
  });

  it("keeps a draft restored by the host after the pane's close snapshot was taken", async () => {
    const { controller, panels, binding, first } = desktop();
    const stored = editorWorkspaceState();
    controller.context.workspaceState = stored;
    await controller.openDesktopConversationBeside("one", "/repo");
    const pane = panels[0];
    pane.receive({ type: "ready" });
    const oldSnapshot = { binding: binding(pane), text: "Typed", chipIds: [], revision: 0, scrollTop: null };
    pane.receive({ type: "editorChatDraft", binding: oldSnapshot.binding, text: oldSnapshot.text });
    const [tab] = controller.editorChats;
    controller.restoreComposerFor(first, undefined, "Restored by host", [], false, tab);
    expect(controller.saveDesktopPaneDraft(pane.webview, oldSnapshot)).toBe(false);
    expect(controller.saveDesktopPaneDraft(pane.webview, {
      ...oldSnapshot, text: "Typed\n\nRestored by host", revision: 1,
    })).toBe(true);
    pane.dispose();
    expect(stored.get("grok.editorChatDraft.one")).toMatchObject({ text: "Typed\n\nRestored by host" });
  });

  it("recovers a closed unsent draft once in the same project", async () => {
    const { controller, panels, binding, first, second, main } = desktop();
    const stored = editorWorkspaceState();
    controller.context.workspaceState = stored;
    await controller.openDesktopConversationBeside("one", "/repo");
    const pane = panels[0];
    pane.receive({ type: "ready" });
    first.hasHistory = false;
    pane.receive({ type: "editorChatDraft", binding: binding(pane), text: "Unsent without history" });
    pane.dispose();
    controller.focused = second;
    second.hasHistory = false;
    second.cwd = "/different";
    controller.restoreClosedDesktopDraft(second);
    expect(main).not.toHaveBeenCalledWith(expect.objectContaining({ type: "restoreComposer" }));
    second.cwd = "/repo";
    controller.restoreClosedDesktopDraft(second);
    controller.restoreClosedDesktopDraft(second);
    expect(main.mock.calls.filter(([msg]) => msg.type === "restoreComposer")).toEqual([
      [expect.objectContaining({ text: "Unsent without history" })],
    ]);
  });

  it("restores saved panes in creation order with independent drafts and the last-used target after quit", async () => {
    const profile = mkdtempSync(join(tmpdir(), "afk-split-restore-"));
    const file = join(profile, "workspaceState.json");
    try {
      const old = desktop();
      old.controller.context.workspaceState = createFileMemento(file);
      await old.controller.openDesktopConversationBeside("one", "/repo");
      await old.controller.openDesktopConversationBeside("two", "/repo");
      for (const [i, pane] of old.panels.entries()) {
        pane.receive({ type: "ready" });
        pane.receive({ type: "editorChatDraft", binding: old.binding(pane), text: `Unsent in pane ${i + 1}` });
      }
      old.controller.revealDesktopPane(old.panels[0].webview);
      old.controller.saveDesktopMainDraft("sidebar", "Unsent in main", []);
      old.controller.preserveDesktopConversationLayout();
      for (const pane of old.panels) pane.dispose();

      const next = desktop();
      next.controller.context.workspaceState = createFileMemento(file);
      next.pool.delete(next.first);
      next.pool.delete(next.second);
      next.controller.newLocalSession = () => new Session();
      next.controller.configureLocalResumeSession = (session: Session, _id: string, cwd: string) => {
        session.cwd = cwd;
        return true;
      };
      next.controller.bindSessionLoad = vi.fn();
      next.controller.startSession = vi.fn(async () => true);
      expect(next.controller.restoreDesktopConversationLayout()).toBe(next.panels[0].webview);
      expect(next.panels.map(pane => next.controller.desktopEditorSession(pane.webview).activeSessionId)).toEqual(["one", "two"]);
      expect(next.main).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "projectsRailChatTarget", editor: true, sessionId: "one",
      }));
      for (const [i, pane] of next.panels.entries()) {
        pane.visible = pane.active = false;
        pane.receive({ type: "ready" });
        expect(pane.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: "restoreComposer", text: `Unsent in pane ${i + 1}`,
        }));
      }
      expect(next.controller.startSession).not.toHaveBeenCalled();
      next.panels[1].visible = true;
      next.panels[1].changeViewState();
      await vi.waitFor(() => expect(next.controller.startSession).toHaveBeenCalledOnce());
      expect(next.controller.startSession.mock.calls[0][0]).toBe("two");

      next.controller.chatReadyForHandoff = true;
      next.controller.desktopMainDraftPending = true;
      next.sidebar.activeSessionId = undefined;
      next.controller.postDesktopMainDraftScope();
      expect(next.main).not.toHaveBeenCalledWith(expect.objectContaining({ type: "desktopMainDraftScope" }));
      next.sidebar.activeSessionId = "sidebar";
      next.controller.postDesktopMainDraftScope();
      next.controller.postDesktopMainDraftScope();
      expect(next.main.mock.calls.filter(([msg]) => msg.type === "restoreComposer")).toEqual([
        [expect.objectContaining({ text: "Unsent in main", sessionId: "sidebar" })],
      ]);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("sends a pane's History pick of the main chat's conversation to the main column", async () => {
    const { controller, panels, first, main, host, sidebar, binding } = desktop();
    await controller.openDesktopConversationBeside("one", "/repo");
    panels[0].receive({ type: "ready" });
    panels[0].receive({ type: "editorChatAction", binding: binding(panels[0]),
      message: { type: "resumeSession", id: sidebar.activeSessionId, cwd: "/repo" } });
    await vi.waitFor(() => expect(main).toHaveBeenCalledWith({ type: "focusInput" }));
    // Keyboard focus leaves the pane too, so Reload acts on the main chat.
    expect(host.revealChatView).toHaveBeenCalled();
    expect(controller.desktopEditorSession(panels[0].webview)).toBe(first);
    expect(host.openEditorWebview).toHaveBeenCalledOnce();
  });

  it("keeps saving split state after a close the page vetoed", async () => {
    const { controller, panels } = desktop();
    controller.context.workspaceState = editorWorkspaceState();
    await controller.openDesktopConversationBeside("one", "/repo");
    controller.preserveDesktopConversationLayout();
    controller.resumeDesktopConversationLayout();
    panels[0].dispose();
    expect(controller.hasSavedDesktopPanes()).toBe(false);
  });

  it("forgets an explicitly closed pane but keeps the missing conversation visible and closeable", async () => {
    const stored = editorWorkspaceState();
    const old = desktop();
    old.controller.context.workspaceState = stored;
    await old.controller.openDesktopConversationBeside("one", "/repo");
    await old.controller.openDesktopConversationBeside("two", "/repo");
    old.panels[0].dispose();
    const next = desktop();
    next.controller.context.workspaceState = stored;
    next.pool.delete(next.second);
    next.controller.newLocalSession = () => new Session();
    next.controller.configureLocalResumeSession = () => false;
    next.controller.startSession = vi.fn();
    next.controller.restoreDesktopConversationLayout();
    expect(next.panels).toHaveLength(1);
    const missing = next.panels[0];
    missing.receive({ type: "ready" });
    expect(missing.title).toBe("two");
    expect(missing.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "error", text: "Could not open this conversation.",
    }));
    expect(next.controller.startSession).not.toHaveBeenCalled();
    missing.dispose();
    expect(next.controller.hasSavedDesktopPanes()).toBe(false);
  });

  it("sends the main desktop draft only for its confirmed split composer", () => {
    const saveMainDraft = vi.fn();
    const ui = bootWebview({ beforeScripts(w) {
      Object.assign(w, { grokDesktopShell: true, grokDesktopConversations: { open: vi.fn(), saveMainDraft } });
    } });
    const input = ui.doc.querySelector<HTMLTextAreaElement>("#input")!;
    const type = (text: string) => {
      input.value = text;
      dispatch(ui.window, { type: "voiceConfigured", value: true });
    };
    dispatch(ui.window, { type: "sessionName", sessionId: "one", name: "One" });
    type("Already typed");
    expect(saveMainDraft).not.toHaveBeenCalled();
    dispatch(ui.window, { type: "desktopMainDraftScope", sessionId: "two" });
    expect(saveMainDraft).not.toHaveBeenCalled();
    dispatch(ui.window, { type: "desktopMainDraftScope", sessionId: "one" });
    expect(saveMainDraft).toHaveBeenLastCalledWith("one", "Already typed", []);
    type("Updated");
    expect(saveMainDraft).toHaveBeenLastCalledWith("one", "Updated", []);
    dispatch(ui.window, { type: "projectsRailChatTarget", editor: false, openSessionIds: ["one"], hasPanes: false });
    type("Unsplit again");
    expect(saveMainDraft).toHaveBeenLastCalledWith("one", "Unsplit again", []);
  });

  it("reveals an overflow pane by its existing webview without changing its session or draft", async () => {
    const { controller, panels, binding, first, second, host } = desktop();
    await controller.openDesktopConversationBeside("one", "/repo");
    await controller.openDesktopConversationBeside("two", "/repo");
    const [hidden, shown] = panels;
    hidden.visible = hidden.active = false;
    hidden.receive({ type: "ready" });
    hidden.receive({ type: "editorChatDraft", binding: binding(hidden), text: "Keep this unsent draft" });
    controller.revealDesktopPane(hidden.webview);
    expect(hidden.reveal).toHaveBeenCalled();
    expect(controller.desktopEditorSession(hidden.webview)).toBe(first);
    expect(controller.desktopEditorSession(shown.webview)).toBe(second);
    expect(controller.editorDrafts.get(first)?.text).toBe("Keep this unsent draft");
    expect(host.openEditorWebview).toHaveBeenCalledTimes(2);
    expect(controller.openSession).not.toHaveBeenCalled();
  });

  it("returns focus to main after a running pane closes and replays the unread reply when reopened", async () => {
    const { controller, panels, first, host, main, pool } = desktop();
    controller.remoteClients.isActiveValueVisible = () => false;
    controller.refreshKeepAwake = vi.fn();
    controller.refreshSessionOrderAfterTurn = vi.fn();
    controller.markRead = GrokSidebar.prototype["markRead"];
    await controller.openDesktopConversationBeside("one", "/repo");
    panels[0].receive({ type: "ready" });
    controller.setStatus(first, "working");
    controller.emit(first, { type: "agentStart" });
    panels[0].dispose();
    controller.focusDesktopMainChat();
    expect(main).toHaveBeenLastCalledWith({ type: "focusInput" });
    expect(pool.has(first)).toBe(true);
    expect(first.client!.cancel).not.toHaveBeenCalled();

    controller.emit(first, { type: "messageChunk", text: "Reply after close" });
    controller.emit(first, { type: "agentEnd" });
    controller.setStatus(first, "done");
    expect(main).toHaveBeenCalledWith(expect.objectContaining({ type: "sessionDot", id: "one", dot: "unread" }));
    expect(main).not.toHaveBeenCalledWith({ type: "messageChunk", text: "Reply after close" });

    await controller.openDesktopConversationBeside("one", "/repo");
    panels[1].receive({ type: "ready" });
    expect(panels[1].webview.postMessage).toHaveBeenCalledWith({ type: "messageChunk", text: "Reply after close" });
    expect(controller.desktopEditorSession(panels[1].webview)).toBe(first);
    expect(main).toHaveBeenCalledWith(expect.objectContaining({ type: "sessionDot", id: "one", dot: "none" }));
    expect(host.openEditorWebview).toHaveBeenCalledTimes(2);
  });

  it("reaps an idle background session while keeping an idle visible desktop pane", async () => {
    const { controller, panels, first, second } = desktop();
    await controller.openDesktopConversationBeside("one", "/repo");
    expect(panels[0].visible).toBe(true);
    first.lastActiveAt = second.lastActiveAt = 0;
    controller.remoteClients.isActiveValueVisible = () => false;
    controller.remoteClients.clientsForActiveValue = () => [];
    controller.disposeSession = vi.fn();
    controller.reapPool();
    expect(controller.disposeSession.mock.calls).toEqual([[second]]);
  });

  it("authorizes a quick preview against the pane roots and sends its reply only there", async () => {
    const { controller, panels, main, first, second, binding } = desktop();
    const repo = mkdtempSync(join(tmpdir(), "afk-pane-preview-"));
    try {
      first.cwd = repo;
      controller.isAuthorizedCwd = (cwd: string) => cwd === repo || cwd === "/repo";
      writeFileSync(join(repo, "notes.md"), "# Pane project");
      await controller.openDesktopConversationBeside("one", repo);
      await controller.openDesktopConversationBeside("two", second.cwd);
      for (const pane of panels) pane.receive({ type: "ready" });
      const [pane, other] = panels;
      const request = (requestId: string, cwd: string, relPath: string) => pane.receive({
        type: "editorChatAction", binding: binding(pane),
        message: { type: "readProjectFile", requestId, cwd, relPath },
      });
      request("mine", repo, "notes.md");
      request("main-root", "/repo", "notes.md");
      request("escape", repo, "../notes.md");
      controller.isAuthorizedCwd = (cwd: string) => cwd === "/repo";
      request("revoked", "/repo", "notes.md");
      await vi.waitFor(() => {
        const replies = pane.webview.postMessage.mock.calls.map(([msg]) => msg as Posted)
          .filter(msg => msg.type === "projectFileContent");
        expect(replies).toEqual([
          expect.objectContaining({ requestId: "mine", ok: true, text: "# Pane project" }),
          expect.objectContaining({ requestId: "main-root", ok: false }),
          expect.objectContaining({ requestId: "escape", ok: false }),
          expect.objectContaining({ requestId: "revoked", ok: false }),
        ]);
        expect(replies[0]).not.toHaveProperty("absPath");
      });
      for (const target of [main, other.webview.postMessage]) {
        expect(target).not.toHaveBeenCalledWith(expect.objectContaining({ type: "projectFileContent" }));
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("opens Providers in the main desktop Settings when a pane asks for setup", async () => {
    const { controller, panels, main, binding, host } = desktop();
    await controller.openDesktopConversationBeside("one", "/repo");
    const pane = panels[0];
    pane.receive({ type: "ready" });
    pane.receive({ type: "editorChatAction", binding: binding(pane), message: { type: "runGrokLogin" } });
    await vi.waitFor(() => expect(main).toHaveBeenCalledWith({ type: "desktopOpenSettings", category: "providers" }));
    expect(host.openEditorWebview).toHaveBeenCalledTimes(1);
  });

  it("reuses the last-used pane and reveals an open conversation with the main-chat preference", async () => {
    const { controller, panels, first, second, sidebar, main, settings } = desktop();
    await controller.openDesktopConversationBeside("one", "/repo");
    const pane = panels[0];
    pane.receive({ type: "ready" });
    await controller.openDesktopConversationFromRail("two", "/repo");
    expect(panels).toHaveLength(1);
    expect(controller.desktopEditorSession(pane.webview)).toBe(second);
    expect(controller.focused).toBe(sidebar);
    expect(pane.webview.postMessage).toHaveBeenCalledWith({ type: "focusInput", closeSettings: true });
    expect(main).toHaveBeenCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", sessionId: "two", openSessionIds: ["sidebar", "two"],
    }));
    controller.setLastEditorChat(undefined);
    pane.receive({ type: "localChatFocus" });
    expect(main).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", editor: true, sessionId: "two",
    }));

    settings.openConversationIn = "sidebar";
    pane.reveal.mockClear();
    await controller.openDesktopConversationFromRail("two", "/repo");
    expect(pane.reveal).toHaveBeenCalledOnce();
    expect(controller.openSession).not.toHaveBeenCalled();
    await controller.openDesktopConversationFromRail("one", "/repo");
    expect(controller.focused).toBe(first);
    expect(controller.desktopEditorSession(pane.webview)).toBe(second);
  });

  it("uses the main chat after it was used and honors editor placement from a single chat", async () => {
    const { controller, panels, sidebar, second, main, settings } = desktop();
    settings.openConversationIn = "editor";
    await controller.openDesktopConversationFromRail("one", "/repo");
    expect(panels).toHaveLength(1);
    expect(controller.focused).toBe(sidebar);
    settings.openConversationIn = "lastUsed";
    controller.setLastEditorChat(undefined);
    await controller.openDesktopConversationFromRail("two", "/repo");
    expect(controller.focused).toBe(second);
    expect(main).toHaveBeenCalledWith(expect.objectContaining({
      type: "projectsRailChatTarget", editor: false, sessionId: "two", openSessionIds: ["two", "one"],
    }));
  });
});
