import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const CHAT_CSS = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");

const MUSE_AGENT = "Follows Muse Code's own approval rules";
const MUSE_YOLO = "Answers every approval Muse Code raises. This may look the same as Agent, because Muse Code asks rarely by default";
const PLAN_REASON = "Plan mode requires a newer CLI.";
const MUSE_MODES = ["yolo", "agent", "onRequest", "denyUnmatched"];
const MUSE_LABELS = ["Allow all", "Prompt unmatched", "On request", "Deny unmatched"];

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
  it.each([{ vscode: true }, {}, { remote: true }])("uses Muse labels for the cloud host's three advertised choices on %j", surface => {
    const h = bootWebview(surface);
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", models: [] });
    const modes = ["yolo", "agent", "denyUnmatched"];
    const labels = ["Allow all", "Prompt unmatched", "Deny unmatched"];
    for (const [index, modeId] of modes.entries()) {
      dispatch(h.window, { type: "modeChanged", modeId, modes });
      expect(h.doc.getElementById("mode-btn")!.textContent).toBe(labels[index]);
      openModes(h);
      expect(labelsOf(h.doc)).toEqual(labels);
      expect(h.doc.querySelector(".mode-item-disabled-note")).toBeNull();
      click(h.window, h.doc.querySelectorAll(".mode-popover-item")[index]);
      expect(h.posted.at(-1)).toEqual({ type: "setMode", modeId });
    }
    expect(h.posted).not.toContainEqual({ type: "setMode", modeId: "onRequest" });
  });

  it.each([{ vscode: true }, {}, { remote: true }])("offers the four advertised Muse modes on %j", surface => {
    const h = bootWebview(surface);
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", models: [] });
    for (const [index, modeId] of MUSE_MODES.entries()) {
      dispatch(h.window, { type: "modeChanged", modeId, modes: MUSE_MODES });
      expect(h.doc.getElementById("mode-btn")!.textContent).toBe(MUSE_LABELS[index]);
      expect(h.doc.getElementById("mode-btn")!.title).toContain(MUSE_LABELS[index]);
      openModes(h);
      expect(labelsOf(h.doc)).toEqual(MUSE_LABELS);
      expect(descsOf(h.doc)).toEqual([
        "No prompts; everything runs.", "Prompt for anything no rule matches (the interactive default).",
        "Tools run sandboxed; prompt only on explicit permission requests.", "Anything no rule matches is denied.",
      ]);
      click(h.window, h.doc.querySelectorAll(".mode-popover-item")[index] as HTMLElement);
      expect(h.posted.at(-1)).toEqual({ type: "setMode", modeId });
    }
  });

  it("gives every Muse mode its own icon, so the button alone shows which is on", () => {
    const h = bootWebview({ remote: true });
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", models: [] });
    const buttonIcons = MUSE_MODES.map(modeId => {
      dispatch(h.window, { type: "modeChanged", modeId, modes: MUSE_MODES });
      return h.doc.querySelector("#mode-btn svg")!.outerHTML;
    });
    expect(new Set(buttonIcons).size).toBe(MUSE_MODES.length);
    openModes(h);
    const menuIcons = [...h.doc.querySelectorAll("#mode-popover .mode-item-icon")].map(el => el.innerHTML);
    expect(menuIcons).toEqual(buttonIcons);
  });

  it("paints the Auto accept button in the same colour as every other mode", () => {
    expect(CHAT_CSS).not.toMatch(/\.yolo-active\s*\{[^}]*color/);
  });

  it.each([{ vscode: true }, {}, { remote: true }])("keeps On request visible but disabled with the host reason on %j", surface => {
    const h = bootWebview(surface);
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", models: [] });
    const reason = "On request requires the shell sandbox.";
    dispatch(h.window, { type: "modeChanged", modeId: "yolo", modes: MUSE_MODES, disabledModes: { onRequest: reason } });
    openModes(h);
    const row = h.doc.querySelectorAll(".mode-popover-item")[2];
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain(reason);
    click(h.window, row);
    expect(h.posted.some(msg => msg.type === "setMode")).toBe(false);
    // A fresh process updates an already open menu, including its click guard.
    dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: MUSE_MODES });
    click(h.window, h.doc.querySelectorAll(".mode-popover-item")[2]);
    expect(h.posted.at(-1)).toEqual({ type: "setMode", modeId: "onRequest" });
  });

  it.each([false, true])("renders an unknown current mode harmlessly and never invents choices, remote=%s", remote => {
    const h = bootWebview({ remote });
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", models: [] });
    dispatch(h.window, { type: "modeChanged", modeId: "<future>", modes: ["agent", "yolo", "future"] });
    expect(h.doc.getElementById("mode-btn")!.textContent).toBe("Unknown mode");
    openModes(h);
    expect(labelsOf(h.doc)).toEqual(["Agent mode", "Auto accept"]);
  });

  it.each(["grok", "codex", "claude"])("keeps %s's labels and choices with both old and current hosts", provider => {
    const h = bootWebview();
    connect(h);
    dispatch(h.window, { type: "session", sessionId: "s", provider, models: [] });
    const modes = provider === "codex" ? ["agent", "yolo"] : ["agent", "plan", "yolo"];
    const labels = provider === "codex" ? ["Agent mode", "Auto accept"] : ["Agent mode", "Plan mode", "Auto accept"];
    for (const advertised of [undefined, modes]) {
      dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: advertised });
      openModes(h);
      expect(labelsOf(h.doc)).toEqual(labels);
    }
  });

  it.each([false, true])("shows native mode semantics and the replayed badge on remote=%s", remote => {
    const h = bootWebview({ remote });
    connect(h);
    dispatch(h.window, { type: "initialState", capabilities: { museNativeModes: true } });
    dispatch(h.window, { type: "session", sessionId: "m", provider: "muse", models: [] });
    dispatch(h.window, { type: "modeChanged", modeId: "yolo", modes: ["agent", "yolo"] });
    expect(h.doc.getElementById("mode-btn")!.title).toContain("Auto accept");
    openModes(h);
    expect(descsOf(h.doc)[0]).toContain("asks for approval");
    expect(descsOf(h.doc)[1]).toContain("full access (YOLO)");
    expect(descsOf(h.doc)[1]).toContain("on reopen or in a new conversation");
    expect(labelsOf(h.doc)).toEqual(["Agent mode", "Auto accept"]);
  });
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
