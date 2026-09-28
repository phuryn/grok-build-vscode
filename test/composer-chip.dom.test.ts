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
const sequence = (h: H) => [...h.doc.querySelector("#add-popover")!.children].map((el) =>
  (el.classList.contains("popover-section") ? "heading: " : "row: ") + el.textContent?.trim());

describe("composer chip", () => {
  it.each(["vscode", "desktop", "remote", "phone"])("opens directly with pinned effort/models/recovery on %s", (surface) => {
    const h = boot(surface);
    const chip = h.doc.getElementById("gear-btn")!;
    // Name and effort only: no provider glyph, no chevron (research/composer-chip.md).
    expect([...chip.children].map((el) => el.classList[0])).toEqual([
      "model-chip-name", "model-chip-effort",
    ]);
    expect(chip.textContent).toBe("Grok BuildHigh");
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

  it("previews on click and keyboard but commits ONCE, on close, at the level it ended on", () => {
    const h = boot();
    open(h);
    const track = h.doc.querySelector(".effort-strip-track")!;
    const low = h.doc.querySelector('[data-effort="low"]') as HTMLElement;
    click(h.window, low);
    // The chip follows immediately; the host hears nothing yet. Committing here
    // is what restarted an empty session mid-gesture, locked the control through
    // `busy`, and left every correction to be dropped by the priming guard.
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Low");
    expect(efforts(h)).toEqual([]);
    expect(h.doc.querySelector(".effort-strip-track")).toBe(track);
    low.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(h.doc.querySelector('[data-effort="xhigh"]')?.getAttribute("aria-checked")).toBe("true");
    expect(efforts(h)).toEqual([]);
    open(h);
    expect(efforts(h)).toEqual([{ type: "setEffort", level: "xhigh" }]);
  });

  it("commits nothing when the knob ends where it started", () => {
    const h = boot(); // boots at high
    open(h);
    click(h.window, h.doc.querySelector('[data-effort="low"]')!);
    click(h.window, h.doc.querySelector('[data-effort="high"]')!);
    open(h);
    expect(efforts(h)).toEqual([]);
  });

  it("drags the knob across stops and commits the one the finger is lifted on", () => {
    const h = boot();
    open(h);
    const track = h.doc.querySelector(".effort-strip-track") as HTMLElement;
    // Four stops over 400px: low 0-100, medium 100-200, high 200-300, xhigh 300+.
    track.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 42,
      right: 400, bottom: 42, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const at = (type: string, clientX: number) => track.dispatchEvent(
      new h.window.PointerEvent(type, { clientX, bubbles: true, pointerId: 1 }));
    at("pointerdown", 10);
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Low");
    at("pointermove", 150);
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Medium");
    at("pointermove", 350);
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("Extra high");
    at("pointerup", 350);
    expect(efforts(h)).toEqual([]);
    open(h);
    expect(efforts(h)).toEqual([{ type: "setEffort", level: "xhigh" }]);
  });

  it("a move with no button down does not drag the knob", () => {
    const h = boot();
    open(h);
    const track = h.doc.querySelector(".effort-strip-track") as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 42,
      right: 400, bottom: 42, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    track.dispatchEvent(new h.window.PointerEvent("pointermove", { clientX: 10, bubbles: true, pointerId: 1 }));
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
    expect(h.doc.querySelector(".model-chip-effort")?.textContent).toBe("");
    expect(h.doc.querySelector(".effort-strip-header strong")?.textContent).toBe("Default");
    const logout = [...h.doc.querySelectorAll(".model-picker-footer .toolbar-popover-item")].find((el) => el.textContent === "Log out")!;
    click(h.window, logout);
    expect(h.posted).toContainEqual({ type: "logout" });
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
