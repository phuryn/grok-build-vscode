import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { Uri } from "../src/host";
import { HOST_CAPABILITIES } from "../src/protocol";
import { MISSING_PROVIDER_CONFIG_STAMP } from "../src/provider-config";
import { GLOBAL_CONFIG_STUB } from "../src/grok-config";
import { Window } from "happy-dom";

const fixture = vi.hoisted(() => ({ home: "", overrides: {} as NodeJS.ProcessEnv }));
vi.mock("../src/provider-config", async (original) => {
  const actual = await original<typeof import("../src/provider-config")>();
  return { ...actual, resolveProviderConfigFile: (provider: unknown) => actual.resolveProviderConfigFile(provider, { HOME: fixture.home, USERPROFILE: fixture.home, ...fixture.overrides }) };
});

beforeEach(() => {
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), "config-host-"));
  fixture.overrides = {};
  for (const [dir, name] of [[".grok", "config.toml"], [".codex", "config.toml"], [".claude", "settings.json"]]) {
    fs.mkdirSync(path.join(fixture.home, dir));
    fs.writeFileSync(path.join(fixture.home, dir, name), "original = true\n");
    fs.writeFileSync(path.join(fixture.home, dir, "auth.json"), "PRIVATE");
  }
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(fixture.home, { recursive: true, force: true }); });

function host() {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = new Session();
  sidebar.focused.provider = "grok";
  sidebar.focused.activeSessionId = "desk-session";
  sidebar.focused.cwd = "/repo";
  sidebar.remoteClients = new RemoteClientState<Session>("/repo");
  sidebar.remoteClients.ready("phone");
  sidebar.host = { workspaceRoot: () => "/repo", appendLine: vi.fn(), openHostResolvedPath: vi.fn() };
  sidebar.postLocal = vi.fn();
  sidebar.post = vi.fn();
  sidebar.sendRemoteRequester = vi.fn();
  sidebar.captureRemoteRequester = vi.fn(() => ({ clientId: "phone", tabToken: "tab-1" }));
  sidebar.reportRequester = vi.fn();
  sidebar.startSession = vi.fn(async () => {});
  sidebar.refuseUnboundRemoteSession = vi.fn();
  return sidebar;
}

