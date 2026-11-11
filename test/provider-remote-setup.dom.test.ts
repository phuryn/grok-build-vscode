import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const cases = [
  { id: "agy", name: "Antigravity", row: "providerAgy", status: "providerAgyStatus", login: "agy-login", field: ".onb-agy-key", action: "agySignInKey", install: "installAgy", message: { type: "agySignIn", method: "api-key" } },
  { id: "deepseek", name: "DeepSeek", row: "providerDeepseek", status: "providerDeepSeekStatus", login: "deepseek-login", field: ".onb-deepseek-key", action: "deepseekConnect", install: "installDeepSeek", message: { type: "deepseekConnect" } },
];

describe.each(cases)("$name setup surfaces", provider => {
  it.each(["vscode", "desktop", "remote"])("has Connect and Disconnect on %s", surface => {
    const h = bootWebview({ remote: surface === "remote" });
    const api = (h.window as any).GrokSettings;
    const container = h.doc.createElement("div"); h.doc.body.appendChild(container);
    const posted: any[] = [];
    const mounted = api.mount(container, { standalone: surface === "vscode", category: "providers",
      snapshot: { providers: [{ id: provider.id, connected: false, remoteSetup: true, keepsCliSignIn: true }] },
      env: { isRemote: surface === "remote", isDesktop: surface === "desktop", providersKnown: true },
      post: (message: any) => posted.push(message) });
    const row = () => container.querySelector(`[data-id="${provider.row}"]`)!;
    expect(row().textContent).toContain(provider.name);
    click(h.window, row().querySelector(".settings-action")!);
    expect(posted).toContainEqual({ type: "runGrokLogin", provider: provider.id });
    mounted.update({ providers: [{ id: provider.id, connected: true, remoteSetup: true, keepsCliSignIn: true }] });
    expect(row().querySelector(".settings-action")?.textContent).toBe("Disconnect");
    click(h.window, row().querySelector(".settings-action")!);
    expect(posted).toContainEqual({ type: surface === "remote" ? "disconnectProvider" : "logout", provider: provider.id });
    expect(container.querySelector(`[data-id="${provider.status}"]`)).toBeNull();
  });

  it.each(["vscode", "desktop", "remote"])("uses the cloud Sign out action on %s", surface => {
    const h = bootWebview({ remote: surface === "remote" });
    const api = (h.window as any).GrokSettings;
    const container = h.doc.createElement("div"); h.doc.body.appendChild(container);
    const posted: any[] = [];
    api.mount(container, { standalone: surface === "vscode", category: "providers",
      snapshot: { providers: [{ id: provider.id, connected: true, remoteSetup: true }] },
      env: { isRemote: surface === "remote", isDesktop: surface === "desktop", providersKnown: true },
      post: (message: any) => posted.push(message) });
    const button = container.querySelector(`[data-id="${provider.row}"] .settings-action`)!;
    expect(button.textContent).toBe("Sign out");
    click(h.window, button);
    expect(posted).toContainEqual({ type: "logout", provider: provider.id });
  });

  it("lists the agent in Connect an agent at the desk, without the word experimental", () => {
    const h = bootWebview({ remote: false });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }, { id: provider.id, connected: false, remoteSetup: true }] });
    dispatch(h.window, { type: "onboarding", state: "connect-agent" });
    const tile = h.doc.querySelector(`.onb-agent-tile[data-provider="${provider.id}"]`);
    expect(tile).not.toBeNull();
    expect(tile!.textContent).not.toMatch(/experimental/i);
  });

  it("lists the agent in Connect an agent on a remote whose host takes remote setup", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "initialState", capabilities: { remoteAgentSignIn: true } });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }, { id: provider.id, connected: false, remoteSetup: true }] });
    dispatch(h.window, { type: "onboarding", state: "connect-agent" });
    expect(h.doc.querySelector(`[data-act="connectRemote"][data-provider="${provider.id}"]`)).not.toBeNull();
  });

  it("keeps the old status copy and omits keys/install without the capability", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: provider.id, connected: false }] });
    dispatch(h.window, { type: "onboarding", state: provider.login, provider: provider.id });
    expect(h.doc.querySelector(provider.field)).toBeNull();
    expect(h.doc.querySelector(`[data-act="${provider.install}"]`)).toBeNull();
    const api = (h.window as any).GrokSettings;
    const row = api.ROWS.find((r: any) => r.id === provider.status);
    expect(row.describe({ providers: [{ id: provider.id }] })).toBe(`Connect ${provider.name} on the computer running this workspace.`);
  });

  it("offers remote installation and progress, followed by key setup", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: provider.id, connected: false, remoteSetup: true }] });
    dispatch(h.window, { type: "onboarding", state: `missing-${provider.id}`, provider: provider.id,
      device: { status: "failed", message: "Not installed" } });
    click(h.window, h.doc.querySelector(`[data-act="${provider.install}"]`)!);
    expect(h.posted).toContainEqual({ type: provider.install });
    dispatch(h.window, { type: "agyInstallProgress", provider: provider.id, phase: "downloading", receivedBytes: 1, totalBytes: 4 });
    expect(h.doc.querySelector(".connect-wizard-body")?.textContent).toContain("25%");
    dispatch(h.window, { type: "onboarding", state: provider.login, provider: provider.id, agyChoice: provider.id === "agy" });
    expect(h.doc.querySelector(`.connect-wizard-body ${provider.field}`)).not.toBeNull();
  });

  it("sends a pasted key once, clears it, and never saves it in browser state", () => {
    const saved: unknown[] = [];
    const h = bootWebview({ remote: true, beforeScripts: window => {
      const acquire = (window as any).acquireVsCodeApi;
      (window as any).acquireVsCodeApi = () => ({ ...acquire(), setState: (state: unknown) => saved.push(state) });
    } });
    dispatch(h.window, { type: "providerState", providers: [{ id: provider.id, connected: false, remoteSetup: true }] });
    dispatch(h.window, { type: "onboarding", state: provider.login, provider: provider.id, agyChoice: provider.id === "agy" });
    const key = "sentinel-phone-secret";
    const input = h.doc.querySelector(`.connect-wizard-body ${provider.field}`) as HTMLInputElement;
    input.value = key;
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    click(h.window, h.doc.querySelector(`.connect-wizard-body [data-act="${provider.action}"]`)!);
    expect(h.posted.filter(m => m.type === provider.message.type)).toEqual([{ ...provider.message, key }]);
    expect(input.value).toBe("");
    expect(JSON.stringify(saved)).not.toContain(key);
    for (const storage of [h.window.localStorage, h.window.sessionStorage]) {
      expect(Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i)!)).join("")).not.toContain(key);
    }
    (h.window as any).afkpilotHostLink = { reachable: false, restored: false };
    dispatch(h.window, { type: "hostLink", link: { reachable: false, restored: false } });
    (h.window as any).afkpilotHostLink = { reachable: true, restored: true };
    dispatch(h.window, { type: "hostLink", link: { reachable: true, restored: true } });
    expect(h.posted.filter(m => m.type === provider.message.type)).toHaveLength(1);
  });

  it("refuses an offline key before the transport/outbox and never retries it", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: provider.id, connected: false, remoteSetup: true }] });
    dispatch(h.window, { type: "onboarding", state: provider.login, provider: provider.id, agyChoice: provider.id === "agy" });
    (h.window as any).afkpilotHostLink = { reachable: false, restored: false };
    dispatch(h.window, { type: "hostLink", link: { reachable: false, restored: false } });
    const input = h.doc.querySelector(`.connect-wizard-body ${provider.field}`) as HTMLInputElement;
    input.value = "sentinel-offline-secret";
    click(h.window, h.doc.querySelector(`.connect-wizard-body [data-act="${provider.action}"]`)!);
    expect(input.value).toBe("");
    expect(h.posted.some(m => m.type === provider.message.type)).toBe(false);
    (h.window as any).afkpilotHostLink = { reachable: true, restored: true };
    dispatch(h.window, { type: "hostLink", link: { reachable: true, restored: true } });
    expect(h.posted.some(m => m.type === provider.message.type)).toBe(false);
  });
});

