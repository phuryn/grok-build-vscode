import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

describe.each(["desktop", "vscode", "remote"])("composer session drafts (%s)", (surface) => {
  function setup() {
    const h = bootWebview({
      remote: surface === "remote",
      beforeScripts: (window) => { (window as any).grokDesktopShell = surface === "desktop"; },
    });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    const focus = (sessionId: string) => dispatch(h.window, {
      type: "sessionName", sessionId, name: sessionId, cwd: "/repo",
    });
    return { ...h, input, focus };
  }

  it("restores independent drafts across repeated switches and transcript resets", () => {
    const { window, input, focus } = setup();
    focus("a");
    input.value = "draft A\nwith context";
    dispatch(window, { type: "clearMessages" });
    focus("b");
    expect(input.value).toBe("");
    input.value = "draft B";
    focus("a");
    expect(input.value).toBe("draft A\nwith context");
    focus("b");
    expect(input.value).toBe("draft B");
    input.value = "";
    focus("a");
    focus("b");
    expect(input.value).toBe("");
  });

  it("does not clear a draft on same-session replay or rename", () => {
    const { window, input, focus } = setup();
    focus("a");
    input.value = "keep me";
    dispatch(window, { type: "clearMessages" });
    focus("a");
    dispatch(window, { type: "sessions", entries: [], activeId: "a" });
    expect(input.value).toBe("keep me");
  });

  it("also switches on host session lists before the name frame arrives", () => {
    const { window, input, focus } = setup();
    focus("a");
    input.value = "A";
    dispatch(window, { type: "sessions", entries: [], activeId: "b" });
    expect(input.value).toBe("");
    input.value = "B";
    focus("b");
    expect(input.value).toBe("B");
    focus("a");
    expect(input.value).toBe("A");
  });

  it("starts New empty and keeps text typed before the new id arrives", () => {
    const { doc, window, input, focus } = setup();
    focus("a");
    input.value = "old draft";
    (doc.getElementById("new-btn") as HTMLButtonElement).click();
    expect(input.value).toBe("");
    input.value = "new draft";
    dispatch(window, { type: "clearMessages" });
    focus("a"); // A delayed identity for the session being left.
    expect(input.value).toBe("new draft");
    focus("new");
    expect(input.value).toBe("new draft");
    focus("a");
    expect(input.value).toBe("old draft");
    focus("new");
    expect(input.value).toBe("new draft");
  });

  it("does not restore text that has already been sent", () => {
    const { doc, window, input, focus } = setup();
    focus("a");
    input.value = "send this";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    (doc.getElementById("send-btn") as HTMLButtonElement).click();
    expect(input.value).toBe("");
    focus("b");
    focus("a");
    expect(input.value).toBe("");
  });

  it("keeps input typed before the initial session identity", () => {
    const { input, focus } = setup();
    input.value = "first prompt";
    focus("a");
    expect(input.value).toBe("first prompt");
    focus("b");
    expect(input.value).toBe("");
  });
});
