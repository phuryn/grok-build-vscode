import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const models = [
  { provider: "grok", modelId: "grok-build", name: "Grok Build", reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { provider: "grok", modelId: "grok-fast", name: "Grok Fast", reasoningEffort: "low", reasoningEfforts: ["low", "medium"] },
];
function boot(surface = "vscode", connected = true) {
  const h = bootWebview({ remote: surface === "remote" || surface === "phone", vscode: surface === "vscode",
    beforeScripts: (w) => {
      if (surface === "vscode") return;
      const rail = w.document.createElement("aside"); rail.id = "projects-rail";
      rail.innerHTML = '<div id="rail-scroll"></div><div class="rail-foot"></div>';
      w.document.body.appendChild(rail);
    },
  });
  dispatch(h.window, { type: "initialState", appPurpose: "coding", capabilities: { settingsEditor: surface === "vscode" }, effort: "high" });
  dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected }] });
  dispatch(h.window, { type: "session", provider: "grok", currentModelId: "grok-build", models: structuredClone(models) });
  if (surface !== "vscode") dispatch(h.window, { type: "repos", entries: [], selectedCwd: "/repo", activeCwd: "/repo" });
  return h;
}
type H = ReturnType<typeof boot>;
const open = (h: H, id = "gear-btn") => click(h.window, h.doc.getElementById(id)!);
const effortGroup = (h: H) => h.doc.querySelector('#gear-popover [role="radiogroup"][aria-label="Reasoning effort"]')!;
const effortButton = (h: H, level: string) => effortGroup(h).querySelector<HTMLButtonElement>(`[data-effort="${level}"]`)!;
const sequence = (h: H) => [...h.doc.querySelector("#add-popover")!.children].map((el) =>
  (el.classList.contains("popover-section") ? "heading: " : "row: ") + el.textContent?.trim());

