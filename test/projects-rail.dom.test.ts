import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bootWebview, click, dispatch } from "./webview-harness";

// The rail is the relay page's surface: `#projects-rail` lives in web/chat.html,
// never in the extension's getHtml(). So the harness has to add the mount the way
// the browser client does — and the absence of that element is exactly what keeps
// VS Code free of it.
const withRail = (window: any) => {
  const el = window.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  window.document.body.appendChild(el);
  // The relay page's search box lives in the same shell, and the rail's filter
  // reads it directly — so the mount is only faithful with it.
  const search = window.document.createElement("input");
  search.id = "rail-search";
  window.document.body.appendChild(search);
};

// Two available repos besides the selected one, so a fan-out is actually
// observable — with a single eligible repo the probe and the fan-out look alike.
const repos = [
  { cwd: "/work/alpha", label: "alpha", available: true, pinned: false, updatedAt: 30 },
  { cwd: "/work/beta", label: "beta", available: true, pinned: true, pinnedAt: 5, updatedAt: 10 },
  { cwd: "/work/gamma", label: "gamma", available: true, pinned: false, updatedAt: 20 },
  { cwd: "/mnt/offline", label: "offline", available: false, pinned: false, updatedAt: 0 },
];

const sessionsFrame = (entries: unknown[], total = entries.length) => ({
  type: "sessions",
  entries,
  activeId: null,
  dots: {},
  offset: 0,
  total,
  hasMore: false,
  nextOffset: entries.length,
  query: "",
});

const row = (id: string, cwd: string, name: string, updatedAt = 1) =>
  ({ id, cwd, displayName: name, rawSummary: "", updatedAt, createdAt: 1, numMessages: 2 });

function boot(selectedCwd = "/work/alpha") {
  const h = bootWebview({ remote: true, beforeScripts: withRail });
  dispatch(h.window, { type: "repos", entries: repos, selectedCwd, activeCwd: selectedCwd });
  return h;
}

const rail = (doc: Document) => doc.getElementById("projects-rail") as HTMLElement;
const repoNames = (doc: Document) =>
  [...doc.querySelectorAll(".rail-repo-label")].map((e) => e.textContent);
const sessionNames = (doc: Document, repoIndex: number) =>
  [...doc.querySelectorAll(".rail-repo")[repoIndex].querySelectorAll(".rail-session-name")]
    .map((e) => e.textContent);

