/**
 * Bounded spawn retry in startSession: a transient plain failure after an
 * update must not paint "Failed to start …" on a brand-new empty session.
 * Auth still surfaces immediately; only the last of 3 plain attempts emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";
import { bootWebview, click, dispatch } from "./webview-harness";

const startControl = {
  failuresRemaining: 0,
  failWith: "Internal error",
  starts: 0,
  disposes: 0,
  loadFailuresRemaining: 0,
  loadFailWith: "Internal error",
  exitDuringNewSessionRemaining: 0,
  efforts: [] as Array<string | undefined>,
  museMode: undefined as string | undefined,
  musePostures: [] as any[],
  museRefusesFullAccess: false,
  museFailsAfterReplay: false,
  catalogs: {} as Record<string, { modelId: string; name: string }[]>,
  startWait: undefined as Promise<void> | undefined,
};

vi.mock("../src/acp", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient extends EventEmitter {
    setHumanWaitActive = vi.fn();
    provider: "grok" | "codex" | "claude" | "muse";
    currentModeId?: string;
    usesClientPlanGate = false;
    sessionId: string | undefined;
    availableModels: { modelId: string; name: string }[] = [];
    currentModelId = "fake-model";
    fsRead?: unknown;
    fsWrite?: unknown;
    terminal?: unknown;
    constructor(opts: { log: (msg: string) => void; effort?: string; backend?: any }) {
      super();
      this.provider = opts.backend?.provider ?? "grok";
      this.availableModels = startControl.catalogs[this.provider] ?? [];
      this.currentModelId = this.availableModels[0]?.modelId ?? "fake-model";
      startControl.efforts.push(opts.effort);
      if (this.provider === "muse") startControl.musePostures.push(JSON.parse(opts.backend.spawn({ cliPath: "/fake/muse", cwd: "/repo", env: {} }).env.GROK_MUSE_POSTURE));
    }
    async start(): Promise<void> {
      await startControl.startWait;
      startControl.starts += 1;
      if (startControl.failuresRemaining > 0) {
        startControl.failuresRemaining -= 1;
        throw new Error(startControl.failWith);
      }
      this.emit("initialized", { protocolVersion: 1, serverInfo: { version: "0.2.117" } });
    }
    async newSession(): Promise<{ sessionId: string }> {
      // A process death mid-startup: the exit event fires while startSession
      // is still awaiting a step that will SUCCEED (the swallowed-error class).
      if (startControl.exitDuringNewSessionRemaining > 0) {
        startControl.exitDuringNewSessionRemaining -= 1;
        this.emit("exit", 0);
      }
      this.sessionId = "new-session";
      if (this.provider === "muse") {
        this.currentModeId = startControl.museMode ?? startControl.musePostures.at(-1).mode;
        this.emit("modeChanged", this.currentModeId);
      }
      this.emit("session", { sessionId: this.sessionId });
      return { sessionId: this.sessionId };
    }
    async loadSession(sessionId: string): Promise<{ sessionId: string }> {
      if (startControl.loadFailuresRemaining > 0) {
        startControl.loadFailuresRemaining -= 1;
        throw new Error(startControl.loadFailWith);
      }
      this.sessionId = sessionId;
      if (this.provider === "muse") {
        this.currentModeId = startControl.museMode ?? "agent";
        this.emit("modeChanged", this.currentModeId);
      }
      if (startControl.museFailsAfterReplay) throw new Error("On request requires the shell sandbox");
      this.emit("session", { sessionId });
      this.emit("sessionLoaded", { sessionId });
      return { sessionId };
    }
    async dispose(): Promise<void> {
      startControl.disposes += 1;
    }
    async deleteSession(): Promise<void> {}
    async setMode(mode: string): Promise<void> {
      if (this.provider === "muse" && mode === "yolo" && startControl.museRefusesFullAccess) {
        throw new Error("approval mode allowAll was not accepted");
      }
      if (this.provider === "muse") { this.currentModeId = mode; this.emit("modeChanged", mode); }
    }
    supportsInterject(): boolean { return this.provider === "grok"; }
    isCredentialError(): boolean {
      return /auth|unauthor|401|api[_\s-]?key|credential|sign.?in/i.test(startControl.failWith);
    }
  }
  return { ...actual, AcpClient: FakeAcpClient };
});

import { GrokSidebar } from "../src/sidebar";

function makeSidebar(cwd: string): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.pendingTurnDiffCaptures = new WeakSet();
  const memento: Record<string, unknown> = {};
  sidebar.providerConnectionState = { grok: true, codex: false };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.connectedProviders = vi.fn(() => ["grok"]);
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "grok";
  sidebar.focused.cwd = cwd;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.sessionCache = new Map();
  sidebar.loginReprobeTimers = new Map();
  sidebar.turnOrderTimers = new Set();
  sidebar.pendingConfirms = new Map();
  sidebar.fullImagePaths = new Map();
  sidebar.pendingAttach = new Set();
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    canSwitchWorkspaceFolder: false,
    append: vi.fn(),
    appendLine: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: vi.fn(async () => {}),
    })),
    fs: {
      readFile: vi.fn(async () => Buffer.from("")),
      writeFile: vi.fn(async () => {}),
      createDirectory: vi.fn(async () => {}),
    },
  };
  sidebar.context = { globalStorageUri: { fsPath: cwd }, subscriptions: [] };
  sidebar.terminalManager = { create: vi.fn(), disposeAll: vi.fn(), ownedBy: vi.fn(() => ({ create: vi.fn() })), releaseOwnedBy: vi.fn(() => 0) };
  sidebar.workspaceRoot = vi.fn(() => cwd);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.locateProvider = vi.fn(() => "grok");
  sidebar.providerDefaultForProject = vi.fn(() => "");
  sidebar.configForcesAutoApprove = vi.fn(() => false);
  sidebar.confirmRepoForcedAutoApprove = vi.fn(async () => true);
  sidebar.stopVoiceInput = vi.fn();
  sidebar.queueInFlightPlanCommentsOnExit = vi.fn();
  sidebar.warnOAuthShadowOnce = vi.fn();
  sidebar.cacheProviderModels = vi.fn(async () => {});
  sidebar.modelsForSession = vi.fn(() => []);
  sidebar.updateSessionMeta = vi.fn(async () => {});
  sidebar.postSessionName = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.touch = vi.fn();
  sidebar.reapPool = vi.fn();
  sidebar.maybeFlushQueuedSends = vi.fn(async () => {});
  sidebar.emitContextUsage = vi.fn();
  sidebar.restoreUsage = vi.fn();
  sidebar.restorePersistedDraft = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.sendRemoteClient = vi.fn();
  sidebar.sendRemoteHistorySnapshot = vi.fn();
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.localizeHistoryMessage = (message: HostMsg) => message;
  sidebar.maybeUpdateCliOnUpgrade = vi.fn(async () => {});
  sidebar.maybePinBrokenCli = vi.fn(async () => {});
  sidebar.planModeCompatibility = vi.fn(async () => ({
    planModeAvailable: true,
    planModeVersionVerified: true,
    usedCache: true,
  }));
  sidebar.applyPlanModeCompatibility = vi.fn();
  sidebar.setProviderNeedsLogin = vi.fn();
  sidebar.buildEnv = vi.fn(() => ({ ...process.env }));
  sidebar.posted = [] as HostMsg[];
  sidebar.view = { webview: { postMessage: (message: HostMsg) => sidebar.posted.push(message) } };
  return sidebar;
}

function startErrors(sidebar: any): HostMsg[] {
  return sidebar.posted.filter(
    (message: HostMsg) => message.type === "error" && String(message.text).startsWith("Failed to start"),
  );
}

function onboardings(sidebar: any): HostMsg[] {
  return sidebar.posted.filter((message: HostMsg) => message.type === "onboarding");
}

describe("startSession bounded spawn retry", () => {
  const switchCatalogs = {
    muse: [
      { modelId: "muse-spark-1.3", name: "muse-spark-1.3" },
      { modelId: "muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor" },
      { modelId: "muse-spark-1.2", name: "muse-spark-1.2" },
    ],
    grok: [{ modelId: "grok-4.7", name: "Grok 4.7" }],
    codex: [{ modelId: "gpt-test", name: "GPT Test" }],
    claude: [{ modelId: "claude-test", name: "Claude Test" }],
  };

  async function switchingSidebar(provider: keyof typeof switchCatalogs) {
    const sidebar = makeSidebar(process.cwd());
    startControl.catalogs = switchCatalogs;
    sidebar.providerConnectionState = { grok: true, muse: true, codex: true, claude: true };
    sidebar.focused.provider = provider;
    sidebar.connectedProviders = () => Object.keys(switchCatalogs);
    sidebar.usableProviders = sidebar.connectedProviders;
    // Keep the real cache, catalog composition and project-default methods.
    delete sidebar.cacheProviderModels;
    delete sidebar.modelsForSession;
    delete sidebar.providerDefaultForProject;
    sidebar.discardRestartedEmptySession = vi.fn();
    for (const [id, models] of Object.entries(switchCatalogs)) {
      await sidebar.cacheProviderModels(id, models, models[0].modelId);
    }
    await sidebar.startSession(undefined, sidebar.focused);
    expect(startErrors(sidebar)).toEqual([]);
    const update = sidebar.state.update;
    sidebar.state.update = async (key: string, value: unknown) => {
      await update(key, value);
      if (key === "grok.projectProviderDefaults") {
        // A catalog warm-up finishes while switchModel awaits the preference
        // write, before startSession can detach the old client. Use the real
        // refresh path so its emitted session frame/order is not hand-written.
        await sidebar.cacheProviderModels("grok", switchCatalogs.grok, "grok-4.7");
        await Promise.resolve();
      }
    };
    return sidebar;
  }

  it.each(["grok", "codex", "claude", "muse"] as const)(
    "never attributes the retiring %s client's catalog to its replacement",
    async provider => {
      const sidebar = await switchingSidebar(provider);
      const session = sidebar.focused;
      const oldClient = session.client;
      const next = provider === "grok" ? "muse" : "grok";
      sidebar.posted.length = 0;
      await sidebar.switchModel(switchCatalogs[next][0].modelId, session, undefined, next);
      expect(startErrors(sidebar)).toEqual([]);
      expect(session.client).not.toBe(oldClient);
      expect(session.client.provider).toBe(next);
      expect(startControl.disposes).toBe(1);
      const frames = sidebar.posted.filter((m: HostMsg) => m.type === "session");
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.currentModelId).toBe(switchCatalogs[frame.provider as keyof typeof switchCatalogs][0].modelId);
        for (const model of frame.models) {
          expect(switchCatalogs[model.provider as keyof typeof switchCatalogs]).toContainEqual({
            modelId: model.modelId, name: model.name,
          });
        }
      }
    },
  );

  it.each([false, true])("drives Muse → Grok through the host's restart frames, remote=%s", async remote => {
    const sidebar = await switchingSidebar("muse");
    const h = bootWebview({ remote });
    const el = (id: string) => h.doc.getElementById(id)!;
    dispatch(h.window, { type: "providerState", providers: Object.keys(switchCatalogs).map(id => ({ id, connected: true })) });
    for (const frame of sidebar.posted) dispatch(h.window, frame);
    const modes = () => [...h.doc.querySelectorAll(".mode-item-label")].map(row => row.textContent);
    click(h.window, el("mode-btn"));
    expect(modes()).toEqual(["Allow all", "Prompt unmatched", "On request"]);
    expect(el("mode-btn").textContent).toBe("Prompt unmatched");
    click(h.window, el("gear-btn"));
    const grokRow = [...h.doc.querySelectorAll(".model-picker-row")].find(row => row.textContent?.includes("Grok 4.7"))!;
    click(h.window, grokRow);
    expect(el("gear-btn").textContent).toContain("Grok 4.7");
    expect(h.posted.filter(m => m.type === "setModel")).toEqual([]);
    // Opening the mode menu commits the picker, just as closing it on desk
    // or phone does. Inspect the first transient before any host response.
    click(h.window, el("mode-btn"));
    expect.soft(modes()).toEqual(["Agent mode", "Plan mode", "Auto accept"]);
    expect.soft(el("mode-btn").textContent).toBe("Agent mode");
    expect.soft((el("input") as HTMLTextAreaElement).placeholder).toContain("Ask Grok");
    const pick = h.posted.find(m => m.type === "setModel")!;
    expect(pick).toEqual({ type: "setModel", provider: "grok", modelId: "grok-4.7" });

    const assertUi = () => {
      // Inspect each frame, including the catalog refresh during the switch
      // and modeChanged BEFORE session; final-only assertions miss both bugs.
      dispatch(h.window, { type: "openModePopover" });
      if ((el("mode-popover") as HTMLElement).hidden) dispatch(h.window, { type: "openModePopover" });
      expect.soft(modes()).toEqual(["Agent mode", "Plan mode", "Auto accept"]);
      expect.soft(el("mode-btn").textContent).toBe("Agent mode");
      expect.soft(el("mode-popover").textContent).not.toMatch(/Unknown mode|Muse|Prompt unmatched|Deny unmatched|On request/);
      click(h.window, el("gear-btn"));
      let heading = "";
      for (const row of h.doc.querySelectorAll(".model-picker-list > *")) {
        if (row.classList.contains("model-provider-heading")) heading = row.textContent ?? "";
        else if (heading === "Grok") expect.soft(row.textContent).not.toContain("muse-spark");
      }
      expect.soft(el("gear-btn").textContent).toContain("Grok 4.7");
    };
    sidebar.posted.length = 0;
    let release!: () => void;
    startControl.startWait = new Promise<void>(resolve => { release = resolve; });
    const switching = sidebar.switchModel(pick.modelId, sidebar.focused, remote ? { clientId: "phone" } : undefined, pick.provider);
    try {
      await vi.waitFor(() => expect(sidebar.focused.priming).toBe(true));
      const beforeReady = sidebar.posted.splice(0);
      expect(beforeReady.find((m: HostMsg) => m.type === "modeChanged")).toMatchObject({ modeId: "agent", modes: ["agent", "plan", "yolo"] });
      for (const frame of beforeReady) { dispatch(h.window, frame); assertUi(); }
    } finally {
      release();
      await switching;
    }
    const readyFrames = sidebar.posted;
    expect(readyFrames.find((m: HostMsg) => m.type === "session")).toMatchObject({ provider: "grok", currentModelId: "grok-4.7" });
    for (const frame of readyFrames) { dispatch(h.window, frame); assertUi(); }
    expect(startErrors(sidebar)).toEqual([]);
    expect((el("input") as HTMLTextAreaElement).placeholder).toContain("Ask Grok");
    expect(h.doc.querySelector(".model-picker-row.active")?.textContent).toContain("Grok 4.7");
    await h.window.happyDOM.close();
  });

  it.each(["agent", "yolo", "onRequest", "denyUnmatched"])("applies the host cloud launch rule for remembered %s without persisting cloud flags", async mode => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.provider = "muse";
    sidebar.connectedProviders = () => ["muse"];
    sidebar.usableProviders = () => ["muse"];
    sidebar.providerConnectionState = { muse: true };
    delete sidebar.updateSessionMeta;
    await sidebar.state.update("grok.defaultMuseMode", mode);
    await sidebar.startSession(undefined, session);
    await sidebar.sessionMetaWrites;
    const effective = mode === "onRequest" || mode === "denyUnmatched" ? "agent" : mode;
    expect(startControl.musePostures.at(-1)).toMatchObject({ mode: effective, cloud: true, shellSandbox: false });
    expect(session.museCloud).toBe(true);
    expect(session.museShellSandbox).toBe(false);
    expect(sidebar.displayMode(session)).toBe(effective);
    const saved = sidebar.state.get("grok.sessionMeta", {})["new-session"].musePosture;
    expect(saved).toMatchObject({ mode: effective, shellSandbox: true });
    expect(saved).not.toHaveProperty("cloud");
    expect(sidebar.state.get("grok.defaultMuseMode")).toBe(mode);
    expect(sidebar.posted.filter((message: HostMsg) => message.type === "modeChanged").every((message: any) =>
      !message.modes.includes("onRequest") && !message.disabledModes)).toBe(true);
    // Shared catalog connections use the same host launch rule.
    const catalog = sidebar.createProviderBackend("muse").spawn({ cliPath: "/fake/muse", cwd: "/repo", env: {} });
    expect(JSON.parse(catalog.env.GROK_MUSE_POSTURE)).toMatchObject({ cloud: true, shellSandbox: false });
  });
  it("saves a replayed On request before a sandbox mismatch aborts resume", async () => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.provider = "muse";
    sidebar.connectedProviders = () => ["muse"];
    sidebar.usableProviders = () => ["muse"];
    sidebar.providerConnectionState = { muse: true };
    delete sidebar.updateSessionMeta;
    await sidebar.state.update("grok.sessionMeta", { history: { musePosture: { mode: "yolo", shellSandbox: false, sandboxNetwork: "proxy-only", trustWorkspaces: true } } });
    startControl.museMode = "onRequest";
    startControl.museFailsAfterReplay = true;
    await sidebar.startSession("history", session);
    await sidebar.sessionMetaWrites;
    expect(sidebar.state.get("grok.sessionMeta", {}).history.musePosture.mode).toBe("onRequest");
    startControl.museFailsAfterReplay = false;
    await sidebar.startSession("history", session);
    expect(startControl.musePostures.at(-1).mode).toBe("onRequest");
    expect(session.museShellSandbox).toBe(true);
  });
  it.each([false, true])("starts saved/default Deny unmatched as Prompt unmatched and shows its badge (cloud=%s)", async cloud => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, cloud ? "1" : "");
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.provider = "muse";
    sidebar.connectedProviders = () => ["muse"];
    sidebar.usableProviders = () => ["muse"];
    sidebar.providerConnectionState = { muse: true };
    delete sidebar.updateSessionMeta;
    await sidebar.state.update("grok.defaultMuseMode", "denyUnmatched");
    await sidebar.state.update("grok.sessionMeta", { history: { musePosture: {
      mode: "denyUnmatched", shellSandbox: true, sandboxNetwork: "proxy-only", trustWorkspaces: true,
    } } });
    // The adapter's durable replay repair is tested in muse-session.test.ts.
    startControl.museMode = "agent";
    const h = bootWebview({ remote: cloud });
    dispatch(h.window, { type: "providerState", providers: [{ id: "muse", connected: true }] } as any);
    for (const resumeId of [undefined, "history"]) {
      await sidebar.startSession(resumeId, session);
      await sidebar.sessionMetaWrites;
      expect(startControl.musePostures.at(-1).mode).toBe("agent");
      expect(sidebar.displayMode(session)).toBe("agent");
      dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", models: [] } as any);
      dispatch(h.window, sidebar.posted.filter((message: HostMsg) => message.type === "modeChanged").at(-1));
      expect(h.doc.getElementById("mode-btn")!.textContent).toBe("Prompt unmatched");
    }
    expect(sidebar.state.get("grok.sessionMeta", {}).history.musePosture).toMatchObject({ mode: "agent", trustWorkspaces: true });
    await h.window.happyDOM.close();
  });
  it.each(["agent", "yolo", "onRequest"])("follows replayed Muse %s and preserves it for the next process start", async mode => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.provider = "muse";
    sidebar.connectedProviders = () => ["muse"];
    sidebar.usableProviders = () => ["muse"];
    sidebar.providerConnectionState = { muse: true };
    delete sidebar.updateSessionMeta;
    startControl.museMode = mode;
    await sidebar.startSession("history", session);
    await sidebar.sessionMetaWrites;
    expect(sidebar.displayMode(session)).toBe(mode);
    expect(sidebar.state.get("grok.sessionMeta", {}).history.musePosture.mode).toBe(mode);
    await sidebar.startSession("history", session);
    expect(startControl.musePostures.at(-1).mode).toBe(mode);
    expect(session.museShellSandbox).toBe(mode !== "yolo");
  });

  it.each(["onRequest"])("starts a new Muse conversation in remembered %s without writing the shared default", async mode => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.provider = "muse";
    sidebar.connectedProviders = () => ["muse"];
    sidebar.usableProviders = () => ["muse"];
    sidebar.providerConnectionState = { muse: true };
    delete sidebar.updateSessionMeta;
    const update = vi.fn();
    let sandboxSetting = true;
    sidebar.host.getConfiguration.mockReturnValue({
      get: (key: string, fallback: unknown) => key === "museShellSandbox" ? sandboxSetting : fallback,
      inspect: () => undefined, update,
    });
    await sidebar.startSession(undefined, session);
    await sidebar.setMode(mode, session);
    expect(update).not.toHaveBeenCalled();
    sandboxSetting = false;
    await sidebar.startSession(undefined, session);
    expect(startControl.musePostures.at(-1)).toMatchObject({ mode, shellSandbox: false });
    expect(session.museShellSandbox).toBe(mode === "onRequest");
    expect(sidebar.displayMode(session)).toBe(mode);
  });

  it("starts remembered Muse full access, persists live switches, and follows replay on reopen", async () => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.provider = "muse";
    sidebar.connectedProviders = () => ["muse"];
    sidebar.usableProviders = () => ["muse"];
    sidebar.providerConnectionState = { muse: true };
    delete sidebar.updateSessionMeta; // exercise the serialized, durable store
    const config: Record<string, unknown> = { defaultMode: "yolo", museSandboxNetwork: "restricted" };
    sidebar.host.getConfiguration.mockReturnValue({
      get: (key: string, fallback: unknown) => config[key] ?? fallback,
      inspect: () => undefined,
      update: vi.fn(async (key: string, value: unknown) => { config[key] = value; }),
    });
    const client = await sidebar.startSession(undefined, session);
    expect(client).toBeDefined();
    await sidebar.sessionMetaWrites;
    const original = { mode: "yolo", shellSandbox: true, sandboxNetwork: "restricted", trustWorkspaces: false };
    expect(startControl.musePostures.at(-1)).toEqual(original);
    expect(sidebar.displayMode(session)).toBe("yolo");
    expect(sidebar.state.get("grok.sessionMeta", {})["new-session"].musePosture).toEqual(original);

    const starts = startControl.starts;
    await sidebar.setMode("agent", session);
    expect(startControl.starts).toBe(starts);
    expect(sidebar.state.get("grok.sessionMeta", {})["new-session"].musePosture).toEqual({ ...original, mode: "agent" });
    // Settings changed in another conversation do not alter this one's process.
    config.museTrustWorkspaces = true;
    config.museSandboxNetwork = "enabled";
    startControl.museMode = "yolo"; // Muse replay is authority even when it differs.
    await sidebar.startSession("new-session", session);
    await sidebar.sessionMetaWrites;
    expect(startControl.musePostures.at(-1)).toEqual({ ...original, mode: "agent" });
    expect(sidebar.displayMode(session)).toBe("yolo");
    expect(session.planModeAvailable).toBe(false);
    expect(config.defaultMode).toBe("agent"); // replay never overwrites shared preference
    await sidebar.startSession("new-session", session);
    expect(startControl.musePostures.at(-1)).toEqual(original);
  });
  it("keeps Muse's kept mode for the next start when it refuses full access", async () => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.provider = "muse";
    sidebar.connectedProviders = () => ["muse"];
    sidebar.usableProviders = () => ["muse"];
    sidebar.providerConnectionState = { muse: true };
    delete sidebar.updateSessionMeta;
    const config: Record<string, unknown> = { defaultMode: "agent" };
    sidebar.host.getConfiguration.mockReturnValue({
      get: (key: string, fallback: unknown) => config[key] ?? fallback,
      inspect: () => undefined,
      update: vi.fn(async (key: string, value: unknown) => { config[key] = value; }),
    });
    await sidebar.startSession(undefined, session);
    await sidebar.sessionMetaWrites;
    const agent = startControl.musePostures.at(-1);
    expect(agent.mode).toBe("agent");
    startControl.museRefusesFullAccess = true;
    await sidebar.setMode("yolo", session);
    await sidebar.sessionMetaWrites;
    expect(session.autoApprove).toBe(false);
    expect(sidebar.state.get("grok.sessionMeta", {})["new-session"].musePosture).toEqual(agent);
    await sidebar.startSession("new-session", session);
    expect(startControl.musePostures.at(-1)).toEqual(agent);
  });
  it.each(["completed", "failed"])("the live tool update handler closes a question on %s", async (status) => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    const client = await sidebar.startSession(undefined, session);
    session.turnToken = {};
    client.emit("questionRequest", { id: 0, toolCallId: "call-colour", questions: [{ question: "Which colour?" }] });
    expect(session.pendingQuestions.get(0)).toBe("call-colour");
    expect(session.status).toBe("needs-you");
    client.emit("toolCallUpdate", { toolCallId: "call-colour", status });
    expect(session.pendingQuestions.size).toBe(0);
    expect(client.setHumanWaitActive).toHaveBeenLastCalledWith(false);
    expect(session.status).toBe("working");
    expect(sidebar.posted.filter((m: HostMsg) => m.type === "questionResolved"))
      .toEqual([{ type: "questionResolved", requestId: 0, outcome: "closed" }]);
    session.turnToken = undefined;
  });

  it("ignores a replaced client's terminal update even when tool and request ids are reused", async () => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    const first = await sidebar.startSession(undefined, session);
    first.emit("questionRequest", { id: 0, toolCallId: "reused", questions: [] });
    const replacement = await sidebar.startSession(undefined, session);
    replacement.emit("questionRequest", { id: 0, toolCallId: "reused", questions: [] });
    sidebar.posted.length = 0;
    first.emit("toolCallUpdate", { toolCallId: "reused", status: "completed" });
    expect(session.pendingQuestions.get(0)).toBe("reused");
    expect(sidebar.posted).toEqual([]);
    replacement.emit("toolCallUpdate", { toolCallId: "reused", status: "completed" });
    expect(session.pendingQuestions.size).toBe(0);
    expect(sidebar.posted).toContainEqual({ type: "questionResolved", requestId: 0, outcome: "closed" });
  });

  it("tracks arriving human requests and closes them and confirmations before replacing the client", async () => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    const first = await sidebar.startSession(undefined, session);
    session.planModeAvailable = true;
    vi.spyOn(sidebar, "createPlanReviewSnapshot").mockResolvedValue({ path: "/plan", name: "Plan" });
    first.emit("questionRequest", { id: "question", questions: [{ question: "Q?" }] });
    expect(first.setHumanWaitActive).toHaveBeenLastCalledWith(true);
    first.emit("permissionRequest", {
      id: "permission", toolCall: { title: "Read?", kind: "read" },
      options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }],
    });
    first.emit("exitPlanRequest", { id: "plan", plan: "Plan" });
    await vi.waitFor(() => expect(session.pendingExitPlans.size).toBe(1));
    expect(session.pendingPermissions.size).toBe(1);
    const confirm = sidebar.confirmInChat(session, { title: "Revert?", confirmLabel: "Rewind" });
    const replacement = await sidebar.startSession(undefined, session);
    await expect(confirm).resolves.toBe(false);
    expect(replacement).not.toBe(first);
    expect(first.setHumanWaitActive).toHaveBeenLastCalledWith(false);
    expect(replacement.setHumanWaitActive).toHaveBeenLastCalledWith(false);
    expect(session.pendingQuestions.size + session.pendingPermissions.size + session.pendingExitPlans.size).toBe(0);
    expect(sidebar.posted).toContainEqual({ type: "questionResolved", requestId: "question", outcome: "closed" });
    expect(sidebar.posted.some((m: HostMsg) => m.type === "uiConfirmResolved")).toBe(true);
  });

  it.each([
    ["grok", undefined, "high"],
    ["claude", "low", "low"],
    ["codex", "medium", "medium"],
    ["claude", undefined, undefined],
    ["codex", undefined, undefined],
  ] as const)("starts %s with its own remembered effort (%s)", async (provider, remembered, expected) => {
    const sidebar = makeSidebar(process.cwd());
    sidebar.focused.provider = provider;
    sidebar.connectedProviders = () => [provider];
    sidebar.usableProviders = () => [provider];
    // Starting the adapter runs the vendor binary, so the saved consent has
    // to agree with the mocked derived views above (#171).
    sidebar.providerConnectionState = { [provider]: true };
    sidebar.createProviderBackend = () => ({ provider });
    await sidebar.state.update("grok.defaultEffortByProvider", { [provider]: remembered });
    sidebar.host.getConfiguration.mockReturnValue({
      get: (key: string, fallback: unknown) => key === "defaultEffort" ? "high" : fallback,
    });
    startControl.efforts = [];
    await sidebar.startSession(undefined, sidebar.focused);
    expect(sidebar.focused.provider).toBe(provider);
    expect(startControl.efforts).toEqual([expected]);
    expect(sidebar.posted.find((message: HostMsg) => message.type === "initialized")).toMatchObject({
      info: { provider, steeringSupported: provider === "grok" },
    });
  });

  beforeEach(() => {
    startControl.catalogs = {};
    startControl.startWait = undefined;
    startControl.museMode = undefined;
    startControl.musePostures = [];
    startControl.museRefusesFullAccess = false;
    startControl.museFailsAfterReplay = false;
    startControl.failuresRemaining = 0;
    startControl.failWith = "Internal error";
    startControl.starts = 0;
    startControl.disposes = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    startControl.failuresRemaining = 0;
    startControl.failWith = "Internal error";
    startControl.starts = 0;
    startControl.disposes = 0;
  });

  it.each([undefined, "saved-session"])("a new/load start (%s) clears grants even when reusing a Session object", async (resumeId) => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused;
    session.allowedCommandPrograms.add("npm");
    const client = await sidebar.startSession(resumeId, session);
    expect(client).toBeDefined();
    expect(session.allowedCommandPrograms.size).toBe(0);
  });

  it("retries two transient spawn failures then comes up with no error", async () => {
    startControl.failuresRemaining = 2;
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeDefined();
    expect(startControl.starts).toBe(3);
    expect(startControl.disposes).toBe(2);
    expect(startErrors(sidebar)).toEqual([]);
    expect(onboardings(sidebar)).toEqual([]);
    expect(sidebar.pool.has(sidebar.focused)).toBe(true);
    expect(sidebar.focused.priming).toBe(false);
  });

  it("emits exactly one plain error after three spawn failures", async () => {
    startControl.failuresRemaining = 3;
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeUndefined();
    expect(startControl.starts).toBe(3);
    expect(startControl.disposes).toBe(3);
    const errors = startErrors(sidebar);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "error",
      text: "Failed to start Grok: Internal error",
    });
    expect(onboardings(sidebar)).toEqual([]);
  });

  it("does not retry a plain failure once resume replay has begun", async () => {
    // A second attempt after a partial history load would replay onto the
    // partial transcript and duplicate every message — the retry budget ends
    // the moment the resume branch starts emitting.
    startControl.loadFailuresRemaining = 1;
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession("resume-1", sidebar.focused);
    expect(client).toBeUndefined();
    expect(startControl.starts).toBe(1);
    const errors = startErrors(sidebar);
    expect(errors).toHaveLength(1);
    expect(onboardings(sidebar)).toEqual([]);
  });

  it("retries a mid-startup death and comes up clean, with no banner", async () => {
    // The best-effort awaits in startup swallow their errors, so a death
    // there completes startup with the pipe already detached. That death
    // must be treated as a startup failure (retry budget), never a silent
    // undefined: recoverAuthAndResend reads silent undefined as "failure
    // already surfaced" and abandons the resend.
    startControl.exitDuringNewSessionRemaining = 1;
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeDefined();
    expect(sidebar.focused.client).toBe(client);
    expect(startControl.starts).toBe(2);
    expect(startErrors(sidebar)).toEqual([]);
    expect(sidebar.posted.filter((m: HostMsg) => m.type === "exit")).toEqual([]);
  });

  it("surfaces one error when the process dies mid-startup every time", async () => {
    startControl.exitDuringNewSessionRemaining = 99;
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession(undefined, sidebar.focused);
    startControl.exitDuringNewSessionRemaining = 0;
    expect(client).toBeUndefined();
    expect(sidebar.focused.client).toBeUndefined();
    expect(startControl.starts).toBe(3);
    const errors = startErrors(sidebar);
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as any).text)).toContain("exited during startup");
    expect(sidebar.posted.filter((m: HostMsg) => m.type === "exit")).toEqual([]);
  });

  it("does not retarget a resumed Grok conversation onto a usable Codex", async () => {
    // openSession mints a fresh Session (hasHistory still false) then calls
    // startSession(resumeId). The empty-session fallback used to see that as
    // "nothing to preserve" and hand the Grok row to Codex — then blame Codex
    // for the spawn that followed.
    const sidebar = makeSidebar("/repo");
    sidebar.connectedProviders = vi.fn(() => ["codex"]);
    sidebar.usableProviders = vi.fn(() => ["codex"]);
    sidebar.defaultProviderForProject = vi.fn(() => "codex");
    sidebar.rememberProjectProvider = vi.fn(async () => {});
    sidebar.locateProvider = vi.fn((provider: string) => provider === "codex" ? "codex" : undefined);
    sidebar.focused.provider = "grok";
    sidebar.focused.hasHistory = false;

    const client = await sidebar.startSession("existing-grok-session", sidebar.focused);

    expect(client).toBeUndefined();
    expect(sidebar.focused.provider).toBe("grok");
    expect(sidebar.defaultProviderForProject).not.toHaveBeenCalled();
    expect(startControl.starts).toBe(0);
    expect(startErrors(sidebar)).toEqual([]);
    expect(onboardings(sidebar)).toEqual([
      expect.objectContaining({ type: "onboarding", provider: "grok" }),
    ]);
    expect(String((onboardings(sidebar)[0] as any).state)).not.toMatch(/codex/i);
  });

  it("still retargets a brand-new empty session whose provider cannot answer", async () => {
    const sidebar = makeSidebar("/repo");
    sidebar.connectedProviders = vi.fn(() => ["codex"]);
    sidebar.usableProviders = vi.fn(() => ["codex"]);
    sidebar.defaultProviderForProject = vi.fn(() => "codex");
    sidebar.rememberProjectProvider = vi.fn(async () => {});
    // Refuse the spawn itself — this test only cares that the empty session
    // moved onto Codex before anyone tried to start an agent.
    sidebar.locateProvider = vi.fn(() => undefined);
    sidebar.focused.provider = "grok";
    sidebar.focused.hasHistory = false;

    const client = await sidebar.startSession(undefined, sidebar.focused);

    expect(sidebar.focused.provider).toBe("codex");
    expect(sidebar.defaultProviderForProject).toHaveBeenCalled();
    expect(sidebar.rememberProjectProvider).toHaveBeenCalled();
    expect(client).toBeUndefined();
    expect(startControl.starts).toBe(0);
  });

  it.each([false, true])("drops Codex startup events without transcript side effects (child: %s)", async (child) => {
    const sidebar = makeSidebar("/repo");
    const session = sidebar.focused as Session;
    session.provider = "codex";
    sidebar.providerConnectionState = { grok: false, codex: true };
    sidebar.connectedProviders = vi.fn(() => ["codex"]);
    const client = await sidebar.startSession(undefined, session);
    expect(client).toBeDefined();
    expect(startErrors(sidebar)).toEqual([]);
    session.replaying = true;
    session.inUserMessage = true;
    const countBefore = session.historyEventCount;
    const bufferBefore = [...session.buffer];
    const postedBefore = [...sidebar.posted];
    sidebar.host.appendLine.mockClear();
    const compactSignal = vi.spyOn(sidebar, "noteAdapterCompactSignal");
    const send = (event: "toolCall" | "toolCallUpdate", call: unknown) => {
      if (child) client.emit("childStream", { childSessionId: "child-1", route: { event, payload: call } });
      else client.emit(event, call);
    };
    send("toolCall", {
      toolCallId: "startup-1", title: "mcp__canva__startup", status: "in_progress",
      rawInput: { command: "connect canva" },
    });
    expect(sidebar.host.appendLine).not.toHaveBeenCalled();
    const forwarded = "[codex-acp forwarded startup error] MCP server `canva` startup was cancelled.";
    send("toolCallUpdate", {
      toolCallId: "startup-1", status: "failed",
      rawOutput: forwarded,
      content: [{ type: "content", content: { type: "text", text: forwarded } }],
    });
    expect(sidebar.host.appendLine).toHaveBeenCalledTimes(1);
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(`[mcp] canva startup failed: ${forwarded}`);
    expect(session.historyEventCount).toBe(countBefore);
    expect(session.inUserMessage).toBe(true);
    expect(session.buffer).toEqual(bufferBefore);
    expect(sidebar.posted).toEqual(postedBefore);
    expect(compactSignal).not.toHaveBeenCalled();

    send("toolCall", {
      toolCallId: "real-1", title: "mcp__canva__list_designs", status: "in_progress", rawInput: {},
    });
    expect(session.historyEventCount).toBe(countBefore + (child ? 0 : 1));
    expect(sidebar.posted.at(-1)).toMatchObject({
      type: child ? "childStream" : "toolCall", call: { toolCallId: "real-1" },
    });
  });

  it("emits onboarding on the first credential failure and does not retry", async () => {
    startControl.failWith = "401 Unauthorized";
    startControl.failuresRemaining = 5;
    const sidebar = makeSidebar("/repo");
    const began = Date.now();
    const client = await sidebar.startSession(undefined, sidebar.focused);
    const elapsed = Date.now() - began;
    expect(client).toBeUndefined();
    expect(startControl.starts).toBe(1);
    expect(elapsed).toBeLessThan(250);
    expect(startErrors(sidebar)).toEqual([]);
    expect(onboardings(sidebar)).toHaveLength(1);
    expect(onboardings(sidebar)[0]).toMatchObject({ type: "onboarding" });
  });
});
