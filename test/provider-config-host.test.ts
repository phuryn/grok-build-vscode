import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { Uri } from "../src/host";
import { HOST_CAPABILITIES } from "../src/protocol";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("../src/provider-config", async (original) => {
  const actual = await original<typeof import("../src/provider-config")>();
  return { ...actual, resolveProviderConfigFile: (provider: unknown) => actual.resolveProviderConfigFile(provider, fixture.home) };
});

beforeEach(() => {
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), "config-host-"));
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
  sidebar.host = { workspaceRoot: () => "/repo", appendLine: vi.fn() };
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