// Row actions live behind a ⋯ menu now, parented to <body> (the rail scrolls, so
// a menu inside it would be clipped) — hence the document-level lookup.
const openMenu = (window: any, host: Element) => {
  if (window.document.querySelector(".rail-menu")) {
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  click(window, host.querySelector(".rail-menu-btn") as HTMLElement);
  return window.document.querySelector(".rail-menu") as HTMLElement;
};
const menuItem = (menu: Element, label: string) =>
  [...menu.querySelectorAll(".rail-menu-item")]
    .find((b) => (b.textContent || "").includes(label)) as HTMLElement | undefined;
/** Present in the menu but not clickable — the "still opening" state. */
const disabledItem = (menu: Element, label: string) =>
  !!(menuItem(menu, label) as HTMLButtonElement | undefined)?.disabled;
/** Present AND clickable. False covers both "absent" and "greyed out". */
const usableItem = (menu: Element, label: string) => {
  const el = menuItem(menu, label) as HTMLButtonElement | undefined;
  return !!el && !el.disabled;
};

describe("projects rail", () => {
  it("removes a known session from history, selected rows, previews and pins without requesting a list", () => {
    const { doc, window, posted } = boot();
    const empty = { ...row("empty", "/work/alpha", "Abandoned empty"), numMessages: 0, pinned: true };
    const kept = row("kept", "/work/alpha", "Keep this conversation");
    dispatch(window, { ...sessionsFrame([empty, kept]), activeId: "kept" });
    dispatch(window, { type: "sessionName", sessionId: "kept", name: kept.displayName, cwd: kept.cwd });
    dispatch(window, { type: "repoSessions", cwd: empty.cwd, entries: [empty, kept], dots: {}, total: 2 });
    dispatch(window, { type: "pinnedSessions", entries: [empty], dots: { empty: "idle" } });
    click(window, doc.getElementById("history-btn")!);
    dispatch(window, { ...sessionsFrame([empty, kept]), activeId: "kept", hasMore: true, total: 100, nextOffset: 50 });
    // Clearing the request's loading state could trigger automatic pagination;
    // the removal itself must not issue any new catalog request.
    posted.length = 0;
    dispatch(window, { type: "sessionRemoved", id: "empty", cwd: empty.cwd });
    dispatch(window, { type: "sessionRemoved", id: "empty", cwd: empty.cwd });
    expect(doc.querySelectorAll('[data-session-id="empty"]')).toHaveLength(0);
    expect(doc.querySelector('#history-popover [data-session-id="kept"]')).not.toBeNull();
    expect(doc.querySelector('.rail-session.active')?.getAttribute("data-session-id")).toBe("kept");
    expect(posted).toEqual([]);
    // Switching projects hands selected rows back to previews. The removed row
    // must not reappear from either the old preview or the selected snapshot.
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/alpha" });
    expect(doc.querySelectorAll('[data-session-id="empty"]')).toHaveLength(0);
    expect(doc.getElementById("session-head-title")?.textContent).toBe(kept.displayName);
  });

  it("keeps the pending rail target while the empty session being left is removed", () => {
    const { doc, window } = boot();
    dispatch(window, { ...sessionsFrame([
      row("empty", "/work/alpha", "Empty"), row("target", "/work/alpha", "Target"),
    ]), activeId: "empty" });
    click(window, doc.querySelector('#projects-rail [data-session-id="target"]')!);
    dispatch(window, { type: "sessionRemoved", id: "empty", cwd: "/work/alpha" });
    expect(doc.querySelector('.rail-session.active')?.getAttribute("data-session-id")).toBe("target");
    dispatch(window, { type: "sessionName", sessionId: "target", name: "Target", cwd: "/work/alpha" });
    expect(doc.querySelector('.rail-session.active')?.getAttribute("data-session-id")).toBe("target");
    expect(doc.querySelectorAll('[data-session-id="empty"]')).toHaveLength(0);
  });

  it("does not mount without a #projects-rail element, even when repos arrives", () => {
    // Regression guard for VS Code: getHtml never includes the mount, so a
    // `repos` frame (sent for clear-all naming) must not light a rail column.
    const { doc, window, posted } = bootWebview({});
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(doc.body.classList.contains("has-rail")).toBe(false);
    expect(doc.querySelectorAll(".rail-repo")).toHaveLength(0);
    expect(posted.filter((p) => p.type === "listRepoSessions")).toEqual([]);
  });

  it("mounts for a non-remote host when the rail element exists and repos arrives", () => {
    // A rail mount without body.desk still waits for `repos`. Desktop first-frame
    // chrome is the body.desk test below.
    const { doc, window } = bootWebview({ beforeScripts: withRail });
    expect(rail(doc).hidden).toBe(true);
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(rail(doc).hidden).toBe(false);
    expect(doc.body.classList.contains("has-rail")).toBe(true);
    expect(repoNames(doc)).toContain("alpha");
  });

  it("stays hidden until the host proves it speaks `repos`", () => {
    const { doc, posted } = bootWebview({ remote: true, beforeScripts: withRail });
    expect(rail(doc).hidden).toBe(true);
    // No catalog means no probe: an older host must not be sent a dead frame
    // before it has even shown that it knows about repos.
    expect(posted.filter((p) => p.type === "listRepoSessions")).toEqual([]);
  });

  it("paints desktop rail chrome from the first frame, before repos arrive", () => {
    const { doc, window } = bootWebview({
      beforeScripts: (w) => {
        w.document.body.classList.add("desk");
        withRail(w);
      },
    });
    expect(doc.body.classList.contains("has-rail")).toBe(true);
    expect(rail(doc).hidden).toBe(false);
    expect(rail(doc).textContent).toContain("Loading…");

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(repoNames(doc)).toContain("alpha");
    expect(rail(doc).hidden).toBe(false);
  });

  it("empty first repos frame is No projects yet, not a stuck Loading…", () => {
    // Desktop paints "Loading…" until the first `repos` frame. An empty
    // catalog after that frame is a real empty state, not an unfinished boot.
    const { doc, window, posted } = bootWebview({
      beforeScripts: (w) => {
        w.document.body.classList.add("desk");
        withRail(w);
      },
    });
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: false, steerByDefault: false,
      soundNotifications: false, processingSound: false, readRepliesAloud: false,
      capabilities: { addProjectFolder: true },
    });
    expect(rail(doc).textContent).toContain("Loading…");
    dispatch(window, { type: "repos", entries: [], selectedCwd: "", activeCwd: "" });
    expect(rail(doc).textContent).toContain("No projects yet");
    expect(rail(doc).textContent).not.toContain("Loading…");
    // The wide button is also present under a NON-empty list, which is the case
    // the owner raised: with one project the rail is mostly empty space and a
    // 28px "+" in the group header is easy to miss and hard to hit on a phone.
    dispatch(window, {
      type: "repos",
      entries: [{ cwd: "/w/one", name: "one", sessions: [] }],
      selectedCwd: "/w/one",
      activeCwd: "/w/one",
    } as never);
    const wide = doc.querySelector(".rail-add-project-wide") as HTMLButtonElement;
    expect(wide).toBeTruthy();
    expect(wide.textContent).toContain("Add project");
    // And it is the same control, not a second mechanism: the old text link is gone.
    expect(doc.querySelector(".rail-empty-action")).toBeNull();
    dispatch(window, { type: "repos", entries: [], selectedCwd: "", activeCwd: "" });
    const add = doc.querySelector(".rail-add-project-wide") as HTMLButtonElement;
    expect(add).toBeTruthy();
    // One control for both places it appears — under the project list and
      // here. A link and a button offering the same action in one rail is a
      // second mechanism, not a second affordance.
      expect(add.textContent).toContain("Add project");
    posted.length = 0;
    add.click();
    expect(posted).toEqual([{ type: "addProjectFolder" }]);
  });

  // By name, and nothing else. Recency was the first answer and the wrong one:
  // the rail is navigated by memory, so a list that reorders itself as you work
  // moves the row you were reaching for. `beta` carries pinned:true in the
  // fixture on purpose — the rail ignores repo pins too (the VS Code picker
  // still offers them); a second ordering rule only costs the eye.
  it("lists projects by name, ignoring activity and repo pins", () => {
    const { doc } = boot();
    expect(rail(doc).hidden).toBe(false);
    expect(repoNames(doc)).toEqual(["alpha", "beta", "gamma", "offline"]);
  });

  // Ordering is now a property of the NAME, so nothing a project's history does
  // can move it — which is the whole point. This used to be a specific bug
  // (clearing a project's history touched its session directory and shot it to
  // the top); it is now structurally impossible, and this asserts the general
  // rule rather than that one instance: the row order before and after every
  // frame that once reordered the rail is identical.
  it("never reorders projects, whatever happens to their history", () => {
    const catalog = [
      // gamma's directory was touched by the clear itself, so its catalog stamp
      // is the freshest number in the rail.
      { cwd: "/work/gamma", label: "gamma", available: true, pinned: false, updatedAt: 900 },
      { cwd: "/work/alpha", label: "alpha", available: true, pinned: false, updatedAt: 100 },
      { cwd: "/work/beta", label: "beta", available: true, pinned: false, updatedAt: 90 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    const before = repoNames(h.doc);
    expect(before).toEqual(["alpha", "beta", "gamma"]);

    dispatch(h.window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 500)]));
    dispatch(h.window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 400)], dots: {}, total: 1,
    });
    // The host's answer for the emptied project: no rows.
    dispatch(h.window, { type: "repoSessions", cwd: "/work/gamma", entries: [], dots: {}, total: 0 });

    expect(repoNames(h.doc)).toEqual(before);
  });

  // The project you are working in must not sink while its list is in flight:
  // an empty holder is the state before the first `sessions` frame, not proof of
  // an empty project.
  it("keeps the selected project in place until its own list arrives", () => {
    const { doc } = boot("/work/alpha");
    expect(repoNames(doc)[0]).toBe("alpha");
  });

  // Cold start used to leave the selected project on "No sessions yet" while
  // sibling `repoSessions` previews filled in — because `railSelectedRows`
  // starts empty and was treated as a known-empty list. Empty + unknown must
  // read as loading; empty only after an unfiltered `sessions` frame is real.
  it("shows Loading for the selected project until sessions arrives, not No sessions yet", () => {
    const { doc, window } = boot("/work/alpha");
    const notes = () => {
      const alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      return [...alpha.querySelectorAll(".rail-note")].map((e) => e.textContent);
    };
    expect(notes()).toContain("Loading…");
    expect(notes()).not.toContain("No sessions yet");

    dispatch(window, sessionsFrame([]));
    expect(notes()).toContain("No sessions yet");

    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "real history", 9)]));
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["real history"]);
  });

  it("adds monochrome provider glyphs to session rows only when two agents are connected", () => {
    const h = boot("/work/alpha");
    dispatch(h.window, { ...sessionsFrame([
      { ...row("g1", "/work/alpha", "Grok session", 9), provider: "grok" },
      { ...row("c1", "/work/alpha", "Codex session", 8), provider: "codex" },
    ]), dots: { g1: "working", c1: "needs-you" } });
    expect(h.doc.querySelectorAll(".rail-session .provider-glyph")).toHaveLength(0);
    expect(h.doc.querySelectorAll(".rail-session > .history-row-dot")).toHaveLength(2);
    expect(h.doc.querySelectorAll(".rail-session .provider-status-badge")).toHaveLength(0);

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true },
      ],
    });
    const glyphs = [...h.doc.querySelectorAll(".rail-session .provider-glyph")];
    expect(glyphs).toHaveLength(2); // One rendered row per globally unique session id.
    expect(glyphs.every((el) => !!el.querySelector("svg.provider-logo path"))).toBe(true);
    expect(h.doc.querySelectorAll(".rail-session > .history-row-dot")).toHaveLength(0);
    expect([...h.doc.querySelectorAll(".rail-session .provider-status-badge")].map((el) => (el as HTMLElement).dataset.dot))
      .toEqual(["working", "needs-you"]);

    dispatch(h.window, { type: "sessionDot", id: "g1", dot: "error" });
    expect((h.doc.querySelector('[data-session-dot="g1"]') as HTMLElement).dataset.dot).toBe("error");

    dispatch(h.window, { type: "sessionDot", id: "g1", dot: "none" });
    dispatch(h.window, { type: "sessionDot", id: "c1", dot: "none" });
    expect([...h.doc.querySelectorAll(".rail-session .provider-status-badge")].map((el) => el.className))
      .toEqual(["provider-status-badge dot-none", "provider-status-badge dot-none"]);
  });

  it("renders duplicate ids once and selects equal GPT names by id", () => {
    const { doc, window, posted } = boot();
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "GPT", 9),
        row("a1", "/work/ALPHA", "GPT", 8),
        row("a2", "/work/alpha", "GPT", 7),
      ]),
      activeId: "a1",
    });

    expect(doc.querySelectorAll('[data-session-id="a1"]')).toHaveLength(1);
    expect(doc.querySelectorAll('[data-session-id="a2"]')).toHaveLength(1);
    expect([...doc.querySelectorAll(".rail-session-name")].map((el) => el.textContent))
      .toEqual(["GPT", "GPT"]);
    expect(doc.querySelectorAll(".rail-session.active")).toHaveLength(1);
    expect((doc.querySelector(".rail-session.active") as HTMLElement).dataset.sessionId).toBe("a1");

    click(window, doc.getElementById("history-btn") as HTMLElement);
    expect(doc.querySelectorAll('#history-popover [data-session-id="a1"]')).toHaveLength(1);
    expect(doc.querySelectorAll('#history-popover [data-session-id="a2"]')).toHaveLength(1);
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    click(window, doc.querySelector('#projects-rail [data-session-id="a2"]') as HTMLElement);
    expect(posted.filter((message) => message.type === "resumeSession").at(-1)).toMatchObject({ id: "a2" });
    expect(doc.querySelectorAll(".rail-session.active")).toHaveLength(1);
    expect((doc.querySelector(".rail-session.active") as HTMLElement).dataset.sessionId).toBe("a2");
  });

  // Two empty projects tie on activity, and the tie used to break on the
  // catalog's own stamp — the session directory's mtime, which CLEARING a
  // project touches. So the just-emptied one still climbed above its equally
  // empty neighbours: the same bug, one rank smaller.
  it("does not let the cleared project win the tie between empty ones", () => {
    const catalog = [
      { cwd: "/work/zed", label: "zed", available: true, pinned: false, updatedAt: 10 },
      // Freshly cleared: nothing in it, and the newest directory stamp in the rail.
      { cwd: "/work/acme", label: "acme", available: true, pinned: false, updatedAt: 999 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/zed", activeCwd: "/work/zed" });
    dispatch(h.window, sessionsFrame([]));
    dispatch(h.window, { type: "repoSessions", cwd: "/work/acme", entries: [], dots: {}, total: 0 });

    expect(repoNames(h.doc)).toEqual(["acme", "zed"]); // by name, not by mtime
  });

  // A project we have looked at and found empty has nothing to clear, so the
  // menu says so on its face rather than taking the click and answering with a
  // notice in whatever conversation happens to be open elsewhere.
  it("disables Clear all history for a project known to be empty", () => {
    const { doc, window, posted } = boot();
    dispatch(window, { type: "repoSessions", cwd: "/work/beta", entries: [], dots: {}, total: 0 });

    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    const clear = menuItem(openMenu(window, beta), "Clear all history");
    expect((clear as HTMLButtonElement).disabled).toBe(true);
    click(window, clear as HTMLElement);
    expect(posted.filter((p) => p.type === "clearAllSessions")).toEqual([]);

    // …and stays available where rows are merely unknown: "not loaded" is not
    // "empty", and disabling there would strand a project behind a dead control.
    const gamma = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("gamma")];
    const gammaClear = menuItem(openMenu(window, gamma), "Clear all history");
    expect((gammaClear as HTMLButtonElement).disabled).toBe(false);
  });

  // Clearing a project the host has not SELECTED is a repo-addressed act, and an
  // extension that predates that drops the message without a word — no error, no
  // deletion. The rail appears against those hosts (they send `repos`), so the
  // control has to wait for proof that the cwd on these messages is read at all.
  // Where you already are is never gated: that always worked.
  it("withholds cross-project Clear all until the host proves it reads the cwd", () => {
    const { doc, window, posted } = boot();

    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    const dead = menuItem(openMenu(window, beta), "Clear all history") as HTMLButtonElement;
    expect(dead.disabled).toBe(true);
    // Host-neutral: this page drives the VS Code extension OR the desktop app,
    // and cannot tell which, so it must not name one of them.
    expect(dead.title).toContain("Update Grok Build");
    expect(dead.title).not.toContain("the Grok extension");
    click(window, dead);
    expect(posted.filter((p) => p.type === "clearAllSessions")).toEqual([]);

    // The project you are in is offered regardless — no probe is even sent for
    // it, so gating it on one would disable it forever on a single-project box.
    // It is also offered before its own list has arrived: an empty row-holder is
    // the state before the first frame, not proof of an empty project.
    const alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    expect((menuItem(openMenu(window, alpha), "Clear all history") as HTMLButtonElement).disabled)
      .toBe(false);

    // One answered probe is the proof.
    dispatch(window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 4)], dots: {}, total: 1,
    });
    const live = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect((menuItem(openMenu(window, live), "Clear all history") as HTMLButtonElement).disabled)
      .toBe(false);
  });

  // The degrade path — the whole reason the rail reads the selected repo from
  // `sessions` instead of demanding its own frame. A host that never answers
  // `listRepoSessions` must still produce a usable rail.
  it("works against a host that never answers listRepoSessions", () => {
    const { doc, window, posted } = boot();
    dispatch(window, sessionsFrame([
      row("a1", "/work/alpha", "alpha newest", 9),
      row("a2", "/work/alpha", "alpha older", 8),
    ]));

    // The selected repo has rows without any preview frame ever arriving.
    const alphaIndex = repoNames(doc).indexOf("alpha");
    expect(sessionNames(doc, alphaIndex)).toEqual(["alpha newest", "alpha older"]);

    // And the client probed ONCE, not once per repo — an unanswered probe is one
    // dead frame, not a fan-out repeated on every catalog push.
    expect(posted.filter((p) => p.type === "listRepoSessions")).toHaveLength(1);

    // A second catalog must not re-probe repos already asked about.
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(posted.filter((p) => p.type === "listRepoSessions")).toHaveLength(1);
    expect(rail(doc).hidden).toBe(false);
  });

  it("reports the timed-out project truthfully and offers a retry", async () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (w: any) => { withRail(w); w.__grokRailProbeTimeoutMs = 5; },
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    dispatch(h.window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));

    await new Promise((r) => setTimeout(r, 40));

    const notes = [...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent);
    expect(notes.filter((t) => t === "Couldn't load these conversations. Retry")).toHaveLength(1);
    expect(notes).not.toContain("Sessions need a newer Grok Build");
    // The repo we ARE in still shows its sessions: that list needs no new frame.
    expect(sessionNames(h.doc, repoNames(h.doc).indexOf("alpha"))).toEqual(["alpha one"]);
  });

  it("paints the rail before any catalog on a cloud machine, and not on a laptop", () => {
    // The rail waits for `repos` because an extension older than v2.0.5 never
    // sends one. A cloud machine cannot be that: the relay provisions it and
    // installs the host. Without this the old single-column layout — the one
    // this product had before it had a rail — was the whole screen for as long
    // as a sleeping machine took to wake (owner, 2026-08-31; measured at 4.2s
    // against a host that answered in four seconds).
    const cloud = bootWebview({
      remote: true,
      beforeScripts: (w: any) => { withRail(w); w.grokCloudHost = true; },
    });
    expect(cloud.doc.body.classList.contains("has-rail")).toBe(true);
    expect((cloud.doc.getElementById("projects-rail") as HTMLElement).hidden).toBe(false);

    // A linked laptop still waits: its host may predate the frame.
    const laptop = bootWebview({ remote: true, beforeScripts: (w: any) => withRail(w) });
    expect(laptop.doc.body.classList.contains("has-rail")).toBe(false);
    expect((laptop.doc.getElementById("projects-rail") as HTMLElement).hidden).toBe(true);
  });

  it("fills the cloud rail from the catalog when it finally arrives", () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (w: any) => { withRail(w); w.grokCloudHost = true; },
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    dispatch(h.window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
    expect(repoNames(h.doc)).toContain("alpha");
    expect(sessionNames(h.doc, repoNames(h.doc).indexOf("alpha"))).toEqual(["alpha one"]);
  });

  it("re-probes after a reconnect and clears the old request state", async () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (w: any) => { withRail(w); w.__grokRailProbeTimeoutMs = 5; },
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    dispatch(h.window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
    await new Promise((r) => setTimeout(r, 40));
    expect([...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent))
      .toContain("Couldn't load these conversations. Retry");

    // A reconnect: every remote snapshot opens with initialState.
    h.posted.length = 0;
    dispatch(h.window, {
      type: "initialState", effort: "", cwd: "/work/alpha", useCtrlEnter: false, extVersion: "3.19.9",
      showThinking: false, expandCommandOutputs: false, steerByDefault: false, soundNotifications: false,
      processingSound: false, readRepliesAloud: false, appPurpose: "coding", capabilities: {},
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });

    // It asks again rather than repeating a verdict about a host that is gone.
    expect(h.posted.some((m: any) => m.type === "listRepoSessions")).toBe(true);
    expect([...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent))
      .not.toContain("Couldn't load these conversations. Retry");
  });

  it("never shows that hint to a host that does answer", async () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (w: any) => { withRail(w); w.__grokRailProbeTimeoutMs = 5; },
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    dispatch(h.window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 4)], dots: {}, total: 1,
    });
    dispatch(h.window, { type: "repoSessions", cwd: "/work/gamma", entries: [], dots: {}, total: 0 });

    await new Promise((r) => setTimeout(r, 40));

    const notes = [...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent);
    expect(notes).not.toContain("Couldn't load these conversations. Retry");
  });

  it("does not mark a transport-refused preview in flight and retries only on request", () => {
    let accept = false;
    const h = bootWebview({
      remote: true,
      beforeScripts: withRail,
      postMessage: (message) => message.type === "listRepoSessions" ? accept : undefined,
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });

    expect(h.posted.filter((m) => m.type === "listRepoSessions")).toHaveLength(1);
    expect([...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent))
      .toContain("Couldn't load these conversations. Retry");

    // A catalog repaint is not a background retry.
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(h.posted.filter((m) => m.type === "listRepoSessions")).toHaveLength(1);

    accept = true;
    click(h.window, h.doc.querySelector(".rail-note-retry") as HTMLElement);
    expect(h.posted.filter((m) => m.type === "listRepoSessions")).toHaveLength(2);
    expect([...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent))
      .not.toContain("Couldn't load these conversations. Retry");
  });

  it("fans out to the remaining repos only once a preview comes back", () => {
    const { doc, window, posted } = boot();
    const probes = () => posted.filter((p) => p.type === "listRepoSessions").map((p) => p.cwd);
    expect(probes()).toHaveLength(1);

    // Whichever repo the probe picked — asserting on the probe rather than on a
    // hardcoded name keeps this independent of the rail's ordering rule.
    const probed = probes()[0];
    dispatch(window, {
      type: "repoSessions",
      cwd: probed,
      entries: [row("p1", probed, "first preview", 4)],
      dots: {},
      total: 1,
    });

    // The answer proves the capability; the rest of the catalog is now worth asking.
    expect(probes().length).toBeGreaterThan(1);
    const probedLabel = repos.find((r) => r.cwd === probed)!.label;
    expect(sessionNames(doc, repoNames(doc).indexOf(probedLabel))).toEqual(["first preview"]);
  });

  it("previews three sessions per repo and expands in place", () => {
    const { doc, window } = boot();
    dispatch(window, sessionsFrame([
      row("a1", "/work/alpha", "one", 9),
      row("a2", "/work/alpha", "two", 8),
      row("a3", "/work/alpha", "three", 7),
      row("a4", "/work/alpha", "four", 6),
    ]));
    const alphaIndex = repoNames(doc).indexOf("alpha");
    expect(sessionNames(doc, alphaIndex)).toEqual(["one", "two", "three"]);

    const more = doc.querySelectorAll(".rail-repo")[alphaIndex].querySelector(".rail-more") as HTMLElement;
    // One step, no counters — never "Show N more" (three disagreeing totals).
    expect(more.textContent).toBe("Show more");
    expect(more.textContent).not.toMatch(/\d/);
    click(window, more);
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["one", "two", "three", "four"]);
    const less = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
      .querySelector(".rail-more") as HTMLElement;
    expect(less.textContent).toBe("Show less");
    expect(less.textContent).not.toMatch(/\d/);
  });

  it("reopens a session in its own repo, carrying that session's cwd", () => {
    const { doc, window, posted } = boot();
    dispatch(window, {
      type: "repoSessions",
      cwd: "/work/beta",
      entries: [row("b1", "/work/beta/sub", "beta one", 4)],
      dots: {},
      total: 1,
    });
    const betaIndex = repoNames(doc).indexOf("beta");
    const session = doc.querySelectorAll(".rail-repo")[betaIndex].querySelector(".rail-session") as HTMLElement;
    click(window, session);
    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      // The session's OWN cwd, not the repo row's — a worktree session lives in a
      // deeper checkout and the host resolves sessions by cwd.
      { type: "resumeSession", id: "b1", cwd: "/work/beta/sub", claim: true },
    ]);
  });

  // The catalog naming the new repo arrives before that repo's session list, so
  // without a guard the rail paints the previous project's conversations under
  // the new project's name.
  it("never shows the previous repo's sessions under the repo just switched to", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha secret", 9)]));
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["alpha secret"]);

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });
    // Beta has no preview of its own here, so it shows nothing — and crucially
    // NOT alpha's conversation, which is the bleed this guards.
    expect(sessionNames(doc, repoNames(doc).indexOf("beta"))).toEqual([]);
    // Alpha keeps its own rows as a sibling rather than dropping to a spinner:
    // we already hold them, and walking away is not a reason to forget them.
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["alpha secret"]);

    // ...and the real list restores rows.
    dispatch(window, sessionsFrame([row("b1", "/work/beta", "beta one", 4)]));
    expect(sessionNames(doc, repoNames(doc).indexOf("beta"))).toEqual(["beta one"]);
  });

  // With the history popover searching, the host's unfiltered first page is
  // rejected by the popover (it wants its filtered view back). That page is the
  // only unfiltered one the rail will see, so dropping it wholesale left the rail
  // pinned on "Loading…" until the search was cleared or the page refreshed.
  it("still fills after a repo switch made with a history search open", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));

    // Open history and type a query.
    click(window, doc.getElementById("history-btn") as HTMLElement);
    const search = doc.querySelector(".history-search") as HTMLInputElement;
    search.value = "beta";
    search.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });
    // The host's unfiltered list for the new repo — what the popover rejects.
    dispatch(window, sessionsFrame([row("b1", "/work/beta", "beta one", 4)]));

    expect(sessionNames(doc, repoNames(doc).indexOf("beta"))).toEqual(["beta one"]);
  });

  // Switching INTO a repo we already previewed must show what we know at once —
  // the rows are in hand, so a spinner there would be theatre.
  it("keeps the repo you switch into showing the sessions already known", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
    dispatch(window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 4)], dots: {}, total: 1,
    });

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });
    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect([...beta.querySelectorAll(".rail-session-name")].map((e) => e.textContent)).toEqual(["beta one"]);
    // No spinner in the section we switched INTO. (Repos we have never previewed
    // still show one — they really have nothing yet.)
    expect(beta.querySelector(".rail-note")).toBe(null);
  });

  // Two caps deep: the host's `total` counts hidden subagent rows, and expansion
  // itself stops at RAIL_EXPANDED. The control never prints a count (scar: a
  // "Show 25 more" once revealed 17 and stranded 8).
  it("reveals up to the expand cap with an unnumbered Show more", () => {
    const { doc, window } = boot();
    dispatch(window, sessionsFrame(
      Array.from({ length: 28 }, (_, i) => row(`a${i}`, "/work/alpha", `s${i}`, 100 - i)),
    ));
    const more = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
      .querySelector(".rail-more") as HTMLElement;
    expect(more.textContent).toBe("Show more");
    expect(more.textContent).not.toMatch(/\d/);
    click(window, more);
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toHaveLength(20);
  });

  // `total` counts index slots including subagent sessions the host hides, so a
  // count-derived button can promise rows that do not exist.
  it("never offers a Show-more that reveals nothing", () => {
    const { doc, window } = boot();
    dispatch(window, {
      type: "repoSessions",
      cwd: "/work/beta",
      // The host counted 7 index slots but only 2 are user sessions — the rest
      // are hidden subagent rows. Expanding could never produce a third.
      entries: [row("b1", "/work/beta", "one", 4), row("b2", "/work/beta", "two", 3)],
      dots: {},
      total: 7,
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect([...section.querySelectorAll(".rail-session-name")].map((e) => e.textContent))
      .toEqual(["one", "two"]);
    expect(section.querySelector(".rail-more")).toBe(null);
  });

  // The host folds path case only on Windows, because only there is it
  // insignificant. A client that folded everywhere merged two real Linux
  // checkouts into one identity — so one project rendered the other's
  // conversations, and clicking a row acted on the wrong checkout.
  it("keeps POSIX repos that differ only by case apart", () => {
    const cased = [
      { cwd: "/work/Foo", label: "Foo", available: true, pinned: false, updatedAt: 30 },
      { cwd: "/work/foo", label: "foo", available: true, pinned: false, updatedAt: 20 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: cased, selectedCwd: "/work/Foo", activeCwd: "/work/Foo" });
    // Newer than the sibling's stamp: the rail orders projects by their newest
    // CONVERSATION, and a fixture whose session predates the sibling's catalog
    // entry would be asserting an order the sort no longer promises.
    dispatch(h.window, sessionsFrame([row("f1", "/work/Foo", "upper only", 30)]));

    expect(repoNames(h.doc)).toEqual(["Foo", "foo"]);
    expect(sessionNames(h.doc, 0)).toEqual(["upper only"]);
    // The lower-case sibling is a different repo and must not borrow those rows.
    expect(sessionNames(h.doc, 1)).toEqual([]);
  });

  // A backslash is an ordinary filename character on POSIX, so it must not be
  // read as Windows syntax and normalised away.
  it("keeps POSIX repos apart when their names contain a backslash", () => {
    const odd = [
      { cwd: "/srv/Foo\\bar", label: "Foo-bar", available: true, pinned: false, updatedAt: 30 },
      { cwd: "/srv/foo\\bar", label: "foo-bar", available: true, pinned: false, updatedAt: 20 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: odd, selectedCwd: "/srv/Foo\\bar", activeCwd: "/srv/Foo\\bar" });
    dispatch(h.window, sessionsFrame([row("o1", "/srv/Foo\\bar", "upper only", 30)]));

    expect(sessionNames(h.doc, 0)).toEqual(["upper only"]);
    expect(sessionNames(h.doc, 1)).toEqual([]);
  });

  it("still treats Windows repos spelled differently as one", () => {
    const cased = [
      { cwd: "C:\\Work\\Alpha\\", label: "Alpha", available: true, pinned: false, updatedAt: 30 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    // The host's own frames vary drive-letter case and slash direction freely.
    dispatch(h.window, { type: "repos", entries: cased, selectedCwd: "c:/work/alpha", activeCwd: "c:/work/alpha" });
    dispatch(h.window, sessionsFrame([row("w1", "C:\\Work\\Alpha", "windows row", 9)]));
    expect(sessionNames(h.doc, 0)).toEqual(["windows row"]);
  });

  // Projects are not pinnable here at all: no marker, no menu item. The menu
  // carries only the destructive act, which is the one thing worth hiding behind
  // an extra click.
  it("offers no way to pin a project, and no marker for one", () => {
    const { doc, window } = boot();
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect(section.querySelector(".rail-pin-mark")).toBe(null);
    const menu = openMenu(window, section.querySelector(".rail-repo-head") as HTMLElement);
    expect(menuItem(menu, "Pin project")).toBe(undefined);
    expect(menuItem(menu, "Clear all history")).not.toBe(undefined);
  });

  // Nothing marks the live or the selected project — the highlighted
  // conversation locates it, and the header names it.
  it("marks neither the live nor the selected project", () => {
    const { doc } = boot();
    expect(doc.querySelector(".rail-repo-live")).toBe(null);
    expect(doc.querySelector(".rail-repo.selected")).toBe(null);
  });

  describe("pinned conversations", () => {
    const pinnedFrame = (entries: unknown[]) => ({ type: "pinnedSessions", entries, dots: {} });
    const pinned = (id: string, cwd: string, name: string, at: number) =>
      ({ ...row(id, cwd, name), pinnedAt: at });

    it("shows no Pinned group until something is pinned", () => {
      const { doc } = boot();
      expect([...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent)).toEqual(["Projects"]);
    });

    it("lifts pinned conversations above Projects, newest pin first", () => {
      const { doc, window } = boot();
      dispatch(window, pinnedFrame([
        pinned("b1", "/work/beta", "beta thing", 20),
        pinned("a1", "/work/alpha", "alpha thing", 10),
      ]));
      const heads = [...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
      expect(heads[0]).toBe("Pinned");
      expect(heads).toContain("Projects");
      // Pinned rows ALSO count as recent — Recent duplicates them on purpose
      // (a shortcut, not a partition; dedupe is per group only).
      expect(heads).toContain("Recent");
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-name")].map((e) => e.textContent))
        .toEqual(["beta thing", "alpha thing"]);
    });

    // Out of its project, a row has to say where it came from — two "Untitled"
    // conversations are otherwise identical, and opening the wrong one moves the tab.
    it("names each pinned row's repo", () => {
      const { doc, window } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      expect(doc.querySelector(".rail-pinned .rail-session-repo")?.textContent).toBe("beta");
    });

    // Two checkouts can share a leaf name; the host already disambiguates them
    // in the catalog, so the pinned row must use that label rather than
    // recomputing a leaf and showing "project" twice.
    it("uses the catalog's disambiguated repo label", () => {
      const { doc, window } = boot();
      const dupes = [
        { cwd: "/work/client/proj", label: "client/proj", available: true, pinned: false, updatedAt: 30 },
        { cwd: "/work/archive/proj", label: "archive/proj", available: true, pinned: false, updatedAt: 20 },
      ];
      dispatch(window, { type: "repos", entries: dupes, selectedCwd: "/work/client/proj", activeCwd: "/work/client/proj" });
      dispatch(window, pinnedFrame([
        pinned("p1", "/work/client/proj", "one", 20),
        pinned("p2", "/work/archive/proj", "two", 10),
      ]));
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-repo")].map((e) => e.textContent))
        .toEqual(["client/proj", "archive/proj"]);
    });

    it("reopens a pinned conversation in its own repo", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta/sub", "beta thing", 20)]));
      click(window, doc.querySelector(".rail-pinned .rail-session") as HTMLElement);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
        { type: "resumeSession", id: "b1", cwd: "/work/beta/sub", claim: true },
      ]);
    });

    // A host that never sends `pinnedSessions` drops `toggleSessionPin`, so a
    // pin offered there is a control that does nothing. Capability, not version.
    // The menu itself still exists — rename and delete do not depend on pinning.
    it("offers no pin control against a host that never mentions pinning", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const menu = openMenu(window, doc.querySelector(".rail-session") as HTMLElement);
      expect(menuItem(menu, "Pin conversation")).toBe(undefined);
      expect(menuItem(menu, "Rename")).not.toBe(undefined);
      // The rows themselves still work — only the one affordance is withheld.
      expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["alpha one"]);
    });

    it("offers the pin once the host has proved it handles pinning", () => {
      const { doc, window } = boot("/work/alpha");
      // An EMPTY frame is proof enough — that is what a capable host with no
      // pins yet sends, and it must not be mistaken for silence.
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const menu = openMenu(window, doc.querySelector(".rail-session") as HTMLElement);
      expect(menuItem(menu, "Pin conversation")).not.toBe(undefined);
    });

    it("pins from an ordinary project row, naming that row's own repo", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha/wt", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const menu = openMenu(window, section.querySelector(".rail-session") as HTMLElement);
      click(window, menuItem(menu, "Pin conversation")!);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "a1", cwd: "/work/alpha/wt", pinned: true },
      ]);
    });

    // The Pinned group is where a pinned conversation is unpinned — there is no
    // pin glyph on the row any more, so the group IS the statement that it is
    // pinned, and its menu is where that is undone.
    it("unpins from the Pinned group", () => {
      const { doc, window, posted } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      const menu = openMenu(window, doc.querySelector(".rail-pinned .rail-session") as HTMLElement);
      click(window, menuItem(menu, "Unpin conversation")!);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "b1", cwd: "/work/beta", pinned: false },
      ]);
    });

    it("shows a filled pin on pinned rows and outline on others (hover control)", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const pinnedBtn = doc.querySelector(".rail-pinned .rail-pin-btn") as HTMLElement;
      expect(pinnedBtn).toBeTruthy();
      expect(pinnedBtn.classList.contains("active")).toBe(true);
      // Filled variant uses fill="currentColor" on the pin head path.
      expect(pinnedBtn.innerHTML).toMatch(/fill="currentColor"/);
      const projectRow = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
        .querySelector(".rail-pin-btn") as HTMLElement;
      expect(projectRow).toBeTruthy();
      expect(projectRow.classList.contains("active")).toBe(false);
      expect(projectRow.innerHTML).not.toMatch(/fill="currentColor"/);
    });

    it("pins from the session-row hover control in one click", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha/wt", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const pinBtn = section.querySelector(".rail-pin-btn") as HTMLElement;
      click(window, pinBtn);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "a1", cwd: "/work/alpha/wt", pinned: true },
      ]);
      // Row click is not fired by the pin control.
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
    });

    // The menu button is a real <button> inside a row that also answers
    // Enter/Space. Without a target check the key bubbles and does both — opening
    // the menu AND opening a conversation that may live in another project,
    // moving the whole tab.
    it("opens the menu by keyboard without also opening the conversation", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const btn = doc.querySelector(".rail-session-actions .rail-menu-btn") as HTMLElement;

      // A real button fires click on Enter; the keydown bubbles to the row too.
      btn.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      click(window, btn);

      expect(doc.querySelector(".rail-menu")).not.toBe(null);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
    });

    // Opening the menu must not also open the conversation.
    it("does not resume when the menu is opened", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      openMenu(window, section.querySelector(".rail-session") as HTMLElement);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
    });

    // Rename and delete are authorized by the host against a REPO, and the host
    // only knows which one from this field — without it every row the rail draws
    // from a project it has not selected is refused.
    it("names the row's own repo when deleting", async () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const menu = openMenu(window, doc.querySelector(".rail-session") as HTMLElement);
      click(window, menuItem(menu, "Delete")!);
      click(window, doc.querySelector(".confirm-btn.confirm-danger") as HTMLElement);
      // uiConfirm resolves a promise, so the post lands a microtask later.
      await Promise.resolve();
      expect(posted.filter((p) => p.type === "deleteSession")).toEqual([
        { type: "deleteSession", id: "a1", name: "alpha one", cwd: "/work/alpha" },
      ]);
    });
  });

  // The conversations are the point of the rail, and they were the one thing a
  // keyboard could not reach — repo names and pin buttons are real <button>s,
  // the rows were bare divs with an onclick.
  it("lets a keyboard reach and open a conversation", () => {
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
    const first = doc.querySelector(".rail-session") as HTMLElement;
    expect(first.getAttribute("role")).toBe("button");
    expect(first.tabIndex).toBe(0);

    first.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      { type: "resumeSession", id: "a1", cwd: "/work/alpha", claim: true },
    ]);
  });

  it("offers no session rows for an unavailable checkout", () => {
    const { doc } = boot();
    const offlineIndex = repoNames(doc).indexOf("offline");
    const section = doc.querySelectorAll(".rail-repo")[offlineIndex];
    expect(section.classList.contains("unavailable")).toBe(true);
    expect(section.querySelector(".rail-note")?.textContent).toBe("Unavailable");
  });

  describe("new session", () => {
    const addFor = (doc: Document, label: string) =>
      doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(label)]
        .querySelector('.rail-action-btn[title="New session here"]');

    it("starts directly in the repo already selected", () => {
      const { doc, window, posted } = boot("/work/alpha");
      click(window, addFor(doc, "alpha") as HTMLElement);
      expect(posted.filter((p) => p.type === "newSession")).toEqual([{ type: "newSession" }]);
      expect(posted.filter((p) => p.type === "selectRepo")).toEqual([]);
    });

    // The browser page arms an "open this repo's newest session" bridge on every
    // outbound selectRepo. A cross-repo New would race that bridge and could land
    // on an existing conversation, so the control is not offered where it cannot
    // keep its promise.
    it("is not offered for a project that is not selected", () => {
      const { doc } = boot("/work/alpha");
      expect(addFor(doc, "alpha")).not.toBe(null);
      expect(addFor(doc, "beta")).toBe(null);
      expect(addFor(doc, "gamma")).toBe(null);
    });
  });

  // Archiving exists so the rail can be a list of what you are working on rather
  // than everything you have ever opened. It is DERIVED, never a stored section:
  // one timestamped choice per project plus an age rule, both measured against
  // that project's newest conversation. Which is what makes "work in it and it
  // comes back" free — activity newer than the choice simply outranks it, and
  // there is no second flag to fall out of step.
  describe("archived projects", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const ago = (days: number) => Date.now() - days * DAY;

    /** A catalog whose stamps are real clock time, so the 30-day rule means
     *  something. `archived`/`archivedAt` present = a host that can record the
     *  choice; the fixtures above deliberately omit them. */
    const repo = (
      label: string,
      updatedAt: number,
      extra: Record<string, unknown> = {},
    ) => ({
      cwd: `/work/${label}`,
      label,
      available: true,
      pinned: false,
      updatedAt,
      archived: false,
      archivedAt: 0,
      ...extra,
    });

    const heads = (doc: Document) =>
      [...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
    const sectionRepos = (doc: Document, which: "projects" | "archived") =>
      [...(doc.querySelector(`.rail-list.rail-${which}`)?.querySelectorAll(".rail-repo-label") ?? [])]
        .map((e) => e.textContent);

    /** Five projects: one selected, three recent (which the floor would protect
     *  anyway), and two long-idle ones past the floor. */
    function bootArchive(overrides: Record<string, Record<string, unknown>> = {}, remote = true) {
      const catalog = [
        repo("home", ago(0), overrides.home),
        repo("one", ago(1), overrides.one),
        repo("two", ago(2), overrides.two),
        repo("three", ago(3), overrides.three),
        repo("stale", ago(80), overrides.stale),
        repo("ancient", ago(400), overrides.ancient),
      ];
      const h = bootWebview({ remote, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      // Give every project rows, so activity is read from conversations rather
      // than from the catalog's directory mtime.
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", ago(0))]));
      for (const r of catalog.slice(1)) {
        dispatch(h.window, {
          type: "repoSessions",
          cwd: r.cwd,
          entries: [row(`${r.label}1`, r.cwd, `${r.label} one`, r.updatedAt)],
          dots: {},
          total: 1,
        });
      }
      return h;
    }

    it("archives the project you are standing in", () => {
      // Owner, 2026-09-06: "we can stay inside.... now in the archive. archive
      // is just a way we group projects." The rail used to refuse to file the
      // open project under Archived, so Archive on the project a machine boots
      // into stored the choice and changed nothing on screen -- indistinguishable
      // from a dead button. An explicit choice outranks the heuristic.
      const h = bootArchive({}, true);
      const head = (name: string) => [...h.doc.querySelectorAll(".rail-repo-head")]
        .find((el) => el.querySelector(".rail-repo-label")?.textContent === name)!;
      click(h.window, menuItem(openMenu(h.window, head("home")), "Archive project")!);
      expect(h.posted).toContainEqual({ type: "setRepoArchived", cwd: "/work/home", archived: true });
      const catalog = ["home", "one", "two", "three", "stale", "ancient"].map((name) =>
        repo(name, ago(0), name === "home" ? { archived: true, archivedAt: Date.now() } : {}));
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      expect(sectionRepos(h.doc, "projects")).not.toContain("home");
      const archiveButton = [...h.doc.querySelectorAll(".rail-head-btn")]
        .find((el) => el.textContent?.includes("Project Archive"))!;
      click(h.window, archiveButton);
      expect(sectionRepos(h.doc, "archived")).toContain("home");
    });

    it.each([false, true])("archives and restores through the catalog on desktop/remote=%s", (remote) => {
      const h = bootArchive({}, remote);
      const head = (name: string) => [...h.doc.querySelectorAll(".rail-repo-head")]
        .find((el) => el.querySelector(".rail-repo-label")?.textContent === name)!;
      click(h.window, menuItem(openMenu(h.window, head("one")), "Archive project")!);
      expect(h.posted).toContainEqual({ type: "setRepoArchived", cwd: "/work/one", archived: true });
      const catalog = ["home", "one", "two", "three", "stale", "ancient"].map((name) =>
        repo(name, ago(0), name === "one" ? { archived: true, archivedAt: Date.now() } : {}));
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      expect(sectionRepos(h.doc, "projects")).not.toContain("one");
      const archiveButton = [...h.doc.querySelectorAll(".rail-head-btn")]
        .find((el) => el.textContent?.includes("Project Archive"))!;
      click(h.window, archiveButton);
      expect(sectionRepos(h.doc, "archived")).toContain("one");
      click(h.window, menuItem(openMenu(h.window, head("one")), "Move to Projects")!);
      expect(h.posted).toContainEqual({ type: "setRepoArchived", cwd: "/work/one", archived: false });
      dispatch(h.window, {
        type: "repos", selectedCwd: "/work/home", activeCwd: "/work/home",
        entries: catalog.map((r) => r.label === "one" ? { ...r, archived: false } : r),
      });
      expect(sectionRepos(h.doc, "projects")).toContain("one");
      h.window.close();
    });

    it.each([false, true])("age grouping keeps conversation actions usable on desktop/remote=%s", (remote) => {
      const h = bootArchive({}, remote);
      click(h.window, [...h.doc.querySelectorAll(".rail-head-btn")]
        .find((el) => el.textContent?.includes("Project Archive"))!);
      const stale = [...h.doc.querySelectorAll(".rail-archived .rail-repo")]
        .find((el) => el.querySelector(".rail-repo-label")?.textContent === "stale")!;
      expect(stale).toBeTruthy();
      const menu = openMenu(h.window, stale.querySelector(".rail-repo-head")!);
      expect(usableItem(menu, "Move to Projects")).toBe(true);
      expect(usableItem(menu, "Clear all history")).toBe(true);
      h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      h.posted.length = 0;
      click(h.window, stale.querySelector('[data-session-id="stale1"]')!);
      expect(h.posted).toContainEqual(expect.objectContaining({ type: "resumeSession", id: "stale1", cwd: "/work/stale" }));
      expect(h.posted.some((m) => m.type === "setRepoArchived")).toBe(false);
      h.window.close();
    });

    it("drops long-idle projects into a folded Project Archive section", () => {
      const { doc } = bootArchive();
      // RECENT is present once sessions load; Project Archive is folded (no list).
      expect(heads(doc)).toContain("Projects");
      expect(heads(doc)).toContain("Project Archive");
      expect(heads(doc)).toContain("Recent");
      expect(sectionRepos(doc, "projects")).toEqual(["home", "one", "three", "two"]);
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
      // No count badge on the group header (styled like the others).
      expect(doc.querySelector(".rail-head-count")).toBe(null);
    });

    it("opens and remembers the Project Archive section", () => {
      const { doc, window } = bootArchive();
      const archivedBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive")) as HTMLElement;
      click(window, archivedBtn);
      expect(sectionRepos(doc, "archived")).toEqual(["ancient", "stale"]);
      // Whether it is open is the same kind of answer as a project fold, so it
      // keeps the same company and survives a reload.
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("grok.remote.railShape"));
      const saved = JSON.parse(window.localStorage.getItem(key as string));
      expect(saved.groupCollapsed.archived).toBe(false);
      expect(saved.archiveOpen).toBe(true);
    });

    // Coming back from three weeks away must not archive everything at once and
    // leave a rail that reads as broken.
    it("never lets the age rule empty the Projects section", () => {
      const catalog = [
        repo("home", ago(200)),
        repo("a", ago(210)),
        repo("b", ago(220)),
        repo("c", ago(230)),
        repo("d", ago(240)),
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      // Every project's rows, because the age rule only ever runs on rows it
      // actually has — see the guess test above.
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", ago(200))]));
      for (const r of catalog.slice(1)) {
        dispatch(h.window, {
          type: "repoSessions",
          cwd: r.cwd,
          entries: [row(`${r.label}1`, r.cwd, `${r.label} one`, r.updatedAt)],
          dots: {},
          total: 1,
        });
      }
      // The three newest besides the one you are in, plus the one you are in.
      expect(sectionRepos(h.doc, "projects")).toEqual(["a", "b", "c", "home"]);
      expect(h.doc.querySelector(".rail-list.rail-archived")).toBe(null);
      // One age-archived project remains folded under Project Archive.
      const archivedBtn = [...h.doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive"));
      expect(archivedBtn).toBeTruthy();
    });

    // The age rule needs to know when a project was last worked in, and the only
    // honest source for that is the project's own conversations. The catalog's
    // stamp is the session DIRECTORY's mtime, which does not move when you
    // continue an existing conversation — so against an extension too old to
    // list another project's sessions (v2.3.1 has no `listRepoSessions` at all)
    // it would file a project you use every day under Archived, silently.
    it("never archives on a guess when the host cannot list the project's rows", () => {
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: Date.now() },
        // Used daily, in one long-running conversation — so its directory has
        // not been written to in a year, and its catalog stamp says so.
        { cwd: "/work/daily", label: "daily", available: true, pinned: false, updatedAt: ago(400) },
        { cwd: "/work/other", label: "other", available: true, pinned: false, updatedAt: ago(401) },
        { cwd: "/work/third", label: "third", available: true, pinned: false, updatedAt: ago(402) },
        { cwd: "/work/fourth", label: "fourth", available: true, pinned: false, updatedAt: ago(403) },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });

      // No `repoSessions` ever answers — the whole point. Not even the projects
      // past the floor may be archived.
      expect([...h.doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent))
        .not.toContain("Project Archive");
      expect(sectionRepos(h.doc, "projects")).toHaveLength(5);
    });

    // A rail that files the conversation on screen under "Archived" is
    // describing the screen wrongly, whatever the dates say.
    it("never archives the project you are reading", () => {
      const { doc } = bootArchive({ home: { archived: true, archivedAt: Date.now() } });
      expect(sectionRepos(doc, "projects")).toContain("home");
    });

    it("archives on request, and asks the host to remember it", () => {
      const { doc, window, posted } = bootArchive();
      const one = doc.querySelectorAll(".rail-repo")[1];
      const menu = openMenu(window, one.querySelector(".rail-repo-head") as HTMLElement);
      // First in the menu: putting a project away is the everyday act, and it
      // must be reachable without passing the delete.
      expect((menu.querySelector(".rail-menu-item") as HTMLElement).textContent).toContain("Archive project");
      click(window, menuItem(menu, "Archive project") as HTMLElement);
      expect(posted.filter((p) => p.type === "setRepoArchived")).toEqual([
        { type: "setRepoArchived", cwd: "/work/one", archived: true },
      ]);
    });

    // The floor holds back the AGE rule only. An explicit Archive on a project
    // you use every day has to take effect, or the control silently does nothing
    // exactly where it is most likely to be used.
    it("honours an explicit archive on a project the floor protects", () => {
      const { doc } = bootArchive({ one: { archived: true, archivedAt: Date.now() } });
      expect(sectionRepos(doc, "projects")).toEqual(["home", "three", "two"]);
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
      expect(heads(doc)).toContain("Project Archive");
    });

    // The whole reason the choice is a timestamp rather than a flag.
    it("brings a project back the moment it is worked in again", () => {
      const { doc, window } = bootArchive({ stale: { archived: true, archivedAt: ago(10) } });
      expect(sectionRepos(doc, "projects")).not.toContain("stale");

      dispatch(window, {
        type: "repoSessions",
        cwd: "/work/stale",
        entries: [row("s2", "/work/stale", "back at it", Date.now())],
        dots: {},
        total: 1,
      });
      expect(sectionRepos(doc, "projects")).toContain("stale");
    });

    // "Keep showing me this one" is a real, stored answer — not the absence of
    // one. Without it the age rule would undo the unarchive on the next render.
    it("keeps an unarchived project visible however idle it is", () => {
      const { doc } = bootArchive({ ancient: { archived: false, archivedAt: Date.now() } });
      expect(sectionRepos(doc, "projects")).toContain("ancient");
    });

    it("moves an archived project back from its own menu", () => {
      const { doc, window, posted } = bootArchive();
      const archivedBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive")) as HTMLElement;
      click(window, archivedBtn);
      const archivedSection = doc.querySelector(".rail-list.rail-archived") as HTMLElement;
      // By name, not by position: the section is ordered alphabetically, and a
      // test that takes "the first row" asserts the ordering by accident and
      // breaks whenever it changes.
      const staleHead = [...archivedSection.querySelectorAll(".rail-repo-head")]
        .find((h) => (h.querySelector(".rail-repo-label")?.textContent || "") === "stale") as HTMLElement;
      const menu = openMenu(window, staleHead);
      // The verb follows the SECTION, not the stored flag: these two were
      // archived by age and carry no flag at all, so reading the flag would
      // offer "Archive" on a row already sitting under Project Archive.
      expect(menuItem(menu, "Archive project")).toBe(undefined);
      click(window, menuItem(menu, "Move to Projects") as HTMLElement);
      expect(posted.filter((p) => p.type === "setRepoArchived")).toEqual([
        { type: "setRepoArchived", cwd: "/work/stale", archived: false },
      ]);
    });

    // A query answered with "No matches." while the project sits collapsed two
    // inches below is simply wrong.
    it("reaches into Project Archive when searching, and opens it", () => {
      const { doc, window } = bootArchive();
      const search = doc.getElementById("rail-search") as HTMLInputElement;
      search.value = "ancient";
      search.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

      expect(heads(doc)).toEqual(["Recent", "Project Archive"]);
      expect(sectionRepos(doc, "archived")).toEqual(["ancient"]);
      // …and says why it cannot be folded while the search is holding it open,
      // rather than offering a button whose click the next render undoes.
      const archivedBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive")) as HTMLButtonElement;
      expect(archivedBtn.disabled).toBe(true);
    });

    // Capability, never a version: a host that cannot record the choice must not
    // be offered a control that does nothing. The age rule still applies — it
    // needs nothing from the host.
    it("hides the archive control against a host that cannot record it", () => {
      const { doc, window } = boot();
      const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
      const menu = openMenu(window, beta.querySelector(".rail-repo-head") as HTMLElement);
      expect(menuItem(menu, "Archive project")).toBe(undefined);
      expect(menuItem(menu, "Clear all history")).not.toBe(undefined);
    });
  });

  // Folder colours: host-persisted, capability-gated the same way as archive
  // (`color` present — even as "" — on every row from a supporting host).
  describe("project folder colours", () => {
    const withColors = (entries = repos) =>
      entries.map((r) => ({ ...r, color: r.cwd === "/work/beta" ? "teal" : "" }));

    it("hides Set color against a host that never sends color", () => {
      // The default `repos` fixture omits `color` entirely — that is an older
      // host, and the control must not appear (capability, never a version).
      const { doc, window } = boot();
      const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
      const menu = openMenu(window, beta.querySelector(".rail-repo-head") as HTMLElement);
      expect(menuItem(menu, "Set color")).toBe(undefined);
      expect(menuItem(menu, "Clear all history")).not.toBe(undefined);
      // No tint either — data-repo-color is only set for a non-empty colour.
      expect(beta.querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe(null);
    });

    it("offers Set color, opens a swatch picker, and posts setRepoColor", () => {
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, {
        type: "repos",
        entries: withColors(),
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });
      const alpha = h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")];
      const menu = openMenu(h.window, alpha.querySelector(".rail-repo-head") as HTMLElement);
      expect(menuItem(menu, "Set color")).not.toBe(undefined);
      click(h.window, menuItem(menu, "Set color") as HTMLElement);
      // Menu closes; swatch picker replaces it.
      expect(h.doc.querySelector(".rail-menu")).toBe(null);
      const picker = h.doc.querySelector(".rail-color-picker") as HTMLElement;
      expect(picker).not.toBe(null);
      // Seven options: six hues + none, each with an accessible name.
      const swatches = [...picker.querySelectorAll(".rail-color-swatch")] as HTMLButtonElement[];
      expect(swatches).toHaveLength(7);
      expect(swatches.map((s) => s.getAttribute("aria-label"))).toEqual([
        "None", "Blue", "Teal", "Green", "Amber", "Coral", "Purple",
      ]);
      const blue = swatches.find((s) => s.getAttribute("aria-label") === "Blue")!;
      click(h.window, blue);
      expect(h.posted.filter((p) => p.type === "setRepoColor")).toEqual([
        { type: "setRepoColor", cwd: "/work/alpha", color: "blue" },
      ]);
      expect(h.doc.querySelector(".rail-color-picker")).toBe(null);
      // Optimistic: the folder tints before any repos frame.
      const alphaAfter = h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")];
      expect(alphaAfter.querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe("blue");
    });

    it("keeps a confirming color frame and yields to a contradicting one", () => {
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, {
        type: "repos",
        entries: withColors(),
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });
      const alpha = h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")];
      click(h.window, menuItem(openMenu(h.window, alpha.querySelector(".rail-repo-head") as HTMLElement), "Set color") as HTMLElement);
      click(h.window, [...h.doc.querySelectorAll(".rail-color-swatch")].find((s) => s.getAttribute("aria-label") === "Blue") as HTMLElement);
      expect(h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")]
        .querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe("blue");

      dispatch(h.window, {
        type: "repos",
        entries: withColors().map((r) => r.cwd === "/work/alpha" ? { ...r, color: "blue" } : r),
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });
      expect(h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")]
        .querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe("blue");

      const alpha2 = h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")];
      click(h.window, menuItem(openMenu(h.window, alpha2.querySelector(".rail-repo-head") as HTMLElement), "Set color") as HTMLElement);
      click(h.window, [...h.doc.querySelectorAll(".rail-color-swatch")].find((s) => s.getAttribute("aria-label") === "Coral") as HTMLElement);
      expect(h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")]
        .querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe("coral");

      dispatch(h.window, {
        type: "repos",
        entries: withColors(),
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });
      expect(h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")]
        .querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe(null);
    });

    it("tints the folder stroke when the catalog carries a colour", () => {
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, {
        type: "repos",
        entries: withColors(),
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });
      const beta = h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("beta")];
      expect(beta.querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe("teal");
      // Empty colour does not set the attribute (CSS falls back to default).
      const alpha = h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("alpha")];
      expect(alpha.querySelector(".rail-twisty")?.getAttribute("data-repo-color")).toBe(null);
    });
  });

  // A fold is a preference set at some earlier moment, and the one thing it must
  // never do is hide where you are NOW — corrected when the conversation ARRIVES,
  // rather than by refusing the fold outright.
  describe("the project holding the live conversation", () => {
    it("can still be folded, and stays folded", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });

      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const head = alpha().querySelector(".rail-repo-head") as HTMLElement;
      expect(head.getAttribute("aria-expanded")).toBe("true");
      click(window, head);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);

      // Holding the current project open forever made the one section you most
      // often want out of the way the one section you could not fold.
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });
      expect(alpha().querySelector(".rail-sessions")).toBe(null);
    });

    // A worktree conversation reports the WORKTREE as its cwd, and a worktree is
    // deliberately not a catalog row — so comparing the project's path with the
    // live session's said "not mine", and the project actually holding the open
    // conversation neither highlighted it nor re-opened for it.
    it("recognises its own conversation when that conversation is in a worktree", () => {
      const { doc, window } = boot("/work/alpha");
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      click(window, alpha().querySelector(".rail-repo-head") as HTMLElement);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);

      // The host names the worktree, not the checkout — and it lands BEFORE the
      // conversation goes live, so the active cwd is already the worktree at the
      // moment that matters. Sent the other way round, keying the re-open on the
      // active cwd alone still happens to work, and this test proves nothing.
      dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha/.wt" });
      dispatch(window, {
        ...sessionsFrame([{ ...row("w1", "/work/alpha/.wt", "worktree work", 9), worktreeLabel: "feature" }]),
        activeId: "w1",
      });

      expect(alpha().querySelector(".rail-session.active")).not.toBe(null);
      // Keying the re-open on the active cwd alone would miss this entirely: the
      // conversation's cwd is the worktree, the section's is the checkout.
      expect(alpha().querySelector(".rail-sessions")).not.toBe(null);
    });

    it("re-opens a project that was folded before the conversation moved there", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      click(window, alpha().querySelector(".rail-repo-head") as HTMLElement);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);

      // The conversation is opened from somewhere else — a phone, the desk, the
      // Pinned group. The fold that was fine a moment ago now hides the answer.
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });
      expect(alpha().querySelector(".rail-sessions")).not.toBe(null);
    });
  });

  // ---- Rail redesign: four groups, chevron-after, folder icons, collapse ----
  describe("rail redesign (four groups)", () => {
    const pinnedFrame = (entries: unknown[]) => ({ type: "pinnedSessions", entries, dots: {} });
    const pinned = (id: string, cwd: string, name: string, at: number, updatedAt = at) =>
      ({ ...row(id, cwd, name, updatedAt), pinnedAt: at });

    it("renders PINNED, RECENT, PROJECTS, PROJECT ARCHIVE in that order when all apply", () => {
      // Explicit archive (not age): the always-visible floor keeps a lone
      // idle project in Projects, so age alone cannot produce archive here.
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: Date.now(), archived: false, archivedAt: 0 },
        { cwd: "/work/old", label: "old", available: true, pinned: false, updatedAt: Date.now(), archived: true, archivedAt: Date.now() - 1000 },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", Date.now())]));
      dispatch(h.window, {
        type: "repoSessions",
        cwd: "/work/old",
        entries: [row("o1", "/work/old", "old one", Date.now() - 5000)],
        dots: {},
        total: 1,
      });
      dispatch(h.window, pinnedFrame([pinned("h1", "/work/home", "home one", 50, Date.now())]));

      const titles = [...h.doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
      expect(titles).toEqual(["Pinned", "Recent", "Projects", "Project Archive"]);
    });

    it("all group labels use .rail-head and share bold uppercase CSS treatment", async () => {
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: Date.now(), archived: false, archivedAt: 0 },
        { cwd: "/work/old", label: "old", available: true, pinned: false, updatedAt: Date.now(), archived: true, archivedAt: Date.now() - 1000 },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", Date.now())]));
      dispatch(h.window, {
        type: "repoSessions",
        cwd: "/work/old",
        entries: [row("o1", "/work/old", "old one", Date.now() - 5000)],
        dots: {},
        total: 1,
      });
      dispatch(h.window, pinnedFrame([pinned("h1", "/work/home", "home one", 50, Date.now())]));

      const groupHeads = [...h.doc.querySelectorAll(".rail-head")] as HTMLElement[];
      expect(groupHeads).toHaveLength(4);
      for (const head of groupHeads) {
        // Static PINNED is .rail-head alone; the others are .rail-head.rail-head-fold.
        expect(head.classList.contains("rail-head")).toBe(true);
        const title = head.querySelector(".rail-head-title") as HTMLElement;
        expect(title).toBeTruthy();
        // Applied styles live on the shared class (and .rail-head-title / btn).
        // happy-dom may not load chat.css, so assert the class contract + source.
        expect(title.className).toBe("rail-head-title");
      }
      // Source-level: chat.css forces uppercase + 700 on every group path.
      // (happy-dom may not apply the stylesheet; this still fails if the rule is removed.)
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const css = readFileSync(join(__dirname, "..", "media", "chat.css"), "utf8");
      expect(css).toMatch(/\.rail-head-title\s*\{[^}]*font-weight:\s*700/s);
      expect(css).toMatch(/\.rail-head-title\s*\{[^}]*text-transform:\s*uppercase/s);
      expect(css).toMatch(/\.rail-head-btn\s*\{[^}]*font-weight:\s*700/s);
      expect(css).toMatch(/\.rail-head-btn\s*\{[^}]*text-transform:\s*uppercase/s);
    });

    it("omits Project Archive and archive actions when the host omits archive fields (older desktop)", () => {
      // Capability = presence of `archived` on rows. Older desktop hosts strip the fields;
      // age rule and Archive menu must not run.
      const day = 24 * 60 * 60 * 1000;
      const t = (days: number) => Date.now() - days * day;
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: t(0) },
        { cwd: "/work/stale", label: "stale", available: true, pinned: false, updatedAt: t(80) },
        { cwd: "/work/ancient", label: "ancient", available: true, pinned: false, updatedAt: t(400) },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", t(0))]));
      for (const r of catalog.slice(1)) {
        dispatch(h.window, {
          type: "repoSessions",
          cwd: r.cwd,
          entries: [row(`${r.label}1`, r.cwd, `${r.label} one`, r.updatedAt)],
          dots: {},
          total: 1,
        });
      }
      const { doc, window } = h;
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
      expect([...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent)).not.toContain(
        "Project Archive",
      );
      // All three stay under Projects (age rule disabled).
      const projectLabels = [
        ...(doc.querySelector(".rail-list.rail-projects")?.querySelectorAll(".rail-repo-label") ?? []),
      ].map((e) => e.textContent).sort();
      expect(projectLabels).toEqual(["ancient", "home", "stale"]);
      const menu = openMenu(window, doc.querySelector(".rail-repo-head") as HTMLElement);
      const labels = [...menu.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
      expect(labels.some((l) => /archive/i.test(l))).toBe(false);
    });

    it("omits Project Archive when no project is archived (deliberate, not a bug)", () => {
      // All projects active — no empty archive band.
      const { doc } = boot();
      const titles = [...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
      expect(titles).not.toContain("Project Archive");
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
    });

    it("PINNED is not collapsible — no head button, no chevron", () => {
      const { doc, window } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      const pinnedHead = [...doc.querySelectorAll(".rail-head")]
        .find((h) => h.querySelector(".rail-head-title")?.textContent === "Pinned") as HTMLElement;
      expect(pinnedHead).toBeTruthy();
      expect(pinnedHead.querySelector(".rail-head-btn")).toBe(null);
      expect(pinnedHead.querySelector(".rail-head-twisty")).toBe(null);
      expect(doc.querySelector(".rail-list.rail-pinned")).toBeTruthy();
    });

    it("group headers put the chevron after the label", () => {
      const { doc, window } = boot();
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
      expect(recentBtn).toBeTruthy();
      const kids = [...recentBtn.children].map((c) => c.className);
      const titleIdx = kids.findIndex((c) => c.includes("rail-head-title"));
      const twistyIdx = kids.findIndex((c) => c.includes("rail-head-twisty"));
      expect(titleIdx).toBeGreaterThanOrEqual(0);
      expect(twistyIdx).toBeGreaterThan(titleIdx);
    });

    it("collapses and remembers RECENT / PROJECTS", () => {
      const { doc, window } = boot();
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      expect(doc.querySelector(".rail-list.rail-recent")).toBe(null);
      expect(doc.querySelector(".rail-list.rail-projects")).toBeTruthy();

      let recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
      click(window, recentBtn);
      expect(doc.querySelector(".rail-list.rail-recent")).toBeTruthy();
      recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
      click(window, recentBtn);
      expect(doc.querySelector(".rail-list.rail-recent")).toBe(null);

      const projectsBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Projects")) as HTMLElement;
      click(window, projectsBtn);
      expect(doc.querySelector(".rail-list.rail-projects")).toBe(null);

      const key = Object.keys(window.localStorage).find((k) => k.startsWith("grok.remote.railShape"));
      const saved = JSON.parse(window.localStorage.getItem(key as string));
      expect(saved.groupCollapsed.recent).toBe(true);
      expect(saved.groupCollapsed.projects).toBe(true);
    });

    // Cross-group duplication is deliberate: RECENT is a shortcut, and a
    // session must NEVER leave its project because another group shows it —
    // that exact vanish shipped once (one-visual-home claiming) and the owner
    // caught it in the field (2026-08-13). Dedupe is per group only.
    it("RECENT duplicates pinned and project rows on purpose; a project never loses its session", () => {
      const { doc, window } = boot();
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha recent", 100)]));
      dispatch(window, {
        type: "repoSessions",
        cwd: "/work/beta",
        entries: [row("b1", "/work/beta", "beta older", 50)],
        dots: {},
        total: 1,
      });
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta older", 9, 50)]));

      const recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
      click(window, recentBtn);

      const recentNames = [...doc.querySelectorAll(".rail-list.rail-recent .rail-session-name")]
        .map((e) => e.textContent);
      expect(recentNames).toEqual(["alpha recent", "beta older"]);
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-name")].map((e) => e.textContent))
        .toEqual(["beta older"]);
      // The owner's regression: Recent holding a1 must not evict it from alpha.
      expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toContain("alpha recent");
      // Within one group each id renders once; across groups it repeats.
      expect(doc.querySelectorAll('.rail-list.rail-recent [data-session-id="a1"]')).toHaveLength(1);
      expect(doc.querySelectorAll('[data-session-id="a1"]')).toHaveLength(2);
      expect(doc.querySelectorAll('[data-session-id="b1"]')).toHaveLength(3);
    });

    it("keeps project and RECENT order on open-only, then accepts the optimistic send order", () => {
      const { doc, window } = boot();
      const newer = row("newer", "/work/alpha", "newer", 100);
      const older = row("older", "/work/alpha", "older", 10);
      dispatch(window, { ...sessionsFrame([newer, older]), activeId: "newer" });
      const alphaIndex = repoNames(doc).indexOf("alpha");
      expect(sessionNames(doc, alphaIndex)).toEqual(["newer", "older"]);

      // Opening changes identity/highlight only. The host confirms the same
      // persisted timestamps, so the project list must stay put.
      const alpha = doc.querySelectorAll(".rail-repo")[alphaIndex];
      click(window, alpha.querySelector('[data-session-id="older"]') as HTMLElement);
      dispatch(window, { ...sessionsFrame([newer, older]), activeId: "older" });
      expect(sessionNames(doc, alphaIndex)).toEqual(["newer", "older"]);

      const recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((button) => (button.textContent || "").includes("Recent")) as HTMLElement;
      click(window, recentBtn);
      const recentNames = () => [...doc.querySelectorAll(".rail-list.rail-recent .rail-session-name")]
        .map((entry) => entry.textContent);
      expect(recentNames()).toEqual(["newer", "older"]);

      // Send-time host activity is optimistic: the next frame promotes the
      // target before the provider has persisted its final transcript stamp.
      dispatch(window, {
        ...sessionsFrame([{ ...older, updatedAt: 200 }, newer]),
        activeId: "older",
      });
      expect(recentNames()).toEqual(["older", "newer"]);
    });

    it("RECENT stops at ten expanded rows and keeps its unnumbered affordance", () => {
      const { doc, window } = boot();
      const many = Array.from({ length: 12 }, (_, i) =>
        row(`a${i}`, "/work/alpha", `s${i}`, 100 - i),
      );
      dispatch(window, sessionsFrame(many));
      const recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
      click(window, recentBtn);
      const more = doc.querySelector(".rail-list.rail-recent .rail-more") as HTMLElement;
      expect(more.textContent).toBe("Show more");
      expect(more.textContent).not.toMatch(/\d/);
      expect(doc.querySelectorAll(".rail-list.rail-recent .rail-session-name")).toHaveLength(3);
      click(window, more);
      expect(doc.querySelectorAll(".rail-list.rail-recent .rail-session-name")).toHaveLength(10);
      const less = doc.querySelector(".rail-list.rail-recent .rail-more") as HTMLElement;
      expect(less.textContent).toBe("Show less");
      expect(less.textContent).not.toMatch(/\d/);
    });

    it("project rows use folder-closed when collapsed and folder-open when expanded", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const twisty = () => alpha().querySelector(".rail-twisty") as HTMLElement;
      // Expanded: ONE flag drives icon + session list (data-expanded + folder-open).
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // The two marks are told apart by viewBox — they are the owner's solid
      // folder artwork (media/icons/folder-*.svg), not a shared 24x24 grid.
      expect(twisty().innerHTML).toMatch(/viewBox="0 -57 511/);
      expect(twisty().innerHTML).not.toMatch(/viewBox="0 0 408 408"/);
      expect(alpha().querySelector(".rail-sessions")).not.toBe(null);
      // Icon and list cannot disagree: sessions present ⇒ open icon path.
      expect(!!alpha().querySelector(".rail-sessions")).toBe(
        /viewBox="0 -57 511/.test(twisty().innerHTML),
      );
      // Folder is an indicator (not a button); the whole head toggles.
      expect(twisty().tagName).toBe("SPAN");
      click(window, alpha().querySelector(".rail-repo-head") as HTMLElement);
      // Collapsed: the closed mark, no sessions, data-expanded=0.
      expect(alpha().getAttribute("data-expanded")).toBe("0");
      expect(twisty().innerHTML).toMatch(/viewBox="0 0 408 408"/);
      expect(twisty().innerHTML).not.toMatch(/viewBox="0 -57 511/);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);
      expect(!!alpha().querySelector(".rail-sessions")).toBe(
        /viewBox="0 -57 511/.test(twisty().innerHTML),
      );
    });

    it("the whole project header toggles expand; hover actions do not", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const head = () => alpha().querySelector(".rail-repo-head") as HTMLElement;
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // Click the label area (not the folder alone) — whole head is the control.
      click(window, alpha().querySelector(".rail-repo-label") as HTMLElement);
      expect(alpha().getAttribute("data-expanded")).toBe("0");
      expect(alpha().querySelector(".rail-sessions")).toBe(null);
      click(window, head());
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // Hover action (+ New) must not toggle.
      const before = posted.length;
      const add = alpha().querySelector(".rail-repo-actions .rail-action-btn") as HTMLElement;
      click(window, add);
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // Selected project's + posts newSession (does not fold).
      expect(posted.slice(before).some((p) => p.type === "newSession")).toBe(true);
    });

    it("hidden hover actions are absolutely positioned so they do not reserve label width", () => {
      // Assert the CSS contract: actions overlay (position:absolute) on hover-capable
      // surfaces. A layout-space reservation would reintroduce early title truncation.
      const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css");
      const css = fs.readFileSync(cssPath, "utf8");
      // Overlay path (default).
      expect(css).toMatch(
        /\.rail-repo-actions,\s*\n\s*\.rail-session-actions\s*\{[^}]*position:\s*absolute/s,
      );
      // Touch / no-hover: back to in-flow reservation.
      expect(css).toMatch(
        /@media\s*\(hover:\s*none\)\s*\{[\s\S]*?\.rail-repo-actions,\s*\n\s*\.rail-session-actions\s*\{[^}]*position:\s*static/,
      );
    });

    it("hover action buttons sit flat on the row hover surface (no darker chip)", () => {
      const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css");
      const css = fs.readFileSync(cssPath, "utf8");
      const hoverRule = css.match(
        /\.rail-action-btn:hover\s*,\s*\.rail-action-btn\.active\s*\{[^}]+\}/,
      );
      expect(hoverRule?.[0]).toMatch(/background:\s*transparent/);
      expect(hoverRule?.[0]).not.toContain("toolbar-hoverBackground");
      // Scrim uses the row hover token so controls are not a second layer.
      expect(css).toMatch(
        /\.rail-repo-actions,\s*\n\s*\.rail-session-actions\s*\{[^}]*--rail-hover-bg/s,
      );
    });

    it("a host that never mounts #projects-rail never renders the rail (VS Code property)", () => {
      // Same guard as the top-level test — kept next to the redesign so a
      // regression that lights the rail without a mount fails this suite hard.
      const { doc, window } = bootWebview({});
      dispatch(window, {
        type: "repos",
        entries: repos,
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      expect(doc.getElementById("projects-rail")).toBe(null);
      expect(doc.body.classList.contains("has-rail")).toBe(false);
      expect(doc.querySelectorAll(".rail-head-title")).toHaveLength(0);
      expect(doc.querySelectorAll(".rail-session")).toHaveLength(0);
    });
  });
});

