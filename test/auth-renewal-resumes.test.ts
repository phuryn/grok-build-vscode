/**
 * What signing in actually has to achieve.
 *
 * The card above the composer (2026-09-14) says replies are refused until the
 * account is renewed, which promises that renewing it un-refuses them. Two
 * things stood between the promise and the outcome, and both are about the
 * difference between CONNECTING an account and RENEWING one — an errand the
 * login path had no concept of, because until the card existed nobody signed in
 * from inside a conversation that was failing.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function sidebarWith(sessions: Session[], needsLogin: Record<string, boolean>) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerNeedsLogin = needsLogin;
  sidebar.focused = sessions[0];
  sidebar.pool = new Set(sessions);
  sidebar.remoteClients = { detachedActiveValues: () => [] };
  sidebar.postProviderState = vi.fn();
  sidebar.invalidateSubscriptionUsage = vi.fn();
  sidebar.adapterHistory = vi.fn(() => undefined);
  return sidebar;
}

function spentSession(provider: "grok" | "claude" | "codex") {
  const session = new Session();
  session.provider = provider;
  session.activeSessionId = "s1";
  session.hasHistory = true;
  session.authRecoveryTried = true; // its one restart bought a dead process
  return session;
}

describe("an account that works again", () => {
  // Without this the conversation keeps a client built on the dead token
  // forever: `authRecoveryTried` survives a startSession on purpose, and only a
  // clean turn re-arms it — which a session that cannot complete a turn will
  // never have. The card would have sent someone through a sign-in that
  // changed nothing about the conversation it was offered on.
  it("lets the conversation try the token dance once more", () => {
    const session = spentSession("claude");
    const sidebar = sidebarWith([session], { claude: true });

    sidebar.setProviderNeedsLogin("claude", false);

    expect(session.authRecoveryTried).toBe(false);
  });

  it("says nothing to a conversation on a different agent", () => {
    const claude = spentSession("claude");
    const grok = spentSession("grok");
    const sidebar = sidebarWith([claude, grok], { claude: true });

    sidebar.setProviderNeedsLogin("claude", false);

    expect(claude.authRecoveryTried).toBe(false);
    expect(grok.authRecoveryTried).toBe(true);
  });

  // The flag going UP is the failure, not the fix.
  it("does not re-arm anything when the account is being flagged, not cleared", () => {
    const session = spentSession("claude");
    const sidebar = sidebarWith([session], { claude: false });

    sidebar.setProviderNeedsLogin("claude", true);

    expect(session.authRecoveryTried).toBe(true);
  });

  it("reaches a detached remote conversation, not only the focused one", () => {
    const focused = spentSession("grok");
    const detached = spentSession("claude");
    const sidebar = sidebarWith([focused], { claude: true });
    sidebar.remoteClients = { detachedActiveValues: () => [detached] };

    sidebar.setProviderNeedsLogin("claude", false);

    expect(detached.authRecoveryTried).toBe(false);
  });
});

/**
 * The desk half. `runGrokLogin` parks a conversation with history so the
 * provider's sign-in panel has somewhere to land — right for "connect an agent
 * for my next conversation", wrong for "renew the one refusing this one".
 */
function loginSidebar(needsLogin: Record<string, boolean>) {
  const session = new Session();
  session.provider = "claude";
  session.hasHistory = true;
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerNeedsLogin = needsLogin;
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.remoteClients = { detachedActiveValues: () => [], clients: () => [] };
  sidebar.locateProvider = vi.fn(() => "/usr/bin/claude");
  sidebar.workspaceRoot = vi.fn(() => "/repo");
  sidebar.host = { appendLine: vi.fn(), createTerminal: vi.fn(() => ({ show: vi.fn() })) };
  // Connect is where consent is stated, so the real setProviderConnected runs
  // here and needs somewhere to persist to (#171).
  sidebar.providerConnectionState = Object.fromEntries(Object.keys(needsLogin).map(provider => [provider, true]));
  sidebar.state = { get: (_key: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) };
  sidebar.postProviderState = vi.fn();
  sidebar.invalidateSubscriptionUsage = vi.fn();
  sidebar.adapterHistory = vi.fn(() => undefined);
  sidebar.newFocusedSession = vi.fn(async () => {});
  sidebar.post = vi.fn();
  sidebar.startDeviceLogin = vi.fn(async () => {});
  sidebar.probeProviderVersion = vi.fn(async () => undefined);
  sidebar.deviceLoginCredentialReady = vi.fn(async () => false);
  // Connect starts the terminal watcher, whose probe is a real model warm-up
  // that spawns the vendor's ACP adapter. A harness must never do that: on
  // macOS CI the spawn failed with ENOENT and escaped as an uncaught
  // exception while every test in the run passed. Tests about the ladder
  // itself replace this.
  sidebar.reprobeProviderCredentials = vi.fn(async () => false);
  return { sidebar, session };
}

