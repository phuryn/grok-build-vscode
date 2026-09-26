import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, openAppSettings } from "./webview-harness";

const providers = ["grok", "codex", "claude", "muse"];
const mode = (provider: string) => provider === "grok" ? "auth-required" : `${provider}-login`;
function boot() {
  const h = bootWebview();
  dispatch(h.window, { type: "initialState", hostKind: "desktop", capabilities: { remoteAgentSignIn: true } });
  dispatch(h.window, { type: "providerState", providers: providers.map(id => ({ id, connected: false })) });
  return h;
}
function connected(h: ReturnType<typeof boot>, provider: string, needsLogin: boolean) {
  dispatch(h.window, { type: "providerState", providers: providers.map(id => ({ id, connected: id === provider,
    ...(id === provider ? { needsLogin } : {}) })) });
}

describe("desk Connect feedback", () => {
  it.each(providers)("checks %s from the chooser without claiming a terminal launch", provider => {
    const h = boot();
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    const tile = h.doc.querySelector(`[data-act="connectProvider"][data-provider="${provider}"]`)!;
    click(h.window, tile);
    expect(tile.hasAttribute("disabled")).toBe(true);
    expect(tile.textContent).toContain("Checking…");
    expect(tile.querySelector(".onb-ran-mark")).toBeNull();
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider });
    connected(h, provider, true);
    dispatch(h.window, { type: "onboarding", state: mode(provider), provider, platform: "linux" });
    const panel = h.doc.getElementById("welcome-onboarding")!;
    expect(panel.querySelector(".onb-ran-mark")).toBeNull();
    expect(panel.textContent).not.toContain("Finish the sign-in flow in the terminal");
    const signin = panel.querySelector(`[data-act="${provider === "grok" ? "runLogin" : "connectProvider"}"]`)!;
    expect(signin.hasAttribute("disabled")).toBe(false);
    connected(h, provider, false);
    // Success hides the welcome card; it does not empty it.
    expect(h.doc.getElementById("welcome")!.hidden).toBe(true);
  });

  // Desk provider rows open no wizard (only remote rows do; Muse's desk wizard
  // opens once an explicit sign-in starts its device flow), so the first press
  // must simply not start a sign-in. Explicit sign-in on a connected-but-
  // signed-out row keeps its terminal bar; settings-surface.dom.test.ts pins it.
  it.each(providers)("a first desk Connect of %s from Settings starts no sign-in flow", provider => {
    const h = boot();
    openAppSettings(h.window, h.doc);
    click(h.window, h.doc.querySelector('[data-category="providers"]')!);
    const rowId = `provider${provider[0].toUpperCase()}${provider.slice(1)}`;
    h.posted.length = 0;
    click(h.window, h.doc.querySelector(`[data-id="${rowId}"] .settings-action`)!);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider });
    expect(h.doc.querySelector(".settings-provider-terminal")).toBeNull();
    expect(h.doc.querySelector(".connect-wizard-overlay")).toBeNull();
    // The host reports the check through the flag Refresh already uses.
    dispatch(h.window, { type: "providerState", providers: providers.map(id => ({ id, connected: false })), checking: true });
    expect(h.doc.querySelector(".settings-refresh")?.textContent).toBe("Checking…");
  });

  it("Muse's desk device URL opens only when its link is clicked", () => {
    const h = boot();
    connected(h, "muse", true);
    h.posted.length = 0;
    dispatch(h.window, { type: "onboarding", state: "muse-login", provider: "muse",
      device: { status: "waiting", url: "https://example.com/device", code: "ABCD-EFGH" } });
    expect(h.posted.some(m => m.type === "openUrl")).toBe(false);
    const link = h.doc.querySelector('.connect-wizard-body a[href="https://example.com/device"]')!;
    expect(link.textContent).toBe("Open the sign-in page");
    click(h.window, link);
    expect(h.posted).toContainEqual({ type: "openUrl", url: "https://example.com/device" });
  });
});
