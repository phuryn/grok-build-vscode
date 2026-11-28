import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bootWebview, dispatch } from "./webview-harness";

/**
 * Desktop boot-layout race: CSS `--chat-zoom` must apply before the first
 * composer focus, that focus must not scroll the document, and only the
 * desktop shell resets html scroll after chrome wrap / resize.
 */

describe("desktop boot layout (zoom + preventScroll)", () => {
  it("applies --chat-zoom before boot focus and uses preventScroll", () => {
    const order: string[] = [];
    const { doc } = bootWebview({
      beforeScripts(w) {
        const input = w.document.getElementById("input") as HTMLTextAreaElement;
        const origFocus = input.focus.bind(input);
        input.focus = function (opts?: FocusOptions) {
          order.push(opts?.preventScroll ? "focus:prevent" : "focus");
          return origFocus(opts);
        };
        const origSet = w.document.body.style.setProperty.bind(w.document.body.style);
        w.document.body.style.setProperty = function (key: string, value: string, priority?: string) {
          if (key === "--chat-zoom") order.push("zoom");
          return origSet(key, value, priority);
        };
      },
    });
    expect(order[0]).toBe("zoom");
    expect(order).toContain("focus:prevent");
    expect(order.indexOf("zoom")).toBeLessThan(order.indexOf("focus:prevent"));
    expect(doc.documentElement.scrollTop).toBe(0);
    expect(doc.documentElement.scrollLeft).toBe(0);
  });

  it("window-focus handler focuses the composer with preventScroll", () => {
    const calls: Array<FocusOptions | undefined> = [];
    const { window, doc } = bootWebview({
      beforeScripts(w) {
        const input = w.document.getElementById("input") as HTMLTextAreaElement;
        const origFocus = input.focus.bind(input);
        input.focus = function (opts?: FocusOptions) {
          calls.push(opts);
          return origFocus(opts);
        };
      },
    });
    const input = doc.getElementById("input") as HTMLElement;
    input.blur();
    expect(doc.activeElement === doc.body || !doc.activeElement).toBe(true);
    calls.length = 0;
    window.dispatchEvent(new window.Event("focus"));
    expect(calls[0]).toEqual({ preventScroll: true });
    expect(doc.activeElement).toBe(input);
  });

  it("desktop resize and the chrome-wrap hook reset documentElement scroll", () => {
    const { window, doc } = bootWebview({
      beforeScripts(w) {
        (w as unknown as { grokDesktopShell: boolean }).grokDesktopShell = true;
      },
    });
    expect(typeof (window as unknown as { __grokResetDocumentScroll?: unknown }).__grokResetDocumentScroll)
      .toBe("function");
    doc.documentElement.scrollTop = 40;
    doc.documentElement.scrollLeft = 12;
    window.dispatchEvent(new window.Event("resize"));
    expect(doc.documentElement.scrollTop).toBe(0);
    expect(doc.documentElement.scrollLeft).toBe(0);

    doc.documentElement.scrollTop = 40;
    (window as unknown as { __grokResetDocumentScroll: () => void }).__grokResetDocumentScroll();
    expect(doc.documentElement.scrollTop).toBe(0);
  });

  it("VS Code webview does not expose the desktop scroll hook or reset on resize", () => {
    const { window, doc } = bootWebview();
    expect((window as unknown as { __grokResetDocumentScroll?: unknown }).__grokResetDocumentScroll)
      .toBeUndefined();
    doc.documentElement.scrollTop = 40;
    window.dispatchEvent(new window.Event("resize"));
    expect(doc.documentElement.scrollTop).toBe(40);
  });
});

function bootDesktop() {
  return bootWebview({
    beforeScripts(w) {
      (w as unknown as { grokDesktopShell: boolean }).grokDesktopShell = true;
    },
  });
}

function restoreConversation(window: Window, text = "kept from disk") {
  dispatch(window, { type: "clearMessages" });
  dispatch(window, { type: "historyReplay", active: true });
  dispatch(window, { type: "userMessage", text });
  dispatch(window, { type: "historyReplay", active: false });
  dispatch(window, {
    type: "sessionName",
    sessionId: "keep-1",
    name: "Keep this",
    cwd: "/work/repo",
  });
}