describe("Google browser eligibility", () => {
  it.each([false, true])("remote adopts an existing Google sign-in only (stored=%s)", stored => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", remoteSetup: true, googleSignIn: true, savedSignIns: stored ? ["google"] : [] }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", agyChoice: true });
    const button = h.doc.querySelector('.connect-wizard-body [data-act="agySignInGoogle"]');
    expect(!!button).toBe(stored);
    if (button) {
      expect(h.doc.querySelector(".connect-wizard-body")?.textContent).toContain("no browser is needed");
      click(h.window, button);
      expect(h.posted).toContainEqual({ type: "agySignIn", method: "google" });
    }
  });

  it.each([false, true])("a remote offers Google only if the cloud host accepts pasted redirects=%s", acceptsPaste => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", remoteSetup: true, googleSignIn: false, ...(acceptsPaste ? { googleSignInPaste: true } : {}) }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", agyChoice: true });
    expect(!!h.doc.querySelector('.connect-wizard-body [data-act="agySignInGoogle"]')).toBe(acceptsPaste);
    expect(h.doc.querySelector(".onb-agy-key")).not.toBeNull();
  });

  it("an older cloud host omits Google on its local surface too", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", remoteSetup: true, googleSignIn: false }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", agyChoice: true });
    expect(h.doc.querySelector('[data-act="agySignInGoogle"]')).toBeNull();
    expect(h.doc.querySelector(".onb-agy-key")).not.toBeNull();
  });
});
