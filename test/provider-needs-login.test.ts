/**
 * A signed-out agent must SAY it is signed out.
 *
 * Deleting `~/.codex/auth.json` used to produce two symptoms and no diagnosis:
 * the model picker showed a bare "Codex default" row, and history came back
 * empty. Both are auth-shaped failures (-32000) that the background probes
 * caught and logged. These drive the two probes through their real entry points
 * — a gear re-check and a remote history request — and assert the account state
 * changes rather than the surfaces degrading quietly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { projectProviderKey } from "../src/provider-ui";
import { warmCodexModelCache } from "../src/codex-model-cache";

const probe = vi.hoisted(() => ({ error: new Error("Sign in required") }));

vi.mock("../src/codex-model-cache", () => ({
  warmCodexModelCache: vi.fn(async () => { throw probe.error; }),
}));

vi.mock("../src/acp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/acp")>();
  class ListRefusingAcpClient {
    constructor(readonly options: unknown) {}
    async start(): Promise<void> {}
    async listSessions(): Promise<never> { throw probe.error; }
    async dispose(): Promise<void> {}
  }
  return { ...actual, AcpClient: ListRefusingAcpClient };
});

function makeSidebar(cwd = "/repo"): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerConnectionState = { grok: false, codex: true };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.locatedProviders = vi.fn(() => ({ grok: false, codex: true }));
  sidebar.connectedProviders = vi.fn(() => ["codex"]);
  sidebar.locateProvider = vi.fn(() => "codex");
  sidebar.providerNeedsLogin = {};
  sidebar.loginReprobeTimers = new Map();
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "codex";
  sidebar.focused.cwd = cwd;
  sidebar.codexSessionCache = new Map();
  sidebar.codexSessionCacheAt = new Map();
  sidebar.codexSessionRefresh = new Map();
  sidebar.state = { get: vi.fn((_key: string, fallback: unknown) => fallback), update: vi.fn(async () => {}) };
  sidebar.host = {
    appendLine: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() })),
    workspaceRoot: () => cwd,
    getConfiguration: vi.fn(() => ({ get: (_k: string, d: unknown) => d })),
  };
  sidebar.postProviderState = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.sendRemoteClient = vi.fn();
  sidebar.dotForId = vi.fn(() => "none");
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.setProviderConnected = vi.fn(async () => {});
  sidebar.rememberProjectProvider = vi.fn(async () => {});
  sidebar.startSession = vi.fn(async () => {});
  // A successful re-check now announces itself, so the re-check path reaches
  // emit. The real one builds a remote snapshot and wants state this partial
  // stub does not carry.
  sidebar.emit = vi.fn();
  sidebar.postSessionModels = vi.fn();
  return sidebar;
}

/** Onboarding states this sidebar emitted, in order. */
function onboardingStates(sidebar: any): string[] {
  return sidebar.emit.mock.calls
    .map(([, msg]: [unknown, any]) => (msg?.type === "onboarding" ? msg.state : undefined))
    .filter(Boolean);
}

function codexState(sidebar: any) {
  return sidebar.providerStateMessage().providers.find((provider: any) => provider.id === "codex");
}