describe("provider config host dispatch", () => {
  function settingsHost() {
    const sidebar = host();
    sidebar.state = { get: (_key: string, fallback: unknown) => fallback };
    sidebar.context = { extensionVersion: "test", extensionUri: Uri.file(path.resolve(__dirname, "..")) };
    sidebar.host.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
    sidebar.appPurpose = () => "coding";
    sidebar.chatFontScale = () => 1;
    sidebar.lastVoiceConfiguredByCwd = new Map();
    sidebar.voiceSetting = (_cwd: string, _key: string, fallback: unknown) => fallback;
    sidebar.providerCliVersions = {};
    sidebar.providerStateMessage = () => ({ type: "providerState", providers: [] });
    sidebar.githubStatePayload = () => ({});
    sidebar.mcpConnectorsMessage = () => ({ type: "mcpConnectors", connectors: [] });
    return sidebar;
  }

  it.each([false, true])("advertises config editing in the actual remote snapshot (VS Code host=%s)", (vscode) => {
    const sidebar = settingsHost();
    sidebar.host.canOpenSettingsEditor = vscode;
    sidebar.host.canSwitchWorkspaceFolder = !vscode;
    sidebar.remoteClients.cwdIfPresent = () => "";
    sidebar.authorizedSessionCwds = () => [];
    sidebar.localRepoCatalogEntries = () => [];
    sidebar.githubStateMessage = () => ({ type: "githubState" });
    sidebar.mcpConnectorAuthorizationMessage = () => undefined;
    sidebar.mcpServersMessage = () => ({ type: "mcpServers", servers: [] });
    sidebar.welcomeTipsMessage = () => ({ type: "welcomeTips" });
    sidebar.projectSetupMessage = () => ({ type: "projectSetup" });
    sidebar.githubProjectSetupExtra = () => ({});
    sidebar.resolveVoiceApiKey = () => undefined;
    sidebar.rememberVoiceConfigured = vi.fn();
    sidebar.voiceConfiguredMsg = () => ({ type: "voiceConfigured", configured: false });
    sidebar.seedPostedVoiceConfigured = vi.fn();
    sidebar.remoteVoice = new Map();
    sidebar.buildRemoteReposMsg = () => ({ type: "repos", entries: [] });
    sidebar.buildSessionsList = () => ({ type: "sessions", sessions: [] });
    sidebar.buildPinnedSessions = () => ({ pins: [] });
    sidebar.remoteMediaDeps = {};
    const frames = sidebar.buildRemoteSnapshot("phone");
    const initial = frames.find((frame: { type: string }) => frame.type === "initialState");
    expect(initial.capabilities).toMatchObject({ editProviderConfigFiles: true, editProjectFiles: true });
    expect(initial.capabilities.settingsEditor).toBeUndefined();
  });

  it("boots the real standalone Settings HTML with config capabilities and opens through its allowlist", async () => {
    const sidebar = settingsHost();
    const html = sidebar.getSettingsHtml({ cspSource: "test:", asWebviewUri: (uri: unknown) => String(uri) }, { remoteLinked: false, category: "providers" });
    const window = new Window({ url: "https://localhost/" });
    window.document.body.innerHTML = '<div id="settings-root"></div>';
    const messages: any[] = [];
    (window as any).acquireVsCodeApi = () => ({ postMessage: (msg: any) => messages.push(msg) });
    (window as any).eval(fs.readFileSync(path.resolve(__dirname, "../media/settings.js"), "utf8"));
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      if (script[1].trim()) (window as any).eval(script[1]);
    }
    expect((window as any).GrokFilePanel).toBeUndefined();
    const configs = window.document.querySelector('[data-id="providerConfigFiles"]')!;
    expect(configs).toBeTruthy();
    (configs.querySelector('[data-provider="codex"]') as any).click();
    const message = messages.at(-1);
    expect(message).toEqual({ type: "openProviderConfig", provider: "codex" });
    await sidebar.onSettingsPanelMessage(message);
    expect(sidebar.host.openHostResolvedPath).toHaveBeenCalledWith(path.join(fixture.home, ".codex", "config.toml"));
    window.happyDOM.abort();
  });

  it.each([["grok", GLOBAL_CONFIG_STUB], ["codex", ""], ["claude", "{}"]])("leaves a missing %s read untouched, then creates it on save", async (provider, stub) => {
    const sidebar = host();
    const dir = path.join(fixture.home, `.${provider}`);
    fs.rmSync(dir, { recursive: true });
    await sidebar.onMessage({ type: "readProviderConfig", provider, requestId: "missing" }, "remote", "phone");
    const read = sidebar.sendRemoteRequester.mock.calls.at(-1)[1];
    expect(read).toMatchObject({ ok: false, reason: "not found", text: stub, stamp: MISSING_PROVIDER_CONFIG_STAMP,
      absPath: path.join(dir, provider === "claude" ? "settings.json" : "config.toml") });
    expect(fs.existsSync(dir)).toBe(false);
    await sidebar.onMessage({ type: "writeProviderConfig", provider, requestId: "create", text: read.text, stamp: read.stamp, expectedAbsPath: read.absPath }, "remote", "phone");
    expect(sidebar.sendRemoteRequester.mock.calls.at(-1)[1]).toMatchObject({ type: "providerConfigWriteResult", requestId: "create", ok: true });
    expect(fs.readFileSync(read.absPath, "utf8")).toBe(stub);
    if (provider === "claude") expect(JSON.parse(fs.readFileSync(read.absPath, "utf8"))).toEqual({});
  });

  it.each(["grok", "codex", "claude"])("refuses a %s config that appeared after the missing read", async (provider) => {
    const sidebar = host();
    const file = path.join(fixture.home, `.${provider}`, provider === "claude" ? "settings.json" : "config.toml");
    fs.unlinkSync(file);
    await sidebar.onMessage({ type: "readProviderConfig", provider }, "local");
    const read = sidebar.postLocal.mock.calls.at(-1)[0];
    fs.writeFileSync(file, provider === "claude" ? '{"keep":true}' : "keep = true");
    const appeared = fs.readFileSync(file, "utf8");
    await sidebar.onMessage({ type: "writeProviderConfig", provider, text: "draft", stamp: read.stamp, expectedAbsPath: read.absPath }, "local");
    expect(sidebar.postLocal.mock.calls.at(-1)[0]).toMatchObject({ ok: false, reason: "changed" });
    expect(fs.readFileSync(file, "utf8")).toBe(appeared);
  });

  it("rejects a changed destination or invalid body before creating a config directory", async () => {
    const sidebar = host();
    const dir = path.join(fixture.home, ".codex");
    fs.rmSync(dir, { recursive: true });
    const file = path.join(dir, "config.toml");
    for (const patch of [{ expectedAbsPath: path.join(fixture.home, "other.toml") }, { text: undefined }, { text: "x".repeat(2 * 1024 * 1024 + 1) }]) {
      await sidebar.onMessage({ type: "writeProviderConfig", provider: "codex", text: "", expectedAbsPath: file,
        stamp: MISSING_PROVIDER_CONFIG_STAMP, ...patch }, "local");
      expect(sidebar.postLocal.mock.calls.at(-1)[0].ok).toBe(false);
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  it("returns a creation failure to the requester and preserves the blocking file", async () => {
    const sidebar = host();
    const dir = path.join(fixture.home, ".codex");
    fs.rmSync(dir, { recursive: true });
    await sidebar.onMessage({ type: "readProviderConfig", provider: "codex" }, "remote", "phone");
    const read = sidebar.sendRemoteRequester.mock.calls.at(-1)[1];
    fs.writeFileSync(dir, "blocking file");
    await sidebar.onMessage({ type: "writeProviderConfig", provider: "codex", text: "", expectedAbsPath: read.absPath, stamp: read.stamp }, "remote", "phone");
    expect(sidebar.sendRemoteRequester.mock.calls.at(-1)[1]).toMatchObject({ type: "providerConfigWriteResult", ok: false, reason: expect.any(String) });
    expect(fs.readFileSync(dir, "utf8")).toBe("blocking file");
  });

  it.each(["grok", "codex"])("uses the %s home override for native and panel routes", async (provider) => {
    const sidebar = host();
    const dir = path.join(fixture.home, "override", provider);
    fixture.overrides = { [provider === "grok" ? "GROK_HOME" : "CODEX_HOME"]: dir };
    const file = path.join(dir, "config.toml");
    await sidebar.onMessage({ type: "readProviderConfig", provider }, "local");
    const read = sidebar.postLocal.mock.calls.at(-1)[0];
    expect(read.absPath).toBe(file);
    await sidebar.onMessage({ type: "writeProviderConfig", provider, text: "custom = true", stamp: read.stamp, expectedAbsPath: read.absPath }, "local");
    expect(fs.readFileSync(file, "utf8")).toBe("custom = true");
    fs.unlinkSync(file);
    await sidebar.onSettingsPanelMessage({ type: "openProviderConfig", provider, path: path.join(fixture.home, "auth.json") });
    expect(sidebar.host.openHostResolvedPath).toHaveBeenCalledWith(file);
    expect(fs.readFileSync(file, "utf8")).toBe(provider === "grok" ? GLOBAL_CONFIG_STUB : "");
  });

  it("opens Claude as JSON from standalone Settings and never opens native configs for a remote", async () => {
    const sidebar = host();
    const file = path.join(fixture.home, ".claude", "settings.json");
    fs.unlinkSync(file);
    await sidebar.onSettingsPanelMessage({ type: "openProviderConfig", provider: "claude" });
    expect(sidebar.host.openHostResolvedPath).toHaveBeenCalledWith(file);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
    sidebar.host.openHostResolvedPath.mockClear();
    await sidebar.onMessage({ type: "openProviderConfig", provider: "claude" }, "remote", "phone");
    expect(sidebar.host.openHostResolvedPath).not.toHaveBeenCalled();
  });

  it.each(["grok", "codex", "claude"])("reads and writes %s only for the requester, ignoring all forged path selectors", async (provider) => {
    const sidebar = host();
    const name = provider === "claude" ? "settings.json" : "config.toml";
    await sidebar.onMessage({ type: "readProviderConfig", provider, requestId: "read-1", cwd: fixture.home, relPath: "auth.json" }, "remote", "phone");
    const read = sidebar.sendRemoteRequester.mock.calls[0][1];
    expect(read).toMatchObject({ type: "providerConfigContent", provider, requestId: "read-1", ok: true,
      text: "original = true\n", relPath: `.${provider}/${name}`, absPath: path.join(fixture.home, `.${provider}`, name) });
    expect(sidebar.post).not.toHaveBeenCalled();
    expect(sidebar.postLocal).not.toHaveBeenCalled();
    const write = { type: "writeProviderConfig", provider, requestId: "write-1", relPath: "../auth.json",
      text: "changed = true\n", stamp: read.stamp, expectedAbsPath: read.absPath };
    await sidebar.onMessage(write, "remote", "phone");
    expect(sidebar.sendRemoteRequester.mock.calls[1][1]).toMatchObject({ type: "providerConfigWriteResult", requestId: "write-1", provider, ok: true });
    expect(fs.readFileSync(read.absPath, "utf8")).toBe("changed = true\n");
    expect(fs.readFileSync(path.join(path.dirname(read.absPath), "auth.json"), "utf8")).toBe("PRIVATE");
    await sidebar.onMessage(write, "remote", "phone");
    expect(sidebar.sendRemoteRequester.mock.calls[2][1]).toMatchObject({ ok: false, reason: "changed" });
  });

  it("sends a local config read only to the local view", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "readProviderConfig", provider: "grok" }, "local");
    expect(sidebar.postLocal).toHaveBeenCalledWith(expect.objectContaining({ type: "providerConfigContent", ok: true }));
    expect(sidebar.post).not.toHaveBeenCalled();
    expect(sidebar.sendRemoteRequester).not.toHaveBeenCalled();
  });

  it("refuses unknown providers and does not fall back to the project or another provider", async () => {
    const sidebar = host();
    for (const provider of ["auth.json", "../grok", "__proto__", undefined]) {
      await sidebar.onMessage({ type: "readProviderConfig", provider }, "local");
      expect(sidebar.postLocal.mock.calls.at(-1)[0]).toMatchObject({ ok: false, reason: "unknown provider config" });
    }
  });

  it("refuses forged requests when the shared editing capability is disabled", async () => {
    const sidebar = host();
    const original = HOST_CAPABILITIES.editProjectFiles;
    try {
      (HOST_CAPABILITIES as any).editProjectFiles = false;
      await sidebar.onMessage({ type: "readProviderConfig", provider: "grok" }, "local");
      expect(sidebar.postLocal.mock.calls[0][0]).toMatchObject({ ok: false, reason: "editing is not available" });
      await sidebar.onMessage({ type: "writeProviderConfig", provider: "grok" }, "local");
      expect(sidebar.postLocal.mock.calls[1][0]).toMatchObject({ ok: false, reason: "editing is not available" });
    } finally { (HOST_CAPABILITIES as any).editProjectFiles = original; }
  });

  it.each([false, true])("loads the shared editor assets in real generated HTML (desktop=%s)", (desktop) => {
    const sidebar = host();
    sidebar.host.canSwitchWorkspaceFolder = desktop;
    sidebar.context = { extensionUri: Uri.file(path.resolve(__dirname, "..")) };
    sidebar.showThinking = () => false;
    sidebar.chatFontScale = () => 1;
    const html = sidebar.getHtml({ cspSource: "test:", asWebviewUri: (uri: unknown) => String(uri) });
    expect(html).toContain("media/file-panel.js");
    expect(html).toContain("media/file-panel.css");
    expect(html.indexOf("media/syntax-highlight.js")).toBeLessThan(html.indexOf("media/file-panel.js"));
    expect(html.includes('id="desk-ft-shell"')).toBe(desktop);
  });
});