describe("signing in from a conversation that is being refused", () => {
  it.each(["grok", "codex", "claude"])("keeps %s desk sign-in in its CLI terminal", async provider => {
    const { sidebar } = loginSidebar({ [provider]: true });
    await sidebar.onMessage({ type: "runGrokLogin", provider }, "local");
    expect(sidebar.host.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      shellArgs: provider === "claude" ? ["auth", "login"] : ["login"],
    }));
    expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
    expect(sidebar.deviceLoginCredentialReady).not.toHaveBeenCalled();
    expect(sidebar.post).toHaveBeenCalledWith(expect.objectContaining({ provider, launched: true }));
  });

  // Pressing Connect states CONSENT. It proves nothing about the credential,
  // and every surface reads `connected && !needsLogin` as a healthy account:
  // Settings clears the bar that finishes the terminal sign-in and turns the
  // button into Sign out, which runs the vendor logout and destroys the
  // credential the person came to create. An unsteered review found this on
  // the desk path, where it is the FIRST thing every user does after upgrading
  // (saved connections are cleared once, so everyone presses Connect again).
  it.each(["grok", "codex", "claude", "muse"])(
    "leaves %s awaiting its sign-in rather than reporting a healthy account",
    async provider => {
      const { sidebar } = loginSidebar({});
      const frames: Array<{ connected: boolean; needsLogin: boolean }> = [];
      sidebar.postProviderState = () => {
        frames.push({
          connected: sidebar.providerConnectionState[provider] === true,
          needsLogin: sidebar.providerNeedsLogin[provider] === true,
        });
      };

      await sidebar.onMessage({ type: "runGrokLogin", provider }, "local");

      expect(sidebar.providerConnectionState[provider]).toBe(true);
      expect(sidebar.providerNeedsLogin[provider]).toBe(true);
      // And the ORDER, which is where the first attempt at this failed: Settings
      // drops the Re-check bar on the first frame that reports a healthy account
      // and never restores it, so no such frame may ever be sent.
      expect(frames.filter(f => f.connected && !f.needsLogin)).toEqual([]);
      expect(frames.some(f => f.connected && f.needsLogin)).toBe(true);
      expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
      expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
      const panel = sidebar.post.mock.calls.at(-1)[0];
      expect(panel).toMatchObject({ type: "onboarding", provider,
        state: provider === "grok" ? "auth-required" : `${provider}-login` });
      expect(panel).not.toHaveProperty("launched");
    },
  );

  it("routes remote Muse sign-in to the shared device flow", async () => {
    const { sidebar, session } = loginSidebar({});
    sidebar.locateProvider.mockReturnValue("/usr/bin/muse");
    await sidebar.onMessage({ type: "runGrokLogin", provider: "muse" }, "remote");
    expect(sidebar.startDeviceLogin).toHaveBeenCalledWith("muse", "/usr/bin/muse", undefined);
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
  });

  it("routes explicit desk Muse sign-in through the device card", async () => {
    const { sidebar, session } = loginSidebar({ muse: true });
    sidebar.locateProvider.mockReturnValue("/usr/bin/muse");
    await sidebar.onMessage({ type: "runGrokLogin", provider: "muse" }, "local");
    expect(sidebar.startDeviceLogin).toHaveBeenCalledWith("muse", "/usr/bin/muse", undefined, { remote: false });
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    // The press itself is the consent, and it is recorded before the CLI runs.
    expect(sidebar.providerConnectionState.muse).toBe(true);
  });
  it("keeps that conversation instead of parking it for a panel", async () => {
    const { sidebar, session } = loginSidebar({ claude: true });

    await sidebar.onMessage({ type: "runGrokLogin", provider: "claude" }, session, "local");

    expect(sidebar.newFocusedSession).not.toHaveBeenCalled();
    expect(sidebar.host.createTerminal).toHaveBeenCalled(); // the flow still runs
  });

  // Unchanged for the errand it was written for: connecting a second account
  // must not drop its sign-in panel over a transcript.
  it("still starts a fresh session when the account is merely being connected", async () => {
    const { sidebar, session } = loginSidebar({});

    await sidebar.onMessage({ type: "runGrokLogin", provider: "claude" }, session, "local");

    expect(sidebar.newFocusedSession).toHaveBeenCalled();
  });
});

