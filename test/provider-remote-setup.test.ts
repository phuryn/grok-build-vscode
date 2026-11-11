import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";
import { installManagedAgy } from "../src/agy-managed-installer";
import { installManagedDeepSeek } from "../src/deepseek-managed-installer";
import { allowFromRemote, INBOUND_DISPOSITION, REMOTE_REQUIRES_BOUND_SESSION, transformHostMsgForRemote } from "../src/remote-policy";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";

vi.mock("../src/agy-managed-installer", async original => ({ ...await original<object>(), installManagedAgy: vi.fn() }));
vi.mock("../src/deepseek-managed-installer", async original => ({ ...await original<object>(), installManagedDeepSeek: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

function host() {
  const s: any = Object.create(GrokSidebar.prototype);
  s.focused = new Session(); s.pool = new Set([s.focused]);
  s.workspaceRoot = () => "/work";
  s.remoteClients = { active: () => s.focused, cwd: () => "/work", clients: () => [] };
  const requester = { clientId: "phone", tabToken: "same-tab" };
  s.captureRemoteRequester = () => requester;
  s.context = { globalStorageUri: { fsPath: "/storage" } };
  s.host = { appendLine: vi.fn(), getConfiguration: () => ({ get: (_: string, fallback: unknown) => fallback }), showWarningMessage: vi.fn(), revealChatView: vi.fn() };
  s.locateProvider = vi.fn(() => undefined);
  s.postLocal = vi.fn(); s.sendRemoteRequester = vi.fn(); s.postProviderState = vi.fn();
  return { s, requester };
}

describe("remote provider setup", () => {
  it.each(["installAgy", "cancelAgyInstall", "agySignIn", "installDeepSeek", "cancelDeepSeekInstall", "deepseekConnect", "disconnectProvider"] as const)("admits %s only at full tier, without a conversation", type => {
    expect(INBOUND_DISPOSITION[type]).toBe("full");
    expect(REMOTE_REQUIRES_BOUND_SESSION[type]).toBe(false);
    for (const isCloud of [false, true]) {
      expect(allowFromRemote(type, "full", { isCloud })).toBe(true);
      expect(allowFromRemote(type, "propose", { isCloud })).toBe(false);
      expect(allowFromRemote(type, "read-only", { isCloud })).toBe(false);
    }
  });

  it.each(["agy", "deepseek"] as const)("routes %s install progress and completion to the requester", async provider => {
    const { s, requester } = host();
    const install = vi.mocked(provider === "agy" ? installManagedAgy : installManagedDeepSeek);
    install.mockImplementation(async options => {
      options.onProgress?.("downloading", { receivedBytes: 1, totalBytes: 4 });
      options.onProgress?.("downloading", { receivedBytes: 2, totalBytes: 4 });
      return "/installed";
    });
    await s.onMessage({ type: provider === "agy" ? "installAgy" : "installDeepSeek" }, "remote", "phone");
    expect(install).toHaveBeenCalledOnce();
    const frames = s.sendRemoteRequester.mock.calls.map(([target, frame]: any[]) => {
      expect(target).toBe(requester); return frame;
    });
    expect(frames).toContainEqual(expect.objectContaining({ type: "agyInstallProgress", provider, phase: "downloading", receivedBytes: 2 }));
    expect(frames.at(-1)).toMatchObject({ type: "onboarding", provider, state: provider === "agy" ? "agy-login" : "deepseek-login" });
    expect(s.postLocal).not.toHaveBeenCalled();
    expect(transformHostMsgForRemote(frames[0], {} as any)).toEqual(frames[0]);
  });

  it.each(["agy", "deepseek"] as const)("lets a remote cancel %s and receive its failure", async provider => {
    const { s } = host();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(provider === "agy" ? installManagedAgy : installManagedDeepSeek).mockImplementation(options => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      started();
    }));
    const installing = s.onMessage({ type: provider === "agy" ? "installAgy" : "installDeepSeek" }, "remote", "phone");
    await ready;
    await s.onMessage({ type: provider === "agy" ? "cancelAgyInstall" : "cancelDeepSeekInstall" }, "remote", "phone");
    await installing;
    expect(s.sendRemoteRequester.mock.calls.at(-1)[1]).toMatchObject({ state: provider === "agy" ? "missing-agy" : "missing-deepseek", reason: expect.stringContaining("cancelled") });
  });

  it.each(["agy", "deepseek"] as const)("disconnects %s without a host dialog, even during a reply", async provider => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const { s } = host(); s.focused.provider = provider; s.focused.status = "busy";
    s.finishProviderLogout = vi.fn();
    await s.onMessage({ type: "disconnectProvider", provider }, "remote", "phone");
    expect(s.finishProviderLogout).toHaveBeenCalledWith(provider, expect.any(Function));
    expect(s.host.showWarningMessage).not.toHaveBeenCalled();
    expect(parseWebviewMsg({ type: "disconnectProvider", provider })).toEqual({ type: "disconnectProvider", provider });
    expect(parseWebviewMsg({ type: "disconnectProvider", provider: "unknown" })).toBeNull();
  });

  it.each(["agy", "deepseek"] as const)("reveals chat before a VS Code Settings %s Connect reply", async provider => {
    const { s } = host(); s.onMessage = vi.fn();
    s.chatReadyForHandoff = true;
    await s.onSettingsPanelMessage({ type: "runGrokLogin", provider });
    expect(s.host.revealChatView).toHaveBeenCalledOnce();
    expect(s.host.revealChatView.mock.invocationCallOrder[0]).toBeLessThan(s.onMessage.mock.invocationCallOrder[0]);
    expect(s.onMessage).toHaveBeenCalledWith({ type: "runGrokLogin", provider }, "local");
  });

  it.each(["agy", "deepseek"] as const)("waits for cold chat's ready before answering Settings %s Connect", async provider => {
    const { s } = host(); s.onMessage = vi.fn();
    await s.onSettingsPanelMessage({ type: "runGrokLogin", provider });
    expect(s.onMessage).not.toHaveBeenCalled();
    expect(s.pendingProviderSetup).toBe(provider);
    s.postInitialState = vi.fn(); s.postRepoCatalog = vi.fn(); s.postSessionsList = vi.fn();
    s.firstBootScanCompleted = true;
    await GrokSidebar.prototype["onAdmittedMessage"].call(s, { type: "ready" }, "local");
    expect(s.onMessage).toHaveBeenCalledOnce();
    expect(s.onMessage).toHaveBeenCalledWith({ type: "runGrokLogin", provider }, "local");
    expect(s.pendingProviderSetup).toBeUndefined();
  });
});