describe("desktop launch composer focus", () => {
  it("puts the caret in the composer when the desktop app opens", () => {
    const { doc } = bootDesktop();
    expect(doc.activeElement).toBe(doc.getElementById("input"));
  });

  it("puts the caret in the composer when launch restores a conversation", () => {
    // Force the pending-clear hold: a restore of a conversation that is already
    // on screen skips resetSessionChrome (the phone-keyboard path). Desktop
    // launch still has its one shot, taken when that first historyReplay settles.
    const { window, doc } = bootDesktop();
    dispatch(window, { type: "userMessage", text: "kept from disk" });
    const historyBtn = doc.getElementById("history-btn") as HTMLButtonElement;
    historyBtn.focus();
    expect(doc.activeElement).toBe(historyBtn);

    restoreConversation(window);
    expect(doc.activeElement).toBe(doc.getElementById("input"));
    expect(doc.querySelector(".msg.user")?.textContent).toContain("kept from disk");
  });

  it("first window-focus claims the composer even if chrome already has it", () => {
    const { window, doc } = bootDesktop();
    const historyBtn = doc.getElementById("history-btn") as HTMLButtonElement;
    historyBtn.focus();
    expect(doc.activeElement).toBe(historyBtn);
    window.dispatchEvent(new window.Event("focus"));
    expect(doc.activeElement).toBe(doc.getElementById("input"));
  });

  it("a reconnect/resync of an already-open desktop surface does not move focus", () => {
    const { window, doc } = bootDesktop();
    window.dispatchEvent(new window.Event("focus"));
    dispatch(window, { type: "sessionName", sessionId: "keep-1", name: "Keep this", cwd: "/work/repo" });
    dispatch(window, { type: "userMessage", text: "keep me" });
    const historyBtn = doc.getElementById("history-btn") as HTMLButtonElement;
    historyBtn.focus();
    expect(doc.activeElement).toBe(historyBtn);

    restoreConversation(window, "keep me");
    expect(doc.activeElement).toBe(historyBtn);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("keep me");
  });

  it("VS Code window-focus still does not steal from a control the user focused", () => {
    const { window, doc } = bootWebview();
    const historyBtn = doc.getElementById("history-btn") as HTMLButtonElement;
    historyBtn.focus();
    window.dispatchEvent(new window.Event("focus"));
    expect(doc.activeElement).toBe(historyBtn);
  });
});

describe("desktop composer focus border follows the keyboard", () => {
  function bootWithFocus(desktop: boolean, initial: boolean) {
    const focus = { has: initial };
    const harness = bootWebview({
      beforeScripts(w) {
        if (desktop) (w as unknown as { grokDesktopShell: boolean }).grokDesktopShell = true;
        (w.document as unknown as { hasFocus: () => boolean }).hasFocus = () => focus.has;
      },
    });
    return { ...harness, focus };
  }
  const tick = (w: Window) => new Promise<void>(resolve => (w as unknown as { setTimeout: typeof setTimeout }).setTimeout(() => resolve(), 5));
  const unfocused = (doc: Document) => doc.documentElement.classList.contains("desk-page-unfocused");

  it("marks a desktop chat whose page does not have the keyboard, and clears it when it does", async () => {
    // A pane opened beside the chat you are typing in boots without the keyboard.
    const { window, doc, focus } = bootWithFocus(true, false);
    expect(doc.activeElement).toBe(doc.getElementById("input"));
    expect(unfocused(doc)).toBe(true);

    focus.has = true;
    window.dispatchEvent(new window.Event("focus"));
    expect(unfocused(doc)).toBe(false);

    // Another chat (or app) takes the keyboard; the composer stays this page's activeElement.
    focus.has = false;
    window.dispatchEvent(new window.Event("blur"));
    await tick(window);
    expect(unfocused(doc)).toBe(true);
    expect(doc.activeElement).toBe(doc.getElementById("input"));
  });

  it("a blur that only moved focus into a child frame keeps the border", async () => {
    const { window, doc } = bootWithFocus(true, true);
    expect(unfocused(doc)).toBe(false);
    window.dispatchEvent(new window.Event("blur"));
    await tick(window);
    expect(unfocused(doc)).toBe(false);
  });

  it("never marks the VS Code or browser chat", async () => {
    const { window, doc } = bootWithFocus(false, false);
    window.dispatchEvent(new window.Event("blur"));
    await tick(window);
    expect(unfocused(doc)).toBe(false);
  });

  it("chat.css drops the focus border only under the desktop mark", () => {
    const css = readFileSync(path.join(__dirname, "..", "media", "chat.css"), "utf8");
    expect(css).toMatch(/\.composer-card:focus-within\s*\{\s*border-color:\s*var\(--vscode-focusBorder\);/);
    expect(css).toMatch(
      /html\.desk-page-unfocused \.composer-card:focus-within\s*\{\s*border-color:\s*var\(--vscode-input-border, var\(--vscode-editorWidget-border\)\);/,
    );
  });
});
