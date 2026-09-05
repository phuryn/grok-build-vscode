/**
 * DOM tests for the VS Code primary-side-bar projects rail (media/projects-rail.js).
 * Separate from test/projects-rail.dom.test.ts, which drives the chat.js rail mount.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const railSrc = read("../media/projects-rail.js");

interface Posted {
  type: string;
  [k: string]: unknown;
}

function bootRail() {
  const posted: Posted[] = [];
  const window = new Window({ url: "https://example.test/" });
  const doc = window.document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (m: Posted) => {
      posted.push(m);
    },
    getState: () => ({}),
    setState: () => {},
  });
  // confirm for destructive menu items in tests that do not exercise them
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).confirm = () => true;
  doc.body.innerHTML = `
    <aside id="projects-rail" class="projects-rail" aria-label="Projects">
      <div class="rail-search-wrap">
        <input id="rail-search" class="rail-search" type="search" />
      </div>
      <div id="rail-scroll" class="rail-scroll"></div>
    </aside>
  `;
  window.eval(railSrc);
  return { window, doc, posted };
}

const repos = [
  { cwd: "/work/alpha", label: "alpha", available: true, updatedAt: 30 },
  { cwd: "/work/beta", label: "beta", available: true, updatedAt: 10 },
  { cwd: "/work/gamma", label: "gamma", available: true, updatedAt: 20 },
];

const row = (id: string, cwd: string, name: string, updatedAt = 1) =>
  ({ id, cwd, displayName: name, rawSummary: "", updatedAt, createdAt: 1, numMessages: 2 });

function sectionTitles(doc: Document): string[] {
  return [...doc.querySelectorAll(".rail-head")].map((e) => (e.textContent || "").trim());
}

function repoLabels(doc: Document): string[] {
  return [...doc.querySelectorAll(".rail-repo-label")].map((e) => e.textContent || "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function railApi(window: any) {
  return window.__grokProjectsRail as {
    state: Record<string, unknown>;
    onMessage: (msg: unknown) => void;
    recentRows: () => { id: string; displayName?: string }[];
    colorSupported: () => boolean;
    RECENT_CAP: number;
  };
}

function loadCatalog(
  api: ReturnType<typeof railApi>,
  selectedCwd = "/work/alpha",
  catalog: typeof repos = repos,
) {
  api.onMessage({
    type: "repos",
    entries: catalog,
    selectedCwd,
    activeCwd: selectedCwd,
  });
}

function loadSessions(
  api: ReturnType<typeof railApi>,
  entries: ReturnType<typeof row>[],
  activeId: string | null = null,
) {
  api.onMessage({
    type: "sessions",
    entries,
    activeId,
    dots: {},
    offset: 0,
    total: entries.length,
    hasMore: false,
    nextOffset: entries.length,
    query: "",
  });
}

it("removes abandoned sessions from selected rows, previews, pins and Recent without changing focus", () => {
  const { window, doc, posted } = bootRail();
  const api = railApi(window);
  loadCatalog(api);
  const empty = { ...row("empty", "/work/alpha", "Abandoned empty"), pinned: true };
  const kept = row("kept", "/work/alpha", "Keep this conversation");
  loadSessions(api, [empty, kept], "kept");
  api.onMessage({ type: "repoSessions", cwd: empty.cwd, entries: [empty, kept], total: 2, dots: {} });
  api.onMessage({ type: "pinnedSessions", entries: [empty], dots: { empty: "idle" } });
  posted.length = 0;
  api.onMessage({ type: "sessionRemoved", id: "empty", cwd: empty.cwd });
  api.onMessage({ type: "sessionRemoved", id: "empty", cwd: empty.cwd });
  expect(api.state.currentSessions).toEqual([kept]);
  expect(api.state.pinnedSessions).toEqual([]);
  expect(Object.values(api.state.previews as Record<string, unknown>)).toEqual([{ entries: [kept], total: 1 }]);
  expect(api.state.dots).toEqual({});
  expect(api.state.activeSessionId).toBe("kept");
  expect(api.recentRows().map((s) => s.id)).toEqual(["kept"]);
  expect(doc.querySelectorAll('[data-session-id="empty"]')).toHaveLength(0);
  expect(posted).toEqual([]);
  loadCatalog(api, "/work/beta");
  expect(api.recentRows().map((s) => s.id)).toEqual(["kept"]);
  window.close();
});

function openProjectMenu(doc: Document, window: Window, repoLabel: string) {
  const labels = [...doc.querySelectorAll(".rail-repo-label")];
  const labelEl = labels.find((e) => e.textContent === repoLabel);
  expect(labelEl).toBeTruthy();
  const head = labelEl!.closest(".rail-repo-head") as HTMLElement;
  const btns = [...head.querySelectorAll(".rail-action-btn")] as HTMLElement[];
  // Last action is the ⋯ menu (current project may also have +).
  const menuBtn = btns[btns.length - 1];
  menuBtn.click();
  return doc.querySelector(".rail-menu") as HTMLElement;
}

function menuItem(menu: Element, label: string) {
  return [...menu.querySelectorAll(".rail-menu-item")].find(
    (b) => (b.textContent || "").includes(label),
  ) as HTMLElement | undefined;
}

describe("VS Code projects rail renderer", () => {
  let h: ReturnType<typeof bootRail>;

  beforeEach(() => {
    h = bootRail();
  });

  afterEach(() => {
    h.window.close();
  });

  it("posts ready on boot", () => {
    expect(h.posted.some((p) => p.type === "ready")).toBe(true);
  });

  it("renders one Projects group with the open folder first", () => {
    const { window, doc } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/beta");
    loadSessions(api, [row("b1", "/work/beta", "beta chat")]);
    api.onMessage({
      type: "repoSessions",
      cwd: "/work/alpha",
      entries: [row("a1", "/work/alpha", "alpha chat")],
      dots: {},
      total: 1,
    });
    api.onMessage({
      type: "repoSessions",
      cwd: "/work/gamma",
      entries: [row("g1", "/work/gamma", "gamma chat")],
      dots: {},
      total: 1,
    });

    // RECENT appears once any sessions are known; projects stay below it.
    expect(sectionTitles(doc)).toEqual(["Recent", "Projects"]);
    const projects = doc.querySelector(".rail-projects");
    expect(
      [...(projects?.querySelectorAll(".rail-repo-label") || [])].map((e) => e.textContent),
    ).toEqual(["beta", "alpha", "gamma"]);
    expect(projects?.querySelector(".rail-current-tag")?.textContent).toBe("Your IDE");
    expect(repoLabels(doc)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("clicking a conversation in another project posts plain resumeSession only", () => {
    const { window, doc, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    loadSessions(api, [row("a1", "/work/alpha", "here")]);
    api.onMessage({
      type: "repoSessions",
      cwd: "/work/gamma",
      entries: [row("g1", "/work/gamma", "other chat")],
      dots: {},
      total: 1,
    });

    posted.length = 0;

    const otherName = [...doc.querySelectorAll(".rail-session-name")].find(
      (e) => e.textContent === "other chat",
    ) as HTMLElement | undefined;
    expect(otherName).toBeTruthy();
    const rowEl = otherName!.closest(".rail-session") as HTMLElement;
    rowEl.click();

    expect(posted).toEqual([
      { type: "resumeSession", id: "g1", cwd: "/work/gamma", claim: true },
    ]);
    expect(posted.some((p) => p.type === "selectRepo")).toBe(false);
  });

  it("selects duplicate-titled New session rows by id and drops an empty-id entry", () => {
    const { window, doc, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    loadSessions(api, [
      row("", "/work/alpha", "New session", 12),
      row("live-a", "/work/alpha", "New session", 11),
      row("live-b", "/work/alpha", "New session", 10),
    ], "live-a");
    const projectRows = [...doc.querySelectorAll(".rail-projects .rail-session")] as HTMLElement[];
    expect(projectRows.map((el) => el.dataset.sessionId)).toEqual(["live-a", "live-b"]);
    posted.length = 0;
    projectRows[1].click();
    expect(posted).toEqual([
      { type: "resumeSession", id: "live-b", cwd: "/work/alpha", claim: true },
    ]);
  });

  it("highlights the clicked conversation immediately, before the host answers", () => {
    // The desktop rail shares a document with the chat, so its click can move
    // the highlight and be right. Here the rail is a separate webview and the
    // highlight waited on a round-trip through the extension host, which reads
    // as a dead click.
    const { window, doc } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    loadSessions(api, [row("a1", "/work/alpha", "here"), row("a2", "/work/alpha", "there")], "a1");

    const target = [...doc.querySelectorAll(".rail-session")].find(
      (e) => e.querySelector(".rail-session-name")?.textContent === "there",
    ) as HTMLElement;
    target.click();

    const active = [...doc.querySelectorAll(".rail-session.active")];
    expect(active.length).toBeGreaterThan(0);
    expect(
      active.every((e) => e.querySelector(".rail-session-name")?.textContent === "there"),
      "the clicked row is the highlighted one",
    ).toBe(true);
  });

  it("ignores an activeId for a different conversation while a resume is in flight", () => {
    // A `sessions` frame already on the wire when the click happened names the
    // OLD conversation. Applying it would snap the highlight back and read as
    // the click being undone.
    const { window, doc } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    loadSessions(api, [row("a1", "/work/alpha", "here"), row("a2", "/work/alpha", "there")], "a1");

    const target = [...doc.querySelectorAll(".rail-session")].find(
      (e) => e.querySelector(".rail-session-name")?.textContent === "there",
    ) as HTMLElement;
    target.click();

    loadSessions(api, [row("a1", "/work/alpha", "here"), row("a2", "/work/alpha", "there")], "a1");
    expect(
      doc.querySelector(".rail-session.active .rail-session-name")?.textContent,
      "stale frame must not undo the click",
    ).toBe("there");

    // The host's real answer lands and is applied.
    api.onMessage({ type: "session", sessionId: "a2" });
    expect(doc.querySelector(".rail-session.active .rail-session-name")?.textContent).toBe("there");
  });

  it("lets a NEW session identify itself even while a resume is pending", () => {
    // The in-flight rule is right for a frame already on the wire and wrong the
    // moment the user asks for something else: a resume that never lands would
    // otherwise silence the identity of a conversation created after it, and
    // then the timer would put the old highlight back.
    const { window, doc } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    loadSessions(api, [row("a1", "/work/alpha", "here"), row("a2", "/work/alpha", "there")], "a1");

    const target = [...doc.querySelectorAll(".rail-session")].find(
      (e) => e.querySelector(".rail-session-name")?.textContent === "there",
    ) as HTMLElement;
    target.click(); // resume a2 — suppose the host never answers

    const plus = [...doc.querySelectorAll('.rail-action-btn[title="New session"]')][0] as HTMLButtonElement;
    expect(plus, "the rail offers New session per project").toBeTruthy();
    plus.click();

    // The host's answer for the BRAND NEW conversation must be applied.
    api.onMessage({
      type: "sessions",
      entries: [
        row("a1", "/work/alpha", "here"),
        row("a2", "/work/alpha", "there"),
        row("a3", "/work/alpha", "brand new"),
      ],
      activeId: "a3",
      dots: {},
      offset: 0,
      total: 3,
      hasMore: false,
    });
    expect(doc.querySelector(".rail-session.active .rail-session-name")?.textContent).toBe(
      "brand new",
    );
  });

  it("re-asks the host for everything when the rail becomes visible again", () => {
    // Recent ranks by the session file's mtime, which moves whenever a turn
    // finishes anywhere — including turns driven from a phone this view never
    // sees. A rail restored after being hidden is showing a stale order.
    const { window, doc, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");

    posted.length = 0;
    Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
    doc.dispatchEvent(new window.Event("visibilitychange"));
    expect(posted.some((p) => p.type === "ready")).toBe(true);

    posted.length = 0;
    Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
    doc.dispatchEvent(new window.Event("visibilitychange"));
    expect(posted, "a hidden view must not ask every project to rescan").toEqual([]);
  });

  it("requests listRepoSessions for other projects only", () => {
    const { window, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    const previews = posted.filter((p) => p.type === "listRepoSessions");
    expect(previews.map((p) => p.cwd).sort()).toEqual(["/work/beta", "/work/gamma"]);
    expect(previews.every((p) => p.cwd !== "/work/alpha")).toBe(true);
  });

  it("does not re-read every project on a repeated catalog push", () => {
    // `postRepoCatalog()` has 26 call sites and most push an UNCHANGED catalog
    // because a selection or a pin moved. Each preview is a session-index pass
    // per project on the host, so re-asking on every push is the whole cost.
    const { window, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    expect(posted.filter((p) => p.type === "listRepoSessions")).toHaveLength(2);

    posted.length = 0;
    loadCatalog(api, "/work/alpha");
    loadCatalog(api, "/work/alpha");
    expect(
      posted.filter((p) => p.type === "listRepoSessions"),
      "an unchanged catalog must not make every other project rescan",
    ).toEqual([]);
  });

  it("asks a project that is new to the catalog, without re-asking the rest", () => {
    const { window, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");

    posted.length = 0;
    loadCatalog(api, "/work/alpha", [
      ...repos,
      { cwd: "/work/delta", label: "delta", available: true, updatedAt: 5 },
    ]);
    expect(posted.filter((p) => p.type === "listRepoSessions").map((p) => p.cwd)).toEqual([
      "/work/delta",
    ]);
  });

  it("re-reads every project when the rail comes back into view", () => {
    // The counterweight to the two tests above: caching must not defeat the
    // refresh that exists because Recent's order moves when a phone drives a
    // turn this view never sees.
    const { window, doc, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");

    posted.length = 0;
    Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
    doc.dispatchEvent(new window.Event("visibilitychange"));
    // `ready` makes the host re-push the catalog; that push must now re-probe.
    loadCatalog(api, "/work/alpha");
    expect(
      posted.filter((p) => p.type === "listRepoSessions").map((p) => p.cwd).sort(),
    ).toEqual(["/work/beta", "/work/gamma"]);
  });

  it("forgets a project that has left the catalog", () => {
    const { window, posted } = h;
    const api = railApi(window);
    loadCatalog(api, "/work/alpha");
    api.onMessage({
      type: "repoSessions",
      cwd: "/work/gamma",
      entries: [row("g1", "/work/gamma", "gone with it", 99)],
      total: 1,
    });
    expect(api.recentRows().some((s) => s.id === "g1")).toBe(true);

    posted.length = 0;
    loadCatalog(api, "/work/alpha", repos.filter((r) => r.cwd !== "/work/gamma"));
    expect(
      api.recentRows().some((s) => s.id === "g1"),
      "a removed project's rows must stop feeding Recent",
    ).toBe(false);
  });

  describe("Pinned", () => {
    it("shows no Pinned group until the pinnedSessions frame arrives", () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha");
      loadSessions(api, [row("a1", "/work/alpha", "here", 10)]);
      // Sessions alone must not invent a Pinned section — capability is the frame.
      expect(sectionTitles(doc)).not.toContain("Pinned");
      expect(doc.querySelector(".rail-pinned")).toBeNull();
    });

    it("shows no Pinned group for an empty pinnedSessions frame", () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha");
      api.onMessage({ type: "pinnedSessions", entries: [], dots: {} });
      expect(sectionTitles(doc)).not.toContain("Pinned");
      expect(doc.querySelector(".rail-pinned")).toBeNull();
    });

    it("lifts pinned rows above Recent and labels each with its project", () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha");
      loadSessions(api, [row("a1", "/work/alpha", "alpha chat", 5)]);
      api.onMessage({
        type: "pinnedSessions",
        entries: [
          { ...row("b1", "/work/beta", "beta thing", 20), pinnedAt: 20 },
          { ...row("a2", "/work/alpha", "alpha thing", 15), pinnedAt: 10 },
        ],
        dots: {},
      });
      const heads = sectionTitles(doc);
      expect(heads[0]).toBe("Pinned");
      expect(heads).toContain("Recent");
      expect(heads.indexOf("Pinned")).toBeLessThan(heads.indexOf("Recent"));
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-name")].map((e) => e.textContent))
        .toEqual(["beta thing", "alpha thing"]);
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-repo")].map((e) => e.textContent))
        .toEqual(["beta", "alpha"]);
    });
  });

  describe("Recent", () => {
    it("does not reorder project or Recent rows when a conversation is only opened", () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha");
      const entries = [
        row("newer", "/work/alpha", "newer", 100),
        row("older", "/work/alpha", "older", 10),
      ];
      loadSessions(api, entries, "newer");
      const names = () => api.recentRows().map((entry) => entry.displayName);
      expect(names()).toEqual(["newer", "older"]);

      (doc.querySelector('[data-session-id="older"]') as HTMLElement).click();
      loadSessions(api, entries, "older");
      expect(names()).toEqual(["newer", "older"]);

      loadSessions(api, [{ ...entries[1], updatedAt: 200 }, entries[0]], "older");
      expect(names()).toEqual(["older", "newer"]);
    });

    it("merges sessions across projects, newest first, each labelled with its project", () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha");
      loadSessions(api, [row("a1", "/work/alpha", "alpha old", 10)]);
      api.onMessage({
        type: "repoSessions",
        cwd: "/work/beta",
        entries: [row("b1", "/work/beta", "beta new", 50)],
        dots: {},
        total: 1,
      });
      api.onMessage({
        type: "repoSessions",
        cwd: "/work/gamma",
        entries: [row("g1", "/work/gamma", "gamma mid", 30)],
        dots: {},
        total: 1,
      });

      ([...doc.querySelectorAll(".rail-head-btn")]
        .find((button) => (button.textContent || "").includes("Recent")) as HTMLElement).click();

      expect(sectionTitles(doc)[0]).toBe("Recent");
      const names = [...doc.querySelectorAll(".rail-recent .rail-session-name")].map(
        (e) => e.textContent,
      );
      expect(names).toEqual(["beta new", "gamma mid", "alpha old"]);
      const where = [...doc.querySelectorAll(".rail-recent .rail-session-repo")].map(
        (e) => e.textContent,
      );
      expect(where).toEqual(["beta", "gamma", "alpha"]);
    });

    it("caps Recent at 10 (not the per-project preview depth)", () => {
      const { window, doc } = h;
      const api = railApi(window);
      expect(api.RECENT_CAP).toBe(10);
      loadCatalog(api, "/work/alpha");
      const many = Array.from({ length: 15 }, (_, i) =>
        row(`s${i}`, "/work/alpha", `chat ${i}`, 100 - i),
      );
      loadSessions(api, many);
      ([...doc.querySelectorAll(".rail-head-btn")]
        .find((button) => (button.textContent || "").includes("Recent")) as HTMLElement).click();
      const showMore = doc.querySelector(".rail-recent .rail-more") as HTMLElement;
      expect(showMore.textContent).toBe("Show more");
      showMore.click();
      const recentNames = [...doc.querySelectorAll(".rail-recent .rail-session-name")].map(
        (e) => e.textContent,
      );
      expect(recentNames).toHaveLength(10);
      expect(recentNames[0]).toBe("chat 0");
      expect(recentNames[9]).toBe("chat 9");
      // Pure helper agrees with the renderer cap.
      expect(api.recentRows()).toHaveLength(10);
    });
  });

  describe("section order", () => {
    it("is Pinned → Recent → Projects → Project Archive", () => {
      const { window, doc } = h;
      const api = railApi(window);
      const catalog = [
        { cwd: "/work/alpha", label: "alpha", available: true, updatedAt: 30, color: "" },
        { cwd: "/work/beta", label: "beta", available: true, updatedAt: 10, color: "" },
        {
          cwd: "/work/old",
          label: "old",
          available: true,
          updatedAt: 1,
          archived: true,
          color: "",
        },
      ];
      loadCatalog(api, "/work/alpha", catalog);
      loadSessions(api, [row("a1", "/work/alpha", "here", 10)]);
      api.onMessage({
        type: "repoSessions",
        cwd: "/work/beta",
        entries: [row("b1", "/work/beta", "there", 20)],
        dots: {},
        total: 1,
      });
      api.onMessage({
        type: "pinnedSessions",
        entries: [{ ...row("b1", "/work/beta", "there", 20), pinnedAt: 1 }],
        dots: {},
      });

      expect(sectionTitles(doc)).toEqual([
        "Pinned",
        "Recent",
        "Projects",
        "Project Archive",
      ]);
    });
  });

  describe("project colour picker", () => {
    const withColors = () =>
      repos.map((r) => ({ ...r, color: r.cwd === "/work/beta" ? "teal" : "" }));

    it("hides Set color when the host never sends color", () => {
      const { window, doc } = h;
      const api = railApi(window);
      // Default catalog omits `color` entirely — older host, no control.
      loadCatalog(api, "/work/alpha");
      expect(api.colorSupported()).toBe(false);
      const menu = openProjectMenu(doc, window, "beta");
      expect(menuItem(menu, "Set color")).toBeUndefined();
      expect(menuItem(menu, "Clear all history")).toBeTruthy();
    });

    it("tints the folder stroke when the catalog carries a colour", () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha", withColors());
      const betaLabel = [...doc.querySelectorAll(".rail-repo-label")].find(
        (e) => e.textContent === "beta",
      )!;
      const beta = betaLabel.closest(".rail-repo")!;
      expect(beta.querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe("teal");
      const alphaLabel = [...doc.querySelectorAll(".rail-repo-label")].find(
        (e) => e.textContent === "alpha",
      )!;
      const alpha = alphaLabel.closest(".rail-repo")!;
      expect(alpha.querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe(null);
    });

    it("offers Set color, opens a swatch picker, and posts setRepoColor with the right cwd", () => {
      const { window, doc, posted } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha", withColors());
      expect(api.colorSupported()).toBe(true);

      const menu = openProjectMenu(doc, window, "alpha");
      expect(menuItem(menu, "Set color")).toBeTruthy();
      menuItem(menu, "Set color")!.click();

      expect(doc.querySelector(".rail-menu")).toBeNull();
      const picker = doc.querySelector(".rail-color-picker") as HTMLElement;
      expect(picker).not.toBeNull();
      const swatches = [...picker.querySelectorAll(".rail-color-swatch")] as HTMLElement[];
      expect(swatches).toHaveLength(7);
      expect(swatches.map((s) => s.getAttribute("aria-label"))).toEqual([
        "None",
        "Blue",
        "Teal",
        "Green",
        "Amber",
        "Coral",
        "Purple",
      ]);
      expect(swatches[0].classList.contains("is-none")).toBe(true);

      posted.length = 0;
      const blue = swatches.find((s) => s.getAttribute("aria-label") === "Blue")!;
      blue.click();
      expect(posted.filter((p) => p.type === "setRepoColor")).toEqual([
        { type: "setRepoColor", cwd: "/work/alpha", color: "blue" },
      ]);
      expect(doc.querySelector(".rail-color-picker")).toBeNull();
      const alphaTwisty = [...doc.querySelectorAll(".rail-repo-label")]
        .find((e) => e.textContent === "alpha")!
        .closest(".rail-repo")!
        .querySelector(".rail-twisty");
      expect(alphaTwisty?.getAttribute("data-repo-color")).toBe("blue");
    });

    it("keeps a confirming color frame and yields to a contradicting one", () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api, "/work/alpha", withColors());
      const menu = openProjectMenu(doc, window, "alpha");
      menuItem(menu, "Set color")!.click();
      const coral = [...doc.querySelectorAll(".rail-color-swatch")]
        .find((s) => s.getAttribute("aria-label") === "Coral") as HTMLElement;
      coral.click();
      const twisty = () => [...doc.querySelectorAll(".rail-repo-label")]
        .find((e) => e.textContent === "alpha")!
        .closest(".rail-repo")!
        .querySelector(".rail-twisty");
      expect(twisty()?.getAttribute("data-repo-color")).toBe("coral");

      loadCatalog(api, "/work/alpha", withColors().map((r) => r.cwd === "/work/alpha" ? { ...r, color: "coral" } : r));
      expect(twisty()?.getAttribute("data-repo-color")).toBe("coral");

      const menu2 = openProjectMenu(doc, window, "alpha");
      menuItem(menu2, "Set color")!.click();
      const blue = [...doc.querySelectorAll(".rail-color-swatch")]
        .find((s) => s.getAttribute("aria-label") === "Blue") as HTMLElement;
      blue.click();
      expect(twisty()?.getAttribute("data-repo-color")).toBe("blue");

      loadCatalog(api, "/work/alpha", withColors());
      expect(twisty()?.getAttribute("data-repo-color")).toBe(null);
    });
  });

  describe("optimistic session rename", () => {
    it("paints the row before any host frame, keeps a confirm, yields to a contradict", async () => {
      const { window, doc } = h;
      const api = railApi(window);
      loadCatalog(api);
      loadSessions(api, [row("a1", "/work/alpha", "alpha one")], "a1");

      const sessionRow = [...doc.querySelectorAll(".rail-session")].find(
        (e) => e.querySelector(".rail-session-name")?.textContent === "alpha one",
      ) as HTMLElement;
      const menuBtn = sessionRow.querySelector(".rail-action-btn:last-of-type") as HTMLElement;
      menuBtn.click();
      const rename = [...doc.querySelectorAll(".rail-menu-item")]
        .find((b) => (b.textContent || "").includes("Rename")) as HTMLElement;
      rename.click();
      await Promise.resolve();
      const input = doc.querySelector(".rail-dialog-input") as HTMLInputElement;
      expect(input).toBeTruthy();
      input.value = "Renamed on vscode rail";
      (doc.querySelector(".rail-dialog-primary") as HTMLElement).click();
      await Promise.resolve();

      expect(doc.querySelector(".rail-session-name")!.textContent).toBe("Renamed on vscode rail");

      loadSessions(api, [row("a1", "/work/alpha", "Renamed on vscode rail")], "a1");
      expect(doc.querySelector(".rail-session-name")!.textContent).toBe("Renamed on vscode rail");

      loadSessions(api, [row("a1", "/work/alpha", "Catalog title")], "a1");
      expect(doc.querySelector(".rail-session-name")!.textContent).toBe("Catalog title");
    });
  });
  describe("add project", () => {
    it("shows no control until the host says it answers addProjectFolder", () => {
      // Capability by field presence. An older host sends `repos` without the
      // flag and must not get a button whose message it would ignore.
      const { doc, window } = bootRail();
      loadCatalog(railApi(window));
      expect(doc.querySelector(".rail-add-project")).toBeNull();
    });

    it("puts a + on the Projects head and posts addProjectFolder", () => {
      const { doc, window, posted } = bootRail();
      railApi(window).onMessage({
        type: "repos",
        entries: repos,
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
        canAddProject: true,
      });
      const btn = doc.querySelector(".rail-add-project") as HTMLButtonElement;
      expect(btn).toBeTruthy();
      // On the Projects head, not Recent or Archive.
      expect((btn.closest(".rail-head")!.textContent || "")).toContain("Projects");

      posted.length = 0;
      btn.click();
      expect(posted).toEqual([{ type: "addProjectFolder" }]);
    });

    it("does not fold the group it sits on", () => {
      // The head's fold button fills the head, so the action overlays it. A
      // click that both adds a project and collapses the list is a bug.
      const { doc, window } = bootRail();
      railApi(window).onMessage({
        type: "repos",
        entries: repos,
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
        canAddProject: true,
      });
      expect(doc.querySelectorAll(".rail-repo").length).toBeGreaterThan(0);
      (doc.querySelector(".rail-add-project") as HTMLButtonElement).click();
      expect(doc.querySelectorAll(".rail-repo").length).toBeGreaterThan(0);
    });

    it("the wide Add project button opens a menu that stays on screen", () => {
      // The header + stops the opening click from bubbling; the wide button
      // did not, so the document listener closed the menu on the same click
      // and the button looked dead. Helpers must be loaded so there is a
      // menu to open rather than a one-item fallthrough to the picker.
      const helpers = read("../media/webview-helpers.js");
      const { doc, window, posted } = bootRail();
      window.eval(helpers);
      railApi(window).onMessage({
        type: "repos",
        entries: repos,
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
        canAddProject: true,
        canCreateProject: true,
        canCloneProject: true,
      });
      posted.length = 0;
      const wide = doc.querySelector(".rail-add-project-wide") as HTMLButtonElement;
      expect(wide).toBeTruthy();
      wide.click();
      const menu = doc.querySelector(".rail-menu") as HTMLElement;
      expect(menu).toBeTruthy();
      expect(menu.textContent).toMatch(/Clone from GitHub/);
      expect(posted.some((m) => m.type === "addProjectFolder")).toBe(false);
    });

    it("offers a way out of an empty rail, where no head is rendered", () => {
      const { doc, window, posted } = bootRail();
      railApi(window).onMessage({
        type: "repos",
        entries: [],
        selectedCwd: "",
        activeCwd: "",
        canAddProject: true,
      });
      const link = doc.querySelector(".rail-add-project-wide") as HTMLButtonElement;
      expect(link).toBeTruthy();
      // One control for both places it appears — under the project list and
      // here. A link and a button offering the same action in one rail is a
      // second mechanism, not a second affordance.
      expect(link.textContent).toContain("Add project");
      posted.length = 0;
      link.click();
      expect(posted).toEqual([{ type: "addProjectFolder" }]);
    });

    it("keeps the empty-state action out of a no-matches search result", () => {
      // "No matches." is a filter outcome, not an empty rail; the projects are
      // there and adding one would not answer what the user asked.
      const { doc, window } = bootRail();
      railApi(window).onMessage({
        type: "repos",
        entries: repos,
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
        canAddProject: true,
      });
      const search = doc.getElementById("rail-search") as HTMLInputElement;
      search.value = "zzzznomatch";
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      expect((doc.querySelector(".rail-note")!.textContent || "")).toContain("No matches.");
      expect(doc.querySelector(".rail-empty-action")).toBeNull();
    });
  });
  describe("working in another project", () => {
    it("offers New session on every available project, naming its cwd", () => {
      // `+` used to appear on the current project only, because local
      // newSession always started in the workspace root. It carries a cwd now,
      // so the host starts where the row says and moves the selection with it —
      // one message, no reliance on a selectRepo landing first.
      const { doc, window, posted } = bootRail();
      loadCatalog(railApi(window));
      const plus = [...doc.querySelectorAll(".rail-repo")].map((r) =>
        r.querySelector('.rail-action-btn[title="New session"]'),
      );
      expect(plus.every(Boolean)).toBe(true);

      posted.length = 0;
      (plus[1] as HTMLButtonElement).click();
      expect(posted).toEqual([{ type: "newSession", cwd: "/work/beta" }]);
    });

    it("still folds on a head click rather than switching, same as desktop", () => {
      // One gesture meaning "fold" here and "switch" there is two gestures
      // wearing one coat.
      const { doc, window, posted } = bootRail();
      loadCatalog(railApi(window), "/work/alpha");
      const beta = [...doc.querySelectorAll(".rail-repo")][1];
      posted.length = 0;
      (beta.querySelector(".rail-repo-head") as HTMLElement).click();
      expect(posted.filter((p) => p.type === "selectRepo")).toEqual([]);
      expect(
        [...doc.querySelectorAll(".rail-repo")][1].classList.contains("collapsed"),
      ).toBe(true);
    });
  });
  describe("switching projects", () => {
    it("does not file the old project's conversations under the new one", () => {
      // The `sessions` frame carries no cwd, so between the catalog arriving and
      // the list arriving there is nothing to tell A's rows apart from B's. They
      // used to simply stay put under whatever heading was now current — and
      // stick there if the list refresh never came.
      const { doc, window } = bootRail();
      const api = railApi(window);
      loadCatalog(api, "/work/alpha");
      loadSessions(api, [row("a1", "/work/alpha", "ALPHA CONVERSATION")]);
      expect(doc.body.textContent).toContain("ALPHA CONVERSATION");

      loadCatalog(api, "/work/beta"); // catalog only — no sessions frame yet
      const beta = [...doc.querySelectorAll(".rail-repo")].find(
        (r) => (r.querySelector(".rail-repo-label")?.textContent || "") === "beta",
      )!;
      expect(beta.textContent).not.toContain("ALPHA CONVERSATION");
    });

    it("hands the rows back to the project they belong to", () => {
      // Not thrown away — parked as that project's own preview, which is where
      // they were always going to be shown.
      const { doc, window } = bootRail();
      const api = railApi(window);
      loadCatalog(api, "/work/alpha");
      loadSessions(api, [row("a1", "/work/alpha", "ALPHA CONVERSATION")]);
      loadCatalog(api, "/work/beta");

      const alpha = [...doc.querySelectorAll(".rail-repo")].find(
        (r) => (r.querySelector(".rail-repo-label")?.textContent || "") === "alpha",
      )!;
      expect(alpha.textContent).toContain("ALPHA CONVERSATION");
    });
  });
  describe("removing a hand-added project", () => {
    const withAdded = (api: ReturnType<typeof railApi>) =>
      api.onMessage({
        type: "repos",
        entries: [
          { cwd: "/work/alpha", label: "alpha", available: true, updatedAt: 30 },
          { cwd: "/work/added", label: "added", available: true, updatedAt: 0, added: true },
        ],
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });

    const menuLabels = (doc: Document) =>
      [...doc.querySelectorAll(".rail-menu-item")].map((i) => i.textContent);

    it("offers Hide project only on the row that came from Add project", () => {
      // A hand-added folder is the one catalog row with no expiry: every other
      // one is listed because Grok ran there and stops being listed when that
      // stops being true. It is remotely browsable like any project, so it has
      // to be revocable.
      const { doc, window } = bootRail();
      withAdded(railApi(window));
      const rows = [...doc.querySelectorAll(".rail-repo")];
      const menuOf = (el: Element) =>
        el.querySelector('.rail-action-btn[title="Project actions"]') as HTMLButtonElement;

      menuOf(rows[0]).click(); // alpha — discovered, not added
      expect(menuLabels(doc)).not.toContain("Hide project");
      doc.body.click();

      menuOf(rows[1]).click(); // the added one
      expect(menuLabels(doc)).toContain("Hide project");
    });

    it("asks first, then posts removeProjectFolder for that cwd", async () => {
      // The question is an IN-PAGE dialog: `window.confirm` does nothing at all
      // in a VS Code webview, which is why every menu item wired to it silently
      // failed. Clicking Hide must raise the dialog, not act.
      const { doc, window, posted } = bootRail();
      withAdded(railApi(window));
      const added = [...doc.querySelectorAll(".rail-repo")][1];
      (added.querySelector('.rail-action-btn[title="Project actions"]') as HTMLButtonElement).click();
      const remove = [...doc.querySelectorAll(".rail-menu-item")].find(
        (i) => i.textContent === "Hide project",
      ) as HTMLButtonElement;

      posted.length = 0;
      remove.click();
      expect(posted, "asking is not doing").toEqual([]);
      const dialog = doc.querySelector(".rail-dialog");
      expect(dialog, "Hide must raise a dialog").toBeTruthy();

      (dialog!.querySelector(".rail-dialog-primary") as HTMLButtonElement).click();
      await Promise.resolve();
      expect(posted).toEqual([{ type: "removeProjectFolder", cwd: "/work/added" }]);
    });
  });

  describe("case-sensitive project paths", () => {
    it("keeps two POSIX projects that differ only in case apart", () => {
      // Lowercasing every path merged them: one could vanish as a duplicate of
      // Current, and when both rendered their preview caches collided so one
      // project's conversations landed under the other. A refresh does not cure
      // it. media/chat.js has always had the right rule; this file did not.
      const { doc, window } = bootRail();
      const api = railApi(window);
      api.onMessage({
        type: "repos",
        entries: [
          { cwd: "/work/App", label: "App", available: true, updatedAt: 2 },
          { cwd: "/work/app", label: "app", available: true, updatedAt: 1 },
        ],
        selectedCwd: "/work/App",
        activeCwd: "/work/App",
      });
      expect(repoLabels(doc).sort()).toEqual(["App", "app"]);
      // …and exactly one of them is Current.
      expect(doc.querySelectorAll(".rail-current-tag").length).toBe(1);
    });

    it("still folds Windows drive-letter and separator differences together", () => {
      const { window } = bootRail();
      const api = railApi(window);
      api.onMessage({
        type: "repos",
        entries: [{ cwd: "C:\\Work\\App", label: "App", available: true, updatedAt: 1 }],
        selectedCwd: "c:/work/app",
        activeCwd: "c:/work/app",
      });
      expect(api.state.currentCwd).toBe("c:/work/app");
      // Matched despite the case and separators, so it is the current project.
      expect((window as any).document.querySelectorAll(".rail-current-tag").length).toBe(1);
    });
  });
});