function credentialHost(provider: "agy" | "deepseek", google = false, method = "api-key") {
  const { s } = host();
  const secrets = new Map([["grok.agy.geminiApiKey", "sentinel-agy-key"], ["grok.deepseekApiKey", "sentinel-deepseek-key"]]);
  s.context.secrets = {
    get: vi.fn(async (key: string) => secrets.get(key)),
    delete: vi.fn(async (key: string) => { secrets.delete(key); }),
  };
  s.state = { get: (key: string, fallback: unknown) => key === "grok.agySignInMethod" ? method : fallback };
  s.focused.provider = provider; s.focused.status = "working"; s.focused.turnToken = {};
  s.finishProviderLogout = vi.fn();
  s.host.createTerminal = vi.fn();
  s.agyGoogleSignedIn = vi.fn(async () => google);
  const client = { start: vi.fn(), logout: vi.fn(async () => { google = false; }), dispose: vi.fn(), authenticate: vi.fn() };
  s.agySignInClient = vi.fn(() => client);
  s.locateProvider = vi.fn(() => "/installed");
  s.startDeviceLogin = vi.fn();
  return { s, secrets, client };
}

describe("cloud provider Sign out", () => {
  it.each(["logout", "disconnectProvider"])("removes DeepSeek's saved key remotely through %s", async type => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const { s, secrets } = credentialHost("deepseek");
    await s.onMessage({ type, provider: "deepseek" }, "remote", "phone");
    expect(secrets.has("grok.deepseekApiKey")).toBe(false);
    expect(secrets.get("grok.agy.geminiApiKey")).toBe("sentinel-agy-key");
    expect(s.finishProviderLogout).toHaveBeenCalledWith("deepseek", expect.any(Function));
    expect(s.host.showWarningMessage).not.toHaveBeenCalled();
    expect(s.host.createTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ["logout", "api-key", false], ["logout", "api-key", true],
    ["logout", "google", false], ["logout", "google", true],
    ["disconnectProvider", "api-key", true],
  ] as const)("clears every Antigravity credential via %s (method=%s, Google stored=%s)", async (type, method, google) => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const { s, secrets, client } = credentialHost("agy", google, method);
    await s.onMessage({ type, provider: "agy" }, "remote", "phone");
    expect(secrets.has("grok.agy.geminiApiKey")).toBe(false);
    expect(secrets.get("grok.deepseekApiKey")).toBe("sentinel-deepseek-key");
    expect(await s.agyGoogleSignedIn()).toBe(false);
    expect(client.logout).toHaveBeenCalledTimes(google ? 1 : 0);
    if (google) expect(client.logout.mock.invocationCallOrder[0]).toBeLessThan(s.context.secrets.delete.mock.invocationCallOrder[0]);
    expect(s.finishProviderLogout).toHaveBeenCalledWith("agy", expect.any(Function));
    expect(s.host.showWarningMessage).not.toHaveBeenCalled();
    expect(s.host.createTerminal).not.toHaveBeenCalled();
    expect(s.startDeviceLogin).not.toHaveBeenCalled();
    expect(client.authenticate).not.toHaveBeenCalled();
  });

  it("keeps the key and connection when Google's logout fails, and reports to the remote", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const { s, secrets, client } = credentialHost("agy", true);
    client.logout.mockRejectedValueOnce(new Error("Server refused logout"));
    await s.onMessage({ type: "logout", provider: "agy" }, "remote", "phone");
    expect(secrets.has("grok.agy.geminiApiKey")).toBe(true);
    expect(s.finishProviderLogout).not.toHaveBeenCalled();
    expect(s.sendRemoteRequester).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "error", text: expect.stringContaining("remains connected") }));
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it.each(["agy", "deepseek"] as const)("reports a %s secret-store failure without disclosing credentials", async provider => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const { s } = credentialHost(provider);
    s.context.secrets.delete.mockRejectedValueOnce(new Error("sentinel-stored-key"));
    await s.onMessage({ type: "logout", provider }, "remote", "phone");
    expect(s.finishProviderLogout).not.toHaveBeenCalled();
    expect(s.sendRemoteRequester).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "error" }));
    expect(JSON.stringify([s.sendRemoteRequester.mock.calls, s.host.appendLine.mock.calls])).not.toContain("sentinel-stored-key");
  });

  it.each(["agy", "deepseek"] as const)("desk Disconnect keeps %s credentials", async provider => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    const { s, secrets, client } = credentialHost(provider, true);
    await s.onMessage({ type: "disconnectProvider", provider }, "remote", "phone");
    expect(s.context.secrets.delete).not.toHaveBeenCalled();
    expect(secrets.size).toBe(2);
    expect(client.logout).not.toHaveBeenCalled();
    expect(s.finishProviderLogout).toHaveBeenCalledWith(provider, expect.any(Function));
  });
});