/**
 * The desk terminal is the ONLY sign-in path with no completion signal of its
 * own, and 4.11.1 briefly took away the one thing that watched it.
 *
 * #171 stopped the extension running an agent nobody had connected, and the
 * brief that drove it called this ladder "speculative polling". It is not: it
 * starts one line after consent is recorded, from the Connect press itself.
 * Removing it meant a finished `grok login` / `codex login` / `claude auth
 * login` was noticed by nothing, so the account sat unconnected until Re-check
 * was pressed by hand — on the owner's desk, for all three agents.
 *
 * Cloud and Muse never showed it, and that is exactly why no suite caught it:
 * both go through `startDeviceLogin`, which verifies its own credential. A
 * test that drives the device flow proves nothing about the terminal one.
 */
describe("a desk terminal sign-in finishes without being asked twice", () => {
  it.each(["grok", "codex", "claude"])("re-probes %s after the terminal opens", async provider => {
    const { sidebar } = loginSidebar({ [provider]: true });
    sidebar.reprobeProviderCredentials = vi.fn(async () => true);

    await sidebar.onMessage({ type: "runGrokLogin", provider }, "local");
    await Promise.resolve();

    expect(sidebar.host.createTerminal).toHaveBeenCalled();
    expect(sidebar.reprobeProviderCredentials).toHaveBeenCalledWith(provider);
  });

  // The ladder must not outlive the consent that authorised it: disconnecting
  // between two rungs is a withdrawal, and #171 is the reason the guard is
  // inside `attempt` rather than only at the call site.
  it("stops probing an agent that was disconnected mid-ladder", async () => {
    const { sidebar } = loginSidebar({});
    sidebar.reprobeProviderCredentials = vi.fn(async () => true);

    sidebar.providerConnectionState = {};
    sidebar.watchProviderLogin("codex");
    await Promise.resolve();

    expect(sidebar.reprobeProviderCredentials).not.toHaveBeenCalled();
  });
});

