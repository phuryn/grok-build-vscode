import { describe, expect, it } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

/**
 * Client-owned font scale: AFK Pilot (IS_REMOTE) and the desktop Electron
 * shell (grokDesktopShell). VS Code webview stays on host `fontScale` only.
 */

/**
 * Open the surface the SETTINGS live on.
 *
 * Rail hosts split the popover: the composer gear holds what is about this
 * conversation (model, effort), the rail gear holds what is about the app.
 * Text size is a setting, so it belongs on the rail surface — putting it beside
 * model and effort was the first attempt and it read as a property of the
 * conversation. VS Code has no rail, both halves render, and the composer gear
 * is the only one there is.
 */
const withRail = (window: any) => {
  const el = window.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  window.document.body.appendChild(el);
  const search = window.document.createElement("input");
  search.id = "rail-search";
  window.document.body.appendChild(search);
};

function openSettingsGeneral(window: any, doc: Document) {
  // The rail only mounts once a `repos` frame arrives, and the settings surface
  // lives on the rail gear — so a harness that never sent one would silently
  // fall back to the composer gear and assert against the wrong panel.
  dispatch(window, {
    type: "repos",
    entries: [{ cwd: "/work/alpha", name: "alpha", available: true }],
    selectedCwd: "/work/alpha",
    activeCwd: "/work/alpha",
  } as never);
  const rail = doc.getElementById("rail-gear-btn");
  click(window, (rail || doc.getElementById("gear-btn"))!);
  const entry = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
    .find((el) => /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()));
  if (entry) click(window, entry as HTMLElement);
}

function fontSlider(doc: Document): HTMLInputElement | null {
  return (doc.getElementById("remote-font-scale") ||
    doc.querySelector('[data-id="chatFontScale"] input[type="range"]')) as HTMLInputElement | null;
}

function firstGearLabel(doc: Document): string {
  const first = doc.querySelector(
    "#gear-popover .toolbar-popover-item, #gear-popover .popover-section",
  );
  return (first?.textContent || "").replace(/\s+/g, " ").trim();
}

describe("client font scale (remote)", () => {
  it("puts Text size on General in the settings surface", () => {
    const { window, doc } = bootWebview({ remote: true, beforeScripts: withRail });
    openSettingsGeneral(window, doc);
    expect(fontSlider(doc)).toBeTruthy();
    expect(doc.getElementById("settings-overlay")!.textContent).toContain("Text size");
  });

  it("steps, resets, persists, and is bounded", () => {
    const { window, doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        withRail(w);
        (w as any).localStorage.removeItem("grok.remote.fontScale");
      },
    });
    const api = (window as any).__grokFontScale;
    expect(api).toBeTruthy();
    expect(api.get()).toBe(1);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1");

    api.set(api.step(api.get(), api.stepSize));
    expect(api.get()).toBeCloseTo(1.1, 5);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.1");
    expect((window as any).localStorage.getItem("grok.remote.fontScale")).toBe("1.1");

    api.set(api.step(api.get(), -api.stepSize));
    expect(api.get()).toBeCloseTo(1.0, 5);

    api.set(0.5); // below min
    expect(api.get()).toBe(api.min);
    api.set(3); // above max
    expect(api.get()).toBe(api.max);

    api.set(1);
    expect(api.get()).toBe(1);
    expect((window as any).localStorage.getItem("grok.remote.fontScale")).toBe("1");
  });

  it("restores the stored scale on reload", () => {
    const { doc } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        withRail(w);
        (w as any).localStorage.setItem("grok.remote.fontScale", "1.4");
      },
    });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
  });

  it("Ctrl/Cmd + Shift + +/- /0 adjust zoom and wheel zoom is disabled", () => {
    const { window } = bootWebview({ remote: true, beforeScripts: withRail });
    const api = (window as any).__grokFontScale;
    api.set(1);

    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "+", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(api.get()).toBeCloseTo(1.1, 5);

    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "-", metaKey: true, shiftKey: true, bubbles: true }),
    );
    expect(api.get()).toBeCloseTo(1.0, 5);

    api.set(1.3);
    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true }),
    );
    expect(api.get()).toBe(1);

    api.set(1);
    // wheel zoom should be disabled completely
    const wheel = new (window as any).WheelEvent("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(wheel, "deltaY", { value: -100, configurable: true });
    Object.defineProperty(wheel, "ctrlKey", { value: true, configurable: true });
    Object.defineProperty(wheel, "metaKey", { value: false, configurable: true });
    window.dispatchEvent(wheel);
    expect(api.get()).toBe(1);
  });
});

describe("client font scale (desktop bridge)", () => {
  it("uses localStorage when grokDesktopShell is present and ignores host fontScale", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (w) => {
        (w as any).grokDesktopShell = true;
        (w as any).localStorage.setItem("grok.desktop.fontScale", "1.2");
      },
    });
    const api = (window as any).__grokFontScale;
    expect(api).toBeTruthy();
    expect(api.key).toBe("grok.desktop.fontScale");
    expect(api.get()).toBeCloseTo(1.2, 5);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.2");

    // Host config must not clobber client-owned zoom.
    dispatch(window, { type: "fontScale", value: 0.9 });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.2");

    api.set(1.5);
    expect((window as any).localStorage.getItem("grok.desktop.fontScale")).toBe("1.5");
  });

  it("shows Text size on General and keeps the slider in sync with shortcuts", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (w) => {
        (w as any).grokDesktopShell = true;
        // The settings entry points are gated on the rail mount existing, and
        // the desktop shell ships one.
        withRail(w);
      },
    });
    openSettingsGeneral(window, doc);
    const slider = fontSlider(doc)!;
    expect(slider).toBeTruthy();
    expect(slider.value).toBe("100");
    // Model/effort stay on the conversation surface, not this one.

    // Ctrl+Shift+= (or +) steps zoom; open slider must reflect the same value.
    window.dispatchEvent(
      new (window as any).KeyboardEvent("keydown", { key: "+", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect((window as any).__grokFontScale.get()).toBeCloseTo(1.1, 5);
    expect(slider.value).toBe("110");
    expect(slider.parentElement!.querySelector("output")!.textContent).toBe("110%");

    // Slider change updates zoom the same way.
    slider.value = "140";
    slider.dispatchEvent(new (window as any).Event("change", { bubbles: true }));
    expect((window as any).__grokFontScale.get()).toBeCloseTo(1.4, 5);
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.4");
    expect((window as any).localStorage.getItem("grok.desktop.fontScale")).toBe("1.4");
  });
});

describe("VS Code webview font scale (host-owned)", () => {
  it("does not wire client shortcuts or localStorage client key", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (w) => {
        // No remote flag, no desktop bridge — pure extension webview.
        (w as any).localStorage.setItem("grok.desktop.fontScale", "1.5");
        (w as any).localStorage.setItem("grok.remote.fontScale", "1.5");
      },
    });
    expect((window as any).__grokFontScale).toBeUndefined();
    // Host baked --chat-zoom wins; stored client keys are ignored.
    dispatch(window, { type: "fontScale", value: 1.1 });
    expect(doc.body.style.getPropertyValue("--chat-zoom")).toBe("1.1");
  });

  it("does not show a Text size slider on the main gear panel", () => {
    const { window, doc } = bootWebview();
    click(window, doc.getElementById("gear-btn")!);
    expect(doc.querySelector("#gear-popover input[type=range]")).toBeNull();
    expect(firstGearLabel(doc)).toMatch(/Model and Effort/);
  });
});
