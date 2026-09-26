import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const CHAT_CSS = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");

const MUSE_AGENT = "Follows Muse Code's own approval rules";
const MUSE_YOLO = "Answers every approval Muse Code raises. This may look the same as Agent, because Muse Code asks rarely by default";
const PLAN_REASON = "Plan mode requires a newer CLI.";

function connect(h: ReturnType<typeof bootWebview>) {
  dispatch(h.window, { type: "providerState", providers: [
    { id: "grok", connected: true },
    { id: "claude", connected: true },
    { id: "codex", connected: true },
    { id: "muse", connected: true },
  ] });
}

function labelsOf(doc: Document): string[] {
  return [...doc.querySelectorAll("#mode-popover .mode-item-label")].map((el) => el.textContent || "");
}

function descsOf(doc: Document): string[] {
  return [...doc.querySelectorAll("#mode-popover .mode-item-desc")].map((el) => el.textContent || "");
}

function openModes(h: ReturnType<typeof bootWebview>) {
  const pop = h.doc.getElementById("mode-popover") as HTMLElement;
  if (pop.hidden) click(h.window, h.doc.getElementById("mode-btn")!);
  return pop;
}

describe("Muse Agent / Auto accept", () => {
  it("lists only Agent and Auto accept, and names Muse, when modes is present", () => {
    const h = bootWebview();
    connect(h);
    dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: ["agent", "yolo"] });
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", currentModelId: "m", models: [] });
    dispatch(h.window, { type: "planModeAvailability", available: false, reason: PLAN_REASON });

    const button = h.doc.getElementById("mode-btn") as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    expect(button.title).not.toContain(PLAN_REASON);
    openModes(h);
    expect(labelsOf(h.doc)).toEqual(["Agent mode", "Auto accept"]);
    expect(descsOf(h.doc)).toEqual([MUSE_AGENT, MUSE_YOLO]);
    expect(h.doc.querySelector(".mode-item-disabled-note")).toBeNull();

    const yolo = [...h.doc.querySelectorAll(".mode-popover-item")]
      .find((el) => el.querySelector(".mode-item-label")?.textContent === "Auto accept") as HTMLElement;
    click(h.window, yolo);
    expect(h.posted).toContainEqual({ type: "setMode", modeId: "yolo" });
  });

  it("hides the Muse button when an older host omits modes", () => {
    const h = bootWebview();
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", currentModelId: "m", models: [] });
    dispatch(h.window, { type: "modeChanged", modeId: "agent" });

    const button = h.doc.getElementById("mode-btn") as HTMLButtonElement;
    expect(button.hidden).toBe(true);
    click(h.window, button);
    expect((h.doc.getElementById("mode-popover") as HTMLElement).hidden).toBe(true);
    expect(h.posted.some((message) => message.type === "setMode")).toBe(false);
  });

  it.each(["mode-first", "session-first"] as const)(
    "shows Grok's button with Plan after leaving Muse (%s, modes present)",
    (order) => {
      const h = bootWebview();
      connect(h);
      dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: ["agent", "yolo"] });
      dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", currentModelId: "m", models: [] });
      const mode = { type: "modeChanged", modeId: "agent", modes: ["agent", "plan", "yolo"] };
      const session = { type: "session", sessionId: "g", provider: "grok", currentModelId: "g", models: [] };
      for (const message of order === "mode-first" ? [mode, session] : [session, mode]) {
        dispatch(h.window, message);
      }

      const button = h.doc.getElementById("mode-btn") as HTMLButtonElement;
      expect(button.hidden).toBe(false);
      openModes(h);
      expect(labelsOf(h.doc)).toEqual(["Agent mode", "Plan mode", "Auto accept"]);
      expect(descsOf(h.doc)[0]).toContain("Grok");
      expect(descsOf(h.doc).join(" ")).not.toContain("Muse");
    },
  );

  it.each(["mode-first", "session-first"] as const)(
    "shows Grok's button with Plan after leaving Muse (%s, older host, no modes)",
    (order) => {
      const h = bootWebview();
      connect(h);
      dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", currentModelId: "m", models: [] });
      expect((h.doc.getElementById("mode-btn") as HTMLButtonElement).hidden).toBe(true);
      const mode = { type: "modeChanged", modeId: "agent" };
      const session = { type: "session", sessionId: "g", provider: "grok", currentModelId: "g", models: [] };
      for (const message of order === "mode-first" ? [mode, session] : [session, mode]) {
        dispatch(h.window, message);
      }

      const button = h.doc.getElementById("mode-btn") as HTMLButtonElement;
      expect(button.hidden).toBe(false);
      openModes(h);
      expect(labelsOf(h.doc)).toContain("Plan mode");
      expect(descsOf(h.doc).join(" ")).toContain("Grok");
    },
  );

  it("names Claude from an advertised mode list", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: ["agent", "plan", "yolo"] });
    dispatch(h.window, { type: "session", sessionId: "c", provider: "claude", currentModelId: "c", models: [] });
    openModes(h);
    expect(labelsOf(h.doc)).toEqual(["Agent mode", "Plan mode", "Auto accept"]);
    expect(descsOf(h.doc).every((desc) => desc.startsWith("Claude"))).toBe(true);
  });

  it("keeps a hidden toolbar button from painting", () => {
    expect(CHAT_CSS).toMatch(/#mode-btn\[hidden\],\s*\.toolbar-btn\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
    const h = bootWebview();
    const style = h.doc.createElement("style");
    style.textContent = CHAT_CSS;
    h.doc.head.appendChild(style);
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", currentModelId: "m", models: [] });

    const mode = h.doc.getElementById("mode-btn") as HTMLButtonElement;
    const gear = h.doc.getElementById("gear-btn") as HTMLButtonElement;
    expect(mode.hidden).toBe(true);
    expect(h.window.getComputedStyle(mode).display).toBe("none");
    gear.hidden = true;
    expect(h.window.getComputedStyle(gear).display).toBe("none");
    gear.hidden = false;
    expect(h.window.getComputedStyle(gear).display).not.toBe("none");
  });
});