describe("an agent that will not authenticate", () => {
  beforeEach(() => {
    probe.error = new Error("Sign in required");
  });

  it("a real re-check classifies Codex's uncoded sign-in-required warm-up failure", async () => {
    const sidebar = makeSidebar();

    await sidebar.onMessage({ type: "recheckConnection", provider: "codex" }, "local");

    expect(codexState(sidebar)).toMatchObject({ id: "codex", connected: true, needsLogin: true });
    // The account stays connected: hiding the agent would take every
    // conversation it owns off the list for a fault a sign-in fixes.
    expect(sidebar.connectedProviders()).toContain("codex");
    expect(sidebar.postProviderState).toHaveBeenCalled();
  });

  it("an explicit re-check bypasses listing freshness and clears needs-login after sign-in", async () => {
    const sidebar = makeSidebar();
    sidebar.providerNeedsLogin = { codex: true };
    sidebar.codexSessionCacheAt.set(projectProviderKey("/repo"), Date.now());
    vi.mocked(warmCodexModelCache).mockResolvedValueOnce(undefined as never);

    await sidebar.onMessage({ type: "recheckConnection", provider: "codex" }, "local");

    expect(warmCodexModelCache).toHaveBeenCalled();
    expect(codexState(sidebar).needsLogin).toBeUndefined();
    expect(sidebar.codexSessionCacheAt.has(projectProviderKey("/repo"))).toBe(false);
    // Say it worked. A re-check that succeeds and shows nothing is
    // indistinguishable from one that did nothing.
    expect(onboardingStates(sidebar)).toContain("provider-connected");
  });

  it("stays quiet when the re-check did not actually connect anything", async () => {
    const sidebar = makeSidebar();
    // probe.error is set in beforeEach, so the warm-up fails and Codex is still
    // unusable afterwards. Announcing success here would be a lie, and the
    // confirmation is the one place it would be believed.
    await sidebar.onMessage({ type: "recheckConnection", provider: "codex" }, "local");

    expect(codexState(sidebar).needsLogin).toBe(true);
    expect(onboardingStates(sidebar)).not.toContain("provider-connected");
  });

  it("does not mark Codex needs-login for an unauthorized-model warm-up failure", async () => {
    const sidebar = makeSidebar();
    probe.error = new Error("unauthorized model for project");

    await sidebar.onMessage({ type: "recheckConnection", provider: "codex" }, "local");

    expect(codexState(sidebar).needsLogin).toBeUndefined();
  });

  it("the sign-in action keeps probing until the completed login is observable", async () => {
    vi.useFakeTimers();
    try {
      const sidebar = makeSidebar();
      sidebar.reprobeProviderCredentials = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await sidebar.onMessage({ type: "runGrokLogin", provider: "grok" }, "local");
      await Promise.resolve();
      expect(sidebar.reprobeProviderCredentials).toHaveBeenCalledTimes(1);
      expect(sidebar.reprobeProviderCredentials).toHaveBeenLastCalledWith("grok");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(sidebar.reprobeProviderCredentials).toHaveBeenCalledTimes(2);
      expect(sidebar.loginReprobeTimers.has("grok")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a real remote history request classifies the uncoded Codex failure, not an empty list", async () => {
    const sidebar = makeSidebar();
    sidebar.remoteTargetableCwd = vi.fn(() => true);
    sidebar.authorizedSessionCwds = vi.fn(() => ["/repo"]);
    sidebar.isAuthorizedCwd = vi.fn(() => true);
    sidebar.remoteClients.ready("phone");
    const session = new Session();
    session.provider = "codex";
    session.cwd = "/repo";
    sidebar.remoteClients.setActive("phone", session);

    sidebar.installTestHooks().fromRemote({ type: "listSessions", offset: 0, query: "" }, "phone");
    await sidebar.codexSessionRefresh.get(projectProviderKey("/repo"));

    expect(codexState(sidebar)).toMatchObject({ needsLogin: true });
    expect(sidebar.codexSessionCache.get(projectProviderKey("/repo"))).toBeUndefined();
    // Backed off, so the repaint this state change causes cannot re-list in a loop.
    expect(sidebar.codexSessionCacheAt.get(projectProviderKey("/repo"))).toBeGreaterThan(0);
  });

  it("leaves an account alone when the failure is billing rather than credentials", async () => {
    const sidebar = makeSidebar();
    sidebar.remoteTargetableCwd = vi.fn(() => true);
    sidebar.authorizedSessionCwds = vi.fn(() => ["/repo"]);
    sidebar.isAuthorizedCwd = vi.fn(() => true);
    sidebar.remoteClients.ready("phone");
    const session = new Session();
    session.provider = "codex";
    session.cwd = "/repo";
    sidebar.remoteClients.setActive("phone", session);
    sidebar.refreshCodexHistory = vi.fn(async () => {
      throw new Error("Your subscription does not include this model");
    });

    sidebar.installTestHooks().fromRemote({ type: "listSessions", offset: 0, query: "" }, "phone");
    await sidebar.codexSessionRefresh.get(projectProviderKey("/repo"));

    // A login screen cannot fix an entitlement problem (#58), so the account
    // must not be labelled signed-out.
    expect(codexState(sidebar).needsLogin).toBeUndefined();
  });

  it("does not mark Codex needs-login for an unauthorized-model history failure", async () => {
    const sidebar = makeSidebar();
    probe.error = new Error("unauthorized model for project");
    sidebar.remoteTargetableCwd = vi.fn(() => true);
    sidebar.authorizedSessionCwds = vi.fn(() => ["/repo"]);
    sidebar.isAuthorizedCwd = vi.fn(() => true);
    sidebar.remoteClients.ready("phone");
    const session = new Session();
    session.provider = "codex";
    session.cwd = "/repo";
    sidebar.remoteClients.setActive("phone", session);

    sidebar.installTestHooks().fromRemote({ type: "listSessions", offset: 0, query: "" }, "phone");
    await sidebar.codexSessionRefresh.get(projectProviderKey("/repo"));

    expect(codexState(sidebar).needsLogin).toBeUndefined();
  });
});

describe("remote account boundary", () => {
  it("drops durable re-check but allows retrying an already-connected provider session", async () => {
    const sidebar = makeSidebar();
    sidebar.remoteTargetableCwd = vi.fn(() => true);
    sidebar.authorizedSessionCwds = vi.fn(() => ["/repo"]);
    sidebar.isAuthorizedCwd = vi.fn(() => true);
    sidebar.remoteClients.ready("phone");
    const session = new Session();
    session.provider = "codex";
    session.cwd = "/repo";
    sidebar.remoteClients.setActive("phone", session);

    sidebar.installTestHooks().fromRemote({ type: "recheckConnection", provider: "codex" }, "phone");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sidebar.setProviderConnected).not.toHaveBeenCalled();

    sidebar.installTestHooks().fromRemote({ type: "retryProviderSession", provider: "codex" }, "phone");
    await vi.waitFor(() => expect(sidebar.startSession).toHaveBeenCalledWith(undefined, session));
    expect(sidebar.setProviderConnected).not.toHaveBeenCalled();
  });
});
