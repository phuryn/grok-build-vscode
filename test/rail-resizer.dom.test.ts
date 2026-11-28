/**
 * The rail's edge is a drag handle (owner request, 2026-08-07): no gutter, no
 * fill, no colour of its own — it IS the border, and only changes colour on
 * hover/drag.
 *
 * Mounted by chat.js next to the rail so BOTH rail hosts (the desktop app and
 * the AFK Pilot browser client) get it by construction, the same argument that
 * put the gear in the rail. VS Code has no rail mount, so nothing mounts there.
 *
 * The phone exclusion is NOT tested here — it is a CSS breakpoint owned by
 * web/chat.html, and `npm run e2e:touch` in the relay repo is its gate.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const withRail = (window: any) => {
  const el = window.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  const scroll = window.document.createElement("div");
  scroll.id = "rail-scroll";
  el.appendChild(scroll);
  const foot = window.document.createElement("div");
  foot.className = "rail-foot";
  el.appendChild(foot);
  window.document.body.appendChild(el);
};

const liveRail = (before = withRail): Harness => {
  const h = bootWebview({ ready: true, beforeScripts: before });
  dispatch(h.window, {
    type: "repos",
    entries: [{ cwd: "/proj", label: "proj", available: true, pinned: false, updatedAt: 1 }],
    selectedCwd: "/proj",
    activeCwd: "/proj",
  });
  return h;
};

/** jsdom has no layout, so the rail reports 0 width unless we say otherwise. */
function stubRailWidth(h: Harness, px: number) {
  const rail = h.doc.getElementById("projects-rail")!;
  (rail as any).getBoundingClientRect = () => ({
    width: px, height: 600, top: 0, left: 0, right: px, bottom: 600, x: 0, y: 0,
    toJSON: () => ({}),
  });
}

function drag(h: Harness, fromX: number, toX: number) {
  const handle = h.doc.getElementById("rail-resizer")!;
  const ev = (type: string, clientX: number) =>
    new h.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  // jsdom has no PointerEvent; MouseEvent carries clientX, which is all the
  // handler reads. pointerId is undefined and setPointerCapture is guarded.
  handle.dispatchEvent(Object.assign(ev("pointerdown", fromX), { pointerId: 1 }));
  handle.dispatchEvent(Object.assign(ev("pointermove", toX), { pointerId: 1 }));
  handle.dispatchEvent(Object.assign(ev("pointerup", toX), { pointerId: 1 }));
}

function railWidthVar(h: Harness): string {
  return h.doc.documentElement.style.getPropertyValue("--rail-width");
}

