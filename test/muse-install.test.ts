import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { museInstallCommand } from "../src/muse-install";
import { HOST_CAPABILITIES } from "../src/protocol";
import { allowFromRemote, capabilitiesForRemote, INBOUND_DISPOSITION } from "../src/remote-policy";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { planRunCommandInTerminal } from "../src/desktop/external-terminal";

afterEach(() => vi.restoreAllMocks());

function host(desktop = false) {
  const s = Object.create(GrokSidebar.prototype) as any;
  const terminal = { show: vi.fn(), sendText: vi.fn() };
  s.host = { canSwitchWorkspaceFolder: desktop, appendLine: vi.fn(),
    showWarningMessage: vi.fn(async () => "Install"), createTerminal: vi.fn(() => terminal) };
  s.focused = new Session();
  s.workspaceRoot = () => "/repo";
  s.remoteClients = { active: () => undefined, cwd: () => "/repo" };
  s.captureRemoteRequester = vi.fn();
  s.post = vi.fn();
  s.postLocal = vi.fn();
  s.sendRemoteClient = vi.fn();
  s.locateProvider = vi.fn(() => undefined);
  s.providerConnectionState = {};
  s.setProviderConnected = vi.fn();
  s.startDeviceLogin = vi.fn();
  s.adapterHistoryClient = vi.fn();
  return { s, terminal };
}

describe("Muse installer boundary", () => {
  it("registers its own desktop message and remains host-local at every remote tier", () => {
    expect(parseWebviewMsg({ type: "runMuseInstallCmd" })).toEqual({ type: "runMuseInstallCmd" });
    expect(INBOUND_DISPOSITION.runMuseInstallCmd).toBe("host-local");
    for (const tier of ["read-only", "propose", "full"] as const) {
      expect(allowFromRemote("runMuseInstallCmd", tier)).toBe(false);
      expect(allowFromRemote("runMuseInstallCmd", tier, { isCloud: true })).toBe(false);
    }
    expect(HOST_CAPABILITIES.installMuse).toBe(true);
    expect(capabilitiesForRemote(HOST_CAPABILITIES).installMuse).toBeUndefined();
  });

  it.each(["win32", "darwin", "linux"] as const)("runs only Meta's fixed command on %s, after host confirmation", async platform => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const { s, terminal } = host();
    let approve!: (value: string) => void;
    s.host.showWarningMessage.mockReturnValue(new Promise<string>(resolve => { approve = resolve; }));
    const pending = s.onMessage({ type: "runMuseInstallCmd", command: "untrusted", provider: "grok" }, "local");
    expect(s.host.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("dev.meta.ai"), { modal: true }, "Install");
    expect(s.host.createTerminal).not.toHaveBeenCalled();
    approve("Install");
    await pending;
    expect(s.host.createTerminal).toHaveBeenCalledWith("Install Muse Code");
    expect(terminal.show).toHaveBeenCalledOnce();
    const command = terminal.sendText.mock.calls[0][0];
    expect(command).toBe(platform === "win32"
      ? 'irm https://dev.meta.ai/install.ps1 | iex; Write-Host "`nWhen installation finishes, click Re-check, then Connect Muse Code."'
      : 'curl -fsSL https://dev.meta.ai/install.sh | bash && echo "\\nWhen installation finishes, click Re-check, then Connect Muse Code."');
    expect(command).toBe(museInstallCommand(platform));
    expect(command).not.toMatch(/untrusted|x\.ai/);
    expect(s.setProviderConnected).not.toHaveBeenCalled();
    expect(s.startDeviceLogin).not.toHaveBeenCalled();
    expect(s.locateProvider).not.toHaveBeenCalled();
    const plan = planRunCommandInTerminal("Install Muse Code", command, undefined, platform);
    expect(plan.kind).toBe("spawn");
    if (plan.kind === "spawn") {
      expect(plan.args.some(arg => arg.includes("https://dev.meta.ai/install."))).toBe(true);
      if (platform === "win32") expect(plan.args).toContain("powershell.exe");
    }
  });

  it.each([false, true])("cancel opens no terminal (desktop=%s)", async desktop => {
    const { s } = host(desktop);
    s.host.showWarningMessage.mockResolvedValue(undefined);
    await s.onMessage({ type: "runMuseInstallCmd" }, "local");
    expect(s.host.createTerminal).not.toHaveBeenCalled();
  });

  it("rejects a remote even if called past the policy boundary", async () => {
    const { s } = host();
    await s.onMessage({ type: "runMuseInstallCmd" }, "remote", "phone");
    expect(s.host.showWarningMessage).not.toHaveBeenCalled();
    expect(s.host.createTerminal).not.toHaveBeenCalled();
  });
});

describe("missing Muse on Connect and Re-check", () => {
  it.each(["sidebar", "desktop", "remote"])("answers the requesting %s without granting consent or starting anything", async surface => {
    const { s } = host(surface === "desktop");
    const remote = surface === "remote";
    for (const type of ["runGrokLogin", "recheckConnection"]) {
      await s.onMessage({ type, provider: "muse" }, remote ? "remote" : "local", remote ? "phone" : undefined);
      const message = { type: "onboarding", state: "missing-muse", provider: "muse", platform: process.platform,
        device: { status: "failed", message: "Muse Code is not installed on this machine." } };
      if (remote) {
        expect(s.sendRemoteClient).toHaveBeenCalledWith("phone", message);
        expect(s.post).not.toHaveBeenCalled();
        expect(s.postLocal).not.toHaveBeenCalled();
      } else {
        expect(s.postLocal).toHaveBeenCalledWith(message);
        expect(s.post).not.toHaveBeenCalled();
        expect(s.sendRemoteClient).not.toHaveBeenCalled();
      }
    }
    expect(s.setProviderConnected).not.toHaveBeenCalled();
    expect(s.startDeviceLogin).not.toHaveBeenCalled();
    expect(s.adapterHistoryClient).not.toHaveBeenCalled();
    expect(s.host.createTerminal).not.toHaveBeenCalled();
  });

  it.each([false, true])("Re-check finds the new install but still requires Connect (remote=%s)", async remote => {
    const { s } = host();
    s.locateProvider.mockReturnValue("/fake/muse");
    await s.onMessage({ type: "recheckConnection", provider: "muse" }, remote ? "remote" : "local", remote ? "phone" : undefined);
    const message = { type: "onboarding", state: "muse-login", provider: "muse", platform: process.platform };
    if (remote) expect(s.sendRemoteClient).toHaveBeenCalledWith("phone", message);
    else expect(s.postLocal).toHaveBeenCalledWith(message);
    expect(s.setProviderConnected).not.toHaveBeenCalled();
    expect(s.adapterHistoryClient).not.toHaveBeenCalled();
    expect(s.startDeviceLogin).not.toHaveBeenCalled();
  });
});
