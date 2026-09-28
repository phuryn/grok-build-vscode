/**
 * Model picker rows: provider marks always, versioned Claude labels, and a
 * fixed Manage providers footer. Drives the shipped media/chat.js.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootWebview, click, dispatch } from "./webview-harness";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const modelBtn = (doc: Document) => doc.querySelector(".model-picker-row") as HTMLButtonElement;
const pickerItems = (doc: Document) => [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")];

function openModelPicker(h: ReturnType<typeof bootWebview>, models: object[], extra: object = {}) {
  dispatch(h.window, {
    type: "session",
    sessionId: "fresh",
    provider: "grok",
    currentModelId: "grok-build",
    models,
    ...extra,
  });
  click(h.window, $(h.doc, "gear-btn"));
}

describe("model picker provider marks and manage-providers", () => {
  it.each([false, true])("keeps untagged legacy Muse rows with their supplying provider during a preview, remote=%s", async remote => {
    const h = bootWebview({ remote });
    dispatch(h.window, { type: "providerState", providers: [
      { id: "muse", connected: true }, { id: "grok", connected: true },
    ] });
    dispatch(h.window, { type: "session", sessionId: "muse", provider: "muse", currentModelId: "muse-spark-1.3", models: [
      { modelId: "muse-spark-1.3", name: "muse-spark-1.3" },
      { modelId: "muse-spark-1.2", name: "muse-spark-1.2" },
      { provider: "grok", modelId: "grok-4.7", name: "Grok 4.7" },
    ] });
    dispatch(h.window, { type: "modeChanged", modeId: "onRequest", modes: ["yolo", "agent", "onRequest", "denyUnmatched"] });
    click(h.window, $(h.doc, "gear-btn"));
    click(h.window, [...h.doc.querySelectorAll(".model-picker-row")].find(row => row.textContent?.includes("Grok 4.7"))!);
    expect($(h.doc, "gear-btn").textContent).toContain("Grok 4.7");
    let heading = "";
    for (const row of h.doc.querySelectorAll(".model-picker-list > *")) {
      if (row.classList.contains("model-provider-heading")) heading = row.textContent ?? "";
      else if (row.textContent?.includes("muse-spark")) expect(heading).toBe("Muse Code");
    }
    click(h.window, $(h.doc, "mode-btn"));
    expect($(h.doc, "mode-btn").textContent).toBe("Agent mode");
    expect($(h.doc, "mode-popover").textContent).not.toMatch(/Unknown mode|On request|Deny unmatched/);
    expect(h.posted).toContainEqual({ type: "setModel", modelId: "grok-4.7", provider: "grok" });
    // Until Grok's session exists no mode can take effect, so none is clickable.
    const planRow = [...h.doc.querySelectorAll(".mode-popover-item")].find(row => row.textContent?.includes("Plan mode"))!;
    expect(planRow.textContent).toContain("Available once Grok has started");
    click(h.window, planRow as HTMLElement);
    expect(h.posted).not.toContainEqual({ type: "setMode", modeId: "plan" });
    // Older hosts omit modes and row providers. Their original fallbacks still
    // apply after the confirmed provider arrives, in startup's mode-first order.
    dispatch(h.window, { type: "modeChanged", modeId: "agent" });
    dispatch(h.window, { type: "session", sessionId: "grok", provider: "grok", currentModelId: "grok-4.7", models: [
      { modelId: "grok-4.7", name: "Grok 4.7" },
    ] });
    expect([...h.doc.querySelectorAll(".mode-item-label")].map(row => row.textContent)).toEqual(["Agent mode", "Plan mode", "Auto accept"]);
    expect($(h.doc, "gear-btn").textContent).toContain("Grok 4.7");
    await h.window.happyDOM.close();
  });

  it("preserves all four Muse modes when previewing another Muse model", async () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "muse", connected: true }] });
    openModelPicker(h, [
      { provider: "muse", modelId: "muse-spark-1.3", name: "muse-spark-1.3" },
      { provider: "muse", modelId: "muse-spark-1.2", name: "muse-spark-1.2" },
    ], { provider: "muse", currentModelId: "muse-spark-1.3" });
    dispatch(h.window, { type: "modeChanged", modeId: "denyUnmatched", modes: ["yolo", "agent", "onRequest", "denyUnmatched"] });
    click(h.window, h.doc.querySelectorAll(".model-picker-row")[1]);
    click(h.window, $(h.doc, "mode-btn"));
    expect($(h.doc, "mode-btn").textContent).toBe("Deny unmatched");
    expect([...h.doc.querySelectorAll(".mode-item-label")].map(row => row.textContent)).toEqual(["Allow all", "Prompt unmatched", "On request", "Deny unmatched"]);
    await h.window.happyDOM.close();
  });

  it("restores Muse's modes when a cross-provider preview returns to the original pick", async () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "muse", connected: true }, { id: "grok", connected: true }] });
    openModelPicker(h, [
      { provider: "muse", modelId: "muse-spark-1.3", name: "muse-spark-1.3" },
      { provider: "grok", modelId: "grok-4.7", name: "Grok 4.7" },
    ], { provider: "muse", currentModelId: "muse-spark-1.3" });
    dispatch(h.window, { type: "modeChanged", modeId: "onRequest", modes: ["yolo", "agent", "onRequest", "denyUnmatched"], disabledModes: { denyUnmatched: "Test restriction" } });
    const pick = (name: string) => click(h.window, [...h.doc.querySelectorAll(".model-picker-row")].find(row => row.textContent?.includes(name))!);
    pick("Grok 4.7");
    pick("muse-spark-1.3");
    click(h.window, $(h.doc, "mode-btn"));
    expect(h.posted.filter(m => m.type === "setModel")).toEqual([]);
    expect($(h.doc, "mode-btn").textContent).toBe("On request");
    expect([...h.doc.querySelectorAll(".mode-item-label")].map(row => row.textContent)).toEqual(["Allow all", "Prompt unmatched", "On request", "Deny unmatched"]);
    expect(h.doc.querySelector(".mode-item-disabled-note")?.textContent).toBe("Test restriction");
    await h.window.happyDOM.close();
  });

  it("puts a provider mark on every model row even when only one agent is connected", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "grok", connected: true }],
    });
    openModelPicker(h, [
      { provider: "grok", modelId: "grok-build", name: "Grok Build" },
    ]);

    const rows = [...h.doc.querySelectorAll("#gear-popover .model-picker-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".provider-glyph.provider-grok")).toBeTruthy();
    expect(rows[0].textContent).toContain("Grok Build");
    expect(h.doc.querySelectorAll(".model-provider-heading")).toHaveLength(0);
  });

  it("always offers Manage providers and opens Settings → Providers", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "grok", connected: true }],
    });
    openModelPicker(h, [
      { provider: "grok", modelId: "grok-build", name: "Grok Build" },
    ]);

    const manage = pickerItems(h.doc).find((el) => el.classList.contains("model-manage-providers"));
    expect(manage, "Manage providers footer").toBeTruthy();
    expect(manage!.textContent).toContain("Manage providers");
    expect(manage!.previousElementSibling?.classList.contains("popover-sep")).toBe(true);

    click(h.window, manage!);
    expect(h.doc.getElementById("settings-overlay")).toBeTruthy();
    const activeNav = h.doc.querySelector("#settings-overlay .settings-nav-item.active");
    expect(activeNav?.textContent).toContain("Providers");
  });

  it("surfaces Claude generation numbers from the adapter description", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "claude", connected: true }],
    });
    openModelPicker(h, [
      {
        provider: "claude",
        modelId: "claude-sonnet-4-5",
        name: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks",
      },
      {
        provider: "claude",
        modelId: "claude-haiku-4-5",
        name: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
    ], { provider: "claude", currentModelId: "claude-sonnet-4-5" });

    const text = h.doc.getElementById("gear-popover")!.textContent || "";
    expect(text).toContain("Sonnet 5");
    expect(text).toContain("Haiku 4.5");
    const sonnet = [...h.doc.querySelectorAll("#gear-popover .model-picker-row")]
      .find((el) => el.textContent?.includes("Sonnet 5"));
    expect(sonnet?.querySelector(".provider-glyph.provider-claude")).toBeTruthy();
  });
});

function overflowLabels(window: Window, doc: Document, slotId: string): string[] {
  const overflow = $(doc, slotId).querySelector(".rail-menu-btn");
  expect(overflow, `${slotId} ⋯ menu`).toBeTruthy();
  click(window, overflow!);
  return [...doc.querySelectorAll(".rail-menu-item")].map((el) => (el.textContent || "").trim());
}

describe("New session in the top bar", () => {
  it("keeps New session next to History; overflow keeps Delete and Continue", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const newBtn = $(h.doc, "new-btn") as HTMLButtonElement;
    expect(newBtn.hidden).toBe(false);
    expect(newBtn.title).toBe("New session");

    const labels = overflowLabels(h.window, h.doc, "session-head-actions");
    expect(labels.some((t) => /New session/.test(t))).toBe(false);
    expect(labels.some((t) => /Continue in a new chat/.test(t))).toBe(true);
    expect(labels.some((t) => t === "Delete")).toBe(true);
  });

  it("injects New session beside Session history on a remote header and leaves it out of ⋯", () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (window) => {
        const head = window.document.getElementById("session-head")!;
        const history = window.document.createElement("button");
        history.id = "session-history";
        head.appendChild(history);
      },
    });
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const history = $(h.doc, "session-history");
    const sessionNew = $(h.doc, "session-new");
    expect(sessionNew).toBeTruthy();
    expect(sessionNew.hidden).toBe(false);
    expect(sessionNew.previousElementSibling).toBe(history);
    expect(sessionNew.getAttribute("aria-label")).toBe("New session");

    const labels = overflowLabels(h.window, h.doc, "session-head-actions");
    expect(labels.some((t) => /New session/.test(t))).toBe(false);
    expect(labels.some((t) => /Continue in a new chat/.test(t))).toBe(true);
    expect(labels.some((t) => t === "Delete")).toBe(true);
  });

  it("keeps VS Code New on the top bar; overflow stays Continue and Export", () => {
    const h = bootWebview({ vscode: true });
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const newBtn = $(h.doc, "new-btn") as HTMLButtonElement;
    expect(newBtn.hidden).toBe(false);
    expect(newBtn.title).toBe("New session");

    const labels = overflowLabels(h.window, h.doc, "vscode-session-actions");
    expect(labels).toEqual([
      "Continue in a new chat",
      "Export conversation as Markdown",
      "Find in conversation",
    ]);
  });

  it("does not hide the command: top-bar New still posts newSession", () => {
    const h = bootWebview();
    click(h.window, $(h.doc, "new-btn"));
    expect(h.posted.some((m) => m.type === "newSession")).toBe(true);
  });

  it("drops the includeNew overflow hook so the duplicate cannot come back quietly", () => {
    const src = readFileSync(fileURLToPath(new URL("../media/chat.js", import.meta.url)), "utf8");
    const pkg = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    expect(src).not.toMatch(/includeNew/);
    expect(src).toContain("beginNewSession");
    expect(pkg).toContain('"command": "grok.newSession"');
  });
});

describe("context popover width", () => {
  it("caps the shared popover at 350px in CSS", () => {
    const css = readFileSync(fileURLToPath(new URL("../media/chat.css", import.meta.url)), "utf8");
    expect(css).toMatch(/#context-popover\s*\{[^}]*max-width:\s*350px/);
  });
});
