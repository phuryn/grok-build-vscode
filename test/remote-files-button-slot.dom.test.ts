/**
 * Where the "Project files" button mounts.
 *
 * It used to be appended unconditionally to `.top-bar`. On the browser client
 * that bar is hidden outright once a rail exists (`body.has-rail .top-bar {
 * display: none }` in the relay's chat.html) — the conversation's controls move
 * into `#session-head` there. So the button was built into a hidden element: it
 * showed for the frame before the repo catalog arrived, then vanished, and the
 * remote file browser was unreachable on every browser wide enough for a rail.
 *
 * The ordering is the trap and the reason this is a test rather than a comment:
 * capabilities arrive on `initialState`, `repos` arrives later, and the button
 * is therefore always built while `.top-bar` is still the correct answer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const withRail = (window: any) => {
  const doc = window.document;
  const rail = doc.createElement("aside");
  rail.id = "projects-rail";
  rail.hidden = true;
  const scroll = doc.createElement("div");
  scroll.id = "rail-scroll";
  rail.appendChild(scroll);
  doc.body.appendChild(rail);
  // The relay's own conversation header. Only that page has it, which is why
  // chat.js selects on presence rather than on a host name or a version.
  const head = doc.createElement("header");
  head.id = "session-head";
  const title = doc.createElement("span");
  title.id = "session-head-title";
  head.appendChild(title);
  const sub = doc.createElement("span");
  sub.id = "session-head-sub";
  head.appendChild(sub);
  const history = doc.createElement("button");
  history.id = "session-history";
  head.appendChild(history);
  doc.body.appendChild(head);
};

/** A remote host that advertises the file browser, exactly as the relay does. */
function remoteWithFiles(before?: (w: any) => void): Harness {
  const h = bootWebview({ remote: true, beforeScripts: before });
  dispatch(h.window, {
    type: "initialState",
    cwd: "/proj",
    capabilities: { browseProjectFiles: true, editProjectFiles: true },
  } as never);
  return h;
}

function sendRepos(h: Harness) {
  dispatch(h.window, {
    type: "repos",
    entries: [{ cwd: "/proj", label: "proj", available: true, pinned: false, updatedAt: 1 }],
    selectedCwd: "/proj",
    activeCwd: "/proj",
  } as never);
}

describe("remote files button placement", () => {
  it("sits last in the top bar, behind a separator, when the page has no rail", () => {
    // A panel toggle, placed like the desktop panel's: at the end, after a
    // separator. It used to sit between History and the overflow, where it read
    // as one more conversation action.
    const h = remoteWithFiles();
    const btn = h.doc.getElementById("files-browse-btn");
    expect(btn).toBeTruthy();
    const bar = btn!.closest(".top-bar");
    expect(bar).toBeTruthy();
    expect(bar!.lastElementChild).toBe(btn);
    expect(btn!.previousElementSibling?.id).toBe("files-browse-sep");
  });

  it("moves out of the hidden top bar into the session head when the rail arrives", () => {
    const h = remoteWithFiles(withRail);
    // Built before `repos` — the top bar is still the right home at this point.
    const btn = h.doc.getElementById("files-browse-btn")!;
    expect(btn.closest(".top-bar")).toBeTruthy();

    sendRepos(h);

    expect(h.doc.body.classList.contains("has-rail")).toBe(true);
    // The regression: still parented to the now-`display:none` bar.
    expect(btn.closest(".top-bar")).toBeNull();
    expect(btn.parentElement?.id).toBe("session-head");
    expect(btn.parentElement!.lastElementChild).toBe(btn);
    expect(btn.previousElementSibling?.id).toBe("files-browse-sep");
    expect((btn as HTMLButtonElement).hidden).toBe(false);
  });

  it("does not stack duplicates when the rail re-renders", () => {
    const h = remoteWithFiles(withRail);
    sendRepos(h);
    sendRepos(h);
    sendRepos(h);
    expect(h.doc.querySelectorAll("#files-browse-btn").length).toBe(1);
    expect(h.doc.querySelectorAll("#files-browse-sep").length).toBe(1);
    expect(h.doc.getElementById("session-head")!.lastElementChild).toBe(
      h.doc.getElementById("files-browse-btn"),
    );
  });

  it("mounts nothing when the host does not advertise the capability", () => {
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "initialState", cwd: "/proj", capabilities: {} } as never);
    sendRepos(h);
    const btn = h.doc.getElementById("files-browse-btn") as HTMLButtonElement | null;
    // Either never built, or built and hidden — both are correct; a visible
    // control the host cannot answer is not.
    expect(btn === null || btn.hidden).toBe(true);
  });
});

