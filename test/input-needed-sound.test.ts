import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";

describe("input-needed sound host wiring", () => {
  function sidebar() {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const update = vi.fn(async () => {});
    sidebar.focused = new Session();
    sidebar.host = {
      getConfiguration: vi.fn(() => ({ get: (key: string, fallback: unknown) => key === "inputNeededSound" ? true : fallback, update })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose() {} })),
      createFileSystemWatcher: vi.fn(() => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} })),
    };
    sidebar.chatLocalResourceRoots = vi.fn(() => []);
    sidebar.getHtml = vi.fn(() => "");
    sidebar.forgetPostedVoiceConfigured = vi.fn();
    sidebar.restorePersistedDraft = vi.fn();
    sidebar.watchActiveEditor = vi.fn();
    sidebar.reaper = {};
    sidebar.applyTerminalShellPref = vi.fn();
    sidebar.maybeStartUplink = vi.fn();
    sidebar.sendRemoteSession = vi.fn();
    sidebar.workspaceRoot = vi.fn(() => "/w");
    const postMessage = vi.fn();
    sidebar.resolveWebviewView({ webview: { postMessage, onDidReceiveMessage: vi.fn() } });
    return { sidebar, update, postMessage };
  }

  it("rebroadcasts configuration changes to the chat webview", () => {
    const h = sidebar();
    const listener = h.sidebar.host.onDidChangeConfiguration.mock.calls[0][0];
    listener({ affectsConfiguration: (key: string) => key === "grok.inputNeededSound" });
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalledWith({ type: "inputNeededSound", value: true });
    listener({ affectsConfiguration: () => false });
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts the Settings tab setter and writes host configuration", async () => {
    const h = sidebar();
    await h.sidebar.onSettingsPanelMessage({ type: "setInputNeededSound", value: true });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith("inputNeededSound", true, "global");
  });

  it("validates the desktop message as a boolean", () => {
    expect(parseWebviewMsg({ type: "setInputNeededSound", value: true })).toEqual({ type: "setInputNeededSound", value: true });
    expect(parseWebviewMsg({ type: "setInputNeededSound", value: "true" })).toBeNull();
  });
});
