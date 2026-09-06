/**
 * Bounded spawn retry in startSession: a transient plain failure after an
 * update must not paint "Failed to start …" on a brand-new empty session.
 * Auth still surfaces immediately; only the last of 3 plain attempts emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";

const startControl = {
  failuresRemaining: 0,
  failWith: "Internal error",
  starts: 0,
  disposes: 0,
  loadFailuresRemaining: 0,
  loadFailWith: "Internal error",
  exitDuringNewSessionRemaining: 0,
};

vi.mock("../src/acp", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient extends EventEmitter {
    provider: "grok" | "codex";
    usesClientPlanGate = false;
    sessionId: string | undefined;
    availableModels: { modelId: string; name: string }[] = [];
    currentModelId = "fake-model";
    fsRead?: unknown;
    fsWrite?: unknown;
    terminal?: unknown;
    constructor(opts: { log: (msg: string) => void; backend?: { provider: "grok" | "codex" } }) {
      super();
      this.provider = opts.backend?.provider ?? "grok";
    }
    async start(): Promise<void> {
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
      this.emit("session", { sessionId: this.sessionId });
      return { sessionId: this.sessionId };
    }
    async loadSession(sessionId: string): Promise<{ sessionId: string }> {
      if (startControl.loadFailuresRemaining > 0) {
        startControl.loadFailuresRemaining -= 1;
        throw new Error(startControl.loadFailWith);
      }
      this.sessionId = sessionId;
      this.emit("session", { sessionId });
      this.emit("sessionLoaded", { sessionId });
      return { sessionId };
    }
    async dispose(): Promise<void> {
      startControl.disposes += 1;
    }
    async setMode(): Promise<void> {}
    isCredentialError(): boolean {
      return /auth|unauthor|401|api[_\s-]?key|credential|sign.?in/i.test(startControl.failWith);
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
  beforeEach(() => {
    startControl.failuresRemaining = 0;
    startControl.failWith = "Internal error";
    startControl.starts = 0;
    startControl.disposes = 0;
  });

  afterEach(() => {
    startControl.failuresRemaining = 0;
    startControl.failWith = "Internal error";
    startControl.starts = 0;
    startControl.disposes = 0;
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