// "Continue in a new chat" used to sit in the composer's settings popover
// beside model and effort. Those two say how the agent ANSWERS; forking makes a
// different conversation — which is what the ⋯ menu is already for (Rename,
// Pin, Delete). Moving it leaves the composer popover holding model and effort
// alone. Owner, 2026-08-07.
describe("continue-in-a-new-chat lives in the session ⋯ menu", () => {
  const pinnedFrame = (entries: unknown[]) => ({ type: "pinnedSessions", entries, dots: {} });
  it("offers it on the conversation you are actually in", () => {
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    const menu = openMenu(window, section.querySelector(".rail-session") as HTMLElement);
    const item = menuItem(menu, "Continue in a new chat");
    expect(item).toBeTruthy();
    click(window, item!);
    // Knowledge work is the default, so there is one destination and no popup.
    expect(posted.find((p) => p.type === "forkSession")).toBeTruthy();
  });

  it("withholds it from other rows — a fork continues from the LIVE transcript", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    const rows = section.querySelectorAll(".rail-session");
    // Second row is not the live conversation — offering a fork there would
    // promise to continue from a transcript this client does not have.
    const menu = openMenu(window, rows[1] as HTMLElement);
    expect(menuItem(menu, "Continue in a new chat")).toBeUndefined();
    expect(menuItem(menu, "Delete")).toBeTruthy();
  });

  // Regression, found in two directions. Fork and apply/remove worktree carry
  // NO session id — the host runs them against its own `focused` session, and
  // `openSessionReserved` reassigns `focused` BEFORE it starts the session or
  // emits sessionName/sessions.activeId.
  //
  // So while a rail click is in flight neither row is safe: the clicked row is
  // not confirmed yet (its menu would act on the one being left), and the
  // previously active row may already have been left (its menu would act on the
  // one being opened). Removing a worktree discards unapplied edits, so a wrong
  // guess here is work loss. Withhold from BOTH until identity is confirmed.
  it("withholds it from every row while a rail click is in flight", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    // The rail re-renders on every state change, so every lookup has to go back
    // to the document — a NodeList captured before the click is detached.
    const railRows = () => {
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      return section.querySelectorAll(".rail-session");
    };
    const activeLabel = () =>
      doc.querySelector(".rail-session.active .rail-session-name")?.textContent;

    // Click a2 — it paints as active immediately, but the host is still on a1.
    click(window, railRows()[1] as HTMLElement);
    expect(activeLabel()).toBe("alpha two");

    const pendingMenu = openMenu(window, railRows()[1] as HTMLElement);
    // Present but not usable — the row owns it, the host just has not confirmed.
    expect(disabledItem(pendingMenu, "Continue in a new chat")).toBe(true);
    // Still a real conversation — the id-carrying actions stay available.
    expect(menuItem(pendingMenu, "Delete")).toBeTruthy();

    // ...and a1 does not offer it at all: it is no longer the painted target.
    const leavingMenu = openMenu(window, railRows()[0] as HTMLElement);
    expect(menuItem(leavingMenu, "Continue in a new chat")).toBeUndefined();

    // Identity confirmed — the group comes back, on the confirmed row only.
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a2",
    });
    expect(menuItem(openMenu(window, railRows()[1] as HTMLElement), "Continue in a new chat"))
      .toBeTruthy();
    expect(menuItem(openMenu(window, railRows()[0] as HTMLElement), "Continue in a new chat"))
      .toBeUndefined();
  });

  // The watchdog and a stray error tear down the optimistic transition without
  // learning anything about the host — and a cold resume can outlive the
  // watchdog, with `focused` already reassigned. So "the transition is gone" is
  // NOT proof that identities agree; only an identity frame is. Fail closed.
  it("keeps them withheld after the watchdog gives up, until an identity frame lands", async () => {
    const { doc, window } = bootWebview({
      remote: true,
      beforeScripts: (w: any) => {
        withRail(w);
        w.__grokRailTransitionTimeoutMs = 5;
      },
    });
    dispatch(window, {
      type: "repos",
      entries: repos,
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    const railRows = () => {
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      return section.querySelectorAll(".rail-session");
    };

    click(window, railRows()[1] as HTMLElement);
    // Watchdog fires: the optimistic highlight backs out to the host-confirmed
    // row, which is the intended visual behaviour...
    await vi.waitFor(() =>
      expect(doc.querySelector(".rail-session.active .rail-session-name")?.textContent)
        .toBe("alpha one"),
    );

    // ...but the host was never heard from, so the id-less actions stay shut.
    expect(usableItem(openMenu(window, railRows()[0] as HTMLElement), "Continue in a new chat"))
      .toBe(false);

    // A frame naming some OTHER conversation does not settle it either. The
    // resume we asked for is serialised host-side and may still land, so "the
    // host is on a1 right now" is not "the host has finished moving".
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    expect(usableItem(openMenu(window, railRows()[0] as HTMLElement), "Continue in a new chat"))
      .toBe(false);

    // Only an answer to what we actually asked for re-opens them.
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a2",
    });
    expect(menuItem(openMenu(window, railRows()[1] as HTMLElement), "Continue in a new chat"))
      .toBeTruthy();
  });

  // The sharper version of the same trap: a NON-matching identity frame arriving
  // mid-transition. On rapid A→B→C, B's delayed activeId says where the host
  // WAS, not where it is — disarming the latch on it and then letting C outlive
  // the watchdog would reopen the actions with the renderer still showing B.
  it("a non-matching identity frame mid-flight does not disarm the latch", async () => {
    const { doc, window } = bootWebview({
      remote: true,
      beforeScripts: (w: any) => {
        withRail(w);
        w.__grokRailTransitionTimeoutMs = 5;
      },
    });
    dispatch(window, {
      type: "repos",
      entries: repos,
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    dispatch(window, pinnedFrame([]));
    const three = () =>
      sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
        row("a3", "/work/alpha", "alpha three", 7),
      ]);
    dispatch(window, { ...three(), activeId: "a1" });
    const railRows = () => {
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      return section.querySelectorAll(".rail-session");
    };

    // Click a2, then immediately a3 — a3's transition supersedes a2's.
    click(window, railRows()[1] as HTMLElement);
    click(window, railRows()[2] as HTMLElement);

    // a2's echo finally lands. It names a real conversation, but not the one we
    // are waiting on, so it must not be taken as "we know where the host is".
    dispatch(window, { ...three(), activeId: "a2" });

    // a3 never confirms; the watchdog gives up on the highlight.
    await vi.waitFor(() =>
      expect(doc.querySelector(".rail-session.active .rail-session-name")?.textContent)
        .toBe("alpha two"),
    );

    // Latch must still be closed — the host may already be on a3.
    for (const i of [0, 1, 2]) {
      expect(usableItem(openMenu(window, railRows()[i] as HTMLElement), "Continue in a new chat"))
        .toBe(false);
    }

    // Only an answer to the LAST thing we asked for settles it.
    dispatch(window, { ...three(), activeId: "a3" });
    expect(menuItem(openMenu(window, railRows()[2] as HTMLElement), "Continue in a new chat"))
      .toBeTruthy();
  });

  // The nastiest ordering: the superseded resume confirms AFTER the newest one
  // has already been abandoned by the watchdog. Resumes are serialised
  // host-side, so B genuinely can land late while C is still queued and about
  // to become focused. Forgetting what we asked for the moment the paint is
  // abandoned is what made that stale B frame look authoritative.
  it("a superseded confirmation arriving after the watchdog does not settle identity", async () => {
    const { doc, window } = bootWebview({
      remote: true,
      beforeScripts: (w: any) => {
        withRail(w);
        w.__grokRailTransitionTimeoutMs = 5;
      },
    });
    dispatch(window, {
      type: "repos",
      entries: repos,
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    dispatch(window, pinnedFrame([]));
    const three = () =>
      sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
        row("a3", "/work/alpha", "alpha three", 7),
      ]);
    dispatch(window, { ...three(), activeId: "a1" });
    const railRows = () => {
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      return section.querySelectorAll(".rail-session");
    };

    click(window, railRows()[1] as HTMLElement); // ask for a2
    click(window, railRows()[2] as HTMLElement); // supersede: ask for a3

    // a3 never confirms; the watchdog abandons the optimistic paint.
    await vi.waitFor(() =>
      expect(doc.querySelector(".rail-session.active .rail-session-name")?.textContent)
        .toBe("alpha one"),
    );

    // NOW a2's slow load finally confirms — after the paint was abandoned.
    dispatch(window, { ...three(), activeId: "a2" });

    // a3 is still queued host-side and may already be focused. The gate must
    // stay shut: acting here could fork or remove against a3.
    for (const i of [0, 1, 2]) {
      expect(usableItem(openMenu(window, railRows()[i] as HTMLElement), "Continue in a new chat"))
        .toBe(false);
    }

    // a3 landing is what actually settles it.
    dispatch(window, { ...three(), activeId: "a3" });
    expect(menuItem(openMenu(window, railRows()[2] as HTMLElement), "Continue in a new chat"))
      .toBeTruthy();
  });

  it("posts forkSession with the confirmed-active session id", () => {
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    const menu = openMenu(window, section.querySelector(".rail-session") as HTMLElement);
    click(window, menuItem(menu, "Continue in a new chat")!);
    expect(posted.find((p) => p.type === "forkSession")).toEqual({
      type: "forkSession",
      sessionId: "a1",
    });
  });

  it("posts applyWorktree/removeWorktree with the confirmed-active session id", async () => {
    const { doc, window, posted } = bootWebview({
      beforeScripts: withRail,
    });
    dispatch(window, {
      type: "repos",
      entries: repos,
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      type: "session",
      sessionId: "a1",
      models: [],
      currentModelId: "grok-build",
      worktree: { label: "feature", path: "/work/alpha/.worktrees/feature" },
    } as never);
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });
    dispatch(window, { type: "sessionName", sessionId: "a1", name: "alpha one", cwd: "/work/alpha" });
    const openRowMenu = () => {
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      return openMenu(window, section.querySelector(".rail-session") as HTMLElement);
    };

    click(window, menuItem(openRowMenu(), "Apply worktree")!);
    click(window, doc.querySelector(".confirm-overlay .confirm-primary") as HTMLElement);
    await Promise.resolve();
    expect(posted.find((p) => p.type === "applyWorktree")).toEqual({
      type: "applyWorktree",
      sessionId: "a1",
    });

    posted.length = 0;
    click(window, menuItem(openRowMenu(), "Remove worktree")!);
    click(window, doc.querySelector(".confirm-overlay .confirm-danger") as HTMLElement);
    await Promise.resolve();
    expect(posted.find((p) => p.type === "removeWorktree")).toEqual({
      type: "removeWorktree",
      sessionId: "a1",
    });
  });
});

