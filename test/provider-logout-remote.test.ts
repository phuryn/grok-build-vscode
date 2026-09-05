import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";

function makeSidebar(update: () => Promise<void> = async () => {}): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.cliPath = "grok";
  sidebar.locateProvider = vi.fn((provider: "grok" | "codex") => provider);
  sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: true }));
  sidebar.providerConnectionState = { grok: true, codex: true };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.remoteClients = new RemoteClientState<Session>("/repo");
  // Signing out now deletes the empty shells it replaces, and this harness has
  // no session store — nor any business touching a real ~/.grok.
  sidebar.sessionCache = new Map();
  sidebar.removeSessionFromDisk = vi.fn();
  sidebar.discardAdapterEmptySession = vi.fn(async () => {});
  // A real instance has this from its field initialiser; signing out clears the
  // provider's preflight latch so the next sign-in starts at step 1 again.
  sidebar.deviceLoginPreflightShown = new Set<string>();
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "codex";
  sidebar.focused.cwd = "/repo";
  let sessionMeta: Record<string, unknown> = {};
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) => (key === "grok.sessionMeta" ? sessionMeta : fallback)),
    update: vi.fn((key: string, value: unknown) => {
      if (key === "grok.sessionMeta") sessionMeta = value as Record<string, unknown>;
      return update();
    }),
  };
  sidebar.host = {
    showWarningMessage: vi.fn(async () => "Sign Out"),
    showErrorMessage: vi.fn(async () => undefined),
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
    appendLine: vi.fn(),
  };
  sidebar.post = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.dotForId = vi.fn(() => "none");
  sidebar.dropRemoteVoice = vi.fn();
  sidebar.connectedProviders = vi.fn(() => ["codex"]);
  sidebar.defaultProviderForProject = vi.fn(() => "codex");
  sidebar.workspaceRoot = vi.fn(() => "/repo");
  sidebar.authorizedSessionCwds = vi.fn(() => ["/repo", "/project-a", "/project-b"]);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || "/repo");
  sidebar.setSessionCwd = vi.fn((session: Session, cwd: string) => { session.cwd = cwd; });
  sidebar.startSession = vi.fn(async () => ({}));
  sidebar.persistWorktreeBinding = vi.fn(async () => {});
  sidebar.sweepEmptySessions = vi.fn();
  sidebar.sendRemoteSessionList = vi.fn();
  sidebar.sendRemoteClient = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.emit = vi.fn();
  return sidebar;
}

function logoutFromRealCommand(sidebar: any): Promise<void> {
  return sidebar.onMessage({ type: "logout", provider: "grok" }, "local");
}

