/**
 * #203: Settings → Providers must not sign the user out of the agent CLI
 * itself. At a desk the account button DISCONNECTS — consent off, the
 * provider's conversations reset — and leaves the CLI signed in for the next
 * Connect to adopt. A cloud environment, and `Grok: Log Out`, still clear the
 * CLI's credentials.
 *
 * Driven through `onMessage`, the entry every surface's button reaches.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";

type Provider = "grok" | "codex" | "claude";

function makeSidebar(connected: Provider[]): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.memento = memento;
  sidebar.pendingConfirms = new Map();
  sidebar.providerConnectionState = Object.fromEntries(connected.map((id) => [id, true]));
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.locateProvider = vi.fn((provider: Provider) => `/bin/${provider}`);
  sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: true, claude: true }));
  sidebar.remoteClients = new RemoteClientState<Session>("/repo");
  sidebar.sessionCache = new Map();
  for (const id of ["codex", "claude"]) {
    sidebar[`${id}SessionCache`] = new Map();
  }
  sidebar.disposeAdapterHistoryClient = vi.fn(async () => {});
  sidebar.removeSessionFromDisk = vi.fn();
  sidebar.discardAdapterEmptySession = vi.fn(async () => {});
  sidebar.deviceLoginPreflightShown = new Set<string>();
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = connected[0] ?? "grok";
  sidebar.focused.cwd = "/repo";
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) =>
      (Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback)),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showQuickPick: vi.fn(async () => undefined),
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
    appendLine: vi.fn(),
  };
  sidebar.execProviderCli = vi.fn(async () => ({ stdout: "", stderr: "" }));
  sidebar.post = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.dotForId = vi.fn(() => "none");
  sidebar.dropRemoteVoice = vi.fn();
  sidebar.connectedProviders = vi.fn(() =>
    (["grok", "codex", "claude"] as Provider[]).filter((id) => sidebar.providerConnectionState[id] === true));
  sidebar.defaultProviderForProject = vi.fn(() => sidebar.connectedProviders()[0] ?? "grok");
  sidebar.workspaceRoot = vi.fn(() => "/repo");
  sidebar.authorizedSessionCwds = vi.fn(() => ["/repo"]);
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

function pressAccountButton(sidebar: any, provider: Provider): Promise<void> {
  return sidebar.onMessage({ type: "logout", provider }, "local");
}

const CONSENT_KEY = "grok.providerConnections.v2";

afterEach(() => vi.unstubAllEnvs());

describe("Settings → Providers at a desk disconnects (#203)", () => {
  it.each(["codex", "claude", "grok"] as const)("leaves the %s CLI signed in and turns consent off", async (provider) => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const sidebar = makeSidebar([provider, ...(provider === "grok" ? [] : ["grok" as const])]);

    await pressAccountButton(sidebar, provider);

    expect(sidebar.execProviderCli).not.toHaveBeenCalled();
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    // Nothing is lost that Connect does not bring back, so nothing is asked.
    expect(sidebar.host.showWarningMessage).not.toHaveBeenCalled();
    expect(sidebar.providerConnectionState[provider]).toBe(false);
    expect((sidebar.memento[CONSENT_KEY] as Record<string, boolean>)[provider]).toBe(false);
  });

  it("asks only when a reply is running, and a No changes nothing", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const sidebar = makeSidebar(["codex"]);
    const working = sidebar.focused as Session;
    working.provider = "codex";
    working.status = "working";
    working.turnToken = {};
    const client = { setHumanWaitActive: vi.fn(), dispose: vi.fn() };
    working.client = client as any;

    await pressAccountButton(sidebar, "codex");

    expect(sidebar.host.showWarningMessage).toHaveBeenCalledWith(
      "Disconnect Codex? A reply in progress will stop. The Codex CLI stays signed in.",
      { modal: true },
      "Disconnect",
    );
    expect(sidebar.providerConnectionState.codex).toBe(true);
    expect(working.client).toBe(client);
    expect(sidebar.execProviderCli).not.toHaveBeenCalled();

    sidebar.host.showWarningMessage = vi.fn(async () => "Disconnect");
    await pressAccountButton(sidebar, "codex");
    expect(sidebar.providerConnectionState.codex).toBe(false);
    expect(working.client).toBeUndefined();
    expect(sidebar.execProviderCli).not.toHaveBeenCalled();
  });

  it("tells every surface its button disconnects", () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const sidebar = makeSidebar(["codex"]);
    const { providers } = sidebar.providerStateMessage();
    expect(providers.map((p: { keepsCliSignIn?: boolean }) => p.keepsCliSignIn)).toEqual([true, true, true, true, true, true]);
  });
});

describe("a cloud environment still signs the CLI out (#203)", () => {
  it("runs the vendor logout before resetting, without a modal nobody can answer", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const sidebar = makeSidebar(["codex"]);

    await sidebar.onMessage({ type: "logout", provider: "codex" }, "remote");

    expect(sidebar.execProviderCli).toHaveBeenCalledWith("codex", "/bin/codex", ["logout"], expect.any(Object));
    expect(sidebar.host.showWarningMessage).not.toHaveBeenCalled();
    expect(sidebar.providerConnectionState.codex).toBe(false);
  });

  it("keeps the Sign out label by sending no disconnect flag", () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const sidebar = makeSidebar(["codex"]);
    const { providers } = sidebar.providerStateMessage();
    expect(providers.some((p: { keepsCliSignIn?: boolean }) => "keepsCliSignIn" in p)).toBe(false);
  });
});

describe("Grok: Log Out stays a real CLI sign-out at a desk (#203)", () => {
  it("signs Grok out of its CLI when Grok is the only agent, as it always did", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const sidebar = makeSidebar(["grok"]);
    sidebar.host.showWarningMessage = vi.fn(async () => "Sign Out");

    await sidebar.signOutAgentCli();

    expect(sidebar.host.showQuickPick).not.toHaveBeenCalled();
    expect(sidebar.host.showWarningMessage).toHaveBeenCalledWith(
      "Sign out of Grok? This clears the CLI's cached credentials.", { modal: true }, "Sign Out");
    expect(sidebar.host.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ shellPath: "/bin/grok", shellArgs: ["logout"] }));
    expect(sidebar.providerConnectionState.grok).toBe(false);
  });

  it("offers each connected agent and clears the chosen CLI's credentials", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const sidebar = makeSidebar(["grok", "codex"]);
    sidebar.host.showWarningMessage = vi.fn(async () => "Sign Out");
    sidebar.host.showQuickPick = vi.fn(async (items: { id: string }[]) => items.find((item) => item.id === "codex"));

    await sidebar.signOutAgentCli();

    expect(sidebar.host.showQuickPick.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual(["grok", "codex"]);
    expect(sidebar.execProviderCli).toHaveBeenCalledWith("codex", "/bin/codex", ["logout"], expect.any(Object));
    expect(sidebar.providerConnectionState.codex).toBe(false);
    expect(sidebar.providerConnectionState.grok).toBe(true);
  });

  it("does nothing when the pick is dismissed", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const sidebar = makeSidebar(["grok", "claude"]);

    await sidebar.signOutAgentCli();

    expect(sidebar.execProviderCli).not.toHaveBeenCalled();
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    expect(sidebar.providerConnectionState).toEqual({ grok: true, claude: true });
  });
});
