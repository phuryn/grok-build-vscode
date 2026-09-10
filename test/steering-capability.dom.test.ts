import { describe, expect, it } from "vitest";
import { bootWebview, dispatch, press } from "./webview-harness";

function initialize(window: any, provider: string, steeringSupported?: boolean) {
  dispatch(window, { type: "initialized", info: { provider, steeringSupported, version: "999.0.0", init: {} } });
  dispatch(window, { type: "session", provider, models: [] });
}

function queue(window: any) {
  dispatch(window, { type: "agentStart" });
  dispatch(window, { type: "queuedSends", items: ["correct course"] });
}

function enter(window: any, doc: Document) {
  const input = doc.getElementById("input") as HTMLTextAreaElement;
  input.value = "correct course";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

describe("Steer uses the focused backend's capability", () => {
  it.each([
    ["grok", true, true], ["grok", false, false],
    ["codex", true, true], ["codex", false, false], ["codex", undefined, false],
    ["claude", false, false], ["claude", undefined, false],
  ] as const)("%s with capability %s offers Steer=%s and preserves attachments", (provider, supported, offered) => {
    const { window, doc, posted } = bootWebview();
    initialize(window, provider, supported);
    dispatch(window, { type: "agentStart" });
    const chip = { id: "img-1", path: "/img.png", relPath: "Image #1", mimeType: "image/png", imageIndex: 1, hidden: false };
    dispatch(window, { type: "queuedSends", items: ["look"], queued: [{ text: "look", chips: [chip] }] });
    const button = doc.querySelector(".queued-steer");
    expect(!!button).toBe(offered);
    if (button) {
      press(window, button);
      expect(posted.find((msg) => msg.type === "steerSend")).toMatchObject({ text: "look", chips: [expect.objectContaining({ id: chip.id })] });
    }
    dispatch(window, { type: "steerByDefault", value: true });
    posted.length = 0;
    enter(window, doc);
    expect(posted.some((msg) => msg.type === "steerSend")).toBe(offered);
    expect(posted.some((msg) => msg.type === "queueSend")).toBe(!offered);
    expect(posted.some((msg) => msg.type === "cancel" || msg.type === "send")).toBe(false);
  });

  it.each([undefined, false, true])("requires the remote host field (%s), regardless of version", (remoteSteering) => {
    const { window, doc, posted } = bootWebview({ remote: true });
    dispatch(window, { type: "initialState", cwd: "/w", extVersion: "999.0.0", capabilities: { remoteSteering }, steerByDefault: true });
    initialize(window, "codex", true);
    queue(window);
    expect(!!doc.querySelector(".queued-steer")).toBe(remoteSteering === true);
    enter(window, doc);
    expect(posted.some((msg) => msg.type === "steerSend")).toBe(remoteSteering === true);
    expect(posted.some((msg) => msg.type === "queueSend")).toBe(remoteSteering !== true);
  });

  it("does not invent a capability from an older host's initialize", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "initialState", cwd: "/w", capabilities: { remoteSteering: true } });
    initialize(window, "codex");
    queue(window);
    expect(doc.querySelector(".queued-steer")).toBeNull();
  });

  it("repaints when the backend capability arrives after the queue", () => {
    const { window, doc } = bootWebview({ ready: false });
    queue(window);
    expect(doc.querySelector(".queued-steer")).toBeNull();
    initialize(window, "codex", true);
    expect(doc.querySelector(".queued-steer")).not.toBeNull();
  });

  it("does not carry a capability or unsupported latch across session switches", () => {
    const { window, doc } = bootWebview();
    initialize(window, "codex", true);
    queue(window);
    dispatch(window, { type: "steerUnavailable" });
    expect(doc.querySelector(".queued-steer")).toBeNull();
    dispatch(window, { type: "clearMessages" });
    initialize(window, "grok", true);
    queue(window);
    expect(doc.querySelector(".queued-steer")).not.toBeNull();
    dispatch(window, { type: "clearMessages" });
    queue(window);
    expect(doc.querySelector(".queued-steer")).toBeNull();
    initialize(window, "claude", false);
    expect(doc.querySelector(".queued-steer")).toBeNull();
  });

  it("does not apply the previous provider's capability before the next initialize", () => {
    const { window, doc } = bootWebview();
    initialize(window, "grok", true);
    queue(window);
    dispatch(window, { type: "session", provider: "codex", models: [] });
    expect(doc.querySelector(".queued-steer")).toBeNull();
  });
});
