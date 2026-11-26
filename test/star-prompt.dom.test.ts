import { describe, expect, it, vi } from "vitest";
import { desktopChromeBootSource } from "../src/desktop/electron-webview";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const ID = "star-offer";
const REPO = "https://github.com/phuryn/grok-build-vscode";

const frame = (h: Harness, phase: "check" | "offer" | "thanks" | "close", login?: string) =>
  dispatch(h.window, { type: "starPrompt", id: ID, phase, login });
const actions = (h: Harness) => h.posted.filter(msg => msg.type === "starPromptAction");
const action = (action: string) => ({ type: "starPromptAction", id: ID, action });
const card = (h: Harness) => h.doc.querySelector(".star-card");

function show(h: Harness, login?: string) {
  frame(h, "check");
  expect(actions(h)).toEqual([action("ready")]);
  expect(card(h)).toBeNull();
  frame(h, "offer", login);
  expect(actions(h)).toEqual([action("ready"), action("shown")]);
  return card(h)!;
}

describe("Star on GitHub renderer", () => {
  it("ignores an offer in a conversation editor", () => {
    const h = bootWebview({
      vscode: true,
      beforeScripts: window => { window.document.body.dataset.editorChat = "true"; },
    });
    dispatch(h.window, { type: "editorChatBound", binding: 1 });
    frame(h, "check");
    frame(h, "offer", "octocat");
    expect(card(h)).toBeNull();
    expect(h.posted.some(msg => msg.type === "editorChatAction")).toBe(false);
  });

  it("places one labelled offer at the top of the composer without taking focus", () => {
    const h = bootWebview({ vscode: true });
    const input = h.doc.getElementById("input")!;
    input.focus();
    const el = show(h, "octocat");
    expect(el.getAttribute("role")).toBe("region");
    expect(el.getAttribute("aria-label")).toBe("Star AFK Pilot on GitHub");
    expect(el.parentElement?.matches("footer.composer")).toBe(true);
    expect(el.previousElementSibling).toBeNull();
    expect(h.doc.activeElement).toBe(input);
    expect(el.querySelector(".star-copy")?.textContent).toContain(
      "Enjoying AFK Pilot? A star on GitHub helps other developers find it.",
    );
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.map(b => [b.textContent, b.tabIndex])).toEqual([["Star as @octocat", 0], ["Not now", 0]]);
    expect(buttons[1].classList.contains("onb-secondary")).toBe(true);
    const link = el.querySelector("a")!;
    expect(link.textContent).toBe("Open GitHub instead");
    expect(link.href).toBe(REPO);
    frame(h, "offer", "octocat");
    expect(h.doc.querySelectorAll(".star-card")).toHaveLength(1);
    expect(actions(h)).toHaveLength(2);
  });

  it("stars only once and renders the dismissible thanks status", () => {
    const h = bootWebview();
    const el = show(h, "octocat");
    click(h.window, el.querySelector("button")!);
    click(h.window, el.querySelector("button")!);
    click(h.window, el.querySelector("a")!);
    expect(actions(h)).toEqual([action("ready"), action("shown"), action("star")]);
    frame(h, "thanks", "octocat");
    expect(card(h)?.getAttribute("role")).toBe("status");
    expect(card(h)?.textContent).toBe("Starred as @octocat. Thank you!");
    const close = card(h)?.querySelector("button")!;
    expect(close.getAttribute("aria-label")).toBe("Close");
    click(h.window, close);
    expect(actions(h).at(-1)).toEqual(action("dismiss"));
    expect(card(h)).toBeNull();
  });

  it.each([
    [undefined, "button", "Star on GitHub", "open"],
    ["octocat", "a", "Open GitHub instead", "open"],
    ["octocat", ".onb-secondary", "Not now", "dismiss"],
  ] as const)("handles %s mode with %s", (login, selector, label, result) => {
    const h = bootWebview();
    const el = show(h, login);
    if (!login) expect(el.querySelector(".star-alt")).toBeNull();
    const control = el.querySelector(selector)!;
    expect(control.textContent).toBe(label);
    click(h.window, control);
    expect(actions(h).at(-1)).toEqual(action(result));
    expect(h.posted.filter(msg => msg.type === "openUrl")).toEqual([]);
    expect(card(h)).toBeNull();
  });

  it("does not acknowledge a show when a draft is already present or appears during the auth read", () => {
    const h = bootWebview();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "draft";
    frame(h, "check");
    frame(h, "offer", "octocat");
    expect(card(h)).toBeNull();
    expect(actions(h)).toEqual([]);
    input.value = "";
    frame(h, "check");
    expect(actions(h)).toEqual([action("ready")]);
    input.value = "new draft";
    frame(h, "offer", "octocat");
    expect(card(h)).toBeNull();
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
  });

  it("cancels the pending offer immediately when the user types into the draft", () => {
    const h = bootWebview();
    frame(h, "check");
    expect(actions(h)).toEqual([action("ready")]);
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "new draft";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
    frame(h, "offer", "octocat");
    expect(card(h)).toBeNull();
  });

  it("keeps the transcript position for a reader who has scrolled up", () => {
    const h = bootWebview();
    const messages = h.doc.getElementById("messages")!;
    Object.defineProperties(messages, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 200 },
    });
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    messages.dispatchEvent(new h.window.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    messages.scrollTop = 500;
    messages.dispatchEvent(new h.window.Event("scroll"));
    expect(messages.classList.contains("stick-to-bottom")).toBe(false);
    expect(show(h)).toBeTruthy();
    expect(messages.scrollTop).toBe(500);
  });

  it("never renders on the remote webview", () => {
    const local = bootWebview();
    expect(show(local, "octocat")).toBeTruthy();
    const remote = bootWebview({ remote: true });
    frame(remote, "check");
    frame(remote, "offer", "octocat");
    frame(remote, "thanks", "octocat");
    expect(actions(remote)).toEqual([]);
    expect(card(remote)).toBeNull();
  });

  it("makes no offer while an update waits", () => {
    const h = bootWebview();
    frame(h, "check");
    dispatch(h.window, { type: "updateReady", version: "99.0.0" });
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
    frame(h, "check");
    frame(h, "offer", "octocat");
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
    expect(card(h)).toBeNull();
  });

  it("appears in the desktop app, which wraps the transcript and adds fades after it", () => {
    const h = bootWebview();
    new Function("document", "window", "requestAnimationFrame", `return ${desktopChromeBootSource()}`)(h.doc, h.window, () => 0);
    const wrap = h.doc.getElementById("messages-wrap")!;
    expect(h.doc.getElementById("messages")!.nextElementSibling?.matches(".msg-fade")).toBe(true);
    const el = show(h, "octocat");
    // What chat.css relies on to hide the card while an approval waits.
    expect(el.parentElement?.parentElement).toBe(wrap.parentElement);
    expect(wrap.compareDocumentPosition(el) & 4).toBe(4);
  });

  it("makes no offer behind a confirmation", () => {
    const h = bootWebview();
    frame(h, "check");
    expect(actions(h)).toEqual([action("ready")]);
    dispatch(h.window, { type: "uiConfirmRequest", id: "confirm", title: "Rewind?", confirmLabel: "Rewind" });
    expect(h.doc.querySelector(".confirm-overlay")).toBeTruthy();
    frame(h, "offer", "octocat");
    expect(card(h)).toBeNull();
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
    frame(h, "check");
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
  });

  it("makes no offer while a permission waits", () => {
    const h = bootWebview();
    frame(h, "check");
    dispatch(h.window, {
      type: "permissionRequest",
      req: {
        id: 1, toolCall: { toolCallId: "tool", title: "Run a command" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    });
    expect(h.doc.querySelector(".card.permission")).toBeTruthy();
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
    frame(h, "check");
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
    expect(card(h)).toBeNull();
  });

  it("stays up through a new turn, a draft and a conversation switch until a button answers it", () => {
    const h = bootWebview();
    const el = show(h, "octocat");
    dispatch(h.window, { type: "agentStart" });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "draft";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    dispatch(h.window, { type: "clearMessages" });
    expect(card(h)).toBe(el);
    expect(el.parentElement?.matches("footer.composer")).toBe(true);
    expect(actions(h)).toEqual([action("ready"), action("shown")]);
    click(h.window, el.querySelector(".onb-secondary")!);
    expect(actions(h).at(-1)).toEqual(action("dismiss"));
    expect(card(h)).toBeNull();
  });

  it("closes on a failed star result", () => {
    const h = bootWebview();
    const el = show(h, "octocat");
    click(h.window, el.querySelector("button")!);
    frame(h, "close");
    expect(card(h)).toBeNull();
  });

  it("drops a pending offer when the conversation changes", () => {
    const h = bootWebview();
    frame(h, "check");
    dispatch(h.window, { type: "clearMessages" });
    frame(h, "offer", "octocat");
    expect(card(h)).toBeNull();
    expect(actions(h)).toEqual([action("ready"), action("dismiss")]);
  });
});

it.each(["VS Code tab", "desktop overlay", "remote overlay"])("shows the same browser link in the %s About row", surface => {
  const { window, doc } = bootWebview();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const remote = surface === "remote overlay";
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const post = vi.fn();
  const { GrokSettings } = window as unknown as {
    GrokSettings: { mount: (container: Element, opts: unknown) => { dispose: () => void } };
  };
  const settings = GrokSettings.mount(container, {
    standalone: surface === "VS Code tab",
    category: "about",
    env: { isRemote: remote, isDesktop: surface === "desktop overlay" },
    post,
  });
  try {
    const row = container.querySelector('[data-id="aboutRepo"]')!;
    expect(row.querySelector(".settings-row-title")?.textContent).toBe("Star on GitHub");
    expect(row.querySelector(".settings-row-desc")?.textContent).toBe("phuryn/grok-build-vscode");
    const button = row.querySelector(".settings-action")!;
    expect(button.textContent).toBe("Open");
    click(window, button);
    if (remote) expect(open).toHaveBeenCalledWith(REPO, "_blank", "noopener");
    else expect(post).toHaveBeenCalledWith({ type: "openUrl", url: REPO });
  } finally {
    settings.dispose();
    open.mockRestore();
  }
});