describe("Connect adopts the CLI's existing sign-in", () => {
  it.each(["grok", "codex", "claude", "muse"])("adopts %s only after consent and credential proof", async provider => {
    const { sidebar, session } = loginSidebar({});
    session.provider = provider as Session["provider"];
    session.hasHistory = false;
    const frames: Array<{ connected: boolean; needsLogin: boolean }> = [];
    sidebar.postProviderState = () => frames.push({
      connected: sidebar.hasProviderConsent(provider), needsLogin: !!sidebar.providerNeedsLogin[provider],
    });
    sidebar.deviceLoginCredentialReady = vi.fn(async () => {
      expect(sidebar.hasProviderConsent(provider)).toBe(true);
      expect(sidebar.providerNeedsLogin[provider]).toBe(true);
      expect(sidebar.state.update).toHaveBeenCalledWith("grok.providerConnections.v2", { [provider]: true });
      expect(frames.filter(f => f.connected && !f.needsLogin)).toEqual([]);
      return true;
    });
    // Drive the same adoption path as Re-check, including its confirmation.
    sidebar.retargetNeedsProviderSessions = vi.fn(async () => new Set());
    sidebar.usableProviders = () => sidebar.providerNeedsLogin[provider] ? [] : [provider];
    sidebar.startSession = vi.fn(async () => {});
    sidebar.postSessionsList = vi.fn();
    sidebar.emit = vi.fn();

    await sidebar.onMessage({ type: "runGrokLogin", provider }, session, "local");

    expect(sidebar.deviceLoginCredentialReady).toHaveBeenCalledWith(provider, true);
    expect(sidebar.providerNeedsLogin[provider]).toBe(false);
    expect(sidebar.startSession).toHaveBeenCalledWith(undefined, session);
    expect(sidebar.emit).toHaveBeenCalledWith(session, expect.objectContaining({ state: "provider-connected", provider }));
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
    expect(sidebar.post.mock.calls.some(([m]: any[]) => m.launched)).toBe(false);
  });

  it.each(["grok", "codex", "claude", "muse"])("offers explicit %s sign-in when checking throws", async provider => {
    const { sidebar } = loginSidebar({});
    sidebar.deviceLoginCredentialReady.mockRejectedValue(new Error("Cannot check"));
    await sidebar.onMessage({ type: "runGrokLogin", provider }, "local");
    expect(sidebar.providerNeedsLogin[provider]).toBe(true);
    expect(sidebar.post.mock.calls.at(-1)[0]).not.toHaveProperty("launched");
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
  });

  it.each(["grok", "codex", "claude", "muse"])("ignores a late %s check after disconnect, even after reconnect", async provider => {
    const { sidebar } = loginSidebar({});
    let finish!: (ready: boolean) => void;
    sidebar.deviceLoginCredentialReady.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = sidebar.onMessage({ type: "runGrokLogin", provider }, "local");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const signal = sidebar.providerRunSignal(provider);
    sidebar.disposeAdapterHistoryClient = vi.fn(async () => {});
    sidebar.setProviderConnectedInMemory(provider, false);
    expect(signal.aborted).toBe(true);
    sidebar.setProviderConnectedInMemory(provider, true);
    finish(true);
    await pending;
    expect(sidebar.providerNeedsLogin[provider]).toBe(true);
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
    expect(sidebar.post).not.toHaveBeenCalled();
  });

  // The ORDER rule publishes needs-login before the check answers. Painted as
  // connected, that frame drew "needs you to sign in again" over an account
  // that was signed in all along, and its Sign in button fell through to the
  // login terminal mid-check (independent review, round 1).
  it.each(["grok", "codex", "claude", "muse"])(
    "keeps %s reading as not connected, and ignores a second press, until its check answers",
    async provider => {
      const { sidebar } = loginSidebar({});
      sidebar.locatedProviders = () => ({ grok: true, codex: true, claude: true, muse: true });
      sidebar.providerCliVersions = {};
      const frames: any[] = [];
      sidebar.postProviderState = () => {
        const message = GrokSidebar.prototype["providerStateMessage"].call(sidebar);
        frames.push({ ...message.providers.find((p: any) => p.id === provider), checking: message.checking === true });
      };
      sidebar.adoptSessionsForConnectedProvider = vi.fn(async () => {});
      let finish!: (ready: boolean) => void;
      sidebar.deviceLoginCredentialReady = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));

      const first = sidebar.onMessage({ type: "runGrokLogin", provider }, "local");
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every(f => f.connected === false && f.checking)).toBe(true);

      await sidebar.onMessage({ type: "runGrokLogin", provider }, "local");
      expect(sidebar.deviceLoginCredentialReady).toHaveBeenCalledTimes(1);
      expect(sidebar.host.createTerminal).not.toHaveBeenCalled();

      finish(true);
      await first;
      expect(frames.some(f => f.connected && f.needsLogin)).toBe(false);
      expect(frames.at(-1)).toMatchObject({ connected: true, checking: false });
      expect(frames.at(-1)).not.toHaveProperty("needsLogin");
      expect(sidebar.adoptSessionsForConnectedProvider).toHaveBeenCalledTimes(1);
      expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    },
  );

  it.each(["grok", "codex", "claude", "muse"])("leaves remote %s Connect on the device flow", async provider => {
    const { sidebar } = loginSidebar({});
    await sidebar.onMessage({ type: "runGrokLogin", provider }, "remote");
    expect(sidebar.startDeviceLogin).toHaveBeenCalledWith(provider, "/usr/bin/claude", undefined);
    expect(sidebar.deviceLoginCredentialReady).not.toHaveBeenCalled();
  });
});
