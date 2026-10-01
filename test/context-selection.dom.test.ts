import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const selection = { sessionId: "s", modelId: "grok-4.7", generation: 2, sizes: [256000, 500000], defaultSize: 256000, selectedSize: 256000, available: true, changing: false };
function setup() {
  const h = bootWebview();
  dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-4.7", models: [{ modelId: "grok-4.7", name: "Grok 4.7", contextWindowSizes: selection.sizes }] });
  dispatch(h.window, { type: "contextWindowSelection", selection });
  return h;
}
describe("context-window controls", () => {
  it("updates an already-open popup when a native turn starts and ends", () => {
    const h = setup();
    click(h.window, h.doc.getElementById("donut")!);
    dispatch(h.window, { type: "agentStart" });
    expect(h.doc.querySelector(".context-window-choice")!.getAttribute("aria-disabled")).toBe("true");
    dispatch(h.window, { type: "agentEnd", status: "completed" });
    expect(h.doc.querySelector(".context-window-choice")!.getAttribute("aria-disabled")).toBe("false");
  });

  it("routes a typed command without a busy turn or consuming draft attachments", () => {
    const h = setup();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    dispatch(h.window, { type: "chips", chips: [{ id: "file", kind: "file", relPath: "keep.ts", path: "/keep.ts", hidden: false }] });
    input.value = "/context-window 500k";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    click(h.window, h.doc.getElementById("send-btn")!);
    expect(input.value).toBe("/context-window 500k");
    expect(h.doc.getElementById("attachments")!.textContent).toContain("keep.ts");
    expect(h.posted.at(-1)).toEqual({ type: "send", text: "/context-window 500k", bare: true });
    expect(h.doc.getElementById("send-btn")!.title).not.toContain("Stop");
  });

  it("shows native default and selected size in the context popup and preserves the composer", () => {
    const h = setup();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "keep my draft";
    click(h.window, h.doc.getElementById("donut")!);
    const choices = h.doc.querySelectorAll("#context-popover .context-window-choice");
    expect(choices).toHaveLength(2);
    expect(choices[0].textContent).toContain("CLI default");
    click(h.window, choices[1]);
    expect(h.posted.at(-1)).toEqual({ type: "setContextWindow", sessionId: "s", modelId: "grok-4.7", generation: 2, size: 500000 });
    expect(input.value).toBe("keep my draft");
    expect(choices[0].classList.contains("active")).toBe(true);
  });
  it("opens the model continuation only after a confirmed host frame and supports keyboard selection", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection, openPicker: true });
    const rows = h.doc.querySelectorAll("#gear-popover .context-window-choice");
    expect(rows).toHaveLength(2);
    rows[0].dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(h.doc.activeElement).toBe(rows[1]);
    rows[1].dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(h.posted.at(-1)?.type).toBe("setContextWindow");
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("Continue to reasoning effort");
  });
  it("locks both controls while busy or awaiting confirmation", () => {
    for (const changing of [true, false]) {
      const h = setup();
      if (!changing) dispatch(h.window, { type: "setBusy", value: true });
      dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, changing }, openPicker: true });
      const row = h.doc.querySelector("#gear-popover .context-window-choice")!;
      click(h.window, row);
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(h.posted.some(m => m.type === "setContextWindow")).toBe(false);
    }
  });
  it("rejects a late frame from another session and warns before native compaction", () => {
    const h = setup();
    dispatch(h.window, { type: "contextUsage", used: 300000, window: 500000 });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, selectedSize: 500000 }, openPicker: true });
    expect(h.doc.querySelector(".context-window-choice")!.textContent).toContain("may compact");
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, sessionId: "old", sizes: [1, 2] } });
    expect(h.doc.querySelectorAll(".context-window-choice")[1].textContent).toContain("500");
  });
  it("shows a reason instead of selectable sizes when native support is absent", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, available: false, reason: "CLI update required" }, openPicker: true });
    expect(h.doc.querySelectorAll(".context-window-choice")).toHaveLength(0);
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("CLI update required");
  });
  it("ignores older generations and frames for a model no longer selected", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection, openPicker: true });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, generation: 1, sizes: [1, 2] } });
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, modelId: "old-model", generation: 3, sizes: [1, 2] } });
    expect(h.doc.querySelectorAll(".context-window-choice")[1].textContent).toContain("500");
  });
  it("locks choices during initial startup", () => {
    const h = bootWebview({ ready: false });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "grok-4.7", models: [] });
    dispatch(h.window, { type: "contextWindowSelection", selection, openPicker: true });
    const row = h.doc.querySelector(".context-window-choice")!;
    click(h.window, row);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(h.posted.some(m => m.type === "setContextWindow")).toBe(false);
  });
  it("marks a failed confirmation as stale while keeping the confirmed choice", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection: { ...selection, stale: true }, openPicker: true });
    expect(h.doc.querySelector(".context-window-choice.active")!.textContent).toContain("256");
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("native state needs a refresh");
  });
});
