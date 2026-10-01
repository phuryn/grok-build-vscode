import { afterEach, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RAIL_EXPANDED, RAIL_PREVIEW } from "../src/projects-rail";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const railSrc = read("../media/projects-rail.js");
const railCss = read("../media/projects-rail.css");

interface Posted {
  type: string;
  [key: string]: unknown;
}

interface WebviewShape {
  railShape?: {
    collapsed?: Record<string, boolean>;
    expanded?: Record<string, boolean>;
    groupCollapsed?: Record<string, boolean>;
  };
}

const windows: Window[] = [];

function bootRail(seed: WebviewShape = {}) {
  const window = new Window({ url: "https://example.test/" });
  windows.push(window);
  const posted: Posted[] = [];
  let stored = seed;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = () => ({ matches: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (message: Posted) => posted.push(message),
    getState: () => stored,
    setState: (next: WebviewShape) => { stored = next; },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).confirm = () => true;
  window.document.body.innerHTML = `
    <aside id="projects-rail">
      <input id="rail-search" type="search" />
      <div id="rail-scroll"></div>
    </aside>
  `;
  window.eval(railSrc);
  return {
    window,
    doc: window.document,
    posted,
    getStored: () => stored,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: (window as any).__grokProjectsRail as {
      onMessage: (message: unknown) => void;
      RAIL_PREVIEW: number;
      RAIL_EXPANDED: number;
    },
  };
}

const repos = [
  { cwd: "/work/zeta", label: "zeta", available: true, archived: false, color: "" },
  { cwd: "/work/alpha", label: "alpha", available: true, archived: false, color: "" },
  { cwd: "/work/old", label: "old", available: true, archived: true, color: "" },
];

const session = (id: string, cwd: string, updatedAt: number) => ({
  id,
  cwd,
  displayName: `chat ${id}`,
  updatedAt,
  createdAt: 1,
  numMessages: 2,
});

function loadCatalog(h: ReturnType<typeof bootRail>) {
  h.api.onMessage({
    type: "repos",
    entries: repos,
    selectedCwd: "/work/zeta",
    activeCwd: "/work/zeta",
  });
}

function loadSessions(h: ReturnType<typeof bootRail>, count = 6) {
  const entries = Array.from({ length: count }, (_, index) =>
    session(`z${index}`, "/work/zeta", 100 - index),
  );
  h.api.onMessage({
    type: "sessions",
    entries,
    activeId: null,
    dots: {},
    offset: 0,
    total: entries.length,
  });
  h.api.onMessage({
    type: "repoSessions",
    cwd: "/work/alpha",
    entries: Array.from({ length: 5 }, (_, index) =>
      session(`a${index}`, "/work/alpha", 50 - index),
    ),
    dots: {},
    total: 5,
  });
}

function groupButton(doc: Document, title: string): HTMLButtonElement {
  const button = [...doc.querySelectorAll<HTMLButtonElement>(".rail-head-btn")]
    .find((candidate) => candidate.querySelector(".rail-head-title")?.textContent === title);
  expect(button, `missing ${title} group button`).toBeTruthy();
  return button!;
}

afterEach(() => {
  while (windows.length) windows.pop()!.close();
});

describe("VS Code projects rail section parity", () => {
  it("guards the plain-JS preview constants against their TypeScript source", () => {
    const preview = railSrc.match(/const\s+RAIL_PREVIEW\s*=\s*(\d+)/);
    const expanded = railSrc.match(/const\s+RAIL_EXPANDED\s*=\s*(\d+)/);
    expect(Number(preview?.[1])).toBe(RAIL_PREVIEW);
    expect(Number(expanded?.[1])).toBe(RAIL_EXPANDED);
    expect(RAIL_PREVIEW).toBe(3);
    expect(RAIL_EXPANDED).toBe(20);
  });

  it("uses one collapsible Projects group, keeps current first, and leaves Pinned static", () => {
    const h = bootRail();
    loadCatalog(h);
    loadSessions(h);
    h.api.onMessage({
      type: "pinnedSessions",
      entries: [{ ...session("pin", "/work/alpha", 200), pinnedAt: 1 }],
      dots: {},
    });

    const titles = [...h.doc.querySelectorAll(".rail-head-title")].map((el) => el.textContent);
    expect(titles).toEqual(["Pinned", "Recent", "Projects", "Project Archive"]);
    expect(h.doc.querySelector(".rail-pinned")?.previousElementSibling?.querySelector("button"))
      .toBeNull();
    expect([...h.doc.querySelectorAll(".rail-projects .rail-repo-label")].map((el) => el.textContent))
      .toEqual(["zeta", "alpha"]);
    expect(h.doc.querySelector(".rail-projects .rail-current-tag")?.textContent).toBe("Your IDE");
    expect(h.doc.querySelector(".rail-archived")).toBeNull();
    expect(groupButton(h.doc, "Project Archive").getAttribute("aria-expanded")).toBe("false");
  });

  it("shows three rows, then Show more to the loaded cap, then Show less", () => {
    const h = bootRail();
    loadCatalog(h);
    loadSessions(h, 8);
    const current = h.doc.querySelector('.rail-repo[data-cwd="/work/zeta"]')!;
    expect(current.querySelectorAll(".rail-session")).toHaveLength(3);
    const more = current.querySelector(".rail-more") as HTMLButtonElement;
    expect(more.textContent).toBe("Show more");
    expect(more.textContent).not.toMatch(/\d/);

    more.click();
    const expanded = h.doc.querySelector('.rail-repo[data-cwd="/work/zeta"]')!;
    expect(expanded.querySelectorAll(".rail-session")).toHaveLength(8);
    const less = expanded.querySelector(".rail-more") as HTMLButtonElement;
    expect(less.textContent).toBe("Show less");
    less.click();
    expect(h.doc.querySelectorAll('.rail-repo[data-cwd="/work/zeta"] .rail-session'))
      .toHaveLength(3);
  });

  it("persists group folds, repo folds, and expanded lists across a reload", () => {
    const first = bootRail();
    loadCatalog(first);
    loadSessions(first, 7);
    (first.doc.querySelector('.rail-repo[data-cwd="/work/zeta"] .rail-more') as HTMLElement).click();
    (first.doc.querySelector('.rail-repo[data-cwd="/work/alpha"] .rail-repo-head') as HTMLElement)
      .click();
    groupButton(first.doc, "Recent").click();

    const saved = first.getStored();
    expect(saved.railShape?.expanded?.["/work/zeta"]).toBe(true);
    expect(saved.railShape?.collapsed?.["/work/alpha"]).toBe(true);
    expect(saved.railShape?.groupCollapsed?.recent).toBe(false);

    const restored = bootRail(saved);
    loadCatalog(restored);
    loadSessions(restored, 7);
    expect(restored.doc.querySelector(".rail-recent")).not.toBeNull();
    groupButton(restored.doc, "Recent").click();
    expect(restored.doc.querySelector(".rail-recent")).toBeNull();
    expect(restored.doc.querySelector('.rail-repo[data-cwd="/work/alpha"]')?.classList)
      .toContain("collapsed");
    expect(restored.doc.querySelectorAll('.rail-repo[data-cwd="/work/alpha"] .rail-session'))
      .toHaveLength(0);
    expect(restored.doc.querySelectorAll('.rail-repo[data-cwd="/work/zeta"] .rail-session'))
      .toHaveLength(7);
    expect(restored.doc.querySelector('.rail-repo[data-cwd="/work/zeta"] .rail-more')?.textContent)
      .toBe("Show less");
  });

  it("forces matching collapsed groups open while search is active", () => {
    const h = bootRail({ railShape: { groupCollapsed: { projects: true, recent: true } } });
    loadCatalog(h);
    loadSessions(h);
    expect(h.doc.querySelector(".rail-projects")).toBeNull();
    const search = h.doc.querySelector("#rail-search") as HTMLInputElement;
    search.value = "alpha";
    search.dispatchEvent(new h.window.Event("input"));
    const projects = groupButton(h.doc, "Projects");
    expect(projects.disabled).toBe(true);
    expect(projects.getAttribute("aria-expanded")).toBe("true");
    expect(projects.title).toContain("search");
    expect(h.doc.querySelector(".rail-projects")).not.toBeNull();
  });

  it("opens the same action menus from right-click on hover-capable hosts", () => {
    const h = bootRail();
    loadCatalog(h);
    loadSessions(h);
    const repoHead = h.doc.querySelector('.rail-repo[data-cwd="/work/alpha"] .rail-repo-head')!;
    const repoEvent = new h.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 12,
    });
    repoHead.dispatchEvent(repoEvent);
    expect(repoEvent.defaultPrevented).toBe(true);
    expect(h.doc.querySelector(".rail-menu")?.textContent).toContain("Archive project");

    const sessionRow = h.doc.querySelector('.rail-repo[data-cwd="/work/alpha"] .rail-session')!;
    const sessionEvent = new h.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    sessionRow.dispatchEvent(sessionEvent);
    expect(sessionEvent.defaultPrevented).toBe(true);
    expect(h.doc.querySelector(".rail-menu")?.textContent).toContain("Rename");
    expect(h.doc.querySelector(".rail-menu")?.textContent).toContain("Delete");
  });

  it("does not dismiss a popup the pointer has not reached yet", () => {
    // A menu anchored to the ⋯ button opens at the RIGHT of the rail. On a wide
    // rail the cursor that opened it is already further away than the walk-away
    // radius, so the popup vanished on the way to it. Leaving is only something
    // you can do after arriving.
    const start = railSrc.indexOf('document.addEventListener("mousemove"');
    expect(start).toBeGreaterThan(-1);
    const body = railSrc.slice(start, railSrc.indexOf("});", start));
    expect(body).toContain("if (distance === 0) pointerEnteredPopup = true;");
    expect(body).toContain("else if (pointerEnteredPopup && distance > 50) closeMenu();");
  });

  it("opens the colour swatches where the menu was, not back at the button", () => {
    // Same symptom, different cause: the picker re-anchored to the ⋯ button, so
    // choosing "Set color" from a menu opened at the pointer threw the swatches
    // across a wide rail — and then walking after them dismissed them.
    expect(railSrc).toContain("lastMenuRect = menuEl ? menuEl.getBoundingClientRect() : null;");
    expect(railSrc).toContain("openColorPicker(menuBtn, repo, lastMenuRect)");
    expect(railSrc).toContain("at ? { x: at.left, y: at.top } : undefined");
  });

  it("lets section labels scroll away with their own rows", () => {
    // The desktop rail freezes one section label at the top. Here that read as
    // the label being stuck while the rows it belongs to slid up underneath it,
    // so the owner asked for the difference (2026-08-10). The two rails share a
    // visual language and a copy-paste back from chat.css would silently
    // reintroduce it — hence a guard rather than a comment.
    const head = railCss.match(/\n\.rail-head\s*{([^}]*)}/);
    expect(head, ".rail-head rule must exist").toBeTruthy();
    expect(head![1]).not.toMatch(/position:\s*sticky/);
  });

  it("keeps a destructive confirm red under the pointer", () => {
    // The confirm button is `rail-dialog-btn rail-dialog-primary rail-dialog-danger`
    // — danger is a MODIFIER on primary. `.rail-dialog-primary:hover` alone
    // outranks a plain `.rail-dialog-danger` (a pseudo-class adds specificity),
    // so Delete and Clear all turned button-blue the moment you pointed at them.
    const dangerHover = railCss.match(/\.rail-dialog-danger:hover[^{]*{([^}]*)}/);
    expect(dangerHover, "danger needs its own hover rule").toBeTruthy();
    expect(dangerHover![1]).toMatch(/errorForeground|inputValidation-errorBorder/);
    expect(dangerHover![1]).not.toMatch(/button-hoverBackground/);
  });

  function projectLabels(doc: Document): string[] {
    return [...doc.querySelectorAll(".rail-projects .rail-repo-label")].map((el) => el.textContent || "");
  }

  function loadWindow(h: ReturnType<typeof bootRail>, extra: Record<string, unknown>) {
    h.api.onMessage({
      type: "repos",
      entries: repos,
      selectedCwd: "/work/zeta",
      activeCwd: "/work/zeta",
      workspaceCwd: "/work/zeta",
      canAddProject: true,
      canCreateProject: true,
      canCloneProject: true,
      ...extra,
    });
  }

  const groupsOpen = { railShape: { groupCollapsed: { recent: false, projects: false, archived: false } } };

  it("paints only the folders this window has open", () => {
    const h = bootRail(groupsOpen);
    loadWindow(h, { workspaceOnly: true, workspaceFolders: ["/work/zeta"] });
    loadSessions(h);
    h.api.onMessage({
      type: "pinnedSessions",
      entries: [{ ...session("pin", "/work/alpha", 200), pinnedAt: 1 }],
      dots: {},
    });

    expect(projectLabels(h.doc)).toEqual(["zeta"]);
    expect(h.doc.querySelector('.rail-repo[data-cwd="/work/alpha"]')).toBeNull();
    expect(h.doc.querySelector('.rail-repo[data-cwd="/work/old"]')).toBeNull();
    expect(h.doc.querySelector(".rail-pinned")).toBeNull();
    expect(h.doc.body.textContent).not.toContain("chat a");
    expect(h.doc.body.textContent).not.toContain("chat pin");
    expect(h.doc.querySelector(".rail-add-project")).toBeNull();
    expect(h.doc.querySelector(".rail-add-project-wide")).toBeNull();
    expect(h.posted.filter((p) => p.type === "listRepoSessions").map((p) => p.cwd)).toEqual([]);
  });

  it("badges every open folder and still hides the rest", () => {
    const h = bootRail(groupsOpen);
    loadWindow(h, { workspaceOnly: true, workspaceFolders: ["/work/zeta", "/work/alpha"] });
    loadSessions(h);

    expect(projectLabels(h.doc)).toEqual(["zeta", "alpha"]);
    expect(
      [...h.doc.querySelectorAll(".rail-projects .rail-current-tag")].map((el) => el.textContent),
    ).toEqual(["Your IDE", "Your IDE"]);
    expect(h.doc.querySelector('.rail-repo[data-cwd="/work/old"]')).toBeNull();
    expect(h.posted.filter((p) => p.type === "listRepoSessions").map((p) => p.cwd)).toEqual(["/work/alpha"]);
  });

  it("keeps the full catalog when the window has no folder", () => {
    const h = bootRail();
    loadWindow(h, { workspaceOnly: true, workspaceFolders: [] });

    expect(projectLabels(h.doc)).toEqual(["zeta", "alpha"]);
    expect(h.doc.querySelector(".rail-add-project")).not.toBeNull();
    expect(h.doc.querySelector(".rail-add-project-wide")).not.toBeNull();
  });

  it("matches desktop row rhythm and uses an opaque layered action scrim", () => {
    expect(railCss).toMatch(/--rail-row-font-size:\s*13px/);
    expect(railCss).toMatch(/--rail-row-min-height:\s*24px/);
    expect(railCss).toMatch(/--rail-repo-font-size:\s*14px/);
    expect(railCss).toMatch(/\.rail-repo\.collapsed\s+\.rail-sessions\s*{\s*display:\s*none/);
    expect(railCss).toMatch(
      /\.rail-session\.active\s+\.rail-session-actions\s*{[\s\S]*?var\(--vscode-list-activeSelectionBackground\)[\s\S]*?var\(--vscode-sideBar-background\)/,
    );
    expect(railCss).toMatch(
      /\.rail-repo-actions,[\s\S]*?\.rail-session-actions\s*{[\s\S]*?var\(--rail-hover-bg,[\s\S]*?var\(--vscode-sideBar-background\)/,
    );
    expect(railCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
