/**
 * `autoName` write sites and the session-meta setter must store a capped value.
 * The helper itself is tested in `sessions.test.ts`; the load sweep in
 * `persisted-state.test.ts`. This file drives the two live writers plus the
 * setter they share, so a later third path that goes through `updateSessionMeta`
 * cannot persist a raw prompt either.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/acp", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient extends EventEmitter {
    supportsInterject(): boolean { return true; }
    provider = "grok" as const;
    usesClientPlanGate = false;
    sessionId: string | undefined;
    availableModels: { modelId: string; name: string }[] = [];
    currentModelId = "fake-model";
    constructor(_opts: unknown) {
      super();
    }
    async start(): Promise<void> {
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
    async listSessions(): Promise<{ sessions: Array<{ sessionId: string; title: string; cwd: string; updatedAt: number }> }> {
      return { sessions: adapterSessions };
    }
    async dispose(): Promise<void> {}
    async setMode(): Promise<void> {}
    isCredentialError(): boolean {
      return false;
    }
  }
  return { ...actual, AcpClient: FakeAcpClient };
});

import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { AUTO_NAME_MAX_CHARS, capAutoName } from "../src/sessions";
import type { HostMsg } from "../src/protocol";

const SESSION_META_KEY = "grok.sessionMeta";
const FAT_TITLE = "please rewrite this entire module from first principles and then keep going ".repeat(20).trim();

let adapterSessions: Array<{ sessionId: string; title: string; cwd: string; updatedAt: number }> = [];

function makeSidebar(cwd: string): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.providerConnectionState = { grok: true, codex: true, claude: false };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.connectedProviders = vi.fn(() => ["grok", "codex"]);
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "grok";
  sidebar.focused.cwd = cwd;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.sessionCache = new Map();
  sidebar.codexSessionCache = new Map();
  sidebar.codexSessionCacheAt = new Map();
  sidebar.codexSessionRefresh = new Map();
  sidebar.claudeSessionCache = new Map();
  sidebar.claudeSessionCacheAt = new Map();
  sidebar.claudeSessionRefresh = new Map();
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
  sidebar._memento = memento;
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
  sidebar.locateProvider = vi.fn((provider: string) => `/bin/${provider}`);
  sidebar.providerDefaultForProject = vi.fn(() => "");
  sidebar.configForcesAutoApprove = vi.fn(() => false);
  sidebar.confirmRepoForcedAutoApprove = vi.fn(async () => true);
  sidebar.stopVoiceInput = vi.fn();
  sidebar.queueInFlightPlanCommentsOnExit = vi.fn();
  sidebar.warnOAuthShadowOnce = vi.fn();
  sidebar.cacheProviderModels = vi.fn(async () => {});
  sidebar.modelsForSession = vi.fn(() => []);
  sidebar.postSessionName = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.sendLocalRepoSessionsPreview = vi.fn();
  sidebar.setProviderNeedsLogin = vi.fn();
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
  sidebar.buildEnv = vi.fn(() => ({ ...process.env }));
  sidebar.usableProviders = vi.fn(() => ["grok", "codex"]);
  sidebar.view = { webview: { postMessage: vi.fn() } };
  return sidebar;
}

describe("autoName setter", () => {
  it("caps autoName even when the mutator writes a raw prompt", async () => {
    const sidebar = makeSidebar("/repo");
    await sidebar.updateSessionMeta(() => ({
      s1: { autoName: FAT_TITLE, customName: "keep me" },
    }));
    const stored = sidebar._memento[SESSION_META_KEY].s1;
    expect(stored.autoName).toBe(capAutoName(FAT_TITLE));
    expect(stored.autoName.length).toBeLessThanOrEqual(AUTO_NAME_MAX_CHARS);
    expect(stored.customName).toBe("keep me");
    expect(stored.autoName).not.toBe(FAT_TITLE);
  });
});

describe("sessionTitle write site", () => {
  it("stores a capped autoName from a long session title", async () => {
    expect(FAT_TITLE.length).toBeGreaterThan(AUTO_NAME_MAX_CHARS);
    const sidebar = makeSidebar("/repo");
    const client = await sidebar.startSession("resume-1", sidebar.focused);
    expect(client).toBeDefined();
    client.emit("sessionTitle", FAT_TITLE);
    await sidebar.sessionMetaWrites;
    const stored = sidebar._memento[SESSION_META_KEY]["resume-1"];
    expect(stored.autoName).toBe(capAutoName(FAT_TITLE));
    expect(stored.autoName.length).toBeLessThanOrEqual(AUTO_NAME_MAX_CHARS);
  });
});

describe("adapter history write site", () => {
  it("stores a capped autoName from a long adapter title", async () => {
    const sidebar = makeSidebar("/repo");
    adapterSessions = [{
      sessionId: "codex-1",
      title: FAT_TITLE,
      cwd: "/repo",
      updatedAt: 1,
    }];
    await sidebar.refreshAdapterHistory("codex", "/repo");
    const stored = sidebar._memento[SESSION_META_KEY]["codex-1"];
    expect(stored.autoName).toBe(capAutoName(FAT_TITLE));
    expect(stored.autoName.length).toBeLessThanOrEqual(AUTO_NAME_MAX_CHARS);
    expect(stored.provider).toBe("codex");
  });
});