describe("restart after a config edit", () => {
  it.each(["grok", "codex", "claude"])("restarts the requesting %s session and reloads its history", async (provider) => {
    const sidebar = host();
    const remote = new Session();
    remote.provider = provider as Session["provider"];
    remote.activeSessionId = "phone-session";
    remote.hasHistory = true;
    sidebar.remoteClients.ready("phone");
    sidebar.remoteClients.setActive("phone", remote);
    await sidebar.onMessage({ type: "restartProviderSession", provider, sessionId: "phone-session" }, "remote", "phone");
    expect(sidebar.startSession).toHaveBeenCalledWith("phone-session", remote, "replace", undefined, { canReplace: expect.any(Function) });
    const guard = sidebar.startSession.mock.calls[0][4].canReplace;
    expect(guard()).toBe(true);
    remote.turnToken = {};
    expect(guard()).toBe(false);
    remote.turnToken = undefined;
    remote.gen++;
    expect(guard()).toBe(false);
  });

  it("refuses an unbound remote, a different session/provider and a busy session", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "restartProviderSession", provider: "grok", sessionId: "desk-session" }, "remote", "phone");
    expect(sidebar.refuseUnboundRemoteSession).toHaveBeenCalled();
    for (const message of [{ provider: "grok", sessionId: "old-session" }, { provider: "codex", sessionId: "desk-session" }]) {
      await sidebar.onMessage({ type: "restartProviderSession", ...message }, "local");
    }
    sidebar.focused.turnToken = {};
    await sidebar.onMessage({ type: "restartProviderSession", provider: "grok", sessionId: "desk-session" }, "local");
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.reportRequester).toHaveBeenCalledTimes(3);
  });
});