// Optimistic rail transition: a click must paint the highlight (and the loading
// veil) before any host reply. state.activeSessionId stays host-confirmed — the
// display target is renderer-local. See railTransition / railDisplayTarget in
// media/chat.js.
describe("rail transition (optimistic highlight)", () => {
  const activeName = (doc: Document, repoLabel: string) => {
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(repoLabel)];
    const active = section?.querySelector(".rail-session.active .rail-session-name");
    return active?.textContent || null;
  };
  const welcomeStatus = (doc: Document) => {
    const ver = doc.getElementById("welcome-version");
    return (ver as HTMLElement | null)?.dataset?.status || ver?.textContent || "";
  };

  it("highlights a clicked row before any host reply", () => {
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    expect(activeName(doc, "alpha")).toBe("alpha one");

    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    const rows = section.querySelectorAll(".rail-session");
    click(window, rows[1] as HTMLElement);

    // Before sessionName / sessions — highlight moved, host only got resume.
    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      { type: "resumeSession", id: "a2", cwd: "/work/alpha", claim: true },
    ]);
    expect(activeName(doc, "alpha")).toBe("alpha two");
    expect(welcomeStatus(doc)).toBe("Loading conversation");
  });

  it("switches the header and hides the old transcript before any host reply", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    dispatch(window, { type: "sessionName", sessionId: "a1", name: "alpha one", cwd: "/work/alpha" });
    dispatch(window, { type: "userMessage", text: "old transcript" });
    expect(doc.getElementById("session-head-title")!.textContent).toBe("alpha one");
    expect(doc.querySelector(".msg.user")?.textContent).toContain("old transcript");

    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    click(window, section.querySelectorAll(".rail-session")[1] as HTMLElement);

    expect(doc.getElementById("session-head-title")!.textContent).toBe("alpha two");
    expect((doc.querySelector(".msg.user") as HTMLElement).hidden).toBe(true);
    expect(welcomeStatus(doc)).toBe("Loading conversation");

    dispatch(window, { type: "sessionName", sessionId: "a2", name: "alpha two", cwd: "/work/alpha" });
    expect(doc.getElementById("session-head-title")!.textContent).toBe("alpha two");

    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessage", text: "new transcript" });
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.getElementById("session-head-title")!.textContent).toBe("alpha two");
    expect(doc.querySelector(".msg.user")?.textContent).toContain("new transcript");
  });

  it("a contradicting identity frame after a rail open does not keep the pending title", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    dispatch(window, { type: "sessionName", sessionId: "a1", name: "alpha one", cwd: "/work/alpha" });

    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    click(window, section.querySelectorAll(".rail-session")[1] as HTMLElement);
    expect(doc.getElementById("session-head-title")!.textContent).toBe("alpha two");

    dispatch(window, { type: "error", text: "not found", resumeFailed: { id: "a2" } });
    expect(doc.getElementById("session-head-title")!.textContent).toBe("alpha one");
    expect(activeName(doc, "alpha")).toBe("alpha one");
  });

  it("paints a rail rename on the header and row before any host frame", async () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });
    dispatch(window, { type: "sessionName", sessionId: "a1", name: "alpha one", cwd: "/work/alpha" });

    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    click(window, menuItem(openMenu(window, section.querySelector(".rail-session") as HTMLElement), "Rename")!);
    const input = doc.querySelector(".confirm-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "Renamed on rail";
    click(window, doc.querySelector(".confirm-primary") as HTMLElement);
    await Promise.resolve();

    expect(doc.getElementById("session-head-title")!.textContent).toBe("Renamed on rail");
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))[0]).toBe("Renamed on rail");

    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "Catalog title", 9)]),
      activeId: "a1",
    });
    expect(doc.getElementById("session-head-title")!.textContent).toBe("Catalog title");
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))[0]).toBe("Catalog title");
  });

  it("does not confirm a resume on a non-matching activeId (multi-tab echo)", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    click(window, section.querySelectorAll(".rail-session")[1] as HTMLElement);
    expect(activeName(doc, "alpha")).toBe("alpha two");

    // Another tab's catalog refresh: same rows, but this tab's activeId is still
    // a1. Must not clear or re-home the pending a2 highlight.
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    expect(activeName(doc, "alpha")).toBe("alpha two");
    expect(welcomeStatus(doc)).toBe("Loading conversation");

    // Matching activeId confirms; highlight remains (now host-owned).
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a2",
    });
    expect(activeName(doc, "alpha")).toBe("alpha two");
  });

  it("backs the highlight out on error", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    click(window, section.querySelectorAll(".rail-session")[1] as HTMLElement);
    expect(activeName(doc, "alpha")).toBe("alpha two");

    dispatch(window, { type: "error", text: "Session is owned by another client." });
    // Falls back to the last host-confirmed id (a1) — never stranded on a2.
    expect(activeName(doc, "alpha")).toBe("alpha one");
  });

  it("selects duplicate-titled rows by id, and drops a row that has none", () => {
    // "I can't select the other New session as titles are not unique" is the
    // reported symptom. Selection has been id-keyed for a while; this pins that
    // two "New session" rows with distinct ids are independently openable, and
    // that a host entry with an empty id never becomes a clickable row (every
    // such row would share dataset.sessionId === "" and steal each other's click).
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([
        { ...row("", "/work/alpha", "New session", 12) },
        row("live-a", "/work/alpha", "New session", 11),
        row("live-b", "/work/alpha", "New session", 10),
        row("real", "/work/alpha", "Untitled (2026-08-17)", 9),
      ]),
      activeId: "live-a",
    });
    const names = sessionNames(doc, repoNames(doc).indexOf("alpha"));
    expect(names.filter((n) => n === "New session")).toHaveLength(2);
    expect(names).toContain("Untitled (2026-08-17)");
    const rows = [...doc.querySelectorAll(".rail-session")] as HTMLElement[];
    expect(rows.map((el) => el.dataset.sessionId)).toEqual(["live-a", "live-b", "real"]);

    click(window, rows[1]);
    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      { type: "resumeSession", id: "live-b", cwd: "/work/alpha", claim: true },
    ]);
  });

  it("shows a new-conversation placeholder and replaces it without duplicating", () => {
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });

    const alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    // Project "+" on the selected repo → beginNewSession path.
    const add = alpha.querySelector(".rail-repo-actions .rail-action-btn") as HTMLElement;
    click(window, add);
    expect(posted.some((p) => p.type === "newSession")).toBe(true);

    const namesBefore = sessionNames(doc, repoNames(doc).indexOf("alpha"));
    expect(namesBefore[0]).toBe("New session");
    expect(namesBefore).toContain("alpha one");
    expect(activeName(doc, "alpha")).toBe("New session");
    // Synthetic only — never inserted into the host-owned sessions list payload.
    expect(namesBefore.filter((n) => n === "New session")).toHaveLength(1);

    // Identity binds the real id; placeholder keeps the synthetic row until the
    // catalog actually lists that id (no double paint).
    dispatch(window, {
      type: "sessionName",
      sessionId: "a-new",
      name: "New session",
      cwd: "/work/alpha",
    });
    // Still one row for the pending conversation (id resolved, not yet in catalog).
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha")).filter((n) => n === "New session"))
      .toHaveLength(1);

    // Catalog carries the real row — placeholder drops, no duplicate.
    dispatch(window, {
      ...sessionsFrame([
        row("a-new", "/work/alpha", "Fresh chat", 10),
        row("a1", "/work/alpha", "alpha one", 9),
      ]),
      activeId: "a-new",
    });
    const namesAfter = sessionNames(doc, repoNames(doc).indexOf("alpha"));
    expect(namesAfter).toEqual(["Fresh chat", "alpha one"]);
    expect(activeName(doc, "alpha")).toBe("Fresh chat");
    expect(namesAfter.filter((n) => n === "New session")).toHaveLength(0);
  });

  it("gives a pending New-session row the project's remembered provider glyph immediately", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true },
      ],
    });
    dispatch(window, {
      type: "repos",
      entries: repos.map((repo) => ({
        ...repo,
        defaultProvider: repo.cwd === "/work/alpha" ? "codex" : "grok",
      })),
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });

    let alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    click(window, alpha.querySelector(".rail-repo-actions .rail-action-btn") as HTMLElement);
    alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    const fresh = alpha.querySelector('.rail-session[data-session-id^="pending-new:"]') as HTMLElement;
    expect(fresh.querySelector(".provider-glyph")?.getAttribute("aria-label")).toBe("Codex");
  });

  it("highlights a cross-repo row before activeRepoCwd has moved", () => {
    // The wrong shortcut (pendingId || activeId with ownership over confirmed
    // globals) fails here: railRepoOwnsActive returned false for beta while
    // activeRepoCwd was still alpha, so no highlight.
    const { doc, window } = boot("/work/alpha");
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });
    dispatch(window, {
      type: "repoSessions",
      cwd: "/work/beta",
      entries: [row("b1", "/work/beta", "beta one", 4)],
      dots: {},
      total: 1,
    });
    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    click(window, beta.querySelector(".rail-session") as HTMLElement);
    expect(activeName(doc, "beta")).toBe("beta one");
    // Alpha must not keep the active paint for the conversation we just left.
    expect(activeName(doc, "alpha")).toBe(null);
  });
});

