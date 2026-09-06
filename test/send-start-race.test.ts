/**
 * A concurrent startSession used to swallow a send: handleSend echoed
 * userMessage, then bailed on gen !== session.gen with no turn-failed signal.
 * These tests drive the real handleSend / startSession pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteClientState } from "../src/remote-client-state";
import {
  INTERRUPTED_SEND_TEXT,
  Session,
  beginTurn,
  turnIsInFlight,
} from "../src/session";
import { INTERRUPTED_SEND_CODE, type HostMsg } from "../src/protocol";

const promptControl = {
  calls: 0,
  starts: 0,
  hang: false as Promise<void> | false,
  rejectOnDispose: null as ((err: Error) => void) | null,
};

vi.mock("../src/acp", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient extends EventEmitter {
    provider = "grok" as const;
    usesClientPlanGate = false;
    sessionId: string | undefined;
    availableModels: { modelId: string; name: string }[] = [];
    availableCommands: { name: string }[] = [];
    currentModelId = "fake-model";
    fsRead?: unknown;
    fsWrite?: unknown;
    terminal?: unknown;
    constructor(_opts: { log: (msg: string) => void }) {
      super();
    }
    async start(): Promise<void> {
      promptControl.starts += 1;
      this.emit("initialized", { protocolVersion: 1, serverInfo: { version: "0.2.117" } });
    }
    async newSession(): Promise<{ sessionId: string }> {
      this.sessionId = "new-session";
      this.emit("session", { sessionId: this.sessionId });
      return { sessionId: this.sessionId };
    }
    async loadSession(sessionId: string): Promise<{ sessionId: string }> {
      this.sessionId = sessionId;
      this.emit("session", { sessionId });
      this.emit("sessionLoaded", { sessionId });
      return { sessionId };
    }
    async prompt(): Promise<Record<string, never>> {
      promptControl.calls += 1;
      if (promptControl.hang) {
        return new Promise<Record<string, never>>((resolve, reject) => {
          promptControl.rejectOnDispose = reject;
          void Promise.resolve(promptControl.hang).then(() => {
            if (promptControl.rejectOnDispose === reject) {
              promptControl.rejectOnDispose = null;
              resolve({});
            }
          });
        });
      }
      return {};
    }
    async dispose(): Promise<void> {
      if (promptControl.rejectOnDispose) {
        const reject = promptControl.rejectOnDispose;
        promptControl.rejectOnDispose = null;
        reject(new Error("client disposed"));
      }
    }
    async setMode(): Promise<void> {}
    honorsInterjectContent(): boolean {
      return true;
    }
    async interject(): Promise<"ok"> {
      return "ok";
    }
    isCredentialError(): boolean {
      return false;
    }
  }
  return { ...actual, AcpClient: FakeAcpClient };
});

import { GrokSidebar } from "../src/sidebar";

function makeSidebar(cwd: string): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
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
  sidebar.sessionStartTails = new WeakMap();
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
  sidebar.retainUploadedFilesForSession = vi.fn(async () => {});
  sidebar.rememberProjectProvider = vi.fn(async () => {});
  sidebar.reportSessionStart = vi.fn();
  sidebar.noteSessionActivity = vi.fn();
  sidebar.maybeGenerateTitle = vi.fn();
  sidebar.postChips = vi.fn();
  sidebar.refreshImplicitChip = vi.fn();
  sidebar.settleUnavailablePlanTurn = vi.fn();
  sidebar.recoverAuthAndResend = vi.fn(async () => false);
  sidebar.setStatus = (session: Session, status: Session["status"]) => { session.status = status; };
  sidebar.posted = [] as HostMsg[];
  sidebar.emit = (session: Session, message: HostMsg) => {
    if (message.type === "clearMessages") session.buffer = [];
    else session.buffer.push(message);
    sidebar.posted.push(message);
  };
  sidebar.view = { webview: { postMessage: (message: HostMsg) => sidebar.posted.push(message) } };
  return sidebar;
}

function resetPromptControl(): void {
  promptControl.calls = 0;
  promptControl.starts = 0;
  promptControl.hang = false;
  promptControl.rejectOnDispose = null;
}

describe("send vs concurrent startSession", () => {
  beforeEach(resetPromptControl);
  afterEach(resetPromptControl);

  it("keeps remote accounting on a same-conversation restart and resets it for a new conversation", async () => {
    const sidebar = makeSidebar("/repo");
    await sidebar.startSession(undefined, sidebar.focused);
    const session = sidebar.focused as Session;
    const id = session.activeSessionId;
    expect(id).toBeDefined();
    session.telemetrySessionOrigin = "local";
    session.remoteMessageReported = true;

    await sidebar.startSession(id, session);
    expect(session.telemetrySessionOrigin).toBe("local");
    expect(session.remoteMessageReported).toBe(true);

    await sidebar.startSession(undefined, session);
    expect(session.telemetrySessionOrigin).toBeUndefined();
    expect(session.remoteMessageReported).toBe(false);
  });

  it("emits a visible turn failure when a start abandons a send after the echo", async () => {
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeDefined();
    sidebar.posted = [];

    let releaseHang!: () => void;
    promptControl.hang = new Promise<void>((resolve) => { releaseHang = resolve; });

    const send = sidebar.handleSend("queued after restart");
    await vi.waitFor(() => {
      expect(sidebar.posted.some((m: HostMsg) => m.type === "userMessage")).toBe(true);
    });
    expect(sidebar.posted.some((m: HostMsg) => m.type === "agentStart")).toBe(true);
    expect(turnIsInFlight(sidebar.focused)).toBe(true);

    const start = sidebar.startSession(undefined, sidebar.focused);
    await send;
    releaseHang();
    await start;

    const errors = sidebar.posted.filter((m: HostMsg) => m.type === "error");
    expect(errors).toEqual([
      expect.objectContaining({
        type: "error",
        text: INTERRUPTED_SEND_TEXT,
        code: INTERRUPTED_SEND_CODE,
      }),
    ]);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "agentError")).toBe(false);
    expect(sidebar.focused.status).not.toBe("error");
  });

  it("does not let an opportunistic startSession interleave with a send in flight", async () => {
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeDefined();
    const gen = sidebar.focused.gen;
    beginTurn(sidebar.focused);
    expect(turnIsInFlight(sidebar.focused)).toBe(true);

    const started = await sidebar.startSession(undefined, sidebar.focused, "ensure");

    expect(started).toBe(client);
    expect(sidebar.focused.client).toBe(client);
    expect(sidebar.focused.gen).toBe(gen);
    expect(turnIsInFlight(sidebar.focused)).toBe(true);
    expect(promptControl.starts).toBe(1);
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("refused startSession (turn in flight)"),
    );
  });

  it("holds a send until an in-flight startSession settles", async () => {
    const sidebar = makeSidebar("/repo");
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      sidebar.testSessionStartDelay = {
        resumeId: undefined,
        started: resolve,
        wait: new Promise<void>((ok) => { release = ok; }),
      };
    });

    const start = sidebar.startSession(undefined, sidebar.focused, "ensure");
    await started;
    expect(promptControl.starts).toBe(0);

    const events: string[] = [];
    const send = sidebar.handleSend("hello after start").then(() => { events.push("send"); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
    expect(promptControl.calls).toBe(0);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "userMessage")).toBe(false);

    release();
    await Promise.all([start, send]);
    expect(events).toEqual(["send"]);
    expect(promptControl.starts).toBe(1);
    expect(promptControl.calls).toBe(1);
    expect(sidebar.posted.filter((m: HostMsg) => m.type === "userMessage")).toHaveLength(1);
  });

  it("queues a send on a priming replacement that has no client yet", async () => {
    const sidebar = makeSidebar("/repo");
    sidebar.focused.priming = true;

    await sidebar.handleSend("from the phone");

    expect(sidebar.focused.queuedSends).toEqual([{ text: "from the phone", chips: [] }]);
    expect(promptControl.starts).toBe(0);
    expect(promptControl.calls).toBe(0);
    expect(sidebar.posted.some((m: HostMsg) => m.type === "userMessage")).toBe(false);
    expect(sidebar.posted.filter((m: HostMsg) => m.type === "queuedSends")).toEqual([
      { type: "queuedSends", items: ["from the phone"], queued: [{ text: "from the phone" }] },
    ]);
  });

  it("flushes that queued send once the replacement start finishes", async () => {
    const sidebar = makeSidebar("/repo");
    delete sidebar.maybeFlushQueuedSends;
    sidebar.focused.priming = true;
    await sidebar.handleSend("from the phone");
    expect(promptControl.starts).toBe(0);

    await sidebar.startSession(undefined, sidebar.focused);
    await vi.waitFor(() => {
      expect(promptControl.calls).toBe(1);
    });

    expect(promptControl.starts).toBe(1);
    expect(sidebar.posted.filter((m: HostMsg) => m.type === "userMessage")).toEqual([
      expect.objectContaining({ type: "userMessage", text: "from the phone" }),
    ]);
    expect(sidebar.focused.queuedSends).toEqual([]);
  });
});
