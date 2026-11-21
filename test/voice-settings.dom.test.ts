import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, openAppSettings } from "./webview-harness";

const backendState = { provider: "codex", preference: "auto", backend: "openai", hasXai: false, hasOpenAi: true,
  backends: { codex: "openai", grok: "openai", claude: "openai" } };
const googleState = { provider: "agy", preference: "auto", googlePreference: "google", hasXai: false,
  hasOpenAi: false, hasGoogle: true, backend: "google", backends: { grok: "google", agy: "google" } };

describe("voice Settings on every surface", () => {
  it("the row is host-backed and hidden until supporting data arrives, including standalone Settings", () => {
    const w = new Window({ url: "https://localhost/" });
    (w as any).eval(readFileSync(new URL("../media/webview-helpers.js", import.meta.url), "utf8"));
    (w as any).eval(readFileSync(new URL("../media/settings.js", import.meta.url), "utf8"));
    const api = (w as any).GrokSettings;
    (w as any).GrokVoiceSettings.install(api);
    (w as any).GrokVoiceSettings.install(api);
    expect(api.ROWS.filter((r: any) => r.id === "voiceBackend")).toHaveLength(1);
    const row = api.ROWS.find((r: any) => r.id === "voiceBackend");
    expect(row.localOnly).toBeUndefined();
    expect(row.message("openai")).toEqual({ type: "setVoiceBackend", value: "openai" });
    for (const env of [{}, { isDesktop: true }, { isRemote: true }]) {
      expect(api.visibleRows({}, env).some((r: any) => r.id === "voiceBackend")).toBe(false);
      expect(api.visibleRows({ voiceBackendState: backendState }, env).some((r: any) => r.id === "voiceBackend")).toBe(true);
    }
    const posted: any[] = []; const root = w.document.createElement("div"); w.document.body.appendChild(root);
    const surface = api.mount(root, { category: "voice", standalone: true, snapshot: { voiceBackendState: backendState }, post: (m: any) => posted.push(m) });
    const select = root.querySelector('[data-id="voiceBackend"] select') as any;
    expect(select).toBeTruthy(); select.value = "xai"; select.dispatchEvent(new w.Event("change", { bubbles: true }));
    expect(posted).toContainEqual({ type: "setVoiceBackend", value: "xai" });
    surface.update({ voiceBackendState: { ...backendState, preference: "xai" } });
    expect((root.querySelector('[data-id="voiceBackend"] select') as any).value).toBe("xai");
    expect(root.textContent).toContain("Codex / ChatGPT sign-in does not include transcription API access");
    surface.dispose(); w.happyDOM.abort();
  });

  it.each([false, true])("renders a usable OpenAI-only mic and picker (remote=%s)", remote => {
    const h = bootWebview({ remote, beforeScripts(w) {
      Object.defineProperty(w.navigator, "mediaDevices", { value: { getUserMedia() {} }, configurable: true });
      (w as any).AudioWorkletNode = function () {};
    } });
    dispatch(h.window, { type: "session", provider: "codex", models: [] });
    dispatch(h.window, { type: "providerState", providers: [{ id: "codex", connected: true }, { id: "grok", connected: false }] });
    openAppSettings(h.window, h.doc);
    const voice = [...h.doc.querySelectorAll(".settings-nav-item")].find(e => e.textContent === "Voice")!; click(h.window, voice);
    expect(h.doc.querySelector('[data-id="voiceBackend"]')).toBeNull();
    dispatch(h.window, { type: "voiceConfigured", value: true, backendState });
    expect(h.doc.querySelector('[data-id="voiceBackend"]')).toBeTruthy();
    const mic = h.doc.getElementById("mic-btn") as HTMLButtonElement;
    expect(mic.disabled).toBe(false); expect(mic.classList.contains("needs-setup")).toBe(false);
    expect(mic.title).not.toContain("Grok connected");
    // The host supplies every provider's resolution. A provider switch cannot
    // accidentally reuse the desk/provider boolean while waiting for a frame.
    dispatch(h.window, { type: "session", provider: "claude", models: [] });
    expect(mic.disabled).toBe(false); expect(mic.classList.contains("needs-setup")).toBe(false);
    h.window.happyDOM.abort();
  });

  it("an explicit missing backend displays setup even with another credential present", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "voiceConfigured", value: false,
      backendState: { ...backendState, preference: "xai", backend: undefined, backends: { grok: null, codex: null, claude: null } } });
    const mic = h.doc.getElementById("mic-btn")!;
    expect(mic.classList.contains("needs-setup")).toBe(true);
    click(h.window, mic); expect(h.posted).toContainEqual({ type: "voiceStart" });
    expect(h.doc.querySelector(".confirm-overlay")).toBeNull(); h.window.happyDOM.abort();
  });

  it.each([false, true])("gates Google on the host capability and acknowledges selecting it (remote=%s)", remote => {
    const h = bootWebview({ remote, beforeScripts(w) {
      if (remote) (w as any).afkpilotHostLink = { reachable: true, phase: "up", since: Date.now(), restored: true, connection: 1 };
    } });
    try {
      dispatch(h.window, { type: "voiceConfigured", value: true, backendState });
      openAppSettings(h.window, h.doc);
      click(h.window, [...h.doc.querySelectorAll(".settings-nav-item")].find(e => e.textContent === "Voice")!);
      const picker = () => h.doc.querySelector<HTMLSelectElement>('[data-id="voiceBackend"] select')!;
      const keyRow = () => h.doc.querySelector('[data-id="configureGoogleVoice"]');
      expect(Array.from(picker().options, option => option.value)).toEqual(["auto", "xai", "openai"]);
      expect(keyRow()).toBeNull();
      dispatch(h.window, { type: "voiceConfigured", value: true, backendState: { ...backendState, hasGoogle: false } });
      expect(Array.from(picker().options, option => option.value)).toEqual(["auto", "xai", "openai", "google"]);
      expect(h.doc.querySelector('[data-id="voiceBackendAvailability"]')!.textContent).toContain("Google: needs a Gemini API key");
      if (remote) {
        expect(keyRow()).toBeNull();
        expect(h.doc.querySelector('[data-id="voiceBackendAvailability"]')!.textContent).toContain("Google may use your audio to improve its products.");
      } else {
        expect(keyRow()!.textContent).toContain("Google may then use your audio to improve its products.");
        const links = [...keyRow()!.querySelectorAll<HTMLAnchorElement>(".settings-row-link")];
        expect(links.map(a => [a.textContent, a.dataset.href])).toEqual([
          ["Get a key in AI Studio", "https://aistudio.google.com/api-keys"],
          ["Which key?", "https://github.com/phuryn/grok-build-vscode/blob/main/docs/voice-setup.md#google--gemini-api-key"],
        ]);
        h.posted.length = 0;
        click(h.window, links[0]);
        expect(h.posted).toEqual([{ type: "openUrl", url: "https://aistudio.google.com/api-keys" }]);
      }
      const change = picker();
      change.value = "google";
      change.dispatchEvent(new h.window.Event("change", { bubbles: true }) as never);
      expect(h.posted).toContainEqual({ type: "setVoiceBackend", value: "google" });
      if (remote) expect(h.doc.querySelector('[data-id="voiceBackend"]')!.getAttribute("aria-busy")).toBe("true");
      dispatch(h.window, { type: "voiceConfigured", value: true, backendState: googleState });
      expect(picker().value).toBe("google");
      expect(h.doc.querySelector('[data-id="voiceBackend"]')!.getAttribute("aria-busy")).toBeNull();
      expect(h.doc.querySelector('[data-id="voiceBackendAvailability"]')!.textContent).toContain("Google: key available");
      if (!remote) {
        click(h.window, keyRow()!.querySelector("button")!);
        expect(h.posted).toContainEqual({ type: "configureGoogleVoice" });
      }
    } finally { h.window.happyDOM.abort(); }
  });

  it.each([false, true])("uses the host's voice setup prompt for Google and makes a configured mic ready (remote=%s)", remote => {
    const h = bootWebview({ remote, beforeScripts(w) {
      Object.defineProperty(w.navigator, "mediaDevices", { value: { getUserMedia() {} }, configurable: true });
      (w as any).AudioWorkletNode = function () {};
    } });
    try {
      dispatch(h.window, { type: "session", provider: "agy", models: [] });
      dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true }, { id: "grok", connected: false }] });
      dispatch(h.window, { type: "voiceConfigured", value: false,
        backendState: { ...googleState, hasGoogle: false, backend: undefined, backends: { grok: null, agy: null } } });
      const mic = h.doc.getElementById("mic-btn")!;
      expect(mic.classList.contains("needs-setup")).toBe(true);
      expect(mic.title).toContain("Gemini");
      click(h.window, mic);
      expect(h.posted).toContainEqual({ type: remote ? "remoteVoiceStart" : "voiceStart" });
      expect(h.doc.querySelector(".confirm-overlay")).toBeNull();
      dispatch(h.window, { type: "voiceConfigured", value: true, backendState: googleState });
      expect(mic.classList.contains("needs-setup")).toBe(false);
      expect(mic.title).toBe("Voice control");
    } finally { h.window.happyDOM.abort(); }
  });
});
