import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, openAppSettings } from "./webview-harness";

function boot(surface = "sidebar", installMuse?: boolean) {
  const h = bootWebview({ remote: surface === "remote", vscode: surface === "sidebar" });
  dispatch(h.window, { type: "initialState", hostKind: surface === "desktop" ? "desktop" : "extension",
    capabilities: { remoteAgentSignIn: true, ...(installMuse === undefined ? {} : { installMuse }) } });
  dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }, { id: "muse", connected: false }] });
  return h;
}
function missing(h: ReturnType<typeof boot>, platform = "linux", device = true) {
  dispatch(h.window, { type: "onboarding", state: "missing-muse", provider: "muse", platform,
    ...(device ? { device: { status: "failed", message: "Muse Code is not installed on this machine." } } : {}) });
}
const panel = (h: ReturnType<typeof boot>) => h.doc.querySelector(".connect-wizard-body")!;

describe("Muse install capability", () => {
  it.each([undefined, false, true])("offers and sends the new message only with installMuse=%s", installMuse => {
    const h = boot("sidebar", installMuse);
    missing(h, "win32", false);
    const onb = h.doc.getElementById("welcome-onboarding")!;
    expect(onb.textContent).toContain("irm https://dev.meta.ai/install.ps1 | iex");
    expect(!!onb.querySelector('[data-act="installMuse"]')).toBe(installMuse === true);
    // A stale control must not send a message to an old host either.
    const button = h.doc.createElement("button");
    button.className = "onb-action"; button.dataset.act = "installMuse";
    onb.appendChild(button);
    h.posted.length = 0;
    click(h.window, button);
    expect(h.posted).toEqual(installMuse === true ? [{ type: "runMuseInstallCmd" }] : []);
  });

  it.each(["darwin", "linux"])("shows the POSIX command for a %s host", platform => {
    const h = boot("desktop", true);
    missing(h, platform, false);
    expect(h.doc.getElementById("welcome-onboarding")!.textContent).toContain("curl -fsSL https://dev.meta.ai/install.sh | bash");
  });

  it("never offers or sends install from a remote, even if the flag arrives", () => {
    const h = boot("remote", true);
    missing(h);
    expect(panel(h).textContent).toContain("not installed on the machine running this workspace");
    expect(h.doc.querySelector('[data-act="installMuse"]')).toBeNull();
    const button = h.doc.createElement("button");
    button.className = "onb-action"; button.dataset.act = "installMuse";
    panel(h).appendChild(button);
    h.posted.length = 0;
    click(h.window, button);
    expect(h.posted).toEqual([]);
  });
});

describe("missing Muse stays visible where Connect was pressed", () => {
  it.each(["sidebar", "desktop", "remote"])("keeps the missing response above Settings and a conversation on %s", async surface => {
    const h = boot(surface, true);
    dispatch(h.window, { type: "userMessage", text: "Keep my conversation" });
    openAppSettings(h.window, h.doc);
    click(h.window, h.doc.querySelector('[data-category="providers"]')!);
    const row = h.doc.querySelector(surface === "remote" ? '[data-id="providerMuseRemote"]' : '[data-id="providerMuse"]')!;
    click(h.window, row.querySelector(".settings-action")!);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "muse" });
    if (surface === "remote") expect(panel(h).textContent).toContain("Connecting Muse Code");
    missing(h);
    expect(panel(h).textContent).toContain("Muse Code is not installed");
    expect(panel(h).textContent).not.toContain("Connecting Muse Code");
    expect(h.doc.querySelector("#settings-overlay")).not.toBeNull();
    expect(h.doc.getElementById("messages")!.textContent).toContain("Keep my conversation");
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }, { id: "muse", connected: false }] });
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(panel(h).textContent).toContain("Muse Code is not installed");
    expect(!!panel(h).querySelector('[data-act="installMuse"]')).toBe(surface !== "remote");
    if (surface !== "remote") {
      click(h.window, panel(h).querySelector('[data-act="installMuse"]')!);
      expect(h.posted).toContainEqual({ type: "runMuseInstallCmd" });
    }
    click(h.window, panel(h).querySelector('[data-act="recheckProvider"]')!);
    expect(h.posted).toContainEqual({ type: "recheckConnection", provider: "muse" });
    missing(h);
    expect(panel(h).textContent).toContain("Muse Code is not installed");
    // Finding the installed CLI is not consent. The next action is Connect.
    dispatch(h.window, { type: "onboarding", state: "muse-login", provider: "muse", platform: "linux" });
    expect(panel(h).textContent).toContain("Connect Muse Code");
    expect(panel(h).textContent).not.toContain("not installed");
    // A repeated ready-to-connect reply must not dismiss the dialog.
    dispatch(h.window, { type: "onboarding", state: "muse-login", provider: "muse", platform: "linux" });
    expect(panel(h).textContent).toContain("Connect Muse Code");
    click(h.window, panel(h).querySelector(`[data-act="${surface === "remote" ? "connectRemote" : "connectProvider"}"]`)!);
    dispatch(h.window, { type: "onboarding", state: "muse-login", provider: "muse",
      device: { status: "waiting", url: "https://auth.meta.com/device", code: "ABCD-EFGH" } });
    expect(panel(h).textContent).toContain("ABCD-EFGH");
  });

  it("retains a bare missing reply from an older host in the remote wizard", () => {
    const h = boot("remote");
    openAppSettings(h.window, h.doc);
    click(h.window, h.doc.querySelector('[data-category="providers"]')!);
    click(h.window, h.doc.querySelector('[data-id="providerMuseRemote"] .settings-action')!);
    missing(h, "linux", false);
    expect(panel(h).textContent).toContain("Muse Code is not installed");
  });
});