describe("page-local file panel layers", () => {
  function withDock(window: any) {
    window.happyDOM.setViewport({ width: 1200, height: 800 });
    const host = window.document.createElement("div");
    host.id = "file-panel-dock";
    window.document.body.appendChild(host);
  }

  it.each(["close button", "toggle", "dismissTop", "capability removed"])("reports closing through %s", async (close) => {
    const h = remoteWithFiles();
    const layers = (h.window as any).afkpilotLayers;
    const depths: number[] = [];
    h.window.addEventListener("afkpilot-layers", () => depths.push(layers.depth));
    expect(layers.depth).toBe(0);
    expect(layers.dismissTop()).toBe(false);
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    expect(layers.depth).toBe(1);
    expect(depths).toEqual([1]);
    if (close === "close button") click(h.window, h.doc.querySelector(".gfp-close")!);
    else if (close === "toggle") click(h.window, h.doc.getElementById("files-browse-btn")!);
    else if (close === "dismissTop") expect(layers.dismissTop()).toBe(true);
    else {
      dispatch(h.window, { type: "initialState", capabilities: {} });
      dispatch(h.window, { type: "initialState", capabilities: {} });
    }
    expect((h.doc.getElementById("files-browse-panel") as HTMLElement).hidden).toBe(true);
    expect(h.doc.body.classList.contains("files-browse-open")).toBe(false);
    expect(layers.depth).toBe(0);
    expect(layers.dismissTop()).toBe(false);
    expect(depths).toEqual([1, 0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.window.happyDOM.abort();
  });

  it("does not count or dismiss a docked panel, including underneath Settings", async () => {
    const h = remoteWithFiles(withDock);
    const layers = (h.window as any).afkpilotLayers;
    const depths: number[] = [];
    h.window.addEventListener("afkpilot-layers", () => depths.push(layers.depth));
    const panel = h.doc.getElementById("files-browse-panel") as HTMLElement;
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    expect(panel.classList.contains("gfp-docked")).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(layers.depth).toBe(0);
    expect(layers.dismissTop()).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(depths).toEqual([]);

    (h.window as any).__grokFilePanelOpenSettings();
    expect(layers.depth).toBe(1);
    expect(layers.dismissTop()).toBe(true);
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(layers.depth).toBe(0);
    expect(layers.dismissTop()).toBe(false);
    expect(panel.hidden).toBe(false);
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    expect(panel.hidden).toBe(true);
    expect(depths).toEqual([1, 0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.window.happyDOM.abort();
  });

  it("dismisses Settings before the file overlay underneath it without needing styles", async () => {
    const h = remoteWithFiles();
    const layers = (h.window as any).afkpilotLayers;
    const depths: number[] = [];
    h.window.addEventListener("afkpilot-layers", () => depths.push(layers.depth));
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    (h.window as any).__grokFilePanelOpenSettings();
    const panel = h.doc.getElementById("files-browse-panel") as HTMLElement;
    expect(panel.classList.contains("gfp-overlay")).toBe(true);
    expect(layers.depth).toBe(2);
    expect(layers.dismissTop()).toBe(true);
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(panel.hidden).toBe(false);
    expect(layers.depth).toBe(1);
    expect(layers.dismissTop()).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(layers.depth).toBe(0);
    expect(layers.dismissTop()).toBe(false);
    expect(depths).toEqual([1, 2, 1, 0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.window.happyDOM.abort();
  });

  it("reports presentation changes only when an open panel becomes or stops being a layer", async () => {
    const h = remoteWithFiles(withDock);
    const layers = (h.window as any).afkpilotLayers;
    const depths: number[] = [];
    h.window.addEventListener("afkpilot-layers", () => depths.push(layers.depth));
    const panel = h.doc.getElementById("files-browse-panel") as HTMLElement;
    const resize = (width: number) => {
      h.window.happyDOM.setViewport({ width, height: 800 });
      h.window.dispatchEvent(new h.window.Event("resize"));
    };
    resize(390);
    expect(panel.classList.contains("gfp-overlay")).toBe(true);
    expect(layers.depth).toBe(0);
    resize(1200);
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    expect(layers.depth).toBe(0);
    expect(depths).toEqual([]);
    resize(390);
    expect(layers.depth).toBe(1);
    resize(390);
    expect(depths).toEqual([1]);
    resize(1200);
    expect(panel.classList.contains("gfp-docked")).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(layers.depth).toBe(0);
    expect(layers.dismissTop()).toBe(false);
    resize(1200);
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    resize(390);
    expect(layers.depth).toBe(0);
    expect(depths).toEqual([1, 0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.window.happyDOM.abort();
  });

  it("handles a docked panel becoming the top overlay while Settings is already open", async () => {
    const h = remoteWithFiles((window) => {
      withDock(window);
      for (const name of ["settings", "file-panel"]) {
        const style = window.document.createElement("style");
        style.textContent = readFileSync(new URL(`../media/${name}.css`, import.meta.url), "utf8");
        window.document.head.appendChild(style);
      }
    });
    const layers = (h.window as any).afkpilotLayers;
    const depths: number[] = [];
    h.window.addEventListener("afkpilot-layers", () => depths.push(layers.depth));
    click(h.window, h.doc.getElementById("files-browse-btn")!);
    (h.window as any).__grokFilePanelOpenSettings();
    expect(layers.depth).toBe(1);
    expect(depths).toEqual([1]);
    // No click on the covered files toggle: changing presentation is enough
    // to put the phone overlay (1200) above the existing Settings (120).
    h.window.happyDOM.setViewport({ width: 390, height: 844 });
    h.window.dispatchEvent(new h.window.Event("resize"));
    expect(layers.depth).toBe(2);
    const panel = h.doc.getElementById("files-browse-panel") as HTMLElement;
    expect(panel.classList.contains("gfp-overlay")).toBe(true);
    expect(h.window.getComputedStyle(panel as any).zIndex).toBe("1200");
    expect(h.window.getComputedStyle(h.doc.getElementById("settings-overlay") as any).zIndex).toBe("120");
    expect(depths).toEqual([1, 2]);
    expect(layers.dismissTop()).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(h.doc.getElementById("settings-overlay")).not.toBeNull();
    expect(layers.depth).toBe(1);
    expect(layers.dismissTop()).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(layers.depth).toBe(0);
    expect(layers.dismissTop()).toBe(false);
    expect(depths).toEqual([1, 2, 1, 0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.window.happyDOM.abort();
  });

  it.each(["overlay", "docked"])("only publishes dismissible restored-open state (%s)", async (presentation) => {
    const depths: number[] = [];
    const dismissed: boolean[] = [];
    const h = remoteWithFiles((window) => {
      if (presentation === "docked") withDock(window);
      window.sessionStorage.setItem("grok.remote.filesOpen", "1");
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => query === "(hover: none), (pointer: coarse)"
        ? { matches: false } : matchMedia(query);
      window.addEventListener("afkpilot-layers", () => {
        depths.push(window.afkpilotLayers.depth);
        if (window.afkpilotLayers.depth) dismissed.push(window.afkpilotLayers.dismissTop());
      });
    });
    expect(depths).toEqual(presentation === "overlay" ? [1, 0] : []);
    expect(dismissed).toEqual(presentation === "overlay" ? [true] : []);
    expect((h.window as any).afkpilotLayers.depth).toBe(0);
    expect((h.doc.getElementById("files-browse-panel") as HTMLElement).hidden).toBe(presentation === "overlay");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.window.happyDOM.abort();
  });
});