describe("rail resize handle (DOM)", () => {
  it("mounts immediately after the rail, and never in VS Code", () => {
    const h = liveRail();
    const rail = h.doc.getElementById("projects-rail")!;
    const handle = h.doc.getElementById("rail-resizer")!;
    expect(handle).toBeTruthy();
    // Immediately after: the handle has to sit on the rail's own edge.
    expect(rail.nextSibling).toBe(handle);
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");

    const vscode = bootWebview({ ready: true });
    dispatch(vscode.window, {
      type: "repos",
      entries: [{ cwd: "/w", label: "w", available: true, pinned: false, updatedAt: 1 }],
      selectedCwd: "/w",
      activeCwd: "/w",
    });
    // A repos frame for clear-all naming must not conjure a handle with no rail.
    expect(vscode.doc.getElementById("rail-resizer")).toBeNull();
  });

  it("dragging right widens the rail and persists on release", () => {
    const h = liveRail();
    stubRailWidth(h, 256);
    h.window.innerWidth = 1400;
    drag(h, 256, 356);
    expect(railWidthVar(h)).toBe("356px");
    // Persisted once, on release — not on every move.
    expect(h.window.localStorage.getItem("rail-width")).toBe("356px".replace("px", ""));
  });

  it("dragging at zoom 1 matches the cursor delta", () => {
    const h = liveRail();
    h.doc.body.style.setProperty("--chat-zoom", "1");
    stubRailWidth(h, 256);
    h.window.innerWidth = 1400;
    drag(h, 256, 356);
    expect(railWidthVar(h)).toBe("356px");
  });

  it("dragging at a non-1 zoom tracks the cursor in layout px", () => {
    // getBoundingClientRect / clientX are visual; --rail-width is layout.
    // A 256px rail at 1.5× reports 384 visual; 150 visual px is 100 layout px.
    const h = liveRail();
    h.doc.body.style.setProperty("--chat-zoom", "1.5");
    stubRailWidth(h, 384);
    h.window.innerWidth = 1400;
    drag(h, 384, 534);
    expect(railWidthVar(h)).toBe("356px");
  });

  it("clamps to a minimum and never starves the conversation", () => {
    const h = liveRail();
    h.window.innerWidth = 1000;
    stubRailWidth(h, 256);
    drag(h, 256, 6); // far left
    expect(parseInt(railWidthVar(h), 10)).toBe(180);

    stubRailWidth(h, 256);
    drag(h, 256, 4000); // far right
    // min(50% of 1000, 1000 - 360) = 500 — half the window bites first here.
    expect(parseInt(railWidthVar(h), 10)).toBe(500);
  });

  it("restores a persisted width at boot, bounded by the window", () => {
    const seed = (window: any) => {
      window.localStorage.setItem("rail-width", "420");
      withRail(window);
    };
    const h = liveRail(seed);
    expect(railWidthVar(h)).toBe("420px");
  });

  it("a hostile persisted value cannot break the layout", () => {
    const seed = (window: any) => {
      window.localStorage.setItem("rail-width", "999999");
      withRail(window);
    };
    const h = liveRail(seed);
    const w = parseInt(railWidthVar(h), 10);
    expect(w).toBeGreaterThanOrEqual(180);
    expect(w).toBeLessThanOrEqual(Math.floor(h.window.innerWidth * 0.5));
  });

  it("re-clamps when the window shrinks outside full-screen", () => {
    const h = liveRail();
    h.window.innerWidth = 1400;
    stubRailWidth(h, 400);
    drag(h, 400, 500);
    expect(railWidthVar(h)).toBe("500px");

    // Window shrinks; rail still paints at 500 until re-clamp.
    // Preferred comes from localStorage (drag persist), not the painted width.
    h.window.innerWidth = 600;
    stubRailWidth(h, 500);
    h.window.dispatchEvent(new h.window.Event("resize"));
    // With panel closed: distribute budget = 600-360 = 240, preferred 500 → 240
    // (also matches solo clamp max = min(300, 240) = 240).
    expect(parseInt(railWidthVar(h), 10)).toBe(240);
  });

  it("restores preferred width when the window grows again", () => {
    const h = liveRail();
    h.window.innerWidth = 1400;
    stubRailWidth(h, 400);
    drag(h, 400, 480);
    expect(railWidthVar(h)).toBe("480px");
    expect(h.window.localStorage.getItem("rail-width")).toBe("480");

    h.window.innerWidth = 600;
    stubRailWidth(h, 480);
    h.window.dispatchEvent(new h.window.Event("resize"));
    expect(parseInt(railWidthVar(h), 10)).toBe(240);

    // Grow: preferred 480 still in storage; reclamp must not leave the shrunk value.
    h.window.innerWidth = 1400;
    stubRailWidth(h, 240);
    h.window.dispatchEvent(new h.window.Event("resize"));
    expect(parseInt(railWidthVar(h), 10)).toBe(480);
  });

  it("shares a narrow-window deficit with a registered side panel", () => {
    const h = liveRail();
    h.window.innerWidth = 1400;
    stubRailWidth(h, 400);
    drag(h, 400, 500);
    // Desktop file panel registers via __grokRegisterSidePanel (no desk-ft- in chat.js).
    let appliedPanel = 0;
    const storedPanel = 500;
    (h.window as any).__grokRegisterSidePanel({
      id: "panel",
      min: 200,
      maxFrac: 0.7,
      isOpen: () => true,
      preferredWidth: () => storedPanel,
      applyWidth: (px: number) => { appliedPanel = px; },
    });

    h.window.innerWidth = 1000;
    stubRailWidth(h, 500);
    h.window.dispatchEvent(new h.window.Event("resize"));
    // budget 640, preferred 500+500, mins 180+200 → proportional mid values.
    const rail = parseInt(railWidthVar(h), 10);
    expect(rail + appliedPanel).toBe(640);
    expect(rail).toBeGreaterThan(180);
    expect(appliedPanel).toBeGreaterThan(200);
    // Stored drag widths must not be overwritten by the temporary shrink.
    expect(h.window.localStorage.getItem("rail-width")).toBe("500");
    expect(storedPanel).toBe(500);
  });

  it("ignores resize while full-screen, then re-clamps once on exit", () => {
    const h = liveRail();
    h.window.innerWidth = 1400;
    stubRailWidth(h, 300);
    drag(h, 300, 320);
    expect(railWidthVar(h)).toBe("320px");

    // Mutation check: without the fullscreenElement guard a mid-transition
    // resize would apply this bogus width and leave the rail crushed after exit.
    const fakeFs = h.doc.createElement("video");
    Object.defineProperty(h.doc, "fullscreenElement", {
      configurable: true,
      get: () => fakeFs,
    });
    stubRailWidth(h, 48);
    h.window.dispatchEvent(new h.window.Event("resize"));
    expect(railWidthVar(h)).toBe("320px");

    // Exit full-screen; window may have changed size while we were away.
    Object.defineProperty(h.doc, "fullscreenElement", {
      configurable: true,
      get: () => null,
    });
    h.window.innerWidth = 600;
    stubRailWidth(h, 320);
    h.doc.dispatchEvent(new h.window.Event("fullscreenchange"));
    expect(parseInt(railWidthVar(h), 10)).toBe(240);
  });
});

describe("desktop boot rail width (computed layout)", () => {
  function firstFrameLayoutCss(): string {
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const start = sidebar.indexOf("const firstFrameLayout");
    const block = sidebar.slice(start, sidebar.indexOf("const filePanelStyle", start));
    const m = block.match(/`([\s\S]*?)`/);
    if (!m) throw new Error("firstFrameLayout CSS missing");
    return m[1];
  }

  it("lets --rail-width change the computed rail width after boot", () => {
    // The first-frame rule is more specific than chat.css's #projects-rail
    // width. A hardcoded 260px there pins the column forever — drag, restore,
    // and the side-panel coordinator all write --rail-width and lose.
    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    const win = new Window({ url: "https://localhost/" });
    const doc = win.document;
    const boot = doc.createElement("style");
    boot.textContent = firstFrameLayoutCss();
    doc.head.appendChild(boot);
    const sheet = doc.createElement("style");
    sheet.textContent = chatCss;
    doc.head.appendChild(sheet);
    doc.body.className = "desk has-rail";
    const rail = doc.createElement("aside");
    rail.id = "projects-rail";
    rail.className = "projects-rail";
    doc.body.appendChild(rail);

    expect(win.getComputedStyle(rail).width).toBe("260px");
    doc.documentElement.style.setProperty("--rail-width", "180px");
    expect(win.getComputedStyle(rail).width).toBe("180px");
  });
});
