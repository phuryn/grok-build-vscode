import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

// The Grok Workspaces panel (a native tree view) is the history surface while
// it's visible, so the host mirrors its visibility into the webview via
// `historyPanelVisible` and the chat's own history button hides (New stays).
// `[hidden]` loses to .toolbar-btn's `display: inline-flex`, so chat.js toggles
// inline display — assert that, not the attribute.
describe("historyPanelVisible (Grok Workspaces panel ↔ chat history button)", () => {
  it("hides the history button while the panel is visible and restores it after", () => {
    const { window, doc } = bootWebview();
    const historyBtn = doc.getElementById("history-btn")!;
    const newBtn = doc.getElementById("new-btn")!;

    dispatch(window, { type: "historyPanelVisible", value: true });
    expect((historyBtn as HTMLElement).style.display).toBe("none");
    expect((newBtn as HTMLElement).style.display).not.toBe("none"); // New stays

    dispatch(window, { type: "historyPanelVisible", value: false });
    expect((historyBtn as HTMLElement).style.display).toBe("");
  });

  it("closes an open history popover when the panel appears", () => {
    const { window, doc } = bootWebview();
    const popover = doc.getElementById("history-popover")!;
    // Open the popover the way the user would (host replies with a sessions page).
    const historyBtn = doc.getElementById("history-btn")!;
    historyBtn.dispatchEvent(new (window as any).MouseEvent("click", { bubbles: true }));
    expect((popover as any).hidden).toBe(false);

    dispatch(window, { type: "historyPanelVisible", value: true });
    expect((popover as any).hidden).toBe(true);
  });
});