describe("rail overflow menus toggle", () => {
  // The dots opened but never closed on a second click. openRailMenu already had
  // toggle logic; it compared an id stamped on the BUTTON, and the rail
  // re-renders and recreates those buttons — so by the second click the element
  // was new, carried no id, and the "is this already my menu?" test could not
  // match. It closed and immediately reopened, which looks like nothing
  // happening, and only clicking elsewhere dismissed it.
  it("closes on a second click of the same button", () => {
    const h = boot();
    const dots = h.doc.querySelector(".rail-menu-btn") as HTMLElement | null;
    expect(dots).toBeTruthy();

    click(h.window, dots!);
    expect(h.doc.querySelector(".rail-menu")).toBeTruthy();

    // Same button again. Re-query rather than reusing the node, because the
    // rail may have re-rendered — which is the whole point.
    const again = h.doc.querySelector(".rail-menu-btn") as HTMLElement;
    click(h.window, again);
    expect(h.doc.querySelector(".rail-menu")).toBeFalsy();
  });

  it("keeps the top-right session ⋯ open across catalog refreshes", () => {
    // The header overflow is parented to <body> but its button lives in
    // #session-head-actions, outside the rail. renderRail used to look for
    // that button only inside the rail, miss it, and closeRailMenu() on every
    // repos / repoSessions / pinnedSessions frame — so Export as Markdown
    // vanished every few seconds while projects were still loading.
    const { window, doc } = boot();
    dispatch(window, {
      type: "sessionName",
      sessionId: "s-alpha-1",
      name: "Alpha one",
      cwd: "/work/alpha",
    });
    const btn = doc.querySelector("#session-head-actions .rail-menu-btn") as HTMLButtonElement | null;
    expect(btn, "session-head ⋯").toBeTruthy();
    click(window, btn!);
    const open = doc.querySelector(".rail-menu");
    expect(open?.textContent).toContain("Export as Markdown");

    dispatch(window, { type: "repoSessions", cwd: "/work/beta", entries: [row("s-beta-1", "/work/beta", "Beta")], dots: {}, total: 1 });
    dispatch(window, { type: "pinnedSessions", entries: [], dots: {} });
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });

    const still = doc.querySelector(".rail-menu");
    expect(still, "menu must survive catalog frames").toBeTruthy();
    expect(still).toBe(open);
    expect(still!.textContent).toContain("Export as Markdown");
  });

  it("keys the menu to what it acts on, not to the element", () => {
    // A key derived from the project/conversation survives a re-render; an
    // incrementing counter on a recreated node does not.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    expect(src).toContain('"session-head"');
    expect(src).toContain('"session:"');
    expect(src).toContain('"repo:"');
  });

  it("caps rail popover max-width at 280px and never past the viewport", () => {
    const h = boot();
    const host = h.doc.querySelector(".rail-repo") as HTMLElement;
    expect(host).toBeTruthy();

    h.window.innerWidth = 1200;
    const wide = openMenu(h.window, host);
    expect(parseInt(wide.style.maxWidth, 10)).toBe(280);

    h.window.innerWidth = 150;
    const narrow = openMenu(h.window, h.doc.querySelector(".rail-repo") as HTMLElement);
    expect(parseInt(narrow.style.maxWidth, 10)).toBe(134);
  });
  // --- new session must never be unreachable -------------------------------

  it("keeps New session clickable in every project while a switch is in flight", () => {
    // The lock was released only by the frames a session START produces — a
    // replay, setBusy, or an error. Selecting a project stopped opening a
    // conversation, so on that path none of them arrive, and every "+" in the
    // rail stayed disabled in every project. Starting a conversation is the one
    // thing that must always be available.
    const { doc, window, posted } = boot();
    const plus = (name: string) =>
      doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(name)]
        .querySelector(".rail-action-btn") as HTMLButtonElement;

    click(window, plus("beta")); // switch in flight, nothing released it
    expect(posted.filter((p) => p.type === "selectRepo")).toHaveLength(1);

    // Force a rail re-render while the lock is still held — that is when the
    // buttons are recomputed, and the reason the symptom appears only after
    // some unrelated frame arrives rather than on the click itself. (Verified
    // by re-gating the button on the lock: without this the mutation survives.)
    dispatch(window, { type: "repoSessions", cwd: "/work/gamma", entries: [], dots: {}, total: 0 });

    expect(plus("alpha").disabled).toBe(false);
    expect(plus("gamma").disabled).toBe(false);
    // A second click supersedes the first rather than being swallowed.
    click(window, plus("gamma"));
    expect(posted.filter((p) => p.type === "selectRepo").map((p: any) => p.cwd))
      .toEqual(["/work/beta", "/work/gamma"]);

    // A folder the host cannot reach is still refused — that one is real.
    expect(plus("offline").disabled).toBe(true);
  });

  it("releases the switch lock when the catalog confirms the selection", () => {
    // Without this the repo chip and popover stay locked forever on a selection
    // that opens no conversation.
    const { doc, window } = boot();
    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    click(window, beta.querySelector(".rail-action-btn") as HTMLElement);

    // The lock is observable through the repo chip, which disables while a
    // switch is in flight.
    const chip = () => doc.getElementById("repo-btn") as HTMLButtonElement;
    expect(chip().disabled).toBe(true);

    // A catalog for some OTHER selection must not unlock a transition in flight.
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/gamma", activeCwd: "/work/gamma" });
    expect(chip().disabled).toBe(true);

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });
    expect(chip().disabled).toBe(false);
  });

  it("offers Hide project only where the host can close folders", async () => {
    // Desktop's rail IS the open-folder set, so putting a project away means
    // closing it.
    //
    // It gates on its OWN capability since 4.1.2, not on the "+" that adds
    // projects. Those agreed only while "+" meant the native picker, which no
    // remote has; once create and clone shipped as remote-capable ways in, the
    // shared gate started answering true on a phone and Hide came with it —
    // drawn, posted, and dropped by remote-policy without a word.
    const h = bootWebview({ beforeScripts: withRail });
    dispatch(h.window, {
      type: "initialState",
      effort: "medium", cwd: "/work/alpha", useCtrlEnter: false, extVersion: "0",
      showThinking: true, expandCommandOutputs: false, steerByDefault: false,
      soundNotifications: false, processingSound: false, readRepliesAloud: false,
      capabilities: {
        uploadFile: true, remoteVoice: false,
        addProjectFolder: true, removeProjectFolder: true,
      },
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });

    const beta = h.doc.querySelectorAll(".rail-repo")[repoNames(h.doc).indexOf("beta")];
    const hide = menuItem(openMenu(h.window, beta), "Hide project");
    expect(hide).toBeTruthy();
    click(h.window, hide as HTMLElement);
    // It ASKS now, like the VS Code rail always has. Nothing is posted on the
    // click alone — the row leaves every linked device at once, and one
    // surface guarding that gesture while the other did not was the drift.
    expect(h.posted.filter((p) => p.type === "removeProjectFolder")).toEqual([]);
    click(h.window, h.doc.querySelector(".confirm-btn.confirm-primary") as HTMLElement);
    await Promise.resolve();
    expect(h.posted.filter((p) => p.type === "removeProjectFolder"))
      .toEqual([{ type: "removeProjectFolder", cwd: "/work/beta" }]);

    // The browser client never grows it, whatever the rest of the frame says.
    const r = boot();
    const rBeta = r.doc.querySelectorAll(".rail-repo")[repoNames(r.doc).indexOf("beta")];
    expect(menuItem(openMenu(r.window, rBeta), "Hide project")).toBeFalsy();
  });
  it("starts the new session in the project whose + was clicked", () => {
    // "+" on a project the host is not in means switch, THEN start — `newSession`
    // names no repo, so it has to wait for the switch to land. The desktop had
    // only the first half: it switched and left whatever conversation was open
    // on screen, which with an empty session already around looks like nothing
    // happened, and otherwise like it started one in the wrong project.
    //
    // (The harness has no relay page, so the intent flag survives the post the
    // way it does on the desktop. In a real browser the page consumes it as it
    // forwards the selectRepo, which is what stops this firing twice there.)
    const { doc, window, posted } = boot();
    const plus = (name: string) =>
      doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(name)]
        .querySelector(".rail-action-btn") as HTMLButtonElement;

    click(window, plus("gamma"));
    expect(posted.filter((p) => p.type === "newSession")).toEqual([]); // not yet

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/gamma", activeCwd: "/work/gamma" });
    expect(posted.filter((p) => p.type === "newSession")).toHaveLength(1);

    // Single-shot: a later catalog push for the same repo must not start another.
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/gamma", activeCwd: "/work/gamma" });
    expect(posted.filter((p) => p.type === "newSession")).toHaveLength(1);
  });

  it("drops the new-session intent when a different project supersedes it", () => {
    const { doc, window, posted } = boot();
    const repoAt = (name: string) => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(name)];

    click(window, repoAt("gamma").querySelector(".rail-action-btn") as HTMLElement);
    // Then just BROWSE to another project — no "+" this time.
    click(window, repoAt("beta").querySelector(".rail-repo-label") as HTMLElement);
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });

    expect(posted.filter((p) => p.type === "newSession")).toEqual([]);
  });
});