describe("composer chip", () => {
  it("outlines both picker selections in forced colours", () => {
    const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    const blocks = [...css.matchAll(/@media \(forced-colors: active\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    const picker = blocks.find(([, rules]) => rules.includes(".effort-strip-stop"))?.[1];
    expect(picker).toMatch(/\.effort-strip-stop\[aria-checked="true"\]\s*\{[^}]*outline:\s*2px solid Highlight/);
    expect(picker).toMatch(/\.model-picker-option\.active\s*\{[^}]*outline:\s*1px solid CanvasText/);
  });

  it.each(["vscode", "desktop", "remote", "phone"])("opens directly with pinned effort/models/recovery on %s", (surface) => {
    const h = boot(surface);
    const chip = h.doc.getElementById("gear-btn")!;
    expect([...chip.children].map((el) => el.classList[0])).toEqual([
      "model-chip-name", "effort-bars", "model-chip-effort",
    ]);
    expect(chip.textContent).toBe("Grok BuildHigh");
    const bars = chip.querySelector('.effort-bars[aria-hidden="true"]')!;
    expect([...bars.children].map((bar) => bar.classList.contains("filled"))).toEqual([true, true, true, false]);
    open(h);
    const pop = h.doc.getElementById("gear-popover")!;
    expect(pop.hidden).toBe(false);
    expect([...pop.children].map((el) => el.className)).toEqual([
      "model-effort-strip", "model-picker-list", "model-picker-footer",
    ]);
    expect(pop.querySelector(".popover-back")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    open(h); expect(pop.hidden).toBe(true);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    { levels: ["low", "medium", "high", "xhigh"], words: ["Low", "Medium", "High", "Extra high"] },
    { levels: ["minimal", "low", "medium", "high", "xhigh"], words: ["Minimal", "Low", "Medium", "High", "X-high"] },
    { levels: ["none", "minimal", "low", "medium", "high", "xhigh"], words: ["None", "Minimal", "Low", "Medium", "High", "X-high"] },
  ])("labels every segment when the model offers $levels.length levels", ({ levels, words }) => {
    const h = boot();
    dispatch(h.window, { type: "session", provider: "grok", currentModelId: "grok-build",
      models: [{ ...models[0], reasoningEfforts: levels }] });
    open(h);
    const segments = [...effortGroup(h).querySelectorAll('[role="radio"]')];
    expect(segments.map((el) => el.textContent)).toEqual(words);
    expect(segments.map((el) => el.getAttribute("data-effort"))).toEqual(levels);
    const extraHigh = effortButton(h, "xhigh");
    click(h.window, extraHigh);
    expect(extraHigh.getAttribute("aria-label")).toBe("Extra high");
    expect(extraHigh.title).toBe("Extra high — deepest reasoning, slowest");
    expect(h.doc.querySelector(".effort-strip-tip")?.textContent).toBe(extraHigh.title);
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Extra high");
    expect(h.doc.getElementById("gear-btn")?.getAttribute("aria-label")).toContain("Extra high");
    expect(h.doc.querySelectorAll("#gear-btn .effort-bars .filled")).toHaveLength(levels.length);
  });

  it("leaves the name out of the tooltip for a provider's unnamed default model", () => {
    const h = boot();
    const title = (reasoningEfforts: string[]) => {
      dispatch(h.window, { type: "session", provider: "grok", currentModelId: "",
        models: [{ provider: "grok", modelId: "", name: "Grok default", supportsReasoningEffort: reasoningEfforts.length > 0,
          reasoningEffort: reasoningEfforts[0], reasoningEfforts }] });
      return h.doc.getElementById("gear-btn")!.title;
    };
    expect(title([])).toBe("Model and effort");
    expect(title(["low"])).toBe("Low · Model and effort");
    dispatch(h.window, { type: "setBusy", value: true, locked: true });
    expect(title([])).toBe("Model and effort — selection available once the session is ready");
  });

  it("moves the active model row and its check on preview", () => {
    const h = boot();
    open(h);
    const active = () => h.doc.querySelector('.model-picker-list .model-picker-row.active[aria-checked="true"]');
    expect(active()?.textContent).toBe("Grok Build✓");
    click(h.window, h.doc.querySelector('.model-picker-list .model-picker-row[aria-checked="false"]')!);
    expect(active()?.textContent).toBe("Grok Fast✓");
    expect(h.doc.querySelectorAll(".model-picker-list .popover-check")).toHaveLength(1);
    expect(h.posted.filter((m) => m.type === "setModel")).toEqual([]);
  });

  it.each(["grok", "codex", "claude"])("keeps recovery actionable when %s is signed out", (provider) => {
    const h = boot();
    dispatch(h.window, { type: "providerState", providers: [{ id: provider, connected: true, needsLogin: true }] });
    dispatch(h.window, { type: "setBusy", value: true, locked: true });
    open(h);
    expect((h.doc.getElementById("gear-btn") as HTMLButtonElement).disabled).toBe(false);
    expect(h.doc.getElementById("gear-popover")!.hidden).toBe(false);
    expect([...h.doc.querySelectorAll<HTMLButtonElement>(".model-picker-row, .effort-strip-stop, .effort-reset")].every((el) => el.disabled)).toBe(true);
    click(h.window, h.doc.querySelector(".model-manage-providers")!);
    expect(h.posted).toContainEqual({ type: "openSettingsSurface", category: "providers" });
    expect(h.posted.some((m) => ["setEffort", "setModel"].includes(m.type))).toBe(false);
  });

  const efforts = (h: H) => h.posted.filter((m) => m.type === "setEffort");

  it("previews each click and commits only the last choice on close", () => {
    const h = boot();
    open(h);
    const group = effortGroup(h);
    for (const [level, label] of [["low", "Low"], ["medium", "Medium"], ["xhigh", "Extra high"]]) {
      const button = effortButton(h, level);
      click(h.window, button);
      expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe(label);
      expect(group.querySelector('[aria-checked="true"][tabindex="0"]')).toBe(button);
      expect(effortGroup(h)).toBe(group);
      expect(efforts(h)).toEqual([]);
    }
    open(h);
    expect(efforts(h)).toEqual([{ type: "setEffort", level: "xhigh" }]);
  });

  it("commits nothing when the selection ends where it started", () => {
    const h = boot(); // boots at high
    open(h);
    click(h.window, h.doc.querySelector('[data-effort="low"]')!);
    click(h.window, h.doc.querySelector('[data-effort="high"]')!);
    open(h);
    expect(efforts(h)).toEqual([]);
  });

  it("roves focus and previews with arrows, Home and End until Escape commits", () => {
    const h = boot();
    const chip = h.doc.getElementById("gear-btn")!;
    const press = (el: Element, key: string) => el.dispatchEvent(new h.window.KeyboardEvent("keydown", { key, bubbles: true }));
    press(chip, "ArrowDown");
    expect(h.doc.activeElement).toBe(effortButton(h, "high"));
    for (const [key, level, label] of [
      ["ArrowLeft", "medium", "Medium"], ["ArrowUp", "low", "Low"], ["ArrowLeft", "xhigh", "Extra high"],
      ["ArrowRight", "low", "Low"], ["ArrowDown", "medium", "Medium"], ["Home", "low", "Low"], ["End", "xhigh", "Extra high"],
    ]) {
      press(h.doc.activeElement!, key);
      const button = effortButton(h, level);
      expect(h.doc.activeElement).toBe(button);
      expect([...effortGroup(h).querySelectorAll('[tabindex="0"]')]).toEqual([button]);
      expect([...effortGroup(h).querySelectorAll('[aria-checked="true"]')]).toEqual([button]);
      expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe(label);
      expect(efforts(h)).toEqual([]);
    }
    press(h.doc.activeElement!, "Escape");
    expect(h.doc.activeElement).toBe(chip);
    expect(efforts(h)).toEqual([{ type: "setEffort", level: "xhigh" }]);
  });

  it("disables all segments and Reset while the picker is locked", () => {
    const h = boot();
    dispatch(h.window, { type: "setBusy", value: true, locked: true });
    open(h);
    const segments = [...effortGroup(h).querySelectorAll<HTMLButtonElement>("button")];
    expect(segments).toHaveLength(4);
    expect(segments.every((el) => el.disabled)).toBe(true);
    const reset = h.doc.querySelector<HTMLButtonElement>(".effort-reset")!;
    expect(reset.disabled).toBe(true);
    click(h.window, segments[0]);
    click(h.window, reset);
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("High");
    open(h);
    expect(efforts(h)).toEqual([]);
  });

  it("reconciles a refusal without clearing context, and Reset commits the default", () => {
    const h = boot();
    dispatch(h.window, { type: "contextUsage", used: 71000, window: 100000, systemPromptTokens: 1234, messageTokens: 69000 });
    open(h);
    dispatch(h.window, { type: "initialState", effort: "high", appPurpose: "coding" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("High");
    expect(h.doc.getElementById("donut-label")?.textContent).toBe("71K/100K");
    expect(h.doc.getElementById("gear-popover")!.hidden).toBe(false);
    click(h.window, h.doc.querySelector(".effort-reset")!);
    expect(h.doc.querySelectorAll('.effort-strip-stop[aria-checked="true"]')).toHaveLength(0);
    expect(h.doc.querySelector("#gear-btn .effort-bars, #gear-btn .model-chip-effort")).toBeNull();
    open(h, "donut"); // opening another popover closes this one, which commits
    expect(efforts(h)).toEqual([{ type: "setEffort", level: "" }]);
    dispatch(h.window, { type: "initialState", effort: "medium", appPurpose: "coding" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Medium");
    expect(h.doc.getElementById("context-popover")!.textContent).toContain("In this window");
    expect(h.doc.getElementById("context-popover")!.textContent?.replace(/\s/g, "")).toContain("System1.23K");
  });

  it("reconciles a model's narrower ladder from existing metadata", () => {
    const h = boot();
    dispatch(h.window, { type: "modelChanged", modelId: "grok-fast" });
    expect(h.doc.querySelector(".model-chip-name")?.textContent).toBe("Grok Fast");
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Low");
    expect(h.doc.querySelector('.composer-effort-notice[role="status"]')?.textContent).toBe("Grok Fast uses Low effort.");
    // Older hosts can echo the saved preference after a model has narrowed
    // its ladder. It must not replace valid model metadata with an off-menu word.
    dispatch(h.window, { type: "initialState", effort: "high" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Low");
    open(h);
    expect([...h.doc.querySelectorAll(".effort-strip-stop")].map((el) => el.getAttribute("data-effort"))).toEqual(["low", "medium"]);
  });

  it("shows the level the host reports after a switch, and keeps the old rule only without the field", () => {
    const h = boot();
    dispatch(h.window, { type: "modelChanged", modelId: "grok-fast", effort: "medium" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Medium");
    dispatch(h.window, { type: "modelChanged", modelId: "grok-build", effort: "xhigh" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Extra high");
    // An older host sends no field: the chip keeps an in-ladder level.
    dispatch(h.window, { type: "modelChanged", modelId: "grok-build" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Extra high");
    // "" is the agent at its default (claude-agent-acp 0.76.0 drops X-high on
    // Opus -> Haiku -> Sonnet), so the chip falls back to the model's own
    // metadata instead of the level it had.
    dispatch(h.window, { type: "modelChanged", modelId: "grok-build", effort: "" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("High");
    // Off-menu reads the same way: never a level the model does not show.
    dispatch(h.window, { type: "modelChanged", modelId: "grok-build", effort: "xhigh" });
    dispatch(h.window, { type: "modelChanged", modelId: "grok-build", effort: "max" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("High");
  });

  it("keeps the advertised effective effort when an older host reports no override", () => {
    const h = boot();
    dispatch(h.window, { type: "initialState", effort: "" });
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("High");
  });

  it("supports keyboard entry and Escape back to the chip", () => {
    const h = boot();
    const chip = h.doc.getElementById("gear-btn")!;
    chip.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(h.doc.activeElement?.getAttribute("data-effort")).toBe("high");
    h.doc.activeElement!.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.doc.getElementById("gear-popover")!.hidden).toBe(true);
    expect(h.doc.activeElement).toBe(chip);
  });

  it("does not invent an effective default on an old host, and retains its account action", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "session", currentModelId: "grok-build", models: [{ modelId: "grok-build", name: "Grok Build" }] });
    open(h);
    expect(h.doc.querySelector("#gear-btn .effort-bars, #gear-btn .model-chip-effort")).toBeNull();
    expect(h.doc.querySelector(".effort-strip-header")?.textContent).toBe("EffortReset");
    expect(h.doc.querySelector(".effort-strip-tip")?.textContent).toBe("Uses the provider default");
    expect(effortGroup(h).querySelectorAll('[aria-checked="false"]')).toHaveLength(6);
    expect(effortGroup(h).querySelector('[tabindex="0"]')).toBe(effortButton(h, "none"));
    const logout = [...h.doc.querySelectorAll(".model-picker-footer .toolbar-popover-item")].find((el) => el.textContent === "Log out")!;
    click(h.window, logout);
    expect(h.posted).toContainEqual({ type: "logout" });
  });

  it("omits effort on an Orchestrator even when a previous model used it", () => {
    const h = boot();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true }] });
    dispatch(h.window, { type: "session", provider: "agy", currentModelId: "orchestrator",
      models: [{ provider: "agy", modelId: "orchestrator", name: "Orchestrator (Neon)", supportsReasoningEffort: false }] });
    open(h);
    expect(h.doc.querySelector("#gear-btn .effort-bars, #gear-btn .model-chip-effort")).toBeNull();
    expect(h.doc.querySelector(".model-effort-strip")).toBeNull();
    expect(h.doc.querySelector(".model-picker-row.active")?.textContent).toContain("Orchestrator (Neon)");
  });
});

describe("VS Code + app sections", () => {
  it.each([false, true])("renders the full flat sequence (linked=%s) and groups by headings", (linked) => {
    const h = boot();
    dispatch(h.window, { type: "remoteStatus", linked });
    open(h, "add-btn");
    expect(sequence(h)).toEqual([
      "heading: Attach", "row: Upload from computer", "heading: Use this app for", "row: Knowledge work", "row: Coding✓",
      "heading: Settings", "row: Settings",
    ]);
    expect(h.doc.querySelectorAll("#add-popover .popover-sep")).toHaveLength(0); // Rules are on headings themselves.
    const upload = h.doc.querySelector('[data-upload-row="photo"]')!;
    const docRow = h.doc.createElement("div"); docRow.className = "toolbar-popover-item"; docRow.textContent = "Add document";
    // The relay-owned adapter consumes this insertion contract. Its code is
    // outside this repository; this proves our marker remains unambiguous.
    upload.after(docRow);
    expect(sequence(h).slice(0, 4)).toEqual(["heading: Attach", "row: Upload from computer", "row: Add document", "heading: Use this app for"]);
    const settings = [...h.doc.querySelectorAll("#add-popover .toolbar-popover-item")].find((el) => el.textContent === "Settings")!;
    click(h.window, settings);
    expect(h.posted).toContainEqual({ type: "openSettingsSurface" });
  });

  it("omits the unavailable Remote control heading and its rule, and keeps purpose choices flat", () => {
    const h = boot(); open(h, "add-btn");
    expect(sequence(h).some((row) => row.includes("Remote control"))).toBe(false);
    const knowledge = [...h.doc.querySelectorAll("#add-popover .toolbar-popover-item")].find((el) => el.textContent === "Knowledge work")!;
    click(h.window, knowledge);
    expect(h.posted).toContainEqual({ type: "setAppPurpose", value: "knowledge" });
    expect(h.doc.getElementById("add-popover")!.hidden).toBe(false);
    expect(sequence(h)).toContain("row: Knowledge work✓");
  });

  it.each(["desktop", "remote", "phone"])("keeps + as upload only and keeps the rail menu on %s", (surface) => {
    const h = boot(surface); open(h, "add-btn");
    expect(sequence(h)).toEqual(["row: Upload from computer"]);
    open(h, "rail-gear-btn");
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("Use this app for");
    expect(h.doc.getElementById("gear-popover")!.textContent).toContain("Settings");
    expect(h.doc.querySelector(".model-effort-strip")).toBeNull();
  });
});

describe("context fullness", () => {
  for (const purpose of ["knowledge", "coding"]) {
    it.each([[70499, 70, "green"], [70500, 71, "yellow"], [90499, 90, "yellow"], [90500, 91, "red"]])(
      `${purpose}: bar and donut share rounded thresholds at %s`, (used, pct, color) => {
        const h = boot();
        dispatch(h.window, { type: "initialState", appPurpose: purpose });
        dispatch(h.window, { type: "contextUsage", used, window: 100000 });
        open(h, "donut");
        const pop = h.doc.getElementById("context-popover")!;
        expect(pop.hidden).toBe(false);
        expect(pop.style.bottom).not.toBe("");
        const bar = pop.querySelector(".context-fullness")!;
        expect(bar.getAttribute("aria-valuenow")).toBe(String(pct));
        expect(bar.children).toHaveLength(1);
        const fill = bar.firstElementChild as HTMLElement;
        expect(fill.style.width).toBe(pct + "%");
        expect(fill.style.getPropertyValue("--context-fill")).toContain(String(color));
        expect(h.doc.getElementById("donut-arc")!.getAttribute("stroke")).toBe(fill.style.getPropertyValue("--context-fill"));
        expect(bar.previousElementSibling?.textContent).toContain("Context used");
        const compact = bar.nextElementSibling as HTMLButtonElement;
        expect(compact.tagName).toBe("BUTTON"); expect(compact.disabled).toBe(false);
        click(h.window, compact);
        expect(h.posted).toContainEqual({ type: "send", text: "/compact", bare: true });
      },
    );
  }
});

// The owner, 2026-10-15: "When model and effort are loading, don't make this
// clickable as there is rubbish inside." Until THIS conversation's provider has
// published its catalog the chip is a closed door, on every surface.
describe("the model chip while models load", () => {
  const chipOf = (h: ReturnType<typeof bootWebview>) => h.doc.getElementById("gear-btn") as HTMLButtonElement;
  const popover = (h: ReturnType<typeof bootWebview>) => h.doc.getElementById("gear-popover")!;
  function starting(surface: "vscode" | "remote", providers = [{ id: "grok", connected: true }, { id: "claude", connected: true }]) {
    const h = bootWebview({ remote: surface === "remote", vscode: surface === "vscode" });
    dispatch(h.window, { type: "initialState", appPurpose: "coding", capabilities: { settingsEditor: surface === "vscode" }, effort: "high" });
    dispatch(h.window, { type: "providerState", providers });
    dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.0.0" } });
    return h;
  }
  const expectClosedDoor = (h: ReturnType<typeof bootWebview>) => {
    const chip = chipOf(h);
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.title).toBe("Loading models\u2026");
    expect(chip.classList.contains("model-chip-loading")).toBe(true);
    click(h.window, chip);
    chip.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as any);
    expect(popover(h).hidden).toBe(true);
  };

  it.each(["vscode", "remote"] as const)("stays shut while starting and opens on the catalog (%s)", (surface) => {
    const h = starting(surface);
    expectClosedDoor(h);
    dispatch(h.window, { type: "session", provider: "grok", currentModelId: "grok-build", models: structuredClone(models) });
    const chip = chipOf(h);
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute("aria-disabled")).toBe("false");
    expect(chip.textContent).toBe("Grok BuildHigh");
    click(h.window, chip);
    expect(popover(h).hidden).toBe(false);
  });

  it("closes again when the conversation moves to another provider, until that provider's catalog arrives", () => {
    const h = starting("vscode");
    // Mid-load the host switches the conversation to Claude.
    dispatch(h.window, { type: "initialized", info: { provider: "claude", version: "1.0.0" } });
    expectClosedDoor(h);
    dispatch(h.window, { type: "session", provider: "claude", currentModelId: "sonnet",
      models: [{ provider: "claude", modelId: "sonnet", name: "Sonnet 5" }] });
    expect(chipOf(h).disabled).toBe(false);
    expect(chipOf(h).textContent).toContain("Sonnet 5");
    // A later restart (another provider switch) shuts it, and an open picker
    // on the old catalog closes with it.
    click(h.window, chipOf(h));
    expect(popover(h).hidden).toBe(false);
    dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.0.0" } });
    expect(popover(h).hidden).toBe(true);
    expectClosedDoor(h);
  });

  it("never stays shut: a failed start, a signed-out agent and the failsafe all open it", async () => {
    const failed = starting("vscode");
    dispatch(failed.window, { type: "error", text: "Failed to start" });
    dispatch(failed.window, { type: "setBusy", value: false });
    expect(chipOf(failed).disabled).toBe(false);

    const ended = starting("vscode");
    dispatch(ended.window, { type: "setBusy", value: false });
    expect(chipOf(ended).disabled).toBe(false);

    // Recovery lives in the picker: a signed-out agent keeps it reachable.
    const signedOut = starting("vscode", [{ id: "grok", connected: true, needsLogin: true } as any]);
    expect(chipOf(signedOut).disabled).toBe(false);
    click(signedOut.window, chipOf(signedOut));
    expect(popover(signedOut).hidden).toBe(false);

    const silent = bootWebview({ vscode: true, beforeScripts: (w: any) => { w.__grokModelCatalogFailsafeMs = 5; } });
    dispatch(silent.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    dispatch(silent.window, { type: "initialized", info: { provider: "grok", version: "1.0.0" } });
    expect(chipOf(silent).disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chipOf(silent).disabled).toBe(false);
  });
});
