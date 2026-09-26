import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { runDeviceLogin } from "../src/device-login-run";

vi.mock("../src/device-login-run", async importOriginal => ({
  ...await importOriginal<typeof import("../src/device-login-run")>(),
  runDeviceLogin: vi.fn(() => ({ cancel: vi.fn() })),
}));

describe("sign-in browser ownership", () => {
  it.each([
    ["muse", false, false], ["muse", true, false],
    ["claude", false, false], ["claude", true, false],
    ["grok", true, false], ["codex", true, false],
  ] as const)("%s remote=%s opens browser=%s and retains the card", async (provider, remote, opens) => {
    vi.mocked(runDeviceLogin).mockClear();
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.providerConnectionState = { [provider]: true };
    sidebar.host = { appendLine: vi.fn(), openExternal: vi.fn(async () => true) };
    sidebar.remoteClients = { tabToken: () => "tab" };
    sidebar.deviceLogins = new Map();
    sidebar.deviceLoginPreflightShown = new Set([provider]);
    sidebar.beginDeviceLoginWork = vi.fn(() => 1);
    sidebar.post = vi.fn();
    sidebar.sendRemoteClient = vi.fn();
    await sidebar.startDeviceLogin(provider, "/fake/cli", remote ? "phone" : undefined, { remote });
    const callbacks = vi.mocked(runDeviceLogin).mock.calls[0][2];
    callbacks.onPrompt({ url: "https://example.com/device", code: "ABCD-EFGH" });
    expect(sidebar.host.openExternal).toHaveBeenCalledTimes(opens ? 1 : 0);
    const send = remote ? sidebar.sendRemoteClient : sidebar.post;
    const frame = send.mock.calls.at(-1)[remote ? 1 : 0];
    expect(frame.device).toMatchObject({ status: "waiting", url: "https://example.com/device", code: "ABCD-EFGH" });
  });
});