// The project header used to ALSO switch into an unselected project, forcing
// the section open and returning early. Two problems: it selected a repo
// without opening anything in it (chat still on the old conversation while the
// rail claimed another project — the state the chip explains as "Browsing X;
// live session is in Y"), and clicking an already-expanded unselected project
// did nothing visible, which is why closing one "sometimes" needed two clicks.
describe("project header is a fold control, not a repo switch", () => {
  const headFor = (doc: Document, name: string) =>
    doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(name)]
      .querySelector(".rail-repo-head") as HTMLElement;
  const sessionCount = (doc: Document, name: string) =>
    doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(name)]
      .querySelectorAll(".rail-session").length;

  it("collapses an expanded unselected project on the FIRST click", () => {
    const { doc, window, posted } = boot("/work/alpha");
    // Give beta (not the selected project) some rows, so it renders expanded.
    dispatch(window, {
      type: "repoSessions",
      cwd: "/work/beta",
      entries: [row("b1", "/work/beta", "beta one", 5)],
      dots: {},
      total: 1,
    });
    expect(sessionCount(doc, "beta")).toBe(1);

    click(window, headFor(doc, "beta"));

    // One click, actually folded — and no repo switch rode along with it.
    expect(sessionCount(doc, "beta")).toBe(0);
    expect(posted.filter((p) => p.type === "selectRepo")).toEqual([]);

    // ...and it reopens, still without switching.
    click(window, headFor(doc, "beta"));
    expect(sessionCount(doc, "beta")).toBe(1);
    expect(posted.filter((p) => p.type === "selectRepo")).toEqual([]);
  });
});
