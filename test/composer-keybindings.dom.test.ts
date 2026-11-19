import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

describe("macOS Emacs composer movement", () => {
  it("moves forward by one character", () => {
    const { window, doc } = bootWebview();
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    input.value = "abcd";
    input.focus();
    input.setSelectionRange(1, 1);

    dispatch(window, { type: "moveComposerCaret", direction: "forward" });

    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it("moves to the previous line and preserves the intended column across short lines", () => {
    const { window, doc } = bootWebview();
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    input.value = "012345\nx\nabcdef";
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    dispatch(window, { type: "moveComposerCaret", direction: "previousLine" });
    expect(input.selectionStart).toBe(8);
    dispatch(window, { type: "moveComposerCaret", direction: "previousLine" });
    expect(input.selectionStart).toBe(6);
  });
});

function composer(h: ReturnType<typeof bootWebview>) {
  const input = h.doc.querySelector("#input") as HTMLTextAreaElement;
  const key = (key: string, options: KeyboardEventInit = {}) => {
    const event = new (h.window as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const type = (text: string) => {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new (h.window as any).Event("input", { bubbles: true }));
  };
  return { input, key, type };
}

describe("composer prompt recall", () => {
  it.each([{}, { vscode: true }, { remote: true }])("walks the rendered conversation in both directions (%j)", surface => {
    const h = bootWebview({
      ...surface,
      beforeScripts: window => {
        if ("remote" in surface) Object.defineProperty(window, "matchMedia", { value: (query: string) => ({ matches: query.includes("pointer: coarse") }) });
      },
    });
    const { input, key, type } = composer(h);
    dispatch(h.window, { type: "session", sessionId: "one", provider: "grok" });
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "userMessageChunk", text: '<vscode-context>\nAttached file: src/example.ts\n</vscode-context>\n\nfirst **prompt**' });
    dispatch(h.window, { type: "messageChunk", text: "answer" });
    dispatch(h.window, { type: "historyReplay", active: false });
    dispatch(h.window, { type: "userMessage", text: "second\nline" });
    dispatch(h.window, { type: "queuedSends", items: ["unsent prompt"] });

    expect(key("ArrowDown")).toBe(false);
    expect(key("ArrowUp")).toBe(true);
    expect(input.value).toBe("second\nline");
    expect(input.selectionStart).toBe(input.value.length);
    key("ArrowUp");
    expect(input.value).toBe("first **prompt**");
    key("ArrowUp");
    expect(input.value).toBe("first **prompt**");
    key("ArrowDown");
    expect(input.value).toBe("second\nline");
    key("ArrowDown");
    expect(input.value).toBe("");
    key("ArrowUp");
    type("second\nline edited");
    expect(key("ArrowUp")).toBe(false);
    expect(key("ArrowDown")).toBe(false);
    expect(input.value).toBe("second\nline edited");
    expect(h.posted.some(p => p.type === "send" || p.type === "queueSend")).toBe(false);
  });

  it("leaves draft and popover navigation, modified keys, and IME keys with their existing owners", () => {
    const h = bootWebview();
    const { input, key, type } = composer(h);
    dispatch(h.window, { type: "userMessage", text: "earlier prompt" });
    expect(key("ArrowUp", { shiftKey: true })).toBe(false);
    expect(key("ArrowUp", { isComposing: true })).toBe(false);
    type("first line\nsecond line");
    expect(key("ArrowUp")).toBe(false);
    dispatch(h.window, { type: "commandsUpdate", commands: [{ name: "plan" }, { name: "review" }] });
    type("/");
    expect(key("ArrowDown")).toBe(true);
    expect(h.doc.querySelector(".slash-item.active")!.textContent).toBe("/review");
    expect(key("ArrowUp")).toBe(true);
    expect(h.doc.querySelector(".slash-item.active")!.textContent).toBe("/plan");
    type("@");
    dispatch(h.window, { type: "mentionResults", query: "", files: ["a.txt", "b.txt"] });
    expect(key("ArrowDown")).toBe(true);
    expect(h.doc.querySelector(".mention-item.active")!.textContent).toContain("b.txt");
    expect(key("ArrowUp")).toBe(true);
    expect(h.doc.querySelector(".mention-item.active")!.textContent).toContain("a.txt");
    expect(input.value).toBe("@");
  });

  it("drops the cursor when a conversation is replaced", () => {
    const h = bootWebview();
    const { input, key } = composer(h);
    dispatch(h.window, { type: "sessionName", sessionId: "one", name: "First", cwd: "/workspace" });
    dispatch(h.window, { type: "userMessage", text: "conversation one" });
    key("ArrowUp");
    expect(input.value).toBe("conversation one");
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "sessionName", sessionId: "two", name: "Second", cwd: "/workspace" });
    dispatch(h.window, { type: "userMessage", text: "conversation two" });
    key("ArrowUp");
    expect(input.value).toBe("conversation two");
    key("ArrowUp");
    expect(input.value).toBe("conversation two");
  });

  it("uses the last acknowledged prompt while a remote send is still pending", () => {
    const h = bootWebview({ remote: true });
    const { input, key, type } = composer(h);
    dispatch(h.window, { type: "userMessage", text: "previous prompt" });
    type("pending prompt");
    click(h.window, h.doc.getElementById("send-btn")!);
    expect(h.doc.querySelector(".msg.user[data-optimistic]")!.textContent).toContain("pending prompt");
    key("ArrowUp");
    expect(input.value).toBe("previous prompt");
  });
});
