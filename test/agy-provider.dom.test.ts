import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";
import { AgyBackend } from "../src/agy-backend";

const onboarding = (doc: Document) => doc.getElementById("welcome-onboarding")!;

describe("Antigravity in the chat renderer", () => {
  it.each([false, true])("offers Low/Medium/High only for a key model that thinks (remote=%s)", (remote) => {
    const backend = new AgyBackend({ keyRelay: {
      baseUrl: "http://127.0.0.1/relay/lease", release: () => {}, thinkingLevel: "medium", setThinkingLevel: () => {},
      supportsThinking: (id) => id === "gemini-4-carbon",
    } });
    const normalized = backend.normalizeSessionResponse({ configOptions: [{ id: "model", currentValue: "gemini-4-carbon", options: ["gemini-4-carbon", "gemini-3.8-flash"].map((value) => ({ value, name: value })) }] });
    const models = normalized.models.availableModels.map((model: any) => ({ provider: "agy", modelId: model.modelId, name: model.name,
      ...model._meta, reasoningEfforts: model._meta.reasoningEfforts.map((effort: any) => effort.value) }));
    const h = bootWebview({ remote });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", currentModelId: "gemini-4-carbon", models });
    click(h.window, h.doc.getElementById("gear-btn"));
    expect([...h.doc.querySelectorAll(".effort-strip-stop")].map((el) => el.getAttribute("aria-label"))).toEqual(["Low", "Medium", "High"]);
    click(h.window, h.doc.querySelector('[data-effort="high"]'));
    click(h.window, h.doc.getElementById("gear-btn"));
    expect(h.posted).toContainEqual({ type: "setEffort", level: "high" });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", currentModelId: "gemini-3.8-flash", models });
    click(h.window, h.doc.getElementById("gear-btn"));
    expect(h.doc.querySelector(".model-picker-row")).not.toBeNull();
    expect(h.doc.querySelector(".model-effort-strip")).toBeNull();
  });

  it("draws and sends nothing for Antigravity until the host names it", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "connect-agent" });
    expect(onboarding(h.doc).querySelector('[data-provider="agy"]')).toBeNull();
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy" });
    expect(onboarding(h.doc).textContent).not.toContain("Antigravity");
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", agyChoice: true });
    expect(h.doc.querySelector('[data-act="agySignInGoogle"]')).toBeNull();
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", models: [{ provider: "agy", modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] });
    click(h.window, h.doc.getElementById("gear-btn"));
    expect(h.doc.querySelector(".model-picker-row .provider-agy")).toBeNull();
  });

  it("offers Antigravity among the agents once advertised, and connects it", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }, { id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "connect-agent" });
    const tile = onboarding(h.doc).querySelector('[data-provider="agy"]') as HTMLElement;
    expect(tile.textContent).toContain("Antigravity");
    click(h.window, tile);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "agy" });
  });

  it("installs from the missing-server panel and shows progress", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "missing-agy", provider: "agy", platform: "win32" });
    click(h.window, onboarding(h.doc).querySelector('[data-act="installAgy"]'));
    expect(h.posted).toContainEqual({ type: "installAgy" });
    dispatch(h.window, { type: "agyInstallProgress", phase: "downloading", receivedBytes: 25, totalBytes: 100 });
    expect(onboarding(h.doc).textContent).toContain("Downloading Antigravity (25%)");
    click(h.window, onboarding(h.doc).querySelector('[data-act="cancelAgyInstall"]'));
    expect(h.posted).toContainEqual({ type: "cancelAgyInstall" });
    dispatch(h.window, { type: "agyInstallProgress", phase: "idle", reason: "Antigravity installation failed: disk full" });
    expect(onboarding(h.doc).querySelector(".onb-install-error")?.textContent).toBe("Antigravity installation failed: disk full");
  });

  it("answers Connect with the choice of how to sign in, then shows Google's link while it waits", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "initialState", capabilities: { remoteAgentSignIn: true } });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false, signInMethod: "google", savedSignIns: ["google"] }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy" });
    const connect = onboarding(h.doc).querySelector('[data-act="connectProvider"][data-provider="agy"]') as HTMLElement;
    expect(connect.textContent).toBe("Connect Antigravity");
    expect(onboarding(h.doc).textContent).toContain("Sign in with your Google account, or use a Gemini API key.");
    click(h.window, connect);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "agy" });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", platform: "win32", agyChoice: true });
    const wizard = h.doc.querySelector(".connect-wizard-body")!;
    const google = wizard.querySelector('[data-act="agySignInGoogle"]') as HTMLElement;
    expect(google.textContent).toBe("Sign in with Google (last used)");
    expect(wizard.textContent).toContain("Already signed in on this computer, so no browser is needed.");
    expect(wizard.querySelector('a[href="https://aistudio.google.com/apikey"]')).not.toBeNull();
    expect(wizard.querySelector('[data-act="agySignInSavedKey"]')).toBeNull();
    click(h.window, google);
    expect(h.posted).toContainEqual({ type: "agySignIn", method: "google" });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", launched: true,
      device: { status: "waiting", url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } });
    const waiting = h.doc.querySelector(".connect-wizard-body")!;
    expect(waiting.textContent).toContain("Finish signing in to Antigravity");
    const link = waiting.querySelector('a[href="https://accounts.google.com/o/oauth2/v2/auth?x=1"]');
    expect(link?.textContent).toBe("Open the sign-in page");
    expect(waiting.querySelector('[data-act="cancelDeviceLogin"][data-provider="agy"]')).not.toBeNull();
  });

  it("sends a pasted Gemini API key once and keeps no copy in the page", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", agyChoice: true });
    const wizard = h.doc.querySelector(".connect-wizard-body")!;
    expect(wizard.textContent).toContain("Opens Google's sign-in page in your browser.");
    const input = wizard.querySelector(".onb-agy-key") as HTMLInputElement;
    expect(input.type).toBe("password");
    const use = wizard.querySelector('[data-act="agySignInKey"]') as HTMLElement;
    click(h.window, use);
    expect(h.posted.filter((m) => m.type === "agySignIn")).toEqual([]);
    input.value = "  AIza-dom-key  ";
    click(h.window, use);
    expect(h.posted).toContainEqual({ type: "agySignIn", method: "api-key", key: "AIza-dom-key" });
    expect(input.value).toBe("");
    input.value = "AIza-enter-key";
    input.dispatchEvent(new (h.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(h.posted).toContainEqual({ type: "agySignIn", method: "api-key", key: "AIza-enter-key" });
  });

  it("offers the saved key, marks the way last used, and says why Google refused it", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true, needsLogin: true, signInMethod: "api-key", savedSignIns: ["api-key"] }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", agyChoice: true, reason: "Google rejected this API key." });
    const wizard = h.doc.querySelector(".connect-wizard-body")!;
    expect(wizard.querySelector(".onb-install-error")?.textContent).toBe("Google rejected this API key.");
    expect((wizard.querySelector('[data-act="agySignInGoogle"]') as HTMLElement).textContent).toBe("Sign in with Google");
    expect(wizard.textContent).toContain("Gemini API key (last used)");
    click(h.window, wizard.querySelector('[data-act="agySignInSavedKey"]')!);
    expect(h.posted).toContainEqual({ type: "agySignIn", method: "api-key" });
  });

  it("tells a remote to connect Antigravity at the computer, with nothing to press", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy" });
    expect(onboarding(h.doc).textContent).toContain("Connect Antigravity at the computer");
    expect(onboarding(h.doc).querySelector(".onb-action")).toBeNull();
  });

  it("gives a lapsed Antigravity account no Sign in button on a remote", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "initialState", capabilities: { remoteAgentSignIn: true } });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true, needsLogin: true }] });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", models: [] });
    const card = h.doc.getElementById("provider-signin-card")!;
    expect(card.textContent).toContain("Antigravity can only be signed in on the computer running this workspace.");
    expect(card.querySelector(".provider-signin-btn")).toBeNull();
  });

  it("opens the connect dialog on the Install panel when Connect finds no server", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "missing-agy", provider: "agy", platform: "win32",
      device: { status: "failed", message: "Antigravity is not installed on this machine." } });
    const wizard = h.doc.querySelector(".connect-wizard-body")!;
    expect(wizard.querySelector('[data-act="installAgy"]')).not.toBeNull();
    dispatch(h.window, { type: "agyInstallProgress", phase: "installing" });
    expect(wizard.textContent).toContain("Unpacking Antigravity...");
    // Installed: the same dialog goes on to the choice of how to sign in.
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", platform: "win32" });
    expect(wizard.querySelector('[data-act="agySignInGoogle"]')).not.toBeNull();
    expect(wizard.querySelector(".onb-agy-key")).not.toBeNull();
  });

  it("names Antigravity while it starts, and is patient with its slow start", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", models: [] });
    expect((h.doc.getElementById("input") as HTMLTextAreaElement).placeholder).toBe("Ask Antigravity…");
    const chat = readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
    // Behaviour (60 s before "slow") is pinned in startup-status.dom.test.ts.
    expect(chat).toContain("{ agy: 60, deepseek: 45 }[startup.provider] || 20");
  });
});

