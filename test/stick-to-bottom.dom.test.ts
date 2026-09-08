import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const exec = {
  type: "toolCall",
  call: {
    toolCallId: "big-output",
    kind: "execute",
    title: "Run node",
    rawInput: { command: "node big-output.js" },
  },
};

function bootWithGeometry() {
  let scrollHeight = 1000;
  const harness = bootWebview({
    beforeScripts(window) {
      const messages = window.document.getElementById("messages")!;
      Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeight });
      messages.scrollTop = 800;
    },
  });
  return { ...harness, grow: () => { scrollHeight = 1800; } };
}

function wheelUp(window: Window, messages: HTMLElement) {
  messages.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
}

describe("stick-to-bottom after expanded tool detail growth (#92)", () => {
  it("keeps following when the reader was already at the bottom", async () => {
    const { window, doc, grow } = bootWithGeometry();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    const messages = doc.getElementById("messages") as HTMLElement;
    messages.dispatchEvent(new window.Event("scroll"));
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    dispatch(window, exec);
    grow();
    dispatch(window, {
      type: "commandOutput",
      command: "node big-output.js",
      output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
      exitCode: 0,
      truncated: false,
    });

    await vi.waitFor(() => {
      expect(messages.scrollTop).toBe(1800);
    });
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(false);
  });

  it("stays pinned when content grows and a non-gesture scroll event fires", async () => {
    const { window, doc, grow } = bootWithGeometry();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    const messages = doc.getElementById("messages") as HTMLElement;
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    dispatch(window, exec);
    grow();
    // Browser / focus / programmatic scroll after growth — not a user wheel.
    // Distance is 800px, well past any line-height threshold; the pin must hold.
    messages.dispatchEvent(new window.Event("scroll"));
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(false);
    dispatch(window, {
      type: "commandOutput",
      command: "node big-output.js",
      output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
      exitCode: 0,
      truncated: false,
    });
    await vi.waitFor(() => {
      expect(messages.scrollTop).toBe(1800);
    });
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(false);
  });

  it("preserves position when the reader deliberately scrolled up", async () => {
    const { window, doc, grow } = bootWithGeometry();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    dispatch(window, exec);
    const messages = doc.getElementById("messages") as HTMLElement;
    wheelUp(window, messages);
    messages.scrollTop = 500;
    messages.dispatchEvent(new window.Event("scroll"));
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(true);
    expect(messages.classList.contains("stick-to-bottom")).toBe(false);

    grow();
    dispatch(window, {
      type: "commandOutput",
      command: "node big-output.js",
      output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
      exitCode: 0,
      truncated: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages.scrollTop).toBe(500);
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(true);
  });

  it("permission-card focus does not unpin a pinned reader", () => {
    const { window, doc } = bootWithGeometry();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    const messages = doc.getElementById("messages") as HTMLElement;
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: "stick-perm",
        toolCall: { toolCallId: "tc", kind: "execute", title: "Run node" },
        options: [
          { optionId: "allow", name: "Yes", kind: "allow_once" },
          { optionId: "rej", name: "No", kind: "reject_once" },
        ],
      },
    });
    // focus() / card insertion can emit a scroll with a large distance; that
    // must not clear the pin the force-scroll just set.
    messages.dispatchEvent(new window.Event("scroll"));
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(false);
    expect(doc.querySelector(".card.permission .card-actions button.primary")).toBeTruthy();
  });

  it("re-pins when the reader wheels back to the bottom", () => {
    const { window, doc } = bootWithGeometry();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    const messages = doc.getElementById("messages") as HTMLElement;
    wheelUp(window, messages);
    messages.scrollTop = 500;
    messages.dispatchEvent(new window.Event("scroll"));
    expect(messages.classList.contains("stick-to-bottom")).toBe(false);
    messages.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 80, bubbles: true }));
    messages.scrollTop = 800;
    messages.dispatchEvent(new window.Event("scroll"));
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(false);
  });
});