describe("provider logout real-entry wiring", () => {
  it("provider logout command resets its remote tab and leaves the other provider untouched", async () => {
    const sidebar = makeSidebar();
    const grok = new Session();
    grok.provider = "grok";
    grok.status = "working";
    grok.activeSessionId = "grok-session";
    grok.turnToken = {};
    grok.client = { dispose: vi.fn() } as any;
    const codex = sidebar.focused as Session;
    codex.activeSessionId = "codex-session";
    codex.client = { dispose: vi.fn() } as any;
    sidebar.remoteClients.ready("grok-tab");
    sidebar.remoteClients.setActive("grok-tab", grok);
    sidebar.pool = new Set([grok, codex]);
    const sent: HostMsg[] = [];
    sidebar.sendRemoteClient = vi.fn((_clientId: string, message: HostMsg) => sent.push(message));
    sidebar.emit = vi.fn((_session: Session, message: HostMsg) => sent.push(message));
    sidebar.startSession = vi.fn(async (_id: undefined, session: Session) => {
      session.activeSessionId = "fresh-codex-session";
    });

    await logoutFromRealCommand(sidebar);

    expect(grok.client).toBeUndefined();
    expect(grok.turnToken).toBeUndefined();
    expect(sidebar.remoteClients.active("grok-tab")).toMatchObject({
      provider: "codex",
      activeSessionId: "fresh-codex-session",
    });
    expect(sent).toContainEqual({
      type: "error",
      text: "Grok was signed out, so that conversation ended. This tab has been reset to a fresh session.",
    });
    expect(sidebar.focused).toBe(codex);
    expect(codex.client).toBeDefined();
  });

  it("provider logout command detaches sessions before a slow connection-state write settles", async () => {
    let release!: () => void;
    const slowWrite = new Promise<void>((resolve) => { release = resolve; });
    const sidebar = makeSidebar(() => slowWrite);
    const focused = new Session();
    focused.provider = "grok";
    focused.cwd = "/repo";
    focused.client = { dispose: vi.fn(), prompt: vi.fn() } as any;
    sidebar.focused = focused;
    sidebar.pool.add(focused);

    const logout = logoutFromRealCommand(sidebar);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sidebar.state.update).toHaveBeenCalled();
    expect(focused.client).toBeUndefined();
    expect(sidebar.focused).not.toBe(focused);
    expect(sidebar.focused.provider).toBe("codex");
    release();
    await logout;
  });

  it("provider logout command keeps sessions detached and reports a rejected connection-state write", async () => {
    const sidebar = makeSidebar(async () => { throw new Error("memento unavailable"); });
    const focused = new Session();
    focused.provider = "grok";
    focused.cwd = "/repo";
    focused.client = { dispose: vi.fn(), prompt: vi.fn() } as any;
    sidebar.focused = focused;
    sidebar.pool.add(focused);

    await logoutFromRealCommand(sidebar);

    expect(focused.client).toBeUndefined();
    expect(sidebar.focused.provider).toBe("codex");
    expect(sidebar.host.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("conversations were reset"),
    );
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("memento unavailable"),
    );
  });

  it("provider logout command restores focused local and remote queued drafts before replacement startup", async () => {
    const sidebar = makeSidebar();
    const focused = new Session();
    focused.provider = "grok";
    focused.cwd = "/repo";
    focused.client = { dispose: vi.fn() } as any;
    focused.queuedSends = [{ text: "queued before sign-out", chips: [] }];
    const remote = new Session();
    remote.provider = "grok";
    remote.cwd = "/repo";
    remote.client = { dispose: vi.fn() } as any;
    remote.queuedSends = [{ text: "remote queued before sign-out", chips: [] }];
    sidebar.focused = focused;
    sidebar.pool = new Set([focused, remote]);
    sidebar.remoteClients.ready("grok-tab");
    sidebar.remoteClients.setActive("grok-tab", remote);
    const events: string[] = [];
    sidebar.emit = vi.fn((session: Session, message: HostMsg) => {
      if (message.type === "restoreComposer") {
        events.push(`${session === sidebar.focused ? "local" : "remote"}-restore:${message.text}`);
      }
    });
    sidebar.startSession = vi.fn(async (_id: undefined, replacement: Session) => {
      expect(focused.client).toBeUndefined();
      expect(remote.client).toBeUndefined();
      events.push(replacement === sidebar.focused ? "local-started" : "remote-started");
      return {};
    });

    await logoutFromRealCommand(sidebar);

    expect(events).toEqual([
      "local-started",
      "local-restore:queued before sign-out",
      "remote-started",
      "remote-restore:remote queued before sign-out",
    ]);
  });

  it("provider logout command names a background conversation's draft without quoting it", async () => {
    const sidebar = makeSidebar();
    const background = new Session();
    background.provider = "grok";
    background.cwd = "/repo";
    background.activeSessionId = "background-grok";
    background.hasHistory = true;
    background.client = { dispose: vi.fn() } as any;
    background.queuedSends = [{ text: "keep this background draft", chips: [] }];
    sidebar.pool.add(background);
    sidebar.sessionDisplayName = vi.fn((session: Session) =>
      session === background ? "Background investigation" : "Codex session"
    );
    const local: HostMsg[] = [];
    sidebar.view = { webview: { postMessage: (message: HostMsg) => local.push(message) } };
    sidebar.localizeHistoryMessage = (message: HostMsg) => message;
    delete sidebar.post; // exercise the real fan-out, not a stub

    await logoutFromRealCommand(sidebar);

    expect(background.client).toBeUndefined();
    const notice = local.find((message) =>
      message.type === "error" && message.text.includes("Background investigation"));
    expect(notice).toBeDefined();
    expect(JSON.stringify(notice)).not.toContain("keep this background draft");
    expect(sidebar.state.get("grok.sessionMeta", {})["background-grok"]).toMatchObject({
      queuedDraft: "keep this background draft",
    });
  });

  it("other-provider reconnect restores a detached logical tab draft only when its composer returns", async () => {
    vi.useFakeTimers();
    try {
      const sidebar = makeSidebar();
      const detached = new Session();
      detached.provider = "grok";
      detached.cwd = "/repo";
      detached.activeSessionId = "detached-grok";
      detached.hasHistory = true;
      detached.client = { dispose: vi.fn() } as any;
      detached.queuedSends = [{ text: "draft from disconnected phone", chips: [] }];
      sidebar.pool.add(detached);
      sidebar.remoteClients.identify("old-socket", "stable-tab");
      sidebar.remoteClients.ready("old-socket");
      sidebar.remoteClients.setActive("old-socket", detached);
      sidebar.sessionDisplayName = vi.fn((session: Session) =>
        session === detached ? "Phone conversation" : "Fresh conversation"
      );
      sidebar.installTestHooks().remoteClientLeft("old-socket");

      await logoutFromRealCommand(sidebar);

      sidebar.authorizedSessionCwds = vi.fn(() => ["/repo"]);
      sidebar.localRepoCatalogEntries = vi.fn(() => []);
      sidebar.buildInitialStateMsg = vi.fn(() => ({ type: "initialState", cwd: "/repo" }));
      sidebar.providerStateMessage = vi.fn(() => ({ type: "providerState", providers: [] }));
      sidebar.buildRemoteReposMsg = vi.fn(() => ({ type: "repos", entries: [] }));
      sidebar.buildSessionsList = vi.fn(() => ({
        type: "sessions", entries: [], activeId: null, dots: {}, offset: 0,
        total: 0, hasMore: false, nextOffset: 0, query: "",
      }));
      sidebar.voiceSetting = vi.fn(() => "send");
      sidebar.resolveVoiceApiKey = vi.fn(() => undefined);
      sidebar.remoteVoice = new Map();
      sidebar.startingForRemote = new WeakSet();
      const sent: HostMsg[] = [];
      sidebar.sendRemoteClient = vi.fn((_clientId: string, message: HostMsg) => sent.push(message));
      const restored: HostMsg[] = [];
      sidebar.emit = vi.fn((_session: Session, message: HostMsg) => {
        if (message.type === "restoreComposer") restored.push(message);
      });

      sidebar.installTestHooks().fromRemote({ type: "ready", tabToken: "stable-tab" }, "new-socket");
      await vi.runAllTimersAsync();
      await sidebar.sessionMetaWrites;

      const replacement = sidebar.remoteClients.active("new-socket") as Session;
      expect(replacement).not.toBe(detached);
      expect(replacement.provider).toBe("codex");
      expect(replacement.buffer.some((message) => message.type === "error")).toBe(false);
      expect(restored).toContainEqual({
        type: "restoreComposer",
        text: "draft from disconnected phone",
      });
      expect((sidebar.state.get("grok.sessionMeta", {})["detached-grok"] as any).queuedDraft)
        .toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("provider logout command roots the replacement in focused B while history browses A", async () => {
    const sidebar = makeSidebar();
    sidebar.selectedRepoCwd = "/project-a";
    const focused = new Session();
    focused.provider = "grok";
    focused.cwd = "/project-b";
    focused.client = { dispose: vi.fn() } as any;
    focused.queuedSends = [{ text: "B-only draft", chips: [] }];
    sidebar.focused = focused;
    sidebar.pool.add(focused);
    const restored: Array<{ cwd: string; text: string }> = [];
    sidebar.emit = vi.fn((session: Session, message: HostMsg) => {
      if (message.type === "restoreComposer") restored.push({ cwd: session.cwd!, text: message.text });
    });

    await logoutFromRealCommand(sidebar);

    expect(sidebar.focused.cwd).toBe("/project-b");
    expect(sidebar.focused.cwd).not.toBe("/project-a");
    expect(restored).toEqual([{ cwd: "/project-b", text: "B-only draft" }]);
  });
});