describe("Antigravity in Settings", () => {
  const settingsSrc = readFileSync(path.join(__dirname, "..", "media", "settings.js"), "utf8");
  function mount(env: Record<string, unknown>, providers: unknown[], category = "providers") {
    const window = new Window({ url: "https://localhost/" });
    (window as any).eval(settingsSrc);
    const api = (window as any).GrokSettings;
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const posted: any[] = [];
    api.mount(container, { snapshot: api.defaultSnapshot({ providers }), env: api.defaultEnv(env), category, post: (m: unknown) => posted.push(m) });
    return { container, posted, window };
  }
  const desk = { isRemote: false, isDesktop: false, providersKnown: true };

  it("has a desk row only when advertised: Connect, then Disconnect that keeps what it signed in with", () => {
    expect(mount(desk, [{ id: "grok", connected: false }]).container.querySelector('[data-id="providerAgy"]')).toBeNull();
    const off = mount(desk, [{ id: "agy", connected: false, keepsCliSignIn: true }]);
    const row = off.container.querySelector('[data-id="providerAgy"]')!;
    expect(row.textContent).toContain("Antigravity");
    const button = row.querySelector(".settings-action") as HTMLElement;
    expect(button.textContent).toBe("Connect");
    button.dispatchEvent(new (off.window as any).MouseEvent("click", { bubbles: true }));
    expect(off.posted).toContainEqual({ type: "runGrokLogin", provider: "agy" });
    const on = mount(desk, [{ id: "agy", connected: true, keepsCliSignIn: true, signInMethod: "google" }]);
    const connected = on.container.querySelector('[data-id="providerAgy"]')!;
    expect(connected.textContent).toContain("Connected with your Google account. Disconnect turns it off here and keeps the Google sign-in.");
    expect((connected.querySelector(".settings-action") as HTMLElement).textContent).toBe("Disconnect");
    const key = mount(desk, [{ id: "agy", connected: true, keepsCliSignIn: true, signInMethod: "api-key" }]);
    expect(key.container.querySelector('[data-id="providerAgy"]')!.textContent)
      .toContain("Connected with a Gemini API key. Disconnect turns it off here and keeps the saved key.");
  });

  it("gives a remote a status row with no Connect", () => {
    const remote = mount({ isRemote: true, isDesktop: false, providersKnown: true, hostCaps: { remoteAgentSignIn: true } },
      [{ id: "agy", connected: false }]);
    expect(remote.container.querySelector('[data-id="providerAgy"]')).toBeNull();
    const status = remote.container.querySelector('[data-id="providerAgyStatus"]')!;
    expect(status.textContent).toContain("Connect Antigravity on the computer running this workspace.");
    expect(status.querySelector("button")).toBeNull();
    const connected = mount({ isRemote: true, isDesktop: false, providersKnown: true, hostCaps: { remoteAgentSignIn: true } },
      [{ id: "agy", connected: true, signInMethod: "api-key" }]);
    expect(connected.container.querySelector('[data-id="providerAgyStatus"]')!.textContent)
      .toContain("Connected with a Gemini API key on the computer running this workspace.");
  });

  it("has no experimental controls on any surface", () => {
    for (const env of [desk, { ...desk, isDesktop: true }, { ...desk, isRemote: true }]) {
      const view = mount(env, [{ id: "agy" }, { id: "deepseek" }], "advanced");
      expect(view.container.textContent).not.toContain("Experimental:");
      expect(view.container.querySelector('[data-id="experimentalAntigravity"], [data-id="experimentalDeepSeek"]')).toBeNull();
    }
  });
});
