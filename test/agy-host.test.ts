/**
 * Antigravity at the host: the providerState row, the choice of how to sign
 * in (Google, or a pasted Gemini API key), Disconnect and Sign out -- driven
 * against the fake ACP server, whose state lives under GEMINI_HOME exactly
 * where the real one's does, so the host's own credential checks read real
 * files. The key lives only in a fake HostSecrets.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";

const FAKE = path.join(__dirname, "fixtures", "fake-agy-acp.cjs");
const KEY = "AIza-host-test-key";

let home: string;
const token = () => path.join(home, "antigravity-acp", "acp_token.json");

function signIn(): void {
  fs.mkdirSync(path.dirname(token()), { recursive: true });
  fs.writeFileSync(path.join(home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
  fs.writeFileSync(token(), "{}");
}

function host(opts: { connected?: boolean; experimental?: boolean; method?: "google" | "api-key"; key?: string } = {}): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = "agy";
  session.cwd = home;
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.providerConnectionState = opts.connected ? { agy: true } : {};
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.deviceLogins = new Map();
  sidebar.deviceLoginPreflightShown = new Set();
  sidebar.deviceLoginWork = new Set();
  sidebar.deviceLoginWorkSeq = 0;
  sidebar.refreshKeepAwake = vi.fn();
  sidebar.captureRemoteRequester = () => ({ clientId: "phone", tabToken: "tab" });
  sidebar.sendRemoteRequester = vi.fn();
  sidebar.sendRemoteClient = vi.fn();
  sidebar.remoteClients = { active: () => session, cwd: () => home, detachedActiveValues: () => [], clients: () => [], tabToken: () => undefined, cwdIfPresent: () => undefined };
  sidebar.locateProvider = vi.fn(() => FAKE);
  sidebar.locatedProviders = () => ({ agy: true });
  sidebar.workspaceRoot = vi.fn(() => home);
  const config = { update: vi.fn(async () => {}) };
  sidebar.host = {
    appendLine: vi.fn(),
    createTerminal: vi.fn(),
    showWarningMessage: vi.fn(async () => "Sign Out"),
    showErrorMessage: vi.fn(async () => undefined),
    getConfiguration: () => ({ ...config, get: (key: string, fallback: unknown) => key === "experimentalAntigravity" ? opts.experimental !== false : fallback }),
  };
  sidebar.configUpdate = config.update;
  const memento: Record<string, unknown> = opts.method ? { "grok.agySignInMethod": opts.method } : {};
  sidebar.memento = memento;
  sidebar.state = {
    get: (key: string, fallback?: unknown) => Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback,
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  const secrets = new Map<string, string>(opts.key ? [["grok.agy.geminiApiKey", opts.key]] : []);
  sidebar.secrets = secrets;
  sidebar.context = {
    globalStorageUri: { fsPath: home },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
      delete: vi.fn(async (key: string) => { secrets.delete(key); }),
    },
  };
  sidebar.invalidateSubscriptionUsage = vi.fn();
  sidebar.adapterHistory = vi.fn(() => undefined);
  sidebar.rearmAuthRecovery = vi.fn();
  sidebar.post = vi.fn();
  sidebar.postLocal = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.adoptSessionsForConnectedProvider = vi.fn(async () => {});
  sidebar.resetProviderSessionsAfterLogout = vi.fn();
  sidebar.probeProviderVersion = vi.fn(async () => "");
  sidebar.disposeAdapterHistoryClient = vi.fn(async () => {});
  sidebar.postSessionsList = vi.fn();
  sidebar.worktreeCache = new Map();
  return sidebar;
}

const row = (sidebar: any) => GrokSidebar.prototype["providerStateMessage"].call(sidebar).providers.find((p: any) => p.id === "agy");
const frames = (spy: any) => spy.mock.calls.map(([message]: any[]) => message);
const deviceFrames = (sidebar: any) => frames(sidebar.post).filter((m: any) => m.type === "onboarding" && m.device).map((m: any) => m.device);
const choices = (sidebar: any) => frames(sidebar.postLocal).filter((m: any) => m.type === "onboarding" && m.agyChoice);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-test-"));
  vi.stubEnv("GEMINI_HOME", home);
  vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Antigravity in providerState", () => {
  it("is advertised with remote setup and Disconnect semantics", () => {
    const sidebar = host({ connected: true });
    sidebar.providerCliVersions = { agy: "1.4.0" };
    sidebar.providerNeedsLogin = { agy: true };
    expect(row(sidebar)).toEqual({ id: "agy", connected: true, keepsCliSignIn: true, cliVersion: "1.4.0", needsLogin: true, signInMethod: "google", remoteSetup: true, googleSignIn: true });
  });

  it("names the way it is signed in and what is stored, never the key", async () => {
    signIn();
    const sidebar = host({ connected: true, method: "api-key", key: KEY });
    await sidebar.refreshAgySaved();
    expect(row(sidebar)).toMatchObject({ signInMethod: "api-key", savedSignIns: ["google", "api-key"] });
    expect(JSON.stringify(GrokSidebar.prototype["providerStateMessage"].call(sidebar))).not.toContain(KEY);
  });

  it("is advertised without the retired setting and on a cloud machine", () => {
    const off = host({ connected: true, experimental: false });
    expect(GrokSidebar.prototype["providerStateMessage"].call(off).providers.map((p: any) => p.id)).toContain("agy");
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const cloud = host({ connected: true });
    expect(GrokSidebar.prototype["providerStateMessage"].call(cloud).providers.map((p: any) => p.id)).toContain("agy");
  });

  it("notes the server's version from its handshake", () => {
    const sidebar = host({ connected: true });
    sidebar.noteAgyVersion({ agentInfo: { name: "antigravity-acp", version: "1.4.0" } });
    expect(sidebar.providerCliVersions.agy).toBe("1.4.0");
    expect(sidebar.postProviderState).toHaveBeenCalledTimes(1);
    sidebar.noteAgyVersion({ agentInfo: { version: "1.4.0" } });
    expect(sidebar.postProviderState).toHaveBeenCalledTimes(1);
  });

  it("an Antigravity conversation that cannot start gets a card a renderer will draw", () => {
    const off = host({ experimental: false });
    off.usableProviders = () => ["grok"];
    expect(off.refusedStartOnboarding("agy")).toEqual({ state: "missing-agy", provider: "agy" });
    const on = host();
    on.usableProviders = () => ["grok", "agy"];
    expect(on.refusedStartOnboarding("agy")).toEqual({ state: "missing-agy", provider: "agy" });
  });

  it("ignores retired experimental controls from an old client", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "setExperimentalAntigravity", value: true }, "local");
    await sidebar.onMessage({ type: "setExperimentalAntigravity", value: false }, "local");
    expect(sidebar.configUpdate).not.toHaveBeenCalled();
  });
});

describe("remote key secrecy", () => {
  it.each(["none", "store", "connect"])("does not echo the key in frames or logs, including failure=%s", async failure => {
    const sidebar = host();
    if (failure === "store") sidebar.context.secrets.store.mockRejectedValue(new Error(KEY));
    if (failure === "connect") sidebar.adoptSessionsForConnectedProvider.mockRejectedValue(new Error(KEY));
    await sidebar.onMessage({ type: "agySignIn", method: "api-key", key: KEY }, "remote", "phone");
    const outbound = [...frames(sidebar.post), ...frames(sidebar.postLocal), ...sidebar.sendRemoteRequester.mock.calls.map((c: any[]) => c[1]), ...sidebar.sendRemoteClient.mock.calls.map((c: any[]) => c[1]), sidebar.providerStateMessage()];
    expect(JSON.stringify(outbound)).not.toContain(KEY);
    expect(JSON.stringify(sidebar.host.appendLine.mock.calls)).not.toContain(KEY);
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
    if (failure === "none") expect(sidebar.sendRemoteRequester).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: "provider-connected" }));
  });
});

describe("Connect offers the choice of how to sign in", () => {
  it.each([false, true])("records nothing and opens nothing, with a Google sign-in stored=%s", async stored => {
    if (stored) signIn();
    const sidebar = host();
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    expect(sidebar.providerConnectionState.agy).toBeUndefined();
    expect(choices(sidebar)).toEqual([{ type: "onboarding", state: "agy-login", provider: "agy", platform: process.platform, agyChoice: true }]);
    expect(sidebar.agySaved).toEqual({ google: stored, apiKey: false });
    expect(sidebar.post).not.toHaveBeenCalled();
    expect(sidebar.adoptSessionsForConnectedProvider).not.toHaveBeenCalled();
  });

  it("answers a missing server with the install panel", async () => {
    const sidebar = host();
    sidebar.locateProvider = vi.fn(() => undefined);
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    expect(sidebar.postLocal).toHaveBeenCalledWith(expect.objectContaining({
      type: "onboarding", state: "missing-agy", provider: "agy",
      device: { status: "failed", message: "Antigravity is not installed on this machine." },
    }));
    expect(sidebar.providerConnectionState.agy).toBeUndefined();
  });

  it("accepts local and remote install requests", async () => {
    const sidebar = host();
    sidebar.installManagedAgyServer = vi.fn(async () => {});
    await sidebar.onMessage({ type: "installAgy" }, "remote");
    expect(sidebar.installManagedAgyServer).toHaveBeenCalledTimes(1);
    await sidebar.onMessage({ type: "installAgy" }, "local");
    expect(sidebar.installManagedAgyServer).toHaveBeenCalledTimes(2);
  });

  it("accepts a remote key into host secret storage", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "agySignIn", method: "api-key", key: KEY }, "remote");
    expect(sidebar.secrets.get("grok.agy.geminiApiKey")).toBe(KEY);
    expect(sidebar.providerConnectionState.agy).toBe(true);
  });
});

describe("Sign in with Google", () => {
  it.each([false, true])("never launches a browser remotely, including cloud=%s", async cloud => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, cloud ? "1" : "");
    const sidebar = host();
    sidebar.startDeviceLogin = vi.fn();
    await sidebar.onMessage({ type: "agySignIn", method: "google" }, "remote", "phone");
    expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
    expect(sidebar.providerConnectionState.agy).toBeUndefined();
    expect(sidebar.sendRemoteRequester).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agyChoice: true, reason: expect.stringContaining("API key") }));
    signIn();
    await sidebar.onMessage({ type: "agySignIn", method: "google" }, "remote", "phone");
    expect(sidebar.providerConnectionState.agy).toBe(true);
    expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
    expect(sidebar.sendRemoteRequester).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "provider-connected" }));
  });

  it("refuses a fresh Google sign-in locally on cloud too", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const sidebar = host(); sidebar.startDeviceLogin = vi.fn();
    await sidebar.onMessage({ type: "agySignIn", method: "google" }, "local");
    expect(sidebar.startDeviceLogin).not.toHaveBeenCalled();
    expect(sidebar.providerConnectionState.agy).toBeUndefined();
    expect(row(sidebar)).toMatchObject({ remoteSetup: true, googleSignIn: false });
  });

  it("adopts a stored Google sign-in without starting a server", async () => {
    signIn();
    const sidebar = host({ method: "api-key" });
    await sidebar.onMessage({ type: "agySignIn", method: "google" }, "local");
    expect(sidebar.memento["grok.agySignInMethod"]).toBe("google");
    expect(sidebar.providerConnectionState.agy).toBe(true);
    expect(sidebar.providerNeedsLogin.agy).toBe(false);
    expect(sidebar.adoptSessionsForConnectedProvider).toHaveBeenCalledWith("agy", sidebar.focused);
    expect(sidebar.postLocal).toHaveBeenCalledWith(expect.objectContaining({ state: "provider-connected", provider: "agy" }));
    expect(deviceFrames(sidebar)).toEqual([]);
  });

  it("runs Google's browser sign-in through the server when nothing is stored, and connects", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "agySignIn", method: "google" }, "local");
    await vi.waitFor(() => expect(deviceFrames(sidebar).at(-1)).toEqual({ status: "done" }), { timeout: 15_000 });
    const statuses = deviceFrames(sidebar).map((device: any) => device.status);
    expect(statuses[0]).toBe("starting");
    expect(statuses).toContain("verifying");
    expect(deviceFrames(sidebar).find((device: any) => device.status === "waiting").url)
      .toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=fake");
    expect(fs.existsSync(token())).toBe(true);
    expect(sidebar.providerNeedsLogin.agy).toBe(false);
    expect(sidebar.adoptSessionsForConnectedProvider).toHaveBeenCalled();
  });

  it("cancels a sign-in that is waiting on the browser, back to the choice", async () => {
    vi.stubEnv("FAKE_AGY_SIGN_IN", "hang");
    const sidebar = host();
    await sidebar.onMessage({ type: "agySignIn", method: "google" }, "local");
    await vi.waitFor(() => expect(deviceFrames(sidebar).some((device: any) => device.status === "waiting")).toBe(true), { timeout: 15_000 });
    await sidebar.onMessage({ type: "cancelDeviceLogin", provider: "agy" }, "local");
    expect(sidebar.deviceLogins.size).toBe(0);
    expect(sidebar.post.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ state: "agy-login", provider: "agy" }));
    expect(sidebar.post.mock.calls.at(-1)[0]).not.toHaveProperty("device");
    expect(fs.existsSync(token())).toBe(false);
  });
});

describe("Use a Gemini API key", () => {
  it("keeps a pasted key in HostSecrets only, and hands it to a server start as a credential", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "agySignIn", method: "api-key", key: `  ${KEY}  ` }, "local");
    expect(sidebar.secrets.get("grok.agy.geminiApiKey")).toBe(KEY);
    expect(sidebar.memento["grok.agySignInMethod"]).toBe("api-key");
    expect(sidebar.providerConnectionState.agy).toBe(true);
    expect(sidebar.providerNeedsLogin.agy).toBe(false);
    expect(sidebar.adoptSessionsForConnectedProvider).toHaveBeenCalledWith("agy", sidebar.focused);
    // The start hands it to the relay alone (session-start-retry.test.ts).
    expect(await sidebar.agyCredentialFor()).toEqual({ method: "api-key", key: KEY });
    // Nowhere else: not in state, not in a frame, not in the log.
    expect(JSON.stringify(sidebar.memento)).not.toContain(KEY);
    expect(JSON.stringify([...frames(sidebar.postLocal), ...frames(sidebar.post)])).not.toContain(KEY);
    expect(JSON.stringify(sidebar.host.appendLine.mock.calls)).not.toContain(KEY);
  });

  it("uses the saved key when none is pasted, and asks for one when there is none", async () => {
    const saved = host({ key: KEY });
    await saved.onMessage({ type: "agySignIn", method: "api-key" }, "local");
    expect(saved.providerConnectionState.agy).toBe(true);
    const none = host();
    await none.onMessage({ type: "agySignIn", method: "api-key" }, "local");
    expect(none.providerConnectionState.agy).toBeUndefined();
    expect(choices(none).at(-1)).toMatchObject({ reason: "Paste a Gemini API key." });
  });

  it("refuses something that is not a key, back on the choice and saving nothing", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "agySignIn", method: "api-key", key: "two words" }, "local");
    expect(sidebar.secrets.size).toBe(0);
    expect(sidebar.providerConnectionState.agy).toBeUndefined();
    expect(choices(sidebar).at(-1)).toMatchObject({ reason: "That does not look like a Gemini API key." });
  });

  it("lands a key Google rejected back on the choice, saying so", async () => {
    const sidebar = host({ connected: true, method: "api-key", key: "bad-key" });
    await sidebar.rejectAgyCredential();
    expect(sidebar.providerNeedsLogin.agy).toBe(true);
    expect(choices(sidebar).at(-1)).toMatchObject({ reason: "Google rejected this API key." });
    // The next Connect still says why, until a choice is made.
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    expect(choices(sidebar).at(-1)).toMatchObject({ reason: "Google rejected this API key." });
    await sidebar.onMessage({ type: "agySignIn", method: "api-key", key: KEY }, "local");
    expect(sidebar.agySignInError).toBeUndefined();
    expect(sidebar.providerNeedsLogin.agy).toBe(false);
  });

  it("a refusal replayed from the conversation's history does not reject the new key", () => {
    const sidebar = host({ connected: true, method: "api-key", key: KEY });
    sidebar.rejectAgyCredential = vi.fn(async () => {});
    const session = new Session();
    session.gen = 3;
    session.replaying = true;
    sidebar.onAgyCredentialRejected(session, 3);
    expect(sidebar.rejectAgyCredential).not.toHaveBeenCalled();
    session.replaying = false;
    sidebar.onAgyCredentialRejected(session, 2);
    expect(sidebar.rejectAgyCredential).not.toHaveBeenCalled();
    sidebar.onAgyCredentialRejected(session, 3);
    expect(sidebar.rejectAgyCredential).toHaveBeenCalledTimes(1);
  });

  it("a session start with nothing stored for the chosen way starts no server", async () => {
    signIn();
    expect(await host({ method: "api-key" }).agyCredentialFor()).toBeUndefined();
    expect(await host({ method: "google" }).agyCredentialFor()).toEqual({ method: "google" });
  });
});

describe("Disconnect and Sign out", () => {
  it("Disconnect keeps both the Google sign-in and the saved key, and Connect offers both again", async () => {
    signIn();
    const sidebar = host({ connected: true, method: "api-key", key: KEY });
    sidebar.persistProviderConnections = vi.fn(async () => {});
    await sidebar.logout("agy");
    expect(sidebar.providerConnectionState.agy).toBe(false);
    expect(fs.existsSync(token())).toBe(true);
    expect(sidebar.secrets.get("grok.agy.geminiApiKey")).toBe(KEY);
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    expect(row(sidebar)).toMatchObject({ connected: false, signInMethod: "api-key", savedSignIns: ["google", "api-key"] });
  });

  it("Sign out with Google clears the Google sign-in through ACP logout and keeps the key", async () => {
    signIn();
    const sidebar = host({ connected: true, method: "google", key: KEY });
    sidebar.persistProviderConnections = vi.fn(async () => {});
    await sidebar.logout("agy", { signOutCli: true });
    expect(sidebar.host.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("clears the Google sign-in"), { modal: true }, "Sign Out");
    expect(fs.existsSync(token())).toBe(false);
    expect(sidebar.secrets.get("grok.agy.geminiApiKey")).toBe(KEY);
    expect(sidebar.providerConnectionState.agy).toBe(false);
  });

  it("Sign out with a key deletes the saved key and leaves the Google sign-in", async () => {
    signIn();
    const sidebar = host({ connected: true, method: "api-key", key: KEY });
    sidebar.persistProviderConnections = vi.fn(async () => {});
    await sidebar.logout("agy", { signOutCli: true });
    expect(sidebar.host.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("deletes the Gemini API key"), { modal: true }, "Sign Out");
    expect(sidebar.secrets.has("grok.agy.geminiApiKey")).toBe(false);
    expect(fs.existsSync(token())).toBe(true);
    expect(sidebar.providerConnectionState.agy).toBe(false);
  });

  it("keeps the account when the person declines", async () => {
    signIn();
    const sidebar = host({ connected: true, key: KEY });
    sidebar.host.showWarningMessage = vi.fn(async () => undefined);
    await sidebar.logout("agy", { signOutCli: true });
    expect(fs.existsSync(token())).toBe(true);
    expect(sidebar.providerConnectionState.agy).toBe(true);
  });
});
