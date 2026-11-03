import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";
import { DEEPSEEK_GOAL_COMMANDS } from "../src/deepseek-commands";

const modelId = '["deepseek-official","deepseek-v4-flash"]';
const identity = { sessionId: "s", modelId, generation: 2 };
function setup(remote = false, harness = "default", locked = false) {
  const h = bootWebview({ remote });
  dispatch(h.window, { type: "providerState", providers: [{ id: "deepseek", connected: true }] });
  dispatch(h.window, { type: "session", sessionId: "s", provider: "deepseek", currentModelId: modelId, models: [{ modelId, name: "deepseek-v4-flash", totalContextTokens: 1000000 }] });
  dispatch(h.window, { type: "sessionName", sessionId: "s", name: "New session", cwd: "/work" });
  dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: harness === "minimal" ? [] : ["agent", "yolo"], deepseekHarness: harness, deepseekHarnessLocked: locked, deepseekHarnessContext: identity });
  return h;
}
function select(h: Harness) {
  if (h.doc.getElementById("context-popover")!.hidden) click(h.window, h.doc.getElementById("donut")!);
  return h.doc.querySelector("#context-popover #deepseek-harness") as HTMLSelectElement;
}
describe("DeepSeek renderer capabilities", () => {
  it.each([false, true])("sends a context-window skill as ordinary authored text (remote=%s)", remote => {
    const h = setup(remote);
    dispatch(h.window, { type: "commandsUpdate", commands: [{ name: "context-window", description: "A skill", _meta: { path: "/skill.md", scope: "project-dsh" } }] });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "/context-window review";
    click(h.window, h.doc.getElementById("send-btn")!);
    expect(h.posted.some(message => message.type === "send" && message.text === "/context-window review")).toBe(true);
    expect(h.posted.some(message => message.type === "setContextWindow")).toBe(false);
  });
  it.each([false, true])("offers goals only at the start and skills anywhere via commandsUpdate (remote=%s)", remote => {
    const h = setup(remote);
    dispatch(h.window, { type: "commandsUpdate", commands: [...DEEPSEEK_GOAL_COMMANDS,
      { name: "review", description: "Review the patch", _meta: { path: "/review.md", scope: "project-dsh" } }] });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    for (const [text, expected] of [["/", ["/goal", "/goal-status", "/goal-pause", "/goal-resume", "/goal-done", "/review"]], ["Please /", ["/review"]]] as const) {
      input.value = text; input.selectionStart = text.length; input.selectionEnd = text.length;
      input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
      expect([...h.doc.querySelectorAll(".slash-name")].map(el => el.textContent)).toEqual(expected);
    }
    dispatch(h.window, { type: "userMessage", text: "/goal fix the build", chips: [] });
    expect(h.doc.querySelector(".user-message")?.textContent ?? h.doc.body.textContent).toContain("/goal fix the build");
    expect(h.doc.body.textContent).not.toContain("Set a session goal with create_goal");
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "userMessage", text: "/goal fix the build", chips: [] });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(h.doc.body.textContent).toContain("/goal fix the build");
    expect(h.doc.body.textContent).not.toContain("Set a session goal with create_goal");
  });
  it.each([false, true])("uses the context popup before the first turn and preserves the draft (remote=%s)", remote => {
    const h = setup(remote);
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "keep my draft";
    const control = select(h);
    expect(control.disabled).toBe(false);
    expect(control.closest(".context-window-control")!.textContent).toContain("Harness");
    control.value = "minimal"; control.dispatchEvent(new h.window.Event("change"));
    expect(h.posted.at(-1)).toEqual({ type: "setDeepSeekHarness", ...identity, harness: "minimal", draftId: expect.any(String) });
    const draftId = h.posted.at(-1)!.draftId;
    expect(input.value).toBe("keep my draft");
    expect(select(h).disabled).toBe(true);
    dispatch(h.window, { type: "session", sessionId: "replacement", provider: "deepseek", currentModelId: modelId, models: [] });
    dispatch(h.window, { type: "sessionName", sessionId: "replacement", name: "New session", cwd: "/work" });
    input.value += " while starting";
    dispatch(h.window, { type: "composerDraftSession", draftId, sessionId: "replacement" });
    dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: [], deepseekHarness: "minimal", deepseekHarnessContext: { ...identity, sessionId: "replacement", generation: 3 } });
    dispatch(h.window, { type: "sessionName", sessionId: "replacement", name: "New session", cwd: "/work" });
    expect(input.value).toBe("keep my draft while starting");
    expect(select(h).value).toBe("minimal");
    expect(select(h).disabled).toBe(false);
  });
  it("keeps the draft when a harness replacement is refused", () => {
    const h = setup(); const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "keep this";
    const control = select(h); control.value = "minimal"; control.dispatchEvent(new h.window.Event("change"));
    const draftId = h.posted.at(-1)!.draftId;
    dispatch(h.window, { type: "composerDraftSession", draftId, sessionId: "s" });
    dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: ["agent", "yolo"], deepseekHarness: "default", deepseekHarnessContext: identity });
    dispatch(h.window, { type: "sessionName", sessionId: "s", name: "New session", cwd: "/work" });
    expect(input.value).toBe("keep this"); expect(select(h).disabled).toBe(false);
  });
  it("shows the locked choice and the new-session note without an action", () => {
    const h = setup(false, "default", true);
    expect(select(h).disabled).toBe(true);
    expect(h.doc.getElementById("context-popover")!.textContent).toContain("Start a new session to use a different DeepSeek harness.");
    expect(h.doc.querySelector('[data-deepseek-new-harness]')).toBeNull();
    expect(h.posted.some(m => m.type === "setDeepSeekHarness")).toBe(false);
  });
  it("refuses a popup choice captured for an old model", () => {
    const h = setup(); const old = select(h);
    dispatch(h.window, { type: "modelChanged", modelId: "new-model" });
    old.value = "minimal"; old.dispatchEvent(new h.window.Event("change"));
    expect(h.posted.some(m => m.type === "setDeepSeekHarness")).toBe(false);
    expect(h.doc.querySelector("#deepseek-harness")).toBeNull();
  });
  it("draws and sends nothing before advertisement", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "deepseek-login", provider: "deepseek" });
    expect(h.doc.querySelector('[data-act="deepseekConnect"]')).toBeNull();
    expect(h.posted.some(m => JSON.stringify(m).includes("deepseek"))).toBe(false);
  });
  it("shares install progress and clears a submitted key", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "deepseek", connected: false, keySource: "saved" }] });
    dispatch(h.window, { type: "onboarding", state: "missing-deepseek", provider: "deepseek" });
    click(h.window, h.doc.querySelector('[data-act="installDeepSeek"]'));
    expect(h.posted).toContainEqual({ type: "installDeepSeek" });
    dispatch(h.window, { type: "agyInstallProgress", provider: "deepseek", phase: "downloading", receivedBytes: 25, totalBytes: 100 });
    expect(h.doc.body.textContent).toContain("Downloading DeepSeek (25%)");
    dispatch(h.window, { type: "onboarding", state: "deepseek-login", provider: "deepseek" });
    const field = h.doc.querySelector('.connect-wizard-body .onb-deepseek-key') as HTMLInputElement;
    field.value = "new-key"; click(h.window, field.parentElement!.querySelector('[data-act="deepseekConnect"]'));
    expect(field.value).toBe(""); expect(h.posted).toContainEqual({ type: "deepseekConnect", key: "new-key" });
    expect(h.doc.body.textContent).toContain("saved key");
  });
  it("animates installation with the shared dots and omits download percentages during npm ci", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "deepseek", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "missing-deepseek", provider: "deepseek" });
    dispatch(h.window, { type: "agyInstallProgress", provider: "deepseek", phase: "installing", receivedBytes: 100, totalBytes: 100 });
    const progress = h.doc.querySelector(".onb-install-progress")!;
    expect(progress.textContent).toContain("Installing DeepSeek");
    expect(progress.querySelectorAll(".blink-dots span")).toHaveLength(3);
    expect(progress.querySelector("progress")).toBeNull();
    expect(progress.textContent).not.toContain("100%");
    click(h.window, progress.querySelector('[data-act="cancelDeepSeekInstall"]'));
    expect(h.posted).toContainEqual({ type: "cancelDeepSeekInstall" });
  });
  it("offers only Connect when the environment supplies the key", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "deepseek", connected: false, keySource: "environment" }] });
    dispatch(h.window, { type: "onboarding", state: "deepseek-login", provider: "deepseek" });
    expect(h.doc.querySelector(".onb-deepseek-key")).toBeNull();
    expect(h.doc.body.textContent).toContain("Uses the key from the DEEPSEEK_API_KEY environment variable");
    const button = h.doc.querySelector('[data-act="deepseekConnect"]')!;
    expect(button.textContent).toBe("Connect");
    click(h.window, button);
    expect(h.posted).toContainEqual({ type: "deepseekConnect" });
  });
  it("omits subscription placeholders for DeepSeek while retaining them for Grok", () => {
    const h = setup();
    dispatch(h.window, { type: "subscriptionUsage", windows: [] });
    select(h);
    const popup = h.doc.getElementById("context-popover")!;
    expect(popup.querySelector(".subscription-usage")).toBeNull();
    expect(popup.textContent).not.toMatch(/Subscription usage|No subscription usage|Counted by the CLI/);
    dispatch(h.window, { type: "session", sessionId: "g", provider: "grok", models: [] });
    expect(popup.querySelector(".subscription-usage")).not.toBeNull();
  });
  it.each([false, true])("explains that manual Compact is unavailable over ACP (remote=%s)", remote => {
    const h = setup(remote);
    dispatch(h.window, { type: "contextUsage", used: 40000, window: 1000000 });
    select(h);
    const popup = h.doc.getElementById("context-popover")!;
    expect(popup.querySelector(".context-compact")).toBeNull();
    expect(popup.textContent).toContain("Manual compaction is unavailable through DeepSeek's ACP connection.");
    expect(h.posted.some(m => m.type === "send" && m.text === "/compact")).toBe(false);
  });
  it.each([false, true])("announces Minimal's full access but not Default's Windows shell (remote=%s)", remote => {
    // Owner, 2026-11-03: the unsandboxed Default shell is not announced.
    const h = setup(remote);
    dispatch(h.window, { type: "modeChanged", modeId: "agent", deepseekHarness: "default", deepseekShellUnsandboxed: true });
    const banner = h.doc.getElementById("deepseek-full-access")!;
    expect(banner.hidden).toBe(true);
    dispatch(h.window, { type: "modeChanged", modeId: "agent", deepseekHarness: "minimal", deepseekShellUnsandboxed: false });
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe("Minimal runs with full access to files and shell commands, without approval prompts.");
  });
  it("orders DeepSeek's advertised efforts Off, Low, High, Max", () => {
    const h = setup(false);
    const value = '["deepseek-official","deepseek-v4-flash"]';
    dispatch(h.window, { type: "session", sessionId: "s-effort", provider: "deepseek", currentModelId: value,
      models: [{ modelId: value, name: "DeepSeek V4 Flash", reasoningEfforts: ["low", "high", "off", "max"] }] });
    click(h.window, h.doc.getElementById("gear-btn")!);
    const stops = [...h.doc.querySelectorAll(".effort-strip-stop")] as HTMLElement[];
    expect(stops.map(s => s.dataset.effort)).toEqual(["off", "low", "high", "max"]);
  });
  it.each([490, 250])("bounds the locked popup to a %spx panel and allows its copy to wrap", width => {
    const h = setup(false, "minimal", true);
    const popup = h.doc.getElementById("context-popover")!;
    // Happy DOM has no layout engine: verify the real positioning code's panel
    // bound, and the shipped wrapping rules. A rendered right-edge check needs
    // VS Code/Chromium, not a fabricated getBoundingClientRect for this popup.
    popup.parentElement!.getBoundingClientRect = () => ({ width, left: 0, right: width, top: 400, bottom: 600 } as DOMRect);
    select(h);
    expect(popup.style.right).toBe("6px");
    expect(popup.style.left).toBe("auto");
    expect(popup.style.getPropertyValue("--context-panel-width")).toBe(`${width - 12}px`);
    expect(popup.querySelector('[data-deepseek-new-harness]')).toBeNull();
    const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    expect(css).toMatch(/#context-popover\s*\{[^}]*max-width:\s*min\(350px, var\(--context-panel-width/s);
    expect(css).toMatch(/#context-popover \.context-compact\s*\{[^}]*white-space: normal;[^}]*height: auto/s);
    expect(css).toMatch(/#context-popover \.popover-info\s*\{[^}]*white-space: normal/s);
  });
  it.each(["Enter", "button"])("keeps text and a carried image without going busy on %s", gesture => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }, { id: "deepseek", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "empty", provider: "grok", models: [] });
    const chip = { id: "image", path: "/image.png", relPath: "Image #1", imageIndex: 1, mimeType: "image/png" };
    dispatch(h.window, { type: "chips", chips: [chip] });
    dispatch(h.window, { type: "session", sessionId: "deepseek", provider: "deepseek", models: [] });
    dispatch(h.window, { type: "setBusy", value: false });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "Keep this typed text";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    if (gesture === "Enter") input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    else click(h.window, h.doc.getElementById("send-btn"));
    expect(input.value).toBe("Keep this typed text");
    expect(h.posted.some(m => m.type === "send" || m.type === "queueSend")).toBe(false);
    expect(h.doc.body.textContent).toContain("Remove the image to send this message");
    expect(h.doc.getElementById("send-btn")!.classList.contains("busy")).toBe(false);
    dispatch(h.window, { type: "chips", chips: [] });
    click(h.window, h.doc.getElementById("send-btn"));
    expect(h.posted).toContainEqual({ type: "send", text: "Keep this typed text" });
    expect(input.value).toBe("");
  });
  it("shows full access with no approval control, including a cold remote reopen", () => {
    const h = setup(true, "minimal", true);
    expect(h.doc.getElementById("mode-btn")!.hidden).toBe(true);
    expect(h.doc.getElementById("deepseek-full-access")!.hidden).toBe(false);
    expect(select(h).disabled).toBe(true);
    dispatch(h.window, { type: "onboarding", state: "deepseek-login", provider: "deepseek" });
    expect(h.doc.querySelector('[data-act="deepseekConnect"]')).toBeNull();
  });
  it("withdraws the provider and its controls when the host stops advertising it", () => {
    const h = setup();
    const control = select(h);
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }] });
    expect(h.doc.querySelector("#deepseek-harness")).toBeNull();
    control.value = "minimal"; control.dispatchEvent(new (h.window as any).Event("change"));
    expect(h.posted.some(m => m.type === "setDeepSeekHarness")).toBe(false);
  });
});
