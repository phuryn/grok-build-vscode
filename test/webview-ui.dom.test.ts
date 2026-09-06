// DOM-level regression tests for the webview UI bugs that the native-Windows
// smoke test surfaced and this build fixed (see CLAUDE.md § Status). Each one
// drives the REAL media/chat.js and asserts the fixed behavior, so the bug can't
// silently come back:
//
//   1. History popover that "never closed"  -> open/close toggle + outside-click close
//   2. Session rows "only clickable on the label" -> whole row resumes; action
//      buttons stopPropagation so they don't also resume
//   3. Reasoning traces "no longer expandable" -> header click toggles the body
import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch, click, Posted } from "./webview-harness";
import { countsAsUserBubble } from "../src/plan-restore";
import { bracketRemoteSnapshot } from "../src/remote-policy";
import type { HostMsg } from "../src/protocol";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
function openSettingsOverlay(window: Window, doc: Document) {
  click(window, $(doc, "gear-btn"));
  const item = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
    .find((el) => /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()));
  click(window, item!);
}
function clickSettingsNav(window: Window, doc: Document, title: string) {
  const item = [...doc.querySelectorAll("#settings-overlay .settings-nav-item")]
    .find((el) => (el.textContent || "").trim() === title);
  click(window, item!);
}
const types = (posted: Posted[]) => posted.map((p) => p.type);
// Mirrors chat.js's formatTime EXACTLY. That function is not locale-aware — it
// always emits `h:mm AM/PM` — so building the expectation with
// toLocaleTimeString made this assertion pass only in 12-hour locales and fail
// with "8:14 AM" vs "8:14" wherever the runtime resolves to a 24-hour one.
// Deriving from local time (getHours) is deliberate: it keeps the test
// timezone-independent, which a literal expected string would not be.
const clock = (timestampMs: number) => {
  const d = new Date(timestampMs);
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
};

describe("focused conversation name chip", () => {
  const row = (id: string, name: string, cwd = "/work/repo") => ({
    id, cwd, displayName: name, rawSummary: "", updatedAt: Date.now(), createdAt: 1, numMessages: 2,
  });

  it("shows the host-provided full name, edits in place, and commits with Enter", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessions", entries: [row("s1", "A very long conversation title")], activeId: "s1", dots: {} });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "A very long conversation title", cwd: "/work/repo" });

    const chip = doc.getElementById("session-name-chip") as HTMLElement;
    const label = doc.getElementById("session-name-label") as HTMLElement;
    expect(chip.hidden).toBe(false);
    expect(label.textContent).toBe("A very long conversation title");
    expect(label.title).toBe("A very long conversation title");

    click(window, doc.getElementById("session-name-edit")!);
    const input = doc.getElementById("session-name-label") as HTMLInputElement;
    expect(input.value).toBe("A very long conversation title");
    input.value = "Renamed from the header";
    input.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(posted.filter((message) => message.type === "renameSession")).toEqual([
      { type: "renameSession", id: "s1", name: "Renamed from the header", cwd: "/work/repo" },
    ]);
  });

  it("cancels an unchanged edit and an Escape, but clearing the field drops the custom name", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessions", entries: [row("s1", "Keep this")], activeId: "s1", dots: {} });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Keep this", cwd: "/work/repo" });
    const label = () => doc.getElementById("session-name-label")!;

    click(window, label());
    (label() as HTMLInputElement).dispatchEvent(new (window as any).FocusEvent("blur", { bubbles: true }));
    click(window, label());
    (label() as HTMLInputElement).value = "discard me";
    label().dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(posted.filter((message) => message.type === "renameSession")).toEqual([]);
    expect((label() as HTMLElement).textContent).toBe("Keep this");

    // Emptying the field is the only route back to the title grok generated, so
    // it is a rename to nothing rather than a no-op. Escape, above, is the cancel.
    click(window, label());
    (label() as HTMLInputElement).value = "   ";
    (label() as HTMLInputElement).dispatchEvent(new (window as any).FocusEvent("blur", { bubbles: true }));
    expect(posted.filter((message) => message.type === "renameSession")).toEqual([
      { type: "renameSession", id: "s1", name: "", cwd: "/work/repo" },
    ]);
  });

  it("adds the remote affordance only after sessionName arrives, and carries cwd", () => {
    const { window, doc, posted } = bootWebview({ remote: true });
    dispatch(window, { type: "sessions", entries: [row("s1", "Remote title", "/work/remote")], activeId: "s1", dots: {} });
    expect(doc.getElementById("session-head-title")!.textContent).toBe("Remote title");
    expect(doc.getElementById("session-head-edit")).toBeNull();

    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Remote title", cwd: "/work/remote" });
    expect(doc.getElementById("session-head-title")!.getAttribute("title")).toBe("Remote title");
    expect(doc.getElementById("session-head-edit")).not.toBeNull();
    click(window, doc.getElementById("session-head-title")!);
    const input = doc.getElementById("session-head-title") as HTMLInputElement;
    input.value = "Remote renamed";
    input.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(posted.filter((message) => message.type === "renameSession")).toEqual([
      { type: "renameSession", id: "s1", name: "Remote renamed", cwd: "/work/remote" },
    ]);
  });

  it("paints a header rename on the history row before any host frame", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessions", entries: [row("s1", "Keep this")], activeId: "s1", dots: {} });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Keep this", cwd: "/work/repo" });
    click(window, doc.getElementById("history-btn")!);
    click(window, doc.getElementById("session-name-edit")!);
    const input = doc.getElementById("session-name-label") as HTMLInputElement;
    input.value = "Painted now";
    input.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(doc.getElementById("session-name-label")!.textContent).toBe("Painted now");
    expect(doc.querySelector(".history-row-name")!.textContent).toBe("Painted now");

    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Painted now", cwd: "/work/repo" });
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Painted now");
    expect(doc.querySelector(".history-row-name")!.textContent).toBe("Painted now");

    dispatch(window, {
      type: "sessions",
      entries: [row("s1", "Painted now")],
      activeId: "s1",
      dots: {},
    });
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Painted now");
    expect(doc.querySelector(".history-row-name")!.textContent).toBe("Painted now");
  });

  it("paints a history-row rename on the header before any host frame", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessions", entries: [row("s1", "Keep this")], activeId: "s1", dots: {} });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Keep this", cwd: "/work/repo" });
    click(window, doc.getElementById("history-btn")!);
    click(window, doc.querySelector(".history-row .history-action-btn") as HTMLElement);
    const inp = doc.querySelector(".history-rename") as HTMLInputElement;
    inp.value = "From history";
    inp.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(doc.getElementById("session-name-label")!.textContent).toBe("From history");
    expect(doc.querySelector(".history-row-name")!.textContent).toBe("From history");

    // Contradict while the overlay is still live — a catalog that names this
    // id is the authority, including a refusal that sends the old title back.
    dispatch(window, {
      type: "sessions",
      entries: [row("s1", "Catalog override")],
      activeId: "s1",
      dots: {},
    });
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Catalog override");
    expect(doc.querySelector(".history-row-name")!.textContent).toBe("Catalog override");
  });

  it("stays quiet against an older host that never sends the name frame", () => {
    const local = bootWebview();
    dispatch(local.window, { type: "sessions", entries: [row("s1", "Legacy title")], activeId: "s1", dots: {} });
    expect((local.doc.getElementById("session-name-chip") as HTMLElement).hidden).toBe(true);

    const remote = bootWebview({ remote: true });
    dispatch(remote.window, { type: "sessions", entries: [row("s1", "Legacy title")], activeId: "s1", dots: {} });
    expect(remote.doc.getElementById("session-head-title")!.getAttribute("title")).toBe("Legacy title");
    expect(remote.doc.getElementById("session-head-edit")).toBeNull();
    expect(remote.posted.filter((message) => message.type === "renameSession")).toEqual([]);
  });
});

describe("history popover (regression: popover that never closed)", () => {
  it("opens on the history button and requests the session list", () => {
    const { window, posted, doc } = bootWebview();
    const pop = $(doc, "history-popover");
    expect((pop as any).hidden).toBe(true);

    click(window, $(doc, "history-btn"));

    expect((pop as any).hidden).toBe(false);
    expect(types(posted)).toContain("listSessions");
  });

  it("toggles closed when the history button is clicked again", () => {
    const { window, doc } = bootWebview();
    const pop = $(doc, "history-popover");
    click(window, $(doc, "history-btn"));
    expect((pop as any).hidden).toBe(false);

    click(window, $(doc, "history-btn"));
    expect((pop as any).hidden).toBe(true);
  });

  it("closes on an outside click but stays open on a click inside it", () => {
    const { window, doc } = bootWebview();
    const pop = $(doc, "history-popover");

    click(window, $(doc, "history-btn"));
    expect((pop as any).hidden).toBe(false);

    // click inside the popover -> stopPropagation keeps it open
    click(window, pop);
    expect((pop as any).hidden).toBe(false);

    // click elsewhere in the document -> closePopovers()
    click(window, $(doc, "messages"));
    expect((pop as any).hidden).toBe(true);
  });

  it("right-anchors the popover so async row loading can't crop it off the right edge", () => {
    // Regression: the session rows stream in after the popover is positioned, widening it
    // from min-width toward max-width. The old left-anchor + one-shot width clamp measured
    // the width BEFORE those rows arrived, so the popover later spilled off the right edge
    // (and only looked right on reopen). Right-anchoring is width-independent.
    const { window, doc } = bootWebview();
    const pop = $(doc, "history-popover");
    const btn = $(doc, "history-btn");
    const parent = pop.parentElement as HTMLElement;
    (parent as any).getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 600, width: 400, height: 600 });
    (btn as any).getBoundingClientRect = () =>
      ({ left: 360, right: 392, top: 8, bottom: 30, width: 32, height: 22 });

    click(window, btn);

    expect(pop.style.left).toBe("auto");
    expect(pop.style.right).toBe("6px"); // gap from the panel's right edge, not under the button
    expect(pop.style.top).toBe("34px"); // btnRect.bottom(30) - parentRect.top(0) + 4
    expect(pop.style.maxWidth).toBe("360px"); // wide panel: full max width
  });

  it("caps the popover width to a narrow panel so names ellipsize instead of overflowing left", () => {
    const { window, doc } = bootWebview();
    const pop = $(doc, "history-popover");
    const btn = $(doc, "history-btn");
    const parent = pop.parentElement as HTMLElement;
    // A 240px panel can't fit the 280px CSS min-width — without the inline cap the popover
    // would overflow the left edge. available = 240 - 6*2 = 228.
    (parent as any).getBoundingClientRect = () =>
      ({ left: 0, right: 240, top: 0, bottom: 600, width: 240, height: 600 });
    (btn as any).getBoundingClientRect = () =>
      ({ left: 200, right: 232, top: 8, bottom: 30, width: 32, height: 22 });

    click(window, btn);

    expect(pop.style.maxWidth).toBe("228px");
    expect(pop.style.minWidth).toBe("228px"); // min(280, 228) — shrinks below the CSS floor
    expect(pop.style.right).toBe("6px");
  });

  it("re-measures the open popover when the panel is resized (no close+reopen needed)", () => {
    const { window, doc } = bootWebview();
    const pop = $(doc, "history-popover");
    const btn = $(doc, "history-btn");
    const parent = pop.parentElement as HTMLElement;
    (btn as any).getBoundingClientRect = () =>
      ({ left: 360, right: 392, top: 8, bottom: 30, width: 32, height: 22 });
    (parent as any).getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 600, width: 400, height: 600 });

    click(window, btn);
    expect(pop.style.maxWidth).toBe("360px");

    // Panel shrinks to 240px while the popover is still open -> it should re-fit live.
    (parent as any).getBoundingClientRect = () =>
      ({ left: 0, right: 240, top: 0, bottom: 600, width: 240, height: 600 });
    window.dispatchEvent(new (window as any).Event("resize"));

    expect(pop.style.maxWidth).toBe("228px"); // 240 - 6*2, re-measured without reopening
  });

  it("places the history popover in layout px when chat zoom is not 1", () => {
    // getBoundingClientRect is visual; style.top under body zoom is layout.
    // At 1.5×, a 30px visual bottom edge is 20 layout px — without unzoom the
    // popover opens too far below the button (and above when zoomed out).
    const { window, doc } = bootWebview();
    doc.body.style.setProperty("--chat-zoom", "1.5");
    const pop = $(doc, "history-popover");
    const btn = $(doc, "history-btn");
    const parent = pop.parentElement as HTMLElement;
    (parent as any).getBoundingClientRect = () =>
      ({ left: 0, right: 600, top: 0, bottom: 900, width: 600, height: 900 });
    (btn as any).getBoundingClientRect = () =>
      ({ left: 540, right: 588, top: 12, bottom: 45, width: 48, height: 33 });

    click(window, btn);

    // (45 - 0) / 1.5 + 4 = 34
    expect(pop.style.top).toBe("34px");
    // available layout width = 600/1.5 - 12 = 388 → max 360
    expect(pop.style.maxWidth).toBe("360px");
  });

  it("closes the popover when the view is hidden (switching to another extension/tab)", () => {
    const { window, doc } = bootWebview();
    const pop = $(doc, "history-popover");
    click(window, $(doc, "history-btn"));
    expect((pop as any).hidden).toBe(false);

    Object.defineProperty(doc, "hidden", { configurable: true, get: () => true });
    doc.dispatchEvent(new (window as any).Event("visibilitychange"));

    expect((pop as any).hidden).toBe(true);
  });
});

describe("session rows (regression: only the label was clickable)", () => {
  const entries = [
    { id: "s1", displayName: "Add subtract fn", numMessages: 4, updatedAt: Date.now() - 60000 },
    { id: "s2", displayName: "Refactor parser", numMessages: 9, updatedAt: Date.now() - 3600000 },
  ];

  function openWithSessions(remote = false) {
    const h = bootWebview({ remote });
    dispatch(h.window, {
      type: "repos",
      entries: [{ cwd: "/work/project", label: "project", available: true, pinned: false, updatedAt: 0 }],
      selectedCwd: "/work/project",
      activeCwd: "/work/project",
    });
    click(h.window, $(h.doc, "history-btn")); // open the popover so the list renders
    h.posted.length = 0; // forget the listSessions request; keep only row interactions
    dispatch(h.window, { type: "sessions", entries, activeId: null });
    return h;
  }

  it("renders one row per session with name + meta", () => {
    const { doc } = openWithSessions();
    const rows = doc.querySelectorAll(".history-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".history-row-name")!.textContent).toBe("Add subtract fn");
    expect(rows[0].querySelector(".history-row-meta")!.textContent).toContain("4 msg");
  });

  it("keeps a legacy remote dot-only, then shows provider glyphs for two connected agents", () => {
    const h = openWithSessions(true);
    expect(h.doc.querySelectorAll(".history-row .provider-glyph")).toHaveLength(0);
    expect(h.doc.querySelectorAll(".history-row > .history-row-dot")).toHaveLength(2);
    expect(h.doc.querySelectorAll(".history-row .provider-status-badge")).toHaveLength(0);

    dispatch(h.window, {
      type: "sessions",
      entries: [
        { ...entries[0], provider: "grok" },
        { ...entries[1], provider: "codex" },
      ],
      activeId: null,
      dots: { s1: "working", s2: "error" },
    });
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: false },
      ],
    });
    expect(h.doc.querySelectorAll(".history-row .provider-glyph")).toHaveLength(0);
    expect(h.doc.querySelectorAll(".history-row > .history-row-dot")).toHaveLength(2);

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true },
      ],
    });
    const glyphs = [...h.doc.querySelectorAll(".history-row .provider-glyph")];
    expect(glyphs).toHaveLength(2);
    expect(glyphs.map((el) => el.querySelector("svg.provider-logo path")?.getAttribute("d")?.length > 100))
      .toEqual([true, true]);
    expect(h.doc.querySelectorAll(".history-row > .history-row-dot")).toHaveLength(0);
    const badges = [...h.doc.querySelectorAll(".history-row .provider-status-badge")];
    expect(badges.map((el) => el.className)).toEqual([
      "provider-status-badge dot-working",
      "provider-status-badge dot-error",
    ]);
    dispatch(h.window, { type: "sessionDot", id: "s1", dot: "unread" });
    expect(h.doc.querySelector('[data-session-dot="s1"]')!.className).toBe("provider-status-badge dot-unread");

    dispatch(h.window, { type: "sessionDot", id: "s1", dot: "none" });
    dispatch(h.window, { type: "sessionDot", id: "s2", dot: "none" });
    expect([...h.doc.querySelectorAll(".history-row .provider-status-badge")].every((el) =>
      el.classList.contains("dot-none"),
    )).toBe(true);
  });

  it("resumes the session when the row's META area (not the label) is clicked", () => {
    const { window, posted, doc } = openWithSessions();
    const meta = doc.querySelector(".history-row .history-row-meta") as HTMLElement;
    click(window, meta); // a non-label part of the row

    expect(posted).toContainEqual({ type: "resumeSession", id: "s1", cwd: undefined, claim: true });
  });

  it("delete button opens the in-page confirm; confirming posts deleteSession, no resume", async () => {
    const { window, posted, doc } = openWithSessions();
    const delBtn = doc.querySelector(".history-row .history-action-danger") as HTMLElement;
    click(window, delBtn);

    // No post yet — the uiConfirm dialog (not a native host modal) intervenes.
    expect(types(posted)).not.toContain("deleteSession");
    const okBtn = doc.querySelector(".confirm-overlay .confirm-danger") as HTMLElement;
    expect(okBtn).not.toBeNull();
    click(window, okBtn);
    await Promise.resolve(); // let the uiConfirm promise chain post

    expect(posted).toContainEqual({ type: "deleteSession", id: "s1", name: "Add subtract fn" });
    expect(types(posted)).not.toContain("resumeSession");
    expect(doc.querySelector(".confirm-overlay")).toBeNull(); // dialog closed itself
  });

  it("cancelling the delete confirm posts nothing", async () => {
    const { window, posted, doc } = openWithSessions();
    click(window, doc.querySelector(".history-row .history-action-danger") as HTMLElement);
    const cancelBtn = doc.querySelector(".confirm-overlay .confirm-btn:not(.confirm-danger)") as HTMLElement;
    click(window, cancelBtn);
    await Promise.resolve();

    expect(types(posted)).not.toContain("deleteSession");
    expect(doc.querySelector(".confirm-overlay")).toBeNull();
  });

  // The active row used to carry no delete button at all, and for a real reason:
  // the live CLI owns the conversation and re-persisted it the moment the files
  // went, so the delete genuinely did not stick. The host disposes that process
  // BEFORE touching the disk now, then starts a fresh conversation in the same
  // project — so the control does something, and it is offered.
  it("offers delete on the active session, warning that it is the open one", async () => {
    const h = bootWebview();
    // The host says what it can do; every real snapshot carries this.
    dispatch(h.window, {
      type: "initialState", useCtrlEnter: false,
      capabilities: { uploadFile: true, remoteVoice: true, deleteActiveSession: true },
    });
    click(h.window, $(h.doc, "history-btn"));
    h.posted.length = 0;
    dispatch(h.window, { type: "sessions", entries, activeId: "s1" });
    const rows = h.doc.querySelectorAll(".history-row");
    expect(rows[0].querySelector(".history-action-danger")).not.toBeNull();
    expect(rows[1].querySelector(".history-action-danger")).not.toBeNull();
    expect(rows[0].querySelector(".history-action-btn")).not.toBeNull();

    // Deleting what is on your screen is a bigger act than deleting a cold row,
    // so the dialog says what happens rather than only "cannot be undone".
    click(h.window, rows[0].querySelector(".history-action-danger") as HTMLElement);
    const body = h.doc.querySelector(".confirm-overlay")?.textContent || "";
    expect(body).toContain("conversation you have open");
    expect(body).toContain("a new one will start");

    click(h.window, h.doc.querySelector(".confirm-overlay .confirm-danger") as HTMLElement);
    await Promise.resolve();
    expect(h.posted.filter((p: any) => p.type === "deleteSession").map((p: any) => p.id)).toEqual(["s1"]);
  });

  // The web client is always as new as the deploy; the extension is whatever the
  // user happens to have installed. An older host still refuses to delete a live
  // conversation, so offering the control there hands back a refusal — the exact
  // "renders a control the host can't answer" the compatibility contract forbids.
  it("withholds delete on the active session from a host that cannot do it", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "initialState", useCtrlEnter: false,
      capabilities: { uploadFile: true, remoteVoice: true },
    });
    click(h.window, $(h.doc, "history-btn"));
    dispatch(h.window, { type: "sessions", entries, activeId: "s1" });
    const rows = h.doc.querySelectorAll(".history-row");
    expect(rows[0].querySelector(".history-action-danger")).toBeNull();
    // Every other row is unaffected — cold history was always deletable.
    expect(rows[1].querySelector(".history-action-danger")).not.toBeNull();
  });

  it("rename button enters rename mode and does NOT resume", () => {
    const { window, posted, doc } = openWithSessions();
    const renameBtn = doc.querySelectorAll(".history-row .history-action-btn")[0] as HTMLElement;
    click(window, renameBtn);

    expect(doc.querySelector(".history-row input.history-rename")).not.toBeNull();
    expect(types(posted)).not.toContain("resumeSession");
  });

  it("opening a history row paints the title and hides the old transcript before any host frame", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "sessions",
      entries,
      activeId: "s1",
      dots: {},
    });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Add subtract fn", cwd: "/work/project" });
    dispatch(window, { type: "userMessage", text: "old transcript" });
    expect(doc.querySelector(".msg.user")?.textContent).toContain("old transcript");
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Add subtract fn");

    click(window, doc.getElementById("history-btn")!);
    posted.length = 0;
    const rows = doc.querySelectorAll(".history-row");
    click(window, rows[1] as HTMLElement);

    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      { type: "resumeSession", id: "s2", cwd: undefined, claim: true },
    ]);
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Refactor parser");
    expect((doc.querySelector(".msg.user") as HTMLElement).hidden).toBe(true);
    expect(doc.getElementById("welcome")!.hidden).toBe(false);
    const ver = doc.getElementById("welcome-version") as HTMLElement;
    expect(ver.dataset.status).toBe("Loading conversation");

    dispatch(window, { type: "clearMessages" });
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Refactor parser");

    dispatch(window, { type: "sessionName", sessionId: "s2", name: "Refactor parser", cwd: "/work/project" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessage", text: "new transcript" });
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Refactor parser");
    expect(doc.querySelector(".msg.user")?.textContent).toContain("new transcript");
    expect((doc.querySelector(".msg.user") as HTMLElement).hidden).toBe(false);
  });

  it("a failed history open restores the previous title and transcript", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessions", entries, activeId: "s1", dots: {} });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Add subtract fn", cwd: "/work/project" });
    dispatch(window, { type: "userMessage", text: "old transcript" });

    click(window, doc.getElementById("history-btn")!);
    click(window, doc.querySelectorAll(".history-row")[1] as HTMLElement);
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Refactor parser");
    expect((doc.querySelector(".msg.user") as HTMLElement).hidden).toBe(true);

    dispatch(window, { type: "error", text: "Session is owned by another client.", resumeFailed: { id: "s2" } });
    expect(doc.getElementById("session-name-label")!.textContent).toBe("Add subtract fn");
    expect((doc.querySelector(".msg.user") as HTMLElement).hidden).toBe(false);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("old transcript");
  });

  it("shows a Clear all footer that confirms in-page, then posts clearAllSessions", async () => {
    const { window, posted, doc } = openWithSessions();
    const clearBtn = doc.querySelector(".history-clear-all") as HTMLElement;
    expect(clearBtn).not.toBeNull();
    click(window, clearBtn);

    // The popover closes before the dialog shows; nothing posts until confirmed.
    expect(($(doc, "history-popover") as any).hidden).toBe(true);
    expect(types(posted)).not.toContain("clearAllSessions");
    const okBtn = doc.querySelector(".confirm-overlay .confirm-danger") as HTMLElement;
    expect(okBtn).not.toBeNull();
    expect(doc.querySelector(".confirm-title")?.textContent).toContain("project");
    expect(doc.querySelector(".confirm-body")?.textContent).toContain("/work/project");
    click(window, okBtn);
    await Promise.resolve();

    expect(posted).toContainEqual({ type: "clearAllSessions", cwd: "/work/project" });
  });

  it("hides the Clear all footer when the only session is the active one", () => {
    const h = bootWebview();
    click(h.window, $(h.doc, "history-btn"));
    dispatch(h.window, {
      type: "sessions",
      entries: [entries[0]],
      activeId: entries[0].id,
      total: 1,
    });
    expect((h.doc.querySelector(".history-footer") as any).hidden).toBe(true);
  });

  it("hides the Clear all footer when there are no sessions", () => {
    const h = bootWebview();
    click(h.window, $(h.doc, "history-btn"));
    dispatch(h.window, { type: "sessions", entries: [], activeId: null, total: 0 });
    expect((h.doc.querySelector(".history-footer") as any).hidden).toBe(true);
  });
});

describe("worktree session rows (#65 — branch icon, rename disabled)", () => {
  function open(entries: any[]) {
    const h = bootWebview();
    click(h.window, $(h.doc, "history-btn"));
    h.posted.length = 0;
    dispatch(h.window, { type: "sessions", entries, activeId: null });
    return h;
  }

  it("marks a worktree row with a branch icon (not a WT text badge), strips the (WT) prefix, and disables Rename", () => {
    const { doc } = open([
      { id: "w1", displayName: "(WT) feat-payments", worktreeLabel: "feat-payments", numMessages: 3, updatedAt: Date.now() },
      { id: "s1", displayName: "Normal session", numMessages: 5, updatedAt: Date.now() - 1000 },
    ]);
    const rows = doc.querySelectorAll(".history-row");
    const wtRow = rows[0];
    expect(wtRow.querySelector(".history-row-branch")).not.toBeNull(); // branch icon
    expect(wtRow.querySelector(".history-row-wt")).toBeNull();          // legacy text badge gone
    expect(wtRow.querySelector(".history-row-txt")!.textContent).toBe("feat-payments"); // (WT) stripped
    expect((wtRow.querySelector(".history-action-btn") as HTMLButtonElement).disabled).toBe(true); // rename off

    const normalRow = rows[1];
    expect(normalRow.querySelector(".history-row-branch")).toBeNull();
    expect((normalRow.querySelector(".history-action-btn") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("session history pagination", () => {
  const page1 = [
    { id: "p0", displayName: "Session 0", numMessages: 1, updatedAt: Date.now() - 1000 },
    { id: "p1", displayName: "Session 1", numMessages: 1, updatedAt: Date.now() - 2000 },
    { id: "p2", displayName: "Session 2", numMessages: 1, updatedAt: Date.now() - 3000 },
  ];
  const page2 = [
    { id: "q0", displayName: "Older 0", numMessages: 1, updatedAt: Date.now() - 10000 },
    { id: "q1", displayName: "Older 1", numMessages: 1, updatedAt: Date.now() - 11000 },
  ];

  function openPopover() {
    const h = bootWebview();
    click(h.window, $(h.doc, "history-btn"));
    h.posted.length = 0; // forget the initial listSessions request
    return h;
  }

  it("shows a 'more' indicator while later pages remain", () => {
    const h = openPopover();
    dispatch(h.window, { type: "sessions", entries: page1, activeId: null, offset: 0, total: 5, hasMore: true });
    expect(h.doc.querySelector(".history-more")).not.toBeNull();
    expect(h.doc.querySelectorAll(".history-row")).toHaveLength(3);
  });

  it("appends the next page on a load-more (offset > 0) response", () => {
    const h = openPopover();
    dispatch(h.window, { type: "sessions", entries: page1, activeId: null, offset: 0, total: 5, hasMore: true });
    dispatch(h.window, { type: "sessions", entries: page2, activeId: null, offset: 3, total: 5, hasMore: false });
    expect(h.doc.querySelectorAll(".history-row")).toHaveLength(5);
    // The indicator disappears once the final page has arrived.
    expect(h.doc.querySelector(".history-more")).toBeNull();
  });

  it("replaces (not appends) on a fresh offset-0 response", () => {
    const h = openPopover();
    dispatch(h.window, { type: "sessions", entries: page1, activeId: null, offset: 0, total: 5, hasMore: true });
    dispatch(h.window, { type: "sessions", entries: page2, activeId: null, offset: 0, total: 2, hasMore: false });
    const rows = h.doc.querySelectorAll(".history-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".history-row-name")!.textContent).toBe("Older 0");
  });

  it("de-dupes when a load-more page overlaps the loaded list", () => {
    const h = openPopover();
    dispatch(h.window, { type: "sessions", entries: page1, activeId: null, offset: 0, total: 5, hasMore: true });
    const overlap = [{ ...page1[2] }, ...page2]; // p2 already loaded
    dispatch(h.window, { type: "sessions", entries: overlap, activeId: null, offset: 3, total: 5, hasMore: false });
    expect(h.doc.querySelectorAll(".history-row")).toHaveLength(5); // 3 + 2, the dup dropped
  });

  it("keeps the Clear all footer visible when later pages hold the only deletable sessions", () => {
    const h = openPopover();
    // Only the active session is loaded, but `total` says more exist on later pages.
    dispatch(h.window, {
      type: "sessions",
      entries: [{ id: "active", displayName: "Live", numMessages: 1, updatedAt: Date.now() }],
      activeId: "active",
      offset: 0,
      total: 40,
      hasMore: true,
    });
    expect((h.doc.querySelector(".history-footer") as any).hidden).toBe(false);
  });

  it("returns the Grok offset plus Codex high-water cursor on load-more", () => {
    const h = openPopover();
    dispatch(h.window, {
      type: "sessions",
      entries: [{ ...page1[0], provider: "codex" }],
      activeId: null,
      offset: 0,
      total: 103,
      hasMore: true,
      nextOffset: 101,
      providerCursor: { grokOffset: 100, codexHighWater: { updatedAt: 50, id: "codex-1" } },
    });
    const list = h.doc.querySelector(".history-list") as HTMLElement;
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(list, "scrollTop", { value: 700, configurable: true });
    list.dispatchEvent(new h.window.Event("scroll"));

    expect(h.posted).toContainEqual({
      type: "listSessions",
      offset: 101,
      query: "",
      providerCursor: { grokOffset: 100, codexHighWater: { updatedAt: 50, id: "codex-1" } },
    });
  });

  it("auto-loads hidden-only and underfilled pages without a scroll event", () => {
    const h = openPopover();
    dispatch(h.window, {
      type: "sessions",
      entries: [],
      activeId: null,
      offset: 0,
      total: 202,
      hasMore: true,
      nextOffset: 100,
      providerCursor: { grokOffset: 100 },
      query: "",
    });

    expect(h.doc.querySelector(".history-empty")).toBeNull();
    expect(h.doc.querySelector(".history-more")).not.toBeNull();
    expect(h.doc.body.textContent).not.toContain("No sessions yet");
    expect(h.posted).toContainEqual({
      type: "listSessions",
      offset: 100,
      query: "",
      providerCursor: { grokOffset: 100 },
    });

    dispatch(h.window, {
      type: "sessions",
      entries: [{ ...page2[0], provider: "codex" }],
      activeId: null,
      offset: 100,
      total: 202,
      hasMore: true,
      nextOffset: 200,
      providerCursor: { grokOffset: 200 },
      query: "",
    });

    expect(h.posted).toContainEqual({
      type: "listSessions",
      offset: 200,
      query: "",
      providerCursor: { grokOffset: 200 },
    });
    expect(h.doc.body.textContent).not.toContain("No sessions yet");

    dispatch(h.window, {
      type: "sessions",
      entries: [{ ...page2[1], provider: "grok" }],
      activeId: null,
      offset: 200,
      total: 202,
      hasMore: false,
      nextOffset: 202,
      query: "",
    });

    expect(h.doc.querySelectorAll(".history-row")).toHaveLength(2);
    expect(h.doc.querySelector(".history-more")).toBeNull();
  });
});

describe("session status dots (Agent Dashboard)", () => {
  const entries = [
    { id: "s1", displayName: "Working one", numMessages: 4, updatedAt: Date.now() },
    { id: "s2", displayName: "Resting one", numMessages: 2, updatedAt: Date.now() },
    { id: "s3", displayName: "Unread one", numMessages: 1, updatedAt: Date.now() },
  ];

  function openWithDots(dots: Record<string, string>, activeId: string | null = null) {
    const h = bootWebview();
    click(h.window, $(h.doc, "history-btn"));
    h.posted.length = 0;
    dispatch(h.window, { type: "sessions", entries, activeId, dots });
    return h;
  }

  const dotOf = (doc: Document, id: string) =>
    doc.querySelector(`[data-session-dot="${id}"]`) as HTMLElement;

  it("colors each row's dot from the dots map; rows with no entry render gray (dot-none)", () => {
    const { doc } = openWithDots({ s1: "working", s2: "unread" });
    expect(dotOf(doc, "s1").className).toContain("dot-working");
    expect(dotOf(doc, "s2").className).toContain("dot-unread");
    // s3 is absent from the map → at rest → gray default.
    expect(dotOf(doc, "s3").className).toContain("dot-none");
  });

  it("renders each dot value with its class (working/needs-you/unread/error)", () => {
    const { doc } = openWithDots({ s1: "needs-you", s2: "unread", s3: "error" });
    expect(dotOf(doc, "s1").className).toContain("dot-needs-you");
    expect(dotOf(doc, "s2").className).toContain("dot-unread");
    expect(dotOf(doc, "s3").className).toContain("dot-error");
  });

  it("patches a single dot incrementally on a sessionDot message (no re-render)", () => {
    const { window, doc } = openWithDots({ s1: "working", s2: "unread" });
    const before = dotOf(doc, "s1");
    dispatch(window, { type: "sessionDot", id: "s1", dot: "needs-you" });
    // Same element, mutated in place — not a fresh row.
    expect(dotOf(doc, "s1")).toBe(before);
    expect(dotOf(doc, "s1").className).toContain("dot-needs-you");
    // The other dot is untouched.
    expect(dotOf(doc, "s2").className).toContain("dot-unread");
  });

  it("drops a dot to gray when sessionDot clears it to none (opened / reaped+read)", () => {
    const { window, doc } = openWithDots({ s1: "unread" });
    dispatch(window, { type: "sessionDot", id: "s1", dot: "none" });
    expect(dotOf(doc, "s1").className).toContain("dot-none");
  });

  it("keeps a green unread dot when the session is reaped but still unopened", () => {
    // disposeSession recomputes the dot; an unread reaped session stays green.
    const { window, doc } = openWithDots({ s1: "working" });
    dispatch(window, { type: "sessionDot", id: "s1", dot: "unread" });
    expect(dotOf(doc, "s1").className).toContain("dot-unread");
  });

  it("keeps the dot's tooltip in sync with its state", () => {
    const { doc } = openWithDots({ s1: "working", s2: "unread", s3: "error" });
    expect(dotOf(doc, "s1").title).toBe("Working");
    expect(dotOf(doc, "s2").title).toBe("Finished while no view was watching");
    expect(dotOf(doc, "s3").title).toBe("Errored while no view was watching");
  });
});

describe("mode picker (the plan-gate entry path)", () => {
  it("names the active mode in the button tooltip", () => {
    const { window, doc } = bootWebview();
    const modeBtn = $(doc, "mode-btn") as HTMLButtonElement;
    expect(modeBtn.title).toContain("Agent mode");

    dispatch(window, { type: "modeChanged", modeId: "plan" });
    expect(modeBtn.title).toContain("Plan mode");
    expect(modeBtn.title).not.toContain("Agent mode");
  });

  it("offers Agent / Plan / Auto accept and posts setMode with the chosen mode id", () => {
    const { window, posted, doc } = bootWebview();
    const pop = $(doc, "mode-popover");

    click(window, $(doc, "mode-btn"));
    expect((pop as any).hidden).toBe(false);
    const labels = [...pop.querySelectorAll(".mode-item-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Agent mode", "Plan mode", "Auto accept"]);

    const planItem = [...pop.querySelectorAll(".mode-popover-item")]
      .find((el) => el.querySelector(".mode-item-label")!.textContent === "Plan mode") as HTMLElement;
    click(window, planItem);

    expect(posted).toContainEqual({ type: "setMode", modeId: "plan" });
    expect((pop as any).hidden).toBe(true); // selecting a mode closes the popover
  });

  it("does not offer Grok's plan gate in a Codex conversation", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "session",
      sessionId: "codex-1",
      provider: "codex",
      currentModelId: "gpt-5.6-sol",
      models: [{ modelId: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "codex" }],
    });

    click(window, $(doc, "mode-btn"));
    const labels = [...$(doc, "mode-popover").querySelectorAll(".mode-item-label")]
      .map((label) => label.textContent);
    expect(labels).toEqual(["Agent mode", "Auto accept"]);
  });

  it("disables only Plan with the host's version reason, then re-enables it", () => {
    const { window, posted, doc } = bootWebview();
    const reason = "Plan mode requires Grok CLI 0.2.117 or newer; installed version is 0.2.100.";
    dispatch(window, { type: "planModeAvailability", available: false, reason });

    const modeBtn = $(doc, "mode-btn") as HTMLButtonElement;
    expect(modeBtn.disabled).toBe(false);
    expect(modeBtn.title).toContain(reason);
    click(window, modeBtn);

    const pop = $(doc, "mode-popover");
    let planItem = [...pop.querySelectorAll(".mode-popover-item")]
      .find((el) => el.querySelector(".mode-item-label")!.textContent === "Plan mode") as HTMLElement;
    expect(planItem.className).toContain("disabled");
    expect(planItem.querySelector(".mode-item-disabled-note")?.textContent).toBe(reason);
    click(window, planItem);
    expect(posted).not.toContainEqual({ type: "setMode", modeId: "plan" });

    click(window, modeBtn); // close the still-open picker
    dispatch(window, { type: "planModeAvailability", available: true });
    click(window, modeBtn);
    planItem = [...pop.querySelectorAll(".mode-popover-item")]
      .find((el) => el.querySelector(".mode-item-label")!.textContent === "Plan mode") as HTMLElement;
    expect(planItem.className).not.toContain("disabled");
    expect(planItem.querySelector(".mode-item-disabled-note")).toBeNull();
    click(window, planItem);
    expect(posted).toContainEqual({ type: "setMode", modeId: "plan" });
  });

  it("keeps Plan clickable when the host marks an unverified probe recheckable (#105)", () => {
    const { window, posted, doc } = bootWebview();
    const reason =
      "Could not verify the installed Grok CLI version, so Plan mode is unavailable. " +
      "The version check failed or timed out — a first run after install can be slow. " +
      "Pick Plan again or reload the window to retry. " +
      "Once verified, Plan requires 0.2.117 or newer.";
    dispatch(window, {
      type: "planModeAvailability",
      available: false,
      reason,
      recheckable: true,
    });

    click(window, $(doc, "mode-btn"));
    const pop = $(doc, "mode-popover");
    const planItem = [...pop.querySelectorAll(".mode-popover-item")]
      .find((el) => el.querySelector(".mode-item-label")!.textContent === "Plan mode") as HTMLElement;
    expect(planItem.className).not.toContain("disabled");
    expect(planItem.querySelector(".mode-item-disabled-note")?.textContent).toBe(reason);
    click(window, planItem);
    // Click still posts setMode — the host re-probes and may enable Plan on this pick.
    expect(posted).toContainEqual({ type: "setMode", modeId: "plan" });
  });

  it("toggles the mode popover closed when the button is clicked again", () => {
    const { window, doc } = bootWebview();
    const pop = $(doc, "mode-popover");
    click(window, $(doc, "mode-btn"));
    expect((pop as any).hidden).toBe(false);
    click(window, $(doc, "mode-btn"));
    expect((pop as any).hidden).toBe(true);
  });

  // Regression: switching mode during session start called setMode before the
  // session existed → "Couldn't switch mode: no session". The button is disabled
  // only during the startup window (busyLocked); it stays live during a running
  // turn (#64), and busyLocked always clears so it can't get stuck.
  it("disables the mode button while starting (busyLocked) and won't open the picker or post setMode", () => {
    const { window, posted, doc } = bootWebview({ ready: false }); // startup: busy + locked
    const modeBtn = $(doc, "mode-btn") as HTMLButtonElement;
    expect(modeBtn.disabled).toBe(true);
    expect(modeBtn.className).toContain("disabled");

    click(window, modeBtn);
    expect(($(doc, "mode-popover") as any).hidden).toBe(true); // picker never opened
    expect(types(posted)).not.toContain("setMode");
  });

  it("enables the mode button once the session is ready", () => {
    const { window, doc } = bootWebview(); // ready → busy cleared
    const modeBtn = $(doc, "mode-btn") as HTMLButtonElement;
    expect(modeBtn.disabled).toBe(false);
    click(window, modeBtn);
    expect(($(doc, "mode-popover") as any).hidden).toBe(false); // opens normally
  });

  // #64: switching to Auto-accept mid-run is the whole point — a running turn
  // (busy, but NOT the locked startup window) must keep the picker usable.
  it("keeps the mode button live during a running turn so Auto-accept can be picked mid-run (#64)", () => {
    const { window, posted, doc } = bootWebview(); // ready
    dispatch(window, { type: "setBusy", value: true }); // a normal running turn (locked defaults false)
    const modeBtn = $(doc, "mode-btn") as HTMLButtonElement;
    expect(modeBtn.disabled).toBe(false);
    click(window, modeBtn);
    const pop = $(doc, "mode-popover");
    expect((pop as any).hidden).toBe(false); // picker opens mid-turn
    const yolo = [...pop.querySelectorAll(".mode-popover-item")]
      .find((el) => el.querySelector(".mode-item-label")!.textContent === "Auto accept") as HTMLElement;
    click(window, yolo);
    expect(posted).toContainEqual({ type: "setMode", modeId: "yolo" });
  });
});

describe("context donut (token usage)", () => {
  const boot = () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "session",
      sessionId: "s1",
      currentModelId: "grok-build",
      models: [{ modelId: "grok-build", name: "Grok Build", totalContextTokens: 100000 }],
    });
    return h;
  };

  it("updates on a real totalTokens; keeps the last value when the host stripped it", () => {
    const { window, doc } = boot();
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 32000 } });
    expect($(doc, "donut-label").textContent).toBe("32K/100K");
    // gateZeroTokenMeta strips totalTokens:0 host-side (#39 — /session-info AND
    // /compact report 0, never a real measurement), so the webview only ever
    // sees a real number or nothing. Nothing = keep the last real value.
    dispatch(window, { type: "promptComplete", meta: { totalTokens: undefined } });
    dispatch(window, { type: "promptComplete", meta: {} });
    dispatch(window, { type: "promptComplete" });
    expect($(doc, "donut-label").textContent).toBe("32K/100K");
  });

  it("contextUsage (host-read signals.json) updates used and the window", () => {
    const { window, doc } = boot();
    dispatch(window, { type: "contextUsage", used: 29088, window: 200000 });
    expect($(doc, "donut-label").textContent).toBe("29K/200K");
    expect($(doc, "donut").title).toBe(
      `Context usage — ${(29088).toLocaleString()} / ${(200000).toLocaleString()} tokens`,
    );
  });

  it("contextUsage without a window keeps the model-derived window", () => {
    const { window, doc } = boot();
    dispatch(window, { type: "contextUsage", used: 29088 });
    expect($(doc, "donut-label").textContent).toBe("29K/100K");
  });

  it("seeds a cold restore: the session event zeroes the donut, contextUsage restores it", () => {
    // Cold-restore buffered order: `session` (resets the donut to 0) → replay →
    // `contextUsage` (the host reads signals.json after loadSession returns).
    const { window, doc } = boot();
    expect($(doc, "donut-label").textContent).toBe("0K/100K");
    dispatch(window, { type: "contextUsage", used: 44123, window: 100000 });
    expect($(doc, "donut-label").textContent).toBe("44K/100K");
  });

  it("a stripped zero keeps the donut, a later contextUsage corrects it", () => {
    const { window, doc } = boot();
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 40088 } });
    // /compact reports a stripped zero; the CLI recomputes signals.json only
    // when the NEXT turn ends (research/signals-refresh-probe.cjs), so the
    // corrected count arrives via contextUsage after a follow-up zero turn
    // (e.g. /session-info) — compact shrinks context, it doesn't empty it.
    dispatch(window, { type: "promptComplete", meta: {} });
    dispatch(window, { type: "contextUsage", used: 29088 });
    expect($(doc, "donut-label").textContent).toBe("29K/100K");
  });

  it("a window-only contextUsage rescales without inventing a used count", () => {
    const { window, doc } = boot();
    dispatch(window, { type: "contextUsage", used: 44123, window: 100000 });
    dispatch(window, { type: "contextUsage", window: 1000000 });
    expect($(doc, "donut-label").textContent).toBe("44K/1000K");
  });

  it("switching from Grok to Claude resets the donut window without leaking Grok's 512k", () => {
    const { window, doc } = boot();
    dispatch(window, {
      type: "session",
      sessionId: "s-grok",
      provider: "grok",
      currentModelId: "grok-build",
      models: [{ modelId: "grok-build", name: "Grok Build", totalContextTokens: 512000 }],
    });
    expect($(doc, "donut-label").textContent).toBe("0K/512K");

    dispatch(window, {
      type: "session",
      sessionId: "s-claude",
      provider: "claude",
      currentModelId: "claude-sonnet-5",
      models: [{ modelId: "claude-sonnet-5", name: "Claude Sonnet 5" }],
    });
    expect($(doc, "donut-label").textContent).toBe("0K/1000K");
  });
});

describe("gear settings lock (model + effort disabled while busy / priming)", () => {
  const models = [
    { modelId: "grok-build", name: "Grok Build" },
    { modelId: "grok-composer-2.5-fast", name: "Composer 2.5 Fast" },
  ];
  function bootWithModels(busy?: { value: boolean; locked?: boolean }) {
    const h = bootWebview();
    dispatch(h.window, { type: "session", sessionId: "s1", models, currentModelId: "grok-build" });
    if (busy) dispatch(h.window, { type: "setBusy", ...busy });
    h.posted.length = 0;
    return h;
  }
  const modelBtn = (doc: Document) => doc.querySelector(".model-name-btn") as HTMLButtonElement;

  it("shows the user-facing model name on the gear button, not the raw id", () => {
    const { window, doc } = bootWithModels();
    click(window, $(doc, "gear-btn"));
    expect(modelBtn(doc).textContent).toContain("Grok Build");
    expect(modelBtn(doc).textContent).not.toContain("grok-build");
  });

  it("when idle, the model button opens the picker and a pick posts setModel", () => {
    const { window, posted, doc } = bootWithModels();
    click(window, $(doc, "gear-btn"));
    expect(modelBtn(doc).disabled).toBe(false);

    click(window, modelBtn(doc)); // opens the picker sub-view
    const composer = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => el.textContent!.includes("Composer 2.5 Fast")) as HTMLElement;
    click(window, composer);

    expect(posted).toContainEqual({ type: "setModel", modelId: "grok-composer-2.5-fast" });
  });

  it("groups remote empty-session models deterministically and switches providers additively", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true },
      ],
    });
    dispatch(h.window, {
      type: "session",
      sessionId: "fresh",
      provider: "grok",
      currentModelId: "grok-build",
      models: [
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { provider: "grok", modelId: "grok-build", name: "Grok Build" },
      ],
    });
    click(h.window, $(h.doc, "gear-btn"));
    click(h.window, modelBtn(h.doc));

    expect([...h.doc.querySelectorAll(".model-provider-heading")].map((el) => el.textContent))
      .toEqual(["Grok", "Codex"]);
    const codexModel = [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => el.textContent?.includes("GPT-5.6 Sol")) as HTMLElement;
    click(h.window, codexModel);
    expect(h.posted).toContainEqual({ type: "setModel", modelId: "gpt-5.6-sol", provider: "codex" });
  });

  it("scopes a remote non-empty Codex conversation to Codex models", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true },
      ],
    });
    dispatch(h.window, {
      type: "session",
      sessionId: "codex-live",
      provider: "codex",
      currentModelId: "gpt-5.6-sol",
      models: [
        { provider: "grok", modelId: "grok-build", name: "Grok Build" },
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { provider: "codex", modelId: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      ],
    });
    dispatch(h.window, { type: "userMessage", text: "continue this conversation", chips: [] });
    click(h.window, $(h.doc, "gear-btn"));
    click(h.window, modelBtn(h.doc));

    const text = h.doc.getElementById("gear-popover")!.textContent || "";
    expect(text).toContain("GPT-5.6 Sol");
    expect(text).toContain("GPT-5.6 Terra");
    expect(text).not.toContain("Grok Build");
    expect(h.doc.querySelectorAll(".model-provider-heading")).toHaveLength(0);
  });

  it("renders the Accounts cluster only after the provider capability frame", () => {
    const h = bootWithModels();
    click(h.window, $(h.doc, "gear-btn"));
    expect(h.doc.querySelector("#gear-popover")!.textContent).not.toContain("Accounts");

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: false },
      ],
    });
    expect(h.doc.querySelector("#gear-popover")!.textContent).not.toContain("Accounts");

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: false },
        { id: "codex", connected: false },
      ],
    });
    expect(h.doc.querySelector("#gear-popover")!.textContent).toContain("Accounts");
    const sections = [...h.doc.querySelectorAll("#gear-popover .popover-section")];
    expect(sections.at(-1)?.textContent).toBe("Accounts");
    const codex = [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .find((el) => el.textContent?.includes("Codex")) as HTMLElement;
    click(h.window, codex);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "codex" });
  });

  it("never renders provider management or posts account actions remotely", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: false },
      ],
    });
    click(h.window, $(h.doc, "gear-btn"));
    const text = h.doc.getElementById("gear-popover")!.textContent || "";
    expect(text).not.toContain("Accounts");
    expect(text).not.toContain("Sign out");
    expect(text).not.toContain("Connect");
    expect(types(h.posted)).not.toContain("logout");
    expect(types(h.posted)).not.toContain("runGrokLogin");
  });

  it("while priming, the model button is disabled and clicking it neither opens the picker nor posts", () => {
    const { window, posted, doc } = bootWithModels({ value: true, locked: true });
    click(window, $(doc, "gear-btn"));

    expect(modelBtn(doc).disabled).toBe(true);
    expect(modelBtn(doc).className).toContain("disabled");

    click(window, modelBtn(doc));
    // still on the main gear view (the picker's "← Model" back row never rendered)
    expect(doc.querySelector("#gear-popover .popover-back")).toBeNull();
    expect(types(posted)).not.toContain("setModel");
  });

  it("while busy, clicking an effort dot does not post setEffort", () => {
    const { window, posted, doc } = bootWithModels({ value: true });
    click(window, $(doc, "gear-btn"));
    const dot = doc.querySelector(".effort-dot") as HTMLElement;

    expect(dot.className).toContain("disabled");
    click(window, dot);
    expect(types(posted)).not.toContain("setEffort");
  });

  it("re-renders an open gear to unlock the controls once busy clears", () => {
    const { window, doc } = bootWithModels({ value: true, locked: true });
    click(window, $(doc, "gear-btn"));
    expect(modelBtn(doc).disabled).toBe(true);

    dispatch(window, { type: "setBusy", value: false });

    expect(($(doc, "gear-popover") as any).hidden).toBe(false); // popover stays open
    expect(modelBtn(doc).disabled).toBe(false); // now unlocked
  });
});

describe("provider onboarding", () => {
  it("names a missing project and blocks send instead of leaving Starting up", () => {
    const { window, doc, posted } = bootWebview();
    const send = doc.getElementById("send-btn") as HTMLButtonElement;
    const welcome = doc.getElementById("welcome-version")!;
    expect(welcome.textContent).toContain("Starting");

    dispatch(window, { type: "onboarding", state: "no-project" });
    const onboarding = doc.getElementById("welcome-onboarding")!;
    expect(onboarding.textContent).toContain("No project folder");
    expect(onboarding.textContent).toContain("Add one to continue");
    expect(welcome.textContent).toContain("No project folder");
    expect(welcome.classList.contains("welcome-status-busy")).toBe(false);
    expect(send.disabled).toBe(true);
    expect(send.title).toContain("Add a project folder");

    (doc.getElementById("input") as HTMLTextAreaElement).value = "hello";
    click(window, send);
    expect(posted.filter((p) => p.type === "send")).toEqual([]);

    const add = onboarding.querySelector('[data-act="addProjectFolder"]') as HTMLButtonElement;
    expect(add).toBeTruthy();
    click(window, add);
    expect(posted).toContainEqual({ type: "addProjectFolder" });
  });

  it("tells a remote client to add the folder at the desk", () => {
    const { window, doc, posted } = bootWebview({ remote: true });
    dispatch(window, { type: "onboarding", state: "no-project" });
    const onboarding = doc.getElementById("welcome-onboarding")!;
    expect(onboarding.textContent).toContain("Add a project folder on the computer");
    expect(onboarding.querySelectorAll("button")).toHaveLength(0);
    expect(posted).toEqual([]);
  });

  it("offers a remote sign-in on every provider panel, and still no sign-out", () => {
    // This test used to assert the opposite — "Sign in at the desk", and zero
    // buttons — which was correct while `runGrokLogin` opened a terminal a
    // remote could not see. The host now runs the CLI's headless device-code
    // flow for a remote request, so a dead end became an offer.
    //
    // What has NOT changed, and is the half still worth pinning: a remote is
    // offered no way to sign OUT, on any of these panels.
    //
    // The capability is not decoration here. Without it this panel falls back
    // to the old desk-only guidance on purpose, because a host that predates
    // remote sign-in drops the request silently — see
    // test/remote-device-login.dom.test.ts for that half.
    const { window, doc, posted } = bootWebview({ remote: true });
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.18.0",
      showThinking: false, expandCommandOutputs: false, steerByDefault: false,
      soundNotifications: false, processingSound: false, readRepliesAloud: false,
      capabilities: { remoteAgentSignIn: true },
    });
    posted.length = 0;

    for (const state of ["connect-agent", "auth-required", "codex-login", "claude-login"] as const) {
      dispatch(window, { type: "onboarding", state });
      const onboarding = doc.getElementById("welcome-onboarding")!;
      expect(onboarding.textContent).not.toContain("Sign in at the desk");
      expect(onboarding.querySelectorAll('[data-act="connectRemote"]').length).toBeGreaterThan(0);
      expect(onboarding.querySelectorAll('[data-act="logout"]')).toHaveLength(0);
    }

    // Nothing is posted until something is pressed.
    expect(types(posted)).not.toContain("runGrokLogin");
    expect(types(posted)).not.toContain("logout");
  });

  it("offers both agents when none is connected and keeps Grok visually primary", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "onboarding", state: "connect-agent" });

    const tiles = [...doc.querySelectorAll(".onb-agent-tile")] as HTMLButtonElement[];
    expect(tiles).toHaveLength(4);
    expect(tiles[0].textContent).toContain("Grok");
    expect(tiles[0].classList.contains("primary")).toBe(true);
    expect(tiles[1].textContent).toContain("Codex");
    expect(tiles[2].textContent).toContain("Claude");
    expect(tiles[3].textContent).toContain("Gemini");
    expect(tiles.every((tile) => !!tile.querySelector("svg.provider-logo path"))).toBe(true);

    click(window, tiles[1]);
    expect(posted).toContainEqual({ type: "runGrokLogin", provider: "codex" });
    click(window, tiles[2]);
    expect(posted).toContainEqual({ type: "runGrokLogin", provider: "claude" });
    click(window, tiles[3]);
    expect(posted).toContainEqual({ type: "runGrokLogin", provider: "gemini" });
  });

  it("tells the user to install and sign in with Anthropic's own Claude CLI", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "onboarding", state: "missing-claude" });
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("does not install or sign in to Claude");
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("claude auth login");

    dispatch(window, { type: "onboarding", state: "claude-login" });
    const loginCopy = doc.getElementById("welcome-onboarding")!.textContent ?? "";
    expect(loginCopy).toContain("never implements, proxies, holds, or forwards Claude credentials");
    expect(loginCopy).toContain("Claude subscription");
    expect(loginCopy).toContain("Anthropic Console");
    expect(loginCopy).not.toContain("does not offer Claude.ai login");
    const recheck = [...doc.querySelectorAll("#welcome-onboarding button")]
      .find((el) => el.textContent?.includes("connect Claude")) as HTMLElement;
    click(window, recheck);
    expect(posted).toContainEqual({ type: "recheckConnection", provider: "claude" });
  });

  it("shows Codex install guidance and provider-specific re-check", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "onboarding", state: "missing-codex" });
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("npm i -g @openai/codex");
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("ChatGPT extension");

    const install = [...doc.querySelectorAll("#welcome-onboarding button")]
      .find((el) => el.textContent?.includes("Install Codex")) as HTMLElement;
    click(window, install);
    expect(posted).toContainEqual({ type: "installCodex" });

    dispatch(window, { type: "codexInstallProgress", phase: "downloading", receivedBytes: 25, totalBytes: 100 });
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("Downloading Codex (25%)");
    const progress = doc.querySelector("#welcome-onboarding progress") as HTMLProgressElement;
    expect(progress.value).toBe(25);
    const cancel = [...doc.querySelectorAll("#welcome-onboarding button")]
      .find((el) => el.textContent?.includes("Cancel")) as HTMLElement;
    click(window, cancel);
    expect(posted).toContainEqual({ type: "cancelCodexInstall" });

    dispatch(window, { type: "codexInstallProgress", phase: "idle", reason: "Codex installation failed: disk full" });
    expect(doc.querySelector("#welcome-onboarding [role=alert]")?.textContent).toContain("disk full");

    const recheck = [...doc.querySelectorAll("#welcome-onboarding button")]
      .find((el) => el.textContent?.includes("Re-check")) as HTMLElement;
    click(window, recheck);
    expect(posted).toContainEqual({ type: "recheckConnection", provider: "codex" });
  });

  it("dismisses a matching provider login overlay after the account connects", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "onboarding", state: "codex-login" });
    expect((doc.getElementById("welcome") as HTMLElement).hidden).toBe(false);

    dispatch(window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true },
      ],
    });

    expect((doc.getElementById("welcome") as HTMLElement).hidden).toBe(true);
  });

  it("rechecks and dismisses the provider carried by the older missing-CLI screen", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "providerState",
      providers: [
        { id: "codex", connected: true },
        { id: "grok", connected: false },
      ],
    });
    dispatch(window, { type: "onboarding", state: "missing-cli", provider: "grok" });
    const recheck = [...doc.querySelectorAll("#welcome-onboarding button")]
      .find((el) => el.textContent?.includes("Re-check")) as HTMLElement;

    click(window, recheck);
    expect(posted).toContainEqual({ type: "recheckConnection", provider: "grok" });

    dispatch(window, {
      type: "providerState",
      providers: [
        { id: "codex", connected: true },
        { id: "grok", connected: true },
      ],
    });
    expect((doc.getElementById("welcome") as HTMLElement).hidden).toBe(true);
  });
});

describe("gear menu — AFK Pilot onboarding", () => {
  const gearItem = (doc: Document, label: string) =>
    [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")].find(
      (el) => el.textContent?.includes(label),
    ) as HTMLElement | undefined;
  const button = (doc: Document, label: string) =>
    [...doc.querySelectorAll(".confirm-panel button")].find(
      (el) => el.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;

  it("offers linked devices an immediate hinted Continue remotely action with a phone icon", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "remoteStatus", linked: true });
    click(window, $(doc, "gear-btn"));

    const item = gearItem(doc, "Continue remotely");
    expect(item).toBeTruthy();
    expect(item!.querySelector("svg rect")).not.toBeNull();

    click(window, item!);
    expect(posted).toContainEqual({ type: "openRemotePortal", withHint: true });
    expect(($(doc, "gear-popover") as HTMLElement).hidden).toBe(true);
  });

  it("offers no link/account action until the host has answered with the link status", () => {
    // The host reads the device token from secret storage asynchronously, so
    // there is a real window with no answer. Defaulting to "not linked" told
    // an already-linked machine to "Sign in (link this device)" — the owner
    // started re-linking a device that was working (2026-07-30). Unknown must
    // show nothing, and the section must appear when the answer lands, even
    // while the popover is open.
    const { window, doc } = bootWebview();
    click(window, $(doc, "gear-btn"));

    const labels = () => [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .map((el) => el.textContent || "");
    expect(labels().some((l) => /link this device|Your account|Continue remotely/i.test(l))).toBe(false);

    dispatch(window, { type: "remoteStatus", linked: false });
    expect(labels().some((l) => /Sign in \(link this device\)/i.test(l))).toBe(true);
  });

  it("sends linked devices to the portal for account management, never a one-tap unlink", () => {
    // VS Code: unlinking stays on the Command Palette. A one-tap menu item
    // next to "Continue remotely" was removed (owner, 2026-07-30).
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "remoteStatus", linked: true });
    click(window, $(doc, "gear-btn"));

    const labels = [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
      .map((el) => el.textContent || "");
    expect(labels.some((l) => /unlink this device/i.test(l))).toBe(false);

    const account = gearItem(doc, "Your account");
    expect(account).toBeTruthy();
    click(window, account!);
    expect(posted).toContainEqual({ type: "openRemotePortal" });
    expect(posted.some((m) => m.type === "remoteSignOut" || m.type === "unlinkRemoteDevice")).toBe(false);
  });

  it("offers Unlink this device… in Settings → Account on desktop, not the gear", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      capabilities: { relocateView: false, showOutput: false },
    });
    dispatch(window, { type: "remoteStatus", linked: true });
    click(window, $(doc, "gear-btn"));
    expect(gearItem(doc, "Unlink this device…")).toBeUndefined();
    openSettingsOverlay(window, doc);
    clickSettingsNav(window, doc, "Remote control");
    const unlink = doc.querySelector('[data-id="unlinkDevice"] .settings-action') as HTMLElement;
    expect(unlink).toBeTruthy();
    click(window, unlink);
    expect(posted).toContainEqual({ type: "unlinkRemoteDevice" });
  });

  it("does not offer Unlink this device… in the remote browser client", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      capabilities: { relocateView: false, showOutput: false },
    });
    dispatch(window, { type: "remoteStatus", linked: true });
    click(window, $(doc, "gear-btn"));
    expect(gearItem(doc, "Unlink this device…")).toBeUndefined();
  });

  it("offers a top-bar Continue remotely button only in a linked local client", () => {
    // The desk is where someone decides to get up and keep going on a phone —
    // one tap, not buried in the gear menu. Hidden until this machine links.
    const { window, posted, doc } = bootWebview();
    const remoteBtn = $(doc, "remote-btn") as HTMLButtonElement;
    expect(remoteBtn.hidden).toBe(true);

    dispatch(window, { type: "remoteStatus", linked: true });
    expect(remoteBtn.hidden).toBe(false);

    click(window, remoteBtn);
    expect(posted).toContainEqual({ type: "openRemotePortal", withHint: true });

    dispatch(window, { type: "remoteStatus", linked: false });
    expect(remoteBtn.hidden).toBe(true);
  });

  it("opens the How it works explainer locally without navigating", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "remoteStatus", linked: false });
    click(window, $(doc, "gear-btn"));
    click(window, gearItem(doc, "How it works")!);

    expect(posted.filter((msg) => msg.type === "openRemotePortal")).toEqual([]);
    const panel = doc.querySelector(".remote-explainer-panel");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("Link this device. Sign in with your account.");
    expect(panel!.textContent).toContain("Keep VS Code, Cursor, or Antigravity open.");
    expect(panel!.textContent).toContain("Open afkpilot.com on your phone and sign in.");
    expect(panel!.textContent).toContain(
      "You can then work 100% remotely — it keeps this device awake, and never stores your prompts or code.",
    );
    expect(button(doc, "More & FAQ")).toBeTruthy();
  });

  it("uses desktop phrasing in How it works on a desktop host", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      capabilities: { relocateView: false, showOutput: false },
    });
    dispatch(window, { type: "remoteStatus", linked: false });
    click(window, $(doc, "gear-btn"));
    click(window, gearItem(doc, "How it works")!);
    const panel = doc.querySelector(".remote-explainer-panel");
    expect(panel!.textContent).toContain("Keep this app open.");
    expect(panel!.textContent).not.toContain("Keep VS Code, Cursor, or Antigravity open.");
  });

  it("copies afkpilot.com with success feedback and keeps More & FAQ unhinted", async () => {
    const copied: string[] = [];
    const { window, posted, doc } = bootWebview({
      beforeScripts: (w) => {
        Object.defineProperty((w as any).navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (value: string) => { copied.push(value); } },
        });
      },
    });
    dispatch(window, { type: "remoteStatus", linked: false }); // an unlinked machine, stated not assumed
    click(window, $(doc, "gear-btn"));
    click(window, gearItem(doc, "How it works")!);

    click(window, doc.querySelector(".remote-url-copy")!);
    await Promise.resolve();
    expect(copied).toEqual(["https://afkpilot.com"]);
    expect(doc.querySelector(".remote-url-copied")!.textContent).toBe("Copied");

    click(window, button(doc, "More & FAQ")!);
    expect(posted).toContainEqual({ type: "openRemotePortal" });
    expect(doc.querySelector(".remote-explainer-panel")).toBeNull();
  });

  it("closes the explainer without navigating", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "remoteStatus", linked: false }); // an unlinked machine, stated not assumed
    click(window, $(doc, "gear-btn"));
    click(window, gearItem(doc, "How it works")!);
    click(window, doc.querySelector(".remote-explainer-close")!);

    expect(doc.querySelector(".remote-explainer-panel")).toBeNull();
    expect(posted.filter((msg) => msg.type === "openRemotePortal")).toEqual([]);
  });
});

describe("effort picker uses the model's advertised levels (not a hardcoded set)", () => {
  const openEffortDots = (h: any) => {
    click(h.window, $(h.doc, "gear-btn"));
    return [...h.doc.querySelectorAll(".effort-dot")] as HTMLElement[];
  };

  it("shows exactly the current model's advertised efforts, ordered low→high", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "session", sessionId: "s1", currentModelId: "grok-build",
      models: [{ modelId: "grok-build", name: "Grok Build", reasoningEfforts: ["high", "medium", "low"] }],
    });
    const dots = openEffortDots(h);
    expect(dots).toHaveLength(3); // low/medium/high — not the 6-level ladder
    expect(dots.map((d) => d.title)).toEqual([
      "Low — fast, lightweight reasoning",
      "Medium — balanced",
      "High — deeper reasoning",
    ]);
  });

  it("falls back to the full ladder when the model advertises no efforts", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "session", sessionId: "s1", currentModelId: "grok-build",
      models: [{ modelId: "grok-build", name: "Grok Build" }], // no reasoningEfforts
    });
    expect(openEffortDots(h)).toHaveLength(6);
  });

  it("shows a Loading… model + 5 neutral placeholder dots before the session's model info arrives", () => {
    const h = bootWebview();
    // no `session` message yet → no model / effort menu known
    const dots = openEffortDots(h);
    const nameBtn = h.doc.querySelector("#gear-popover .model-name-btn") as HTMLElement;
    expect(nameBtn.textContent).toContain("Loading");
    expect(dots).toHaveLength(5);
    expect(dots.every((d) => d.classList.contains("loading"))).toBe(true);
  });
});

describe("reasoning trace (regression: thinking traces no longer expandable)", () => {
  it("renders a collapsed thinking block whose header toggles the body open/closed", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "thoughtChunk", text: "considering the approach…" });

    const block = doc.querySelector(".msg.thinking")!;
    const hdr = block.querySelector(".thinking-header") as HTMLElement;
    const body = block.querySelector(".thinking-body") as HTMLElement;
    const chevron = block.querySelector(".thinking-chevron") as HTMLElement;

    // Chevron is the same SVG glyph as tool groups; the body's open state is
    // driven by the `.expanded` class on the block (CSS rotates the chevron),
    // not a glyph swap.
    expect(body.hidden).toBe(true);
    expect(chevron.querySelector("svg")).not.toBeNull();
    expect(block.classList.contains("expanded")).toBe(false);

    click(window, hdr);
    expect(body.hidden).toBe(false);
    expect(block.classList.contains("expanded")).toBe(true);

    click(window, hdr);
    expect(body.hidden).toBe(true);
    expect(block.classList.contains("expanded")).toBe(false);
  });
});

describe("Grokking… indicator (waiting placeholder)", () => {
  const grokking = (doc: Document) => doc.querySelector(".grokking") as HTMLElement | null;

  it("uses the active provider's composer placeholder and updates it live on an empty session", () => {
    const h = bootWebview();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    expect(input.placeholder).toBe("Ask Grok…");

    dispatch(h.window, {
      type: "session", sessionId: "c1", models: [], currentModelId: "gpt-5.6-sol", provider: "codex",
    });
    expect(input.placeholder).toBe("Ask GPT…");

    dispatch(h.window, {
      type: "session", sessionId: "g1", models: [], currentModelId: "grok-build", provider: "grok",
    });
    expect(input.placeholder).toBe("Ask Grok…");
  });

  it("uses Opening AI for Codex while keeping the shared live-turn indicator", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "session", sessionId: "c1", models: [], currentModelId: "gpt-5.6-sol", provider: "codex",
    });
    dispatch(h.window, { type: "agentStart" });
    const el = grokking(h.doc)!;
    expect(el.querySelector(".grokking-label")?.textContent).toBe("Opening AI");
    expect(el.getAttribute("aria-label")).toBe("OpenAI is working");
    expect(el.querySelector(".grokking-icon svg")).not.toBeNull();
  });

  it("uses Clauding for Claude and Ask Claude in the composer", () => {
    const h = bootWebview();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    dispatch(h.window, {
      type: "session", sessionId: "cl1", models: [], currentModelId: "claude-sonnet-4-5", provider: "claude",
    });
    expect(input.placeholder).toBe("Ask Claude…");
    dispatch(h.window, { type: "agentStart" });
    const el = grokking(h.doc)!;
    expect(el.querySelector(".grokking-label")?.textContent).toBe("Clauding");
    expect(el.getAttribute("aria-label")).toBe("Claude is working");
  });

  it("mounts on agentStart with a spinning orbit icon, a label, and no dots or chevron", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });

    const el = grokking(doc);
    expect(el).not.toBeNull();
    const label = el!.querySelector(".grokking-label") as HTMLElement;
    expect(label.textContent).toBe("Grokking");
    // The orbit icon is Grokking's motion — no blink-dots here (those are for
    // Thinking / tools); and NOT expandable: no chevron, no body, not .thinking.
    expect(el!.querySelector(".grokking-icon svg")).not.toBeNull();
    expect(el!.querySelector(".blink-dots")).toBeNull();
    expect(el!.querySelector(".thinking-chevron")).toBeNull();
    expect(el!.querySelector(".thinking-body")).toBeNull();
    expect(el!.classList.contains("thinking")).toBe(false);
  });

  it("is replaced in place by the Thinking block on the first thought chunk", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    expect(grokking(doc)).not.toBeNull();

    dispatch(window, { type: "thoughtChunk", text: "considering…" });
    expect(grokking(doc)).toBeNull();
    expect(doc.querySelector(".msg.thinking")).not.toBeNull();
  });

  it("is replaced by the agent bubble when the turn streams text without thinking", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Here is the answer." });
    expect(grokking(doc)).toBeNull();
    expect(doc.querySelector(".msg.agent")).not.toBeNull();
  });

  it("is replaced when the first content of the turn is a tool call", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "t1", title: "read foo.ts", kind: "read", status: "in_progress" },
    });
    expect(grokking(doc)).toBeNull();
    expect(doc.querySelector(".tool-group")).not.toBeNull();
  });

  it("autoCompactNotice finalizes the active agent bubble so later tokens can't render above it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Before compaction." });
    dispatch(window, { type: "autoCompactNotice", text: "Auto-compacting context (94% full)…" });
    dispatch(window, { type: "messageChunk", text: "After compaction." });
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 5 } }); // flush the buffered bubble
    const notice = doc.querySelector(".plan-notice");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("Auto-compacting context");
    // Two distinct agent bubbles — the notice finalized the first, so "after"
    // starts a fresh bubble instead of reusing (and reordering above) the first.
    const bubbles = [...doc.querySelectorAll(".msg.agent")] as any[];
    expect(bubbles.length).toBe(2);
    expect(bubbles[0].textContent).toContain("Before compaction");
    expect(bubbles[1].textContent).toContain("After compaction");
    // DOM order is bubble0 → notice → bubble1 (the answer never floats above it).
    const nodes = [...doc.querySelectorAll(".msg.agent, .plan-notice")] as any[];
    expect(nodes.indexOf(bubbles[0])).toBeLessThan(nodes.indexOf(notice));
    expect(nodes.indexOf(notice)).toBeLessThan(nodes.indexOf(bubbles[1]));
  });

  it("shows on every turn, not just the first (a general typing indicator)", () => {
    const { window, doc } = bootWebview();
    // Turn 1 completes.
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "first" });
    dispatch(window, { type: "agentEnd" });
    expect(grokking(doc)).toBeNull();
    // Turn 2 begins → the indicator returns.
    dispatch(window, { type: "agentStart" });
    expect(grokking(doc)).not.toBeNull();
  });

  it("clears on agentEnd even if the turn produced no content", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    expect(grokking(doc)).not.toBeNull();
    dispatch(window, { type: "agentEnd" });
    expect(grokking(doc)).toBeNull();
  });

  it("coexists with the user's own bubble, below it (message shows as sent while waiting)", () => {
    const { window, doc } = bootWebview();
    // Mirrors handleSend's order: the user bubble, then agentStart.
    dispatch(window, { type: "userMessage", text: "do the thing", chips: [] });
    dispatch(window, { type: "agentStart" });

    expect(doc.querySelectorAll(".msg.user").length).toBe(1);
    const el = grokking(doc);
    expect(el).not.toBeNull();
    // The indicator sits after the user bubble in DOM order.
    const user = doc.querySelector(".msg.user") as HTMLElement;
    expect(user.compareDocumentPosition(el!) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
  });

  it("renders sent-message attachment chips by filename, full path on hover for external files", () => {
    const { window, doc } = bootWebview();
    const external = "c:\\Users\\Dell\\Downloads\\2025-07-14_12-15-44.png";
    dispatch(window, {
      type: "userMessage",
      text: "test",
      chips: [
        { id: "explicit:1", path: "c:\\GitHub\\grok-build-vscode\\CLAUDE.md", relPath: "CLAUDE.md" },
        { id: "explicit:2", path: external, relPath: external },
      ],
    });
    const chips = Array.from(doc.querySelectorAll(".msg.user .msg-chip")) as HTMLElement[];
    const texts = chips.map((c) => c.querySelector("span")!.textContent);
    expect(texts).toContain("CLAUDE.md");
    const ext = chips.find((c) => c.title === external)!; // full path preserved on hover
    expect(ext).toBeTruthy();
    const extText = ext.querySelector("span")!.textContent!;
    expect(extText.startsWith("2025-07-14")).toBe(true); // filename, not the path
    expect(extText).not.toContain("\\");
    expect(extText).not.toContain("Downloads");
  });

  it("shows the selected line range on a sent-message chip, like the composer chip", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "userMessage",
      text: "explain these lines",
      chips: [
        {
          id: "implicit:/repo/src/prompt-builder.ts",
          path: "/repo/src/prompt-builder.ts",
          relPath: "src/prompt-builder.ts",
          selectionStart: 60,
          selectionEnd: 82,
        },
        { id: "explicit:1", path: "/repo/src/a.ts", relPath: "src/a.ts", selectionStart: 8, selectionEnd: 8 },
      ],
    });
    const chips = Array.from(doc.querySelectorAll(".msg.user .msg-chip")) as HTMLElement[];
    const texts = chips.map((c) => c.querySelector("span")!.textContent);
    // No 20-char JS truncation — the full name + range must survive (ellipsis is CSS).
    expect(texts).toContain("prompt-builder.ts:60-82");
    expect(texts).toContain("a.ts:8");
    const ranged = chips.find((c) => c.querySelector("span")!.textContent === "prompt-builder.ts:60-82")!;
    expect(ranged.title).toBe("/repo/src/prompt-builder.ts (lines 60-82)");
    const single = chips.find((c) => c.querySelector("span")!.textContent === "a.ts:8")!;
    expect(single.title).toBe("/repo/src/a.ts (line 8)");
  });

  it("rebuilds a replayed selection snippet as a ranged chip, not an inline code block", () => {
    const { window, doc } = bootWebview();
    const replayed =
      "<vscode-context note=\"added by the editor, not typed by the user\">\n" +
      "Attached file: CLAUDE.md\n" +
      "</vscode-context>\n\n" +
      "`src/a.ts` (lines 2-4):\n```ts\nline2\nline3\nline4\n```\n\n" +
      "what is this";

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: replayed });
    dispatch(window, { type: "historyReplay", active: false });

    const bubble = doc.querySelector(".msg.user") as HTMLElement;
    expect(bubble.textContent).toContain("what is this");
    expect(bubble.textContent).not.toContain("line2"); // snippet body → chip, not a code block
    const texts = Array.from(bubble.querySelectorAll(".msg-chip span")).map((s) => s.textContent);
    expect(texts).toContain("CLAUDE.md");
    expect(texts).toContain("a.ts:2-4");
    const ranged = Array.from(bubble.querySelectorAll(".msg-chip")).find(
      (c) => c.querySelector("span")!.textContent === "a.ts:2-4",
    ) as HTMLElement;
    expect(ranged.title).toBe("src/a.ts (lines 2-4)");
  });

  it("copies only the user's own words from a restored message, not the context plumbing", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "userMessageChunk",
      text: "`a.ts` (lines 1-1):\n```ts\nconst x = 1;\n```\n\nexplain this",
    });
    dispatch(window, { type: "historyReplay", active: false });

    const msg = doc.querySelector(".msg.user") as HTMLElement & { _copyText?: string };
    expect(msg._copyText).toBe("explain this");
  });

  it("does not duplicate when agentStart fires twice without content", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "agentStart" });
    expect(doc.querySelectorAll(".grokking").length).toBe(1);
  });
});

describe("user message (regression: doubled on grok 0.2.33)", () => {
  const users = (doc: Document) => doc.querySelectorAll(".msg.user");

  it("does not render a second bubble when a live prompt is echoed back as a user chunk", () => {
    const { window, doc } = bootWebview();

    // Live send: the host posts the optimistic bubble.
    dispatch(window, { type: "userMessage", text: "/imagine a rocket", chips: [] });
    expect(users(doc).length).toBe(1);

    // grok 0.2.33 echoes the prompt back as a user_message_chunk mid-turn (not
    // replaying). It must NOT spawn a duplicate bubble.
    dispatch(window, { type: "userMessageChunk", text: "/imagine a rocket" });
    expect(users(doc).length).toBe(1);
  });

  it("still renders the user bubble from chunks during a session replay", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "resumed prompt" });
    dispatch(window, { type: "historyReplay", active: false });

    expect(users(doc).length).toBe(1);
    expect(users(doc)[0].textContent).toContain("resumed prompt");
  });

  it("renders a history batch synchronously while retaining old per-message replay support", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "historyBatch",
      messages: [
        { type: "userMessageChunk", text: "batched prompt" },
        { type: "agentStart" },
        { type: "messageChunk", text: "batched answer" },
        { type: "agentEnd" },
      ],
    });
    dispatch(window, { type: "historyReplay", active: false });

    expect(users(doc)).toHaveLength(1);
    expect(users(doc)[0].textContent).toContain("batched prompt");
    expect(doc.querySelector(".msg.agent")?.textContent).toContain("batched answer");

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "legacy prompt" });
    dispatch(window, { type: "historyReplay", active: false });
    expect(users(doc)).toHaveLength(2);
    expect(users(doc)[1].textContent).toContain("legacy prompt");
  });
});

describe("welcome version line (session-start lifecycle)", () => {
  const verEl = (doc: Document) => $(doc, "welcome-version");
  const ver = (doc: Document) => verEl(doc).textContent;
  // A busy status renders the send button's loader-circle beside the label and
  // spins it, so the marker is the class, not the text — which stays dot-free.
  const animating = (doc: Document) => verEl(doc).classList.contains("welcome-status-busy");

  it("flips to connected only when priming finishes, not at the handshake", () => {
    const { window, doc } = bootWebview();

    // ACP handshake done — but the hidden primer is still in flight, so the
    // line must stay "Starting…" (animated), NOT jump to "Connected" yet.
    dispatch(window, { type: "initialized", info: { version: "0.2.33" } });
    expect(ver(doc)).toBe("Starting");
    expect(animating(doc)).toBe(true);

    // Priming spinner clears → grok is finally ready → reveal the version.
    dispatch(window, { type: "setBusy", value: false });
    expect(ver(doc)).toBe("Connected · v0.2.33");
    expect(animating(doc)).toBe(false); // settled — dots stop
  });

  it("shows the silent-update hint, then starting, then the new version", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "cliUpdating" });
    expect(ver(doc)).toBe("Updating Grok Build CLI");
    expect(animating(doc)).toBe(true);

    dispatch(window, { type: "initialized", info: { version: "0.2.40" } });
    expect(ver(doc)).toBe("Starting");
    expect(animating(doc)).toBe(true);

    dispatch(window, { type: "setBusy", value: false });
    expect(ver(doc)).toBe("Connected · v0.2.40");
    expect(animating(doc)).toBe(false);
  });

  it("shows a distinct loading state while history replay is active", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "initialized", info: { version: "0.2.40" } });
    dispatch(window, { type: "historyReplay", active: true });

    expect(ver(doc)).toBe("Loading conversation");
    expect(animating(doc)).toBe(true);
    // Exactly ONE indicator. A second banner above the transcript used to say
    // the same thing at the same moment, which is what the owner saw as
    // "double loading conversation".
    expect(doc.querySelector("#conversation-loading")).toBeNull();
    expect(doc.querySelectorAll("#welcome-version svg").length).toBe(1);

    dispatch(window, { type: "historyReplay", active: false });
    expect(animating(doc)).toBe(false);
    expect(ver(doc)).toBe("Connected · v0.2.40");
  });

  it("does not overwrite the version on later (post-priming) busy toggles", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "initialized", info: { version: "0.2.33" } });
    dispatch(window, { type: "setBusy", value: false });
    expect(ver(doc)).toBe("Connected · v0.2.33");

    // A normal prompt's busy cycle later — the line must not revert.
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, { type: "setBusy", value: false });
    expect(ver(doc)).toBe("Connected · v0.2.33");
  });
});

describe("send button startup state (spinner by default until the session is ready)", () => {
  const sendBtn = (doc: Document) => $(doc, "send-btn") as HTMLButtonElement;

  it("shows the disabled spinner from the first paint, before the host says ready", () => {
    const { doc } = bootWebview({ ready: false });
    expect(sendBtn(doc).classList.contains("initializing")).toBe(true);
    expect(sendBtn(doc).disabled).toBe(true);
    expect(sendBtn(doc).classList.contains("stop")).toBe(false);
  });

  it("switches to the enabled send arrow once the host posts setBusy:false", () => {
    const { window, doc } = bootWebview({ ready: false });
    dispatch(window, { type: "setBusy", value: false });
    expect(sendBtn(doc).classList.contains("initializing")).toBe(false);
    expect(sendBtn(doc).disabled).toBe(false);
  });
});

describe("gear menu — Other group + About / Settings", () => {
  function boot() {
    const h = bootWebview();
    dispatch(h.window, {
      type: "initialState",
      useCtrlEnter: false,
      effort: "",
      cwd: "/x",
      extVersion: "1.4.0",
      // VS Code host affordances — gear gates logs / Move view on these.
      capabilities: {
        uploadFile: true,
        remoteVoice: true,
        deleteActiveSession: true,
        relocateView: true,
        showOutput: true,
        mcpSettings: true,
      },
    });
    dispatch(h.window, { type: "initialized", info: { version: "0.2.33" } });
    dispatch(h.window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build" });
    h.posted.length = 0;
    return h;
  }
  const items = (doc: Document) => [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")] as HTMLElement[];

  it("replaces the flat Config/Account/Debug sections with an Other group", () => {
    const h = boot();
    click(h.window, $(h.doc, "gear-btn"));
    const labels = items(h.doc).map((el) => el.textContent || "");
    expect(labels.some((l) => l.includes("Version & about"))).toBe(false);
    expect(labels.some((l) => /(^|\s)Settings$/.test(l.replace(/\s+/g, " ").trim()))).toBe(true);
    expect(labels.some((l) => l.includes("Config & debug"))).toBe(false);
    expect(labels.some((l) => l.includes("Log out"))).toBe(true);
    // the old standalone items no longer live on the main view
    expect(labels.some((l) => l.trim() === "Sign out")).toBe(false);
    expect(labels.some((l) => l.includes("Show extension logs"))).toBe(false);
  });

  function aboutSurface(h: ReturnType<typeof bootWebview>) {
    return h.doc.getElementById("settings-overlay")!;
  }
  function openAbout(h: ReturnType<typeof bootWebview>) {
    openSettingsOverlay(h.window, h.doc);
    clickSettingsNav(h.window, h.doc, "About");
    return aboutSurface(h);
  }

  it("About shows both versions and requests an update check", () => {
    const h = boot();
    const overlay = openAbout(h);

    const text = overlay.textContent || "";
    expect(text).toContain("This extension");
    expect(text).toContain("v1.4.0");
    expect(text).toContain("Grok Build CLI");
    expect(text).toContain("v0.2.33");
    expect(types(h.posted)).toContain("checkGrokUpdate");
  });

  it("About shows connected Grok and Codex versions without relabelling the adapter as the CLI", () => {
    const h = boot();
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true, cliVersion: "0.2.117" },
        { id: "codex", connected: true, cliVersion: "0.146.0", adapterVersion: "1.1.14", latestCliVersion: "0.147.0", updateAvailable: true },
      ],
    });
    const overlay = openAbout(h);

    const text = overlay.textContent || "";
    expect(text).toContain("Grok Build CLI");
    expect(text).toContain("v0.2.117");
    expect(text).toContain("Codex CLI");
    expect(text).toContain("v0.146.0");
    // The ACP adapters and the "Codex updates" status left About on 2026-08-19.
    // The adapters are pinned deps of this extension and ship in the vsix, so
    // they move only when it does; and "managed at its install source" pointed
    // at US whenever the user let us install the managed Codex. Grok is the
    // only CLI this extension updates, so it is the only one with an update row.
    expect(text).not.toContain("Codex ACP adapter");
    expect(text).not.toContain("at its install source");
    expect(text).not.toContain("Codex update available");
    expect(overlay.querySelector('[data-id="aboutUpdateGrok"]')).toBeNull();
  });

  it("Codex-only About has no Grok update action or adapter-as-CLI label", () => {
    const h = boot();
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: false },
        { id: "codex", connected: true, cliVersion: "0.147.0", adapterVersion: "1.1.14" },
      ],
    });
    const overlay = openAbout(h);

    const text = overlay.textContent || "";
    expect(text).toContain("Codex CLI");
    expect(text).not.toContain("Codex ACP adapter");
    expect(overlay.querySelector('[data-id="aboutGrokCli"]')).toBeNull();
    expect(overlay.querySelector('[data-id="aboutUpdateGrok"]')).toBeNull();
    expect(types(h.posted)).not.toContain("checkGrokUpdate");
  });

  describe("on a remote, About describes the desk machine and offers nothing", () => {
    function bootRemoteAbout(extra?: Record<string, unknown>) {
      const h = bootWebview({ remote: true });
      const meta = h.doc.createElement("meta");
      meta.setAttribute("name", "grok-web-version");
      meta.setAttribute("content", "3.5.0");
      h.doc.head.appendChild(meta);
      dispatch(h.window, {
        type: "initialState",
        useCtrlEnter: false,
        effort: "",
        cwd: "/x",
        extVersion: "1.4.0",
        hostKind: "desktop",
        hostName: "Pawel-Desk",
        capabilities: { uploadFile: true, deleteActiveSession: true },
        ...extra,
      });
      dispatch(h.window, { type: "initialized", info: { version: "0.2.33" } });
      h.posted.length = 0;
      openAbout(h);
      return h;
    }

    it("names what you are holding and what it is connected to", () => {
      const h = bootRemoteAbout();
      const text = aboutSurface(h).textContent || "";
      expect(text).toContain("Web app");
      expect(text).toContain("v3.5.0");
      expect(text).toContain("Connected to");
      expect(text).toContain("Pawel-Desk");
      expect(text).toContain("Desktop app");
      expect(text).toContain("v1.4.0");
      expect(text).toContain("v0.2.33");
      // "This extension" is the local panel's wording, and it is wrong on a
      // phone — the phone is not the thing being versioned.
      expect(text).not.toContain("This extension");
    });

    it("never asks the host to check for updates", () => {
      // The old panel did, and the answer never arrived — a spinner that could
      // not resolve. Not sending it is what removes the spinner.
      const h = bootRemoteAbout();
      expect(types(h.posted)).not.toContain("checkGrokUpdate");
      expect(aboutSurface(h).textContent).not.toContain("Checking for updates");
    });

    it("reports an available CLI update but offers no way to run it", () => {
      const h = bootRemoteAbout();
      dispatch(h.window, {
        type: "grokUpdateStatus", current: "0.2.3", latest: "0.2.33", updateAvailable: true,
      });
      const overlay = aboutSurface(h);
      const text = overlay.textContent || "";
      expect(text).toContain("CLI update available");
      expect(text).toContain("at the desk");
      expect(overlay.querySelector('[data-id="aboutUpdateGrok"]')).toBeNull();
    });

    it("renders host-reported provider versions view-only", () => {
      const h = bootRemoteAbout();
      dispatch(h.window, {
        type: "providerState",
        providers: [
          { id: "grok", connected: true, cliVersion: "0.2.117" },
          { id: "codex", connected: true, cliVersion: "0.146.0", adapterVersion: "1.1.14", latestCliVersion: "0.147.0", updateAvailable: true },
        ],
      });
      const overlay = aboutSurface(h);
      const text = overlay.textContent || "";
      expect(text).toContain("Grok Build CLI");
      expect(text).toContain("Codex CLI");
      expect(text).not.toContain("Codex ACP adapter");
      expect(text).not.toContain("Codex update available");
      expect(types(h.posted)).not.toContain("checkGrokUpdate");
      expect(overlay.querySelector('[data-id="aboutUpdateGrok"]')).toBeNull();
    });

    it("keeps the local panel when the host is too old to describe itself", () => {
      // Capability by field presence: no hostKind means no answers, and a page
      // of blanks is worse than the panel that was already there.
      const h = bootRemoteAbout({ hostKind: undefined, hostName: undefined });
      expect(aboutSurface(h).textContent).toContain("This extension");
    });
  });

  it("enables Update Grok Build when an update is available and posts updateGrok", () => {
    const h = boot();
    const overlay = openAbout(h);
    dispatch(h.window, { type: "grokUpdateStatus", current: "0.2.3", latest: "0.2.33", updateAvailable: true });

    expect(overlay.textContent).toContain("Update available");
    const btn = overlay.querySelector('[data-id="aboutUpdateGrok"] .settings-action') as HTMLElement;
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    h.posted.length = 0;
    click(h.window, btn);
    expect(types(h.posted)).toContain("updateGrok");
  });

  it("shows a grayed up-to-date status and no update action when current", () => {
    const h = boot();
    const overlay = openAbout(h);
    dispatch(h.window, { type: "grokUpdateStatus", current: "0.2.33", latest: "0.2.33", updateAvailable: false });

    expect(overlay.textContent).toContain("up to date");
    expect(overlay.querySelector('[data-id="aboutUpdateGrok"]')).toBeNull();
  });

  it("falls back to the update check's version when the handshake gave none", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "initialState", useCtrlEnter: false, effort: "", cwd: "/x", extVersion: "1.4.0" });
    // No `initialized` version (native Windows build) — the panel starts at "—".
    dispatch(h.window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build" });
    const overlay = openAbout(h);
    dispatch(h.window, { type: "grokUpdateStatus", current: "0.2.3", latest: "0.2.3", updateAvailable: false });

    const text = overlay.textContent || "";
    expect(text).toContain("Grok Build CLI");
    expect(text).toContain("v0.2.3");
    expect(overlay.querySelector('[data-id="aboutGrokCli"]')!.textContent).not.toContain("—");
  });

  it("the gear no longer has a Version & about entry", () => {
    const h = boot();
    click(h.window, $(h.doc, "gear-btn"));
    expect(items(h.doc).some((el) => (el.textContent || "").includes("Version & about"))).toBe(false);
    expect(items(h.doc).some((el) => (el.textContent || "").includes("Settings"))).toBe(true);
  });

  it("Settings → Advanced exposes the config + logs links and posts the right message", () => {
    const h = boot();
    openSettingsOverlay(h.window, h.doc);
    clickSettingsNav(h.window, h.doc, "Advanced");

    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.querySelector('[data-id="openGlobalConfig"]')).toBeTruthy();
    expect(overlay.querySelector('[data-id="openProjectConfig"]')).toBeTruthy();
    expect(overlay.querySelector('[data-id="showLogs"]')).toBeTruthy();

    click(h.window, overlay.querySelector('[data-id="showLogs"] .settings-action')!);
    expect(types(h.posted)).toContain("showLogs");
  });

  it("Settings → Connectors is a read-only live Grok inventory plus host-owned apps", () => {
    const h = boot();
    openSettingsOverlay(h.window, h.doc);
    clickSettingsNav(h.window, h.doc, "Connectors");
    expect(types(h.posted)).toContain("listMcpServers");
    expect(h.doc.querySelector('#settings-overlay [data-id="mcpCatalog"] .settings-mcp-state')?.textContent).toContain("Loading");
    dispatch(h.window, {
      type: "mcpServers",
      servers: [{ name: "managed_gateway:canva", displayName: "Canva", managed: true, enabled: true, status: "ready", toolCount: 32 }],
      warning: "This list is read-only. Connector enable/disable is machine-global and is not controlled here.",
    });
    expect(h.doc.querySelector("#settings-overlay")?.textContent).toContain("Grok.com connectors");
    expect(h.doc.querySelector("#settings-overlay")?.textContent).toContain("Local Grok connectors");
    expect(h.doc.querySelector("#settings-overlay")?.textContent).not.toContain("grok.com managed");
    expect(h.doc.querySelector("#settings-overlay .settings-switch")).toBeNull();
  });
});

describe("Auto accept mode label (#25 rename)", () => {
  it("labels the auto-approve mode 'Auto accept' and keeps YOLO only in the description", () => {
    const { window, doc } = bootWebview();
    click(window, $(doc, "mode-btn"));
    const pop = $(doc, "mode-popover");
    const yolo = [...pop.querySelectorAll(".mode-popover-item")].find(
      (el) => el.querySelector(".mode-item-label")?.textContent === "Auto accept",
    ) as HTMLElement;
    expect(yolo).toBeTruthy();
    expect(yolo.querySelector(".mode-item-desc")?.textContent).toContain("YOLO");
  });
});

describe("thinking traces toggle (#26)", () => {
  it("applies the hidden body class from initialState (off by default)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "initialState", useCtrlEnter: false, showThinking: false });
    expect(doc.body.classList.contains("thinking-hidden")).toBe(true);
  });

  it("toggles the body class live on a showThinking message (Coding purpose)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "appPurpose", value: "coding" });
    dispatch(window, { type: "showThinking", value: true });
    expect(doc.body.classList.contains("thinking-hidden")).toBe(false);
    dispatch(window, { type: "showThinking", value: false });
    expect(doc.body.classList.contains("thinking-hidden")).toBe(true);
  });

  it("stands in a 'Thinking…' indicator while hidden, still building the real block", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "showThinking", value: false });
    dispatch(window, { type: "thoughtChunk", text: "weighing options…" });
    const ind = doc.querySelector(".thinking-indicator");
    expect(ind).not.toBeNull();
    expect(ind!.querySelectorAll(".blink-dots span").length).toBe(3);
    // the real reasoning block is still built (just CSS-hidden), never lost
    expect(doc.querySelector(".msg.thinking")).not.toBeNull();
  });

  it("shows no stand-in when traces are visible (Coding purpose)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "appPurpose", value: "coding" });
    dispatch(window, { type: "showThinking", value: true });
    dispatch(window, { type: "thoughtChunk", text: "weighing options…" });
    expect(doc.querySelector(".thinking-indicator")).toBeNull();
    expect(doc.querySelector(".msg.thinking")).not.toBeNull();
  });

  it("drops the stand-in when real agent text arrives", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "showThinking", value: false });
    dispatch(window, { type: "thoughtChunk", text: "weighing…" });
    expect(doc.querySelector(".thinking-indicator")).not.toBeNull();
    dispatch(window, { type: "messageChunk", text: "Here's the answer." });
    expect(doc.querySelector(".thinking-indicator")).toBeNull();
  });

  it("exposes a Show thinking traces switch in Settings → General under Coding", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "appPurpose", value: "coding" });
    dispatch(window, { type: "showThinking", value: false });
    expect(doc.body.classList.contains("thinking-hidden")).toBe(true);
    openSettingsOverlay(window, doc);
    const toggle = doc.querySelector('[data-id="showThinking"] .settings-switch') as HTMLElement;
    expect(toggle).toBeTruthy();
    click(window, toggle);
    expect(posted.some((p) => p.type === "setShowThinking" && p.value === true)).toBe(true);
    expect(doc.body.classList.contains("thinking-hidden")).toBe(false); // optimistic flip
  });

  it("exposes a Sound notifications switch in Settings that reflects the setting and posts setSoundNotifications (#59)", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "soundNotifications", value: true }); // host says it's on
    openSettingsOverlay(window, doc);
    clickSettingsNav(window, doc, "Notifications");
    let toggle = doc.querySelector('[data-id="soundNotifications"] .settings-switch') as HTMLElement;
    expect(toggle).toBeTruthy();
    expect(toggle.classList.contains("on")).toBe(true);
    click(window, toggle);
    expect(posted.some((p) => p.type === "setSoundNotifications" && p.value === false)).toBe(true);
    toggle = doc.querySelector('[data-id="soundNotifications"] .settings-switch') as HTMLElement;
    expect(toggle.classList.contains("on")).toBe(false);
  });

  it("defaults local read-aloud off, then speaks completed replies and posts its VS Code setting", () => {
    const spoken: string[] = [];
    let cancellations = 0;
    class Utterance {
      constructor(public text: string) {}
    }
    const { window, posted, doc } = bootWebview({
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() { cancellations += 1; },
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      effort: "",
      cwd: "/x",
      extVersion: "2.0.9",
      readRepliesAloud: false,
    });
    openSettingsOverlay(window, doc);
    clickSettingsNav(window, doc, "Voice");
    const readAloudToggle = () => doc.querySelector('[data-id="readRepliesAloud"] .settings-switch') as HTMLElement;

    expect(readAloudToggle().classList.contains("on")).toBe(false);
    dispatch(window, { type: "readRepliesAloud", value: true });
    expect(readAloudToggle().classList.contains("on")).toBe(true);
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Finished.\n```js\nhidden();\n```" });
    dispatch(window, { type: "agentEnd" });
    expect(spoken).toEqual(["Finished."]);

    click(window, readAloudToggle());
    expect(posted.some((p) => p.type === "setReadRepliesAloud" && p.value === false)).toBe(true);
    expect(cancellations).toBe(2); // once before speaking, once when toggled off
    expect(readAloudToggle().querySelector(".popover-switch.on")).toBeNull();
  });

  it("keeps summarize visible but inert while local read-aloud is off", () => {
    class Utterance {
      constructor(public text: string) {}
    }
    const { window, posted, doc } = bootWebview({
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = { cancel() {}, speak() {} };
      },
    });
    openSettingsOverlay(window, doc);
    clickSettingsNav(window, doc, "Voice");
    const summarize = doc.querySelector('[data-id="summarizeRepliesAloud"]') as HTMLElement;

    expect(summarize).toBeTruthy();
    expect(summarize.classList.contains("is-disabled")).toBe(true);
    expect(summarize.querySelector(".settings-switch")?.hasAttribute("disabled")).toBe(true);
    click(window, summarize.querySelector(".settings-switch")!);
    expect(posted.some((p) => p.type === "setSummarizeRepliesAloud")).toBe(false);
    expect(summarize.querySelector(".settings-switch.on")).toBeNull();
  });

  it("turning local read-aloud off clears and persists summarize in the open popover", () => {
    class Utterance {
      constructor(public text: string) {}
    }
    const { window, posted, doc } = bootWebview({
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = { cancel() {}, speak() {} };
      },
    });
    dispatch(window, { type: "readRepliesAloud", value: true });
    dispatch(window, { type: "summarizeRepliesAloud", value: true });
    posted.length = 0;
    openSettingsOverlay(window, doc);
    clickSettingsNav(window, doc, "Voice");

    expect(doc.querySelector('[data-id="summarizeRepliesAloud"] .settings-switch.on')).not.toBeNull();
    click(window, doc.querySelector('[data-id="readRepliesAloud"] .settings-switch')!);

    expect(posted).toContainEqual({ type: "setReadRepliesAloud", value: false });
    expect(posted).toContainEqual({ type: "setSummarizeRepliesAloud", value: false });
    const summarize = doc.querySelector('[data-id="summarizeRepliesAloud"]') as HTMLElement;
    expect(summarize.classList.contains("is-disabled")).toBe(true);
    expect(summarize.querySelector(".settings-switch.on")).toBeNull();
  });

  it("summarizes only the spoken text and ignores stale summary results", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window, posted } = bootWebview({
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });
    dispatch(window, { type: "readRepliesAloud", value: true });
    dispatch(window, { type: "summarizeRepliesAloud", value: true });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Full reply.\n```ts\nhidden();\n```" });
    dispatch(window, { type: "agentEnd" });

    const request = posted.find((p) => p.type === "summarizeSpeech") as any;
    expect(request.text).toBe("Full reply.");
    expect(spoken).toEqual([]);

    dispatch(window, { type: "questionRequest", req: {
      id: 7,
      questions: [{ question: "Which option should I use?", options: [], multiSelect: false }],
    } });
    const latest = posted.filter((p) => p.type === "summarizeSpeech").at(-1) as any;
    dispatch(window, { type: "speechSummary", requestId: request.requestId, text: "Stale." });
    dispatch(window, { type: "speechSummary", requestId: latest.requestId, text: "Choose an option." });
    expect(spoken).toEqual(["Choose an option."]);
  });

  it("speaks live question text and a tool-detail-free permission cue while waiting", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window } = bootWebview({
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });
    dispatch(window, { type: "readRepliesAloud", value: true });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "I need your input." });
    dispatch(window, { type: "questionRequest", req: {
      id: 8,
      questions: [{ question: "Which database should I use?", options: [], multiSelect: false }],
    } });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "permissionRequest", req: {
      id: 9,
      toolCall: { toolCallId: "secret", kind: "execute", title: "Delete private-file.txt" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }],
    } });

    expect(spoken).toEqual([
      "Which database should I use?",
      "Grok is waiting for your permission. Review the request and choose an option.",
    ]);
    expect(spoken.join(" ")).not.toContain("private-file.txt");
  });

  it("never speaks a completed local reply inside a history replay bracket", () => {
    const spoken: string[] = [];
    class Utterance {
      constructor(public text: string) {}
    }
    const { window } = bootWebview({
      beforeScripts: (w) => {
        (w as any).SpeechSynthesisUtterance = Utterance;
        (w as any).speechSynthesis = {
          cancel() {},
          speak(value: Utterance) { spoken.push(value.text); },
        };
      },
    });
    dispatch(window, { type: "readRepliesAloud", value: true });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "Already heard." });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "historyReplay", active: false });
    expect(spoken).toEqual([]);
  });
});

describe("VS Code session overflow + gear worktree gating", () => {
  const gearItems = (doc: Document) =>
    [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")].map((el) => el.textContent || "");
  const has = (doc: Document, label: string) => gearItems(doc).some((t) => t.includes(label));
  const openOverflow = (window: Window, doc: Document) => {
    click(window, doc.querySelector("#vscode-session-actions .rail-menu-btn")!);
    return [...doc.querySelectorAll(".rail-menu-item")].map((el) => el.textContent || "");
  };

  it("moves Continue to the overflow; worktree sessions keep Apply/Remove in gear", () => {
    const { window, doc } = bootWebview({ vscode: true });
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build" });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Session one", cwd: "/work/repo" });
    click(window, $(doc, "gear-btn"));
    expect(has(doc, "Continue in a new chat")).toBe(false);
    // Old three-entry menu is gone.
    expect(has(doc, "Fork conversation")).toBe(false);
    expect(has(doc, "New worktree session")).toBe(false);
    expect(has(doc, "Apply worktree")).toBe(false);
    expect(has(doc, "Remove worktree")).toBe(false);
    click(window, $(doc, "gear-btn")); // close before opening the separate overflow
    expect(openOverflow(window, doc).some((text) => text.includes("Continue in a new chat"))).toBe(true);

    dispatch(window, { type: "session", sessionId: "s2", models: [], currentModelId: "grok-build", worktree: true });
    dispatch(window, { type: "sessionName", sessionId: "s2", name: "Worktree", cwd: "/work/repo" });
    click(window, $(doc, "gear-btn")); // re-open
    expect(has(doc, "Continue in a new chat")).toBe(false);
    expect(has(doc, "Apply worktree")).toBe(true);
    expect(has(doc, "Remove worktree")).toBe(true);
  });

  it("never shows gear Rewind — rewind is per-message only", () => {
    const { window, doc } = bootWebview({ vscode: true });
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build" });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Session one", cwd: "/work/repo" });
    dispatch(window, { type: "userMessage", text: "hello", chips: [] });
    click(window, $(doc, "gear-btn"));
    expect(has(doc, "Rewind conversation")).toBe(false);
    expect(has(doc, "Continue in a new chat")).toBe(false);
    expect(openOverflow(window, doc).some((text) => text.includes("Continue in a new chat"))).toBe(true);
  });
});

describe("scroll-to-bottom button (#28)", () => {
  // #92: the pin recomputes only after a real user gesture (wheel / touch /
  // scrollbar / paging keys) within the 750ms intent latch. A bare
  // programmatic scrollTop + scroll is the phantom-scroll case the latch
  // exists to ignore, so tests that mean "the user scrolled" must fire a
  // wheel first — same contract as test/stick-to-bottom.dom.test.ts.
  const userScrollTo = (window: any, list: HTMLElement, top: number, height: number, client: number) => {
    Object.defineProperty(list, "scrollHeight", { value: height, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: client, configurable: true });
    Object.defineProperty(list, "scrollTop", { value: top, configurable: true, writable: true });
    list.dispatchEvent(new window.WheelEvent("wheel", { deltaY: top === 0 ? -80 : 80, bubbles: true }));
    list.dispatchEvent(new window.Event("scroll"));
  };

  it("shows when scrolled away from the bottom and hides at the bottom (same threshold)", () => {
    const { window, doc } = bootWebview();
    const btn = $(doc, "scroll-bottom-btn");
    const list = $(doc, "messages");
    userScrollTo(window, list, 0, 1000, 300); // 700px from bottom → visible
    expect(btn.classList.contains("visible")).toBe(true);
    userScrollTo(window, list, 680, 1000, 300); // 20px from bottom (≤40) → hidden
    expect(btn.classList.contains("visible")).toBe(false);
  });

  it("re-pins to the bottom and hides on click", () => {
    const { window, doc } = bootWebview();
    const btn = $(doc, "scroll-bottom-btn");
    const list = $(doc, "messages") as any;
    list.scrollTo = () => {}; // happy-dom has no smooth-scroll impl
    userScrollTo(window, list, 0, 1000, 300);
    expect(btn.classList.contains("visible")).toBe(true);
    click(window, btn);
    expect(btn.classList.contains("visible")).toBe(false);
  });
});

describe("continuous progress indicator (always show something mid-turn)", () => {
  // A *live* progress affordance: Grokking / a running tool group / Thinking /
  // streaming message / an open card. A CSS-hidden thinking
  // block does NOT count (that's the whole point of the stand-in).
  const hasLiveIndicator = (doc: Document) => {
    if (
      doc.querySelector(
        ".grokking, .thinking-indicator, .tool-group.in-progress, .msg.agent, .card:not(.resolved)",
      )
    )
      return true;
    // A thinking block is a live indicator only when traces are shown (a hidden
    // one is display:none via the body class — the stand-in covers that case).
    return !doc.body.classList.contains("thinking-hidden") && !!doc.querySelector(".msg.thinking");
  };

  // A realistic interleaved turn, mirroring how real sessions stream: start →
  // reason → run a tool → reason → narrate → reason → narrate.
  const STEPS: any[] = [
    { type: "agentStart" },
    { type: "thoughtChunk", text: "let me look at the file" },
    { type: "thoughtChunk", text: " and weigh the options" },
    { type: "toolCall", call: { toolCallId: "t1", kind: "read", title: "Read `/a.ts`" } },
    { type: "toolCallUpdate", call: { toolCallId: "t1", status: "completed" } },
    { type: "thoughtChunk", text: "now I'll edit it" },
    { type: "messageChunk", text: "Here's what I'll do: " },
    { type: "thoughtChunk", text: "one more consideration" },
    { type: "messageChunk", text: "and the rest of the answer." },
  ];

  const simulate = (showThinking: boolean) => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "showThinking", value: showThinking });
    dispatch(window, { type: "setBusy", value: true }); // a user turn is in flight
    for (const step of STEPS) {
      dispatch(window, step);
      expect(
        hasLiveIndicator(doc),
        `blank frame after ${step.type} (showThinking=${showThinking})`,
      ).toBe(true);
    }
    dispatch(window, { type: "agentEnd" }); // turn done — idle is allowed now
  };

  it("never leaves a blank frame mid-turn with thinking hidden (the default)", () => {
    simulate(false);
  });

  it("never leaves a blank frame mid-turn with thinking shown", () => {
    simulate(true);
  });

  it("stands in with Grokking when a step would otherwise leave nothing visible", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true }); // unlocked turn, nothing shown yet
    expect(doc.querySelector(".grokking")).toBeNull();
    // A bare completed-tool update with no prior group leaves nothing on its own…
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "x", status: "completed" } });
    expect(doc.querySelector(".grokking")).not.toBeNull(); // …so the safety net stands in
  });

  it("does not stand in during the locked priming window", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true, locked: true }); // priming
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "x", status: "completed" } });
    expect(doc.querySelector(".grokking")).toBeNull();
  });
});

// LaTeX rendering: grok now emits TeX (\(...\) inline, \[...\] display). The
// webview pulls math out before HTML-escaping and renders it via KaTeX. KaTeX
// isn't loaded in the happy-dom harness, so renderMarkdown falls back to the
// escaped raw TeX (.math-raw) — which is exactly what proves the extract/restore
// pipeline runs and that the backslashes survive the inline-markdown pass.
describe("LaTeX math rendering", () => {
  // promptComplete forces a synchronous flushAgent so the markdown is in the DOM.
  const renderAgent = (text: string) => {
    const { doc, window } = bootWebview();
    dispatch(window, { type: "messageChunk", text });
    dispatch(window, { type: "promptComplete" });
    return doc.querySelector(".msg.agent") as HTMLElement;
  };

  it("renders inline \\(...\\) math as a math node, not raw delimiters", () => {
    const el = renderAgent("The area is \\(\\pi r^2\\) exactly.");
    const math = el.querySelector(".math-raw");
    expect(math).not.toBeNull();
    expect(math!.textContent).toBe("\\pi r^2");
    // the literal delimiters must NOT survive into the rendered text
    expect(el.textContent).not.toContain("\\(");
    expect(el.textContent).not.toContain("\\)");
  });

  it("renders display \\[...\\] math as a block", () => {
    const el = renderAgent("Result:\n\\[E = mc^2\\]\ndone");
    const math = el.querySelector(".math-raw.math-display");
    expect(math).not.toBeNull();
    expect(math!.textContent).toBe("E = mc^2");
  });

  it("preserves a matrix (backslashes + braces) through the markdown pipeline", () => {
    const el = renderAgent("\\[\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}\\]");
    const math = el.querySelector(".math-raw.math-display") as HTMLElement;
    expect(math).not.toBeNull();
    expect(math.textContent).toContain("\\begin{pmatrix}");
    expect(math.textContent).toContain("&");
  });

  it("leaves prose with bare dollar amounts untouched", () => {
    const el = renderAgent("it costs $5 and then $10");
    expect(el.querySelector(".math-raw")).toBeNull();
    expect(el.textContent).toContain("it costs $5 and then $10");
  });

  it("strips \\label{...} so an align block doesn't render a red error (KaTeX has no \\ref)", () => {
    const el = renderAgent(
      "\\[\\begin{align} f(x) &= x^2 \\label{eq:quadratic} \\\\ f'(x) &= 2x \\end{align}\\]",
    );
    const math = el.querySelector(".math-raw.math-display") as HTMLElement;
    expect(math).not.toBeNull();
    // the unsupported \label macro is gone, the equation body survives
    expect(math.textContent).not.toContain("\\label");
    expect(math.textContent).not.toContain("eq:quadratic");
    expect(math.textContent).toContain("\\begin{align}");
    expect(math.textContent).toContain("f(x) &= x^2");
  });
});

describe("Mermaid diagram rendering", () => {
  // mermaid (the 3.3 MB browser bundle) is never loaded in happy-dom, so these
  // exercise the fallback: a ```mermaid fence becomes a tagged .mermaid-block
  // whose source stays readable until the real lib swaps in an SVG at runtime.
  const renderAgent = (text: string) => {
    const { doc, window } = bootWebview();
    dispatch(window, { type: "messageChunk", text });
    dispatch(window, { type: "promptComplete" });
    return doc.querySelector(".msg.agent") as HTMLElement;
  };

  it("turns a ```mermaid fence into a .mermaid-block, not a plain code block", () => {
    const el = renderAgent(
      "Here:\n```mermaid\nflowchart TD\n    A[Start] --> B[End]\n```\ndone",
    );
    const block = el.querySelector(".mermaid-block");
    expect(block).not.toBeNull();
    // mermaid isn't loaded under happy-dom, so it must stay in the fallback state
    expect(block!.getAttribute("data-mermaid-state")).toBeNull();
  });

  it("keeps the diagram source readable in the fallback", () => {
    const el = renderAgent("```mermaid\nsequenceDiagram\n    A->>B: hi\n```");
    const src = el.querySelector(".mermaid-block .mermaid-src") as HTMLElement;
    expect(src).not.toBeNull();
    expect(src.textContent).toContain("sequenceDiagram");
    expect(src.textContent).toContain("A->>B: hi");
  });

  it("leaves a non-mermaid fenced block as a normal code block", () => {
    const el = renderAgent("```js\nconst x = 1;\n```");
    expect(el.querySelector(".mermaid-block")).toBeNull();
    const code = el.querySelector(".code-block") as HTMLElement;
    expect(code).not.toBeNull();
    expect(code.textContent).toContain("const x = 1;");
  });

  it("does not treat a half-streamed (unclosed) mermaid fence as a diagram", () => {
    const el = renderAgent("```mermaid\nflowchart TD\n    A --> B");
    expect(el.querySelector(".mermaid-block")).toBeNull();
    // the raw text shows through until the closing fence arrives
    expect(el.textContent).toContain("flowchart TD");
  });

  // A single markdown blank line around a fenced block must NOT render as a doubled
  // gap. The block placeholder used to fall through to the paragraph path and get
  // wrapped in <br><br> before/after; on top of the .code-block div's own margin
  // that read as ~2 blank lines (the model only sent one). It's now emitted as its
  // own block, like tables/math, so no <br> hugs the code block.
  it("does not glue <br> around a code block (single blank line, not doubled)", () => {
    const el = renderAgent("Folders:\n\n```\ndocs/\n```\n\nNo other dirs.");
    const block = el.querySelector(".code-block") as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.previousElementSibling?.tagName).not.toBe("BR");
    expect(block.nextElementSibling?.tagName).not.toBe("BR");
    expect(el.textContent).toContain("Folders:");
    expect(el.textContent).toContain("No other dirs.");
  });
});

// Nested code blocks (issue #20): an outer fence of 4+ backticks must survive so
// it can wrap an inner ``` block. The old regex hardcoded exactly 3 backticks for
// both fences, so it ate the first 3 of a 5-backtick outer fence and closed early
// on the inner ```python fence — splitting one block into several and dropping
// backticks. The fix matches a 3+ backtick fence and requires the close to be the
// same length, so shorter inner fences can't terminate the outer block.
describe("nested code blocks (issue #20)", () => {
  const renderAgent = (text: string) => {
    const { doc, window } = bootWebview();
    dispatch(window, { type: "messageChunk", text });
    dispatch(window, { type: "promptComplete" });
    return doc.querySelector(".msg.agent") as HTMLElement;
  };

  const NESTED_5 =
    "`````text\n" +
    "Here is an example of nested code blocks.\n\n" +
    "```python\n" +
    "def hello():\n" +
    '    print("Hello, world!")\n' +
    "```\n\n" +
    "The outer block uses 5 backticks.\n" +
    "`````";

  it("keeps a 5-backtick outer fence as ONE code block", () => {
    const el = renderAgent(NESTED_5);
    expect(el.querySelectorAll(".code-block").length).toBe(1);
  });

  it("preserves the inner ``` fence literally inside the outer block", () => {
    const el = renderAgent(NESTED_5);
    const code = el.querySelector(".code-block") as HTMLElement;
    expect(code.textContent).toContain("```python");
    expect(code.textContent).toContain("def hello():");
    // the inner closing fence + the outer prose both live inside the one block
    expect(code.textContent).toContain("The outer block uses 5 backticks.");
  });

  it("handles a 4-backtick outer fence the same way", () => {
    const el = renderAgent(
      "````\n```js\nconst x = 1;\n```\n````",
    );
    expect(el.querySelectorAll(".code-block").length).toBe(1);
    const code = el.querySelector(".code-block") as HTMLElement;
    expect(code.textContent).toContain("```js");
    expect(code.textContent).toContain("const x = 1;");
  });

  it("still renders a plain 3-backtick block (the N=3 case)", () => {
    const el = renderAgent("```js\nconst y = 2;\n```");
    expect(el.querySelectorAll(".code-block").length).toBe(1);
    expect((el.querySelector(".code-block") as HTMLElement).textContent)
      .toContain("const y = 2;");
  });

  it("renders two sequential blocks of different fence lengths", () => {
    const el = renderAgent(
      "```js\na\n```\nthen\n`````md\n```inner```\n`````",
    );
    const blocks = el.querySelectorAll(".code-block");
    expect(blocks.length).toBe(2);
    expect(blocks[0].textContent).toContain("a");
    expect(blocks[1].textContent).toContain("```inner```");
  });
});

describe("math / diagram export actions (step b)", () => {
  const renderAgent = (window: any, text: string) => {
    dispatch(window, { type: "messageChunk", text });
    dispatch(window, { type: "promptComplete" });
    return window.document.querySelector(".msg.agent") as HTMLElement;
  };

  it("wraps display math in an export host with Copy/Download/Open carrying the source", () => {
    const { window } = bootWebview();
    const el = renderAgent(window, "Result:\n\\[E = mc^2\\]\ndone");
    const host = el.querySelector(".math-export") as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute("data-export-kind")).toBe("latex");
    expect(host.getAttribute("data-export-src")).toBe("E = mc^2");
    const acts = [...host.querySelectorAll(".expr-btn")].map((b) => b.getAttribute("data-expr-act"));
    expect(acts).toEqual(["copy", "download", "open"]);
  });

  it("does NOT add export actions to inline math", () => {
    const { window } = bootWebview();
    const el = renderAgent(window, "area is \\(\\pi r^2\\) ok");
    expect(el.querySelector(".math-export")).toBeNull();
    expect(el.querySelector(".expr-actions")).toBeNull();
  });

  it("Copy writes the original source TeX to the clipboard", () => {
    const { window } = bootWebview();
    let copied: string | null = null;
    Object.defineProperty((window as any).navigator, "clipboard", {
      value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
      configurable: true,
    });
    const el = renderAgent(window, "\\[a^2 + b^2 = c^2\\]");
    const copyBtn = el.querySelector('.expr-btn[data-expr-act="copy"]') as HTMLElement;
    click(window, copyBtn);
    expect(copied).toBe("a^2 + b^2 = c^2");
  });

  it("Download posts an exportExpr message with transparent dark + light SVG variants", () => {
    const { window, posted } = bootWebview();
    const el = renderAgent(window, "\\[x^2\\]");
    const host = el.querySelector(".math-export") as HTMLElement;
    // happy-dom has no MathJax, so stand in a minimal SVG for the rendered output.
    const svg = (window as any).document.createElementNS("http://www.w3.org/2000/svg", "svg");
    host.insertBefore(svg, host.firstChild);
    click(window, host.querySelector('.expr-btn[data-expr-act="download"]') as HTMLElement);
    const msg = posted.find((p) => p.type === "exportExpr");
    expect(msg).toBeTruthy();
    expect(msg!.action).toBe("download");
    expect(msg!.kind).toBe("latex");
    // two SVG variants for the host to quick-pick between; neither paints a bg.
    expect(typeof msg!.svgDark).toBe("string");
    expect(typeof msg!.svgLight).toBe("string");
    expect(msg!.svgDark as string).not.toContain("background:");
  });
});

// The composer's active-editor context chip mirrors Claude Code's: full file
// name (CSS ellipsis handles pathological lengths — no JS truncation), plus a
// live `:start-end` line-range suffix while the user has an editor selection.
describe("active-editor context chip in the composer", () => {
  const implicitChip = (over: Record<string, unknown> = {}) => ({
    id: "implicit:/ws/vitest.perf.config.ts",
    path: "/ws/vitest.perf.config.ts",
    relPath: "vitest.perf.config.ts",
    hidden: false,
    ...over,
  });

  it("shows the full file name — no 10-char JS truncation", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "chips", chips: [implicitChip()] });
    const span = doc.querySelector("#chips .chip span")!;
    expect(span.textContent).toBe("vitest.perf.config.ts");
  });

  it("appends the selected line range to the label and tooltip", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "chips", chips: [implicitChip({ selectionStart: 8, selectionEnd: 15 })] });
    const chip = doc.querySelector("#chips .chip") as HTMLElement;
    expect(chip.querySelector("span")!.textContent).toBe("vitest.perf.config.ts:8-15");
    expect(chip.getAttribute("title")).toBe("/ws/vitest.perf.config.ts (lines 8-15)");
  });

  it("labels a single-line selection with one line number", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "chips", chips: [implicitChip({ selectionStart: 8, selectionEnd: 8 })] });
    const chip = doc.querySelector("#chips .chip") as HTMLElement;
    expect(chip.querySelector("span")!.textContent).toBe("vitest.perf.config.ts:8");
    expect(chip.getAttribute("title")).toBe("/ws/vitest.perf.config.ts (line 8)");
  });

  it("escapes HTML in the file name instead of injecting it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "chips",
      chips: [implicitChip({ relPath: "<img src=x>.ts", path: "/ws/<img src=x>.ts", id: "implicit:/ws/x" })],
    });
    const chip = doc.querySelector("#chips .chip") as HTMLElement;
    expect(chip.querySelector("span")!.textContent).toBe("<img src=x>.ts");
    expect(chip.querySelector("img")).toBeNull();
  });
});

// A selection sent via the "Add Selection to Grok" command is an EXPLICIT
// attachment (id "explicit:…"), so it belongs in the top attachments row like
// any other attached file — removable, with its line range on the label. Only
// the ambient active-editor chip (implicit) stays in the bottom toolbar.
describe("explicit selection chip placement (top attachments row)", () => {
  const explicitSel = {
    id: "explicit:/repo/src/a.ts:8-12:1",
    path: "/repo/src/a.ts",
    relPath: "src/a.ts",
    selectionStart: 8,
    selectionEnd: 12,
    hidden: false,
  };

  it("renders a command-sent selection in the top row with its range + a remove button", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "chips", chips: [explicitSel] });

    // Top attachments area, NOT the bottom toolbar.
    expect(doc.querySelector("#chips .chip")).toBeNull();
    const row = doc.querySelector("#attachments .attachment") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector("span")!.textContent).toBe("a.ts:8-12"); // range survives the move to the top
    expect(row.title).toBe("/repo/src/a.ts (lines 8-12)");

    // Removable like any other attachment (not a hide toggle).
    const rm = row.querySelector(".attachment-remove") as HTMLElement;
    expect(rm).not.toBeNull();
    click(window, rm);
    expect(posted.find((m) => m.type === "removeChip" && m.id === explicitSel.id)).toBeTruthy();
  });

  it("keeps the ambient active-editor selection in the bottom toolbar", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "chips",
      chips: [{ ...explicitSel, id: "implicit:/repo/src/a.ts" }],
    });
    expect(doc.querySelector("#attachments .attachment")).toBeNull();
    const chip = doc.querySelector("#chips .chip") as HTMLElement;
    expect(chip.querySelector("span")!.textContent).toBe("a.ts:8-12");
  });
});

// Opening the panel must land the caret in the input — no first click needed
// (mirrors Claude Code / Codex). Boot focuses directly (the webview is rebuilt
// on every re-show); a window "focus" landing on <body> is forwarded to the
// input, but never stolen from a real control.
describe("composer input focus (caret ready on open)", () => {
  it("focuses the input on boot, so typing works without a first click", () => {
    const { doc } = bootWebview();
    expect(doc.activeElement).toBe($(doc, "input"));
  });

  it("forwards window focus that landed on <body> to the input", () => {
    const { window, doc } = bootWebview();
    ($(doc, "input") as HTMLTextAreaElement).blur(); // focus falls back to <body>
    expect(doc.activeElement).toBe(doc.body);

    window.dispatchEvent(new (window as any).Event("focus"));
    expect(doc.activeElement).toBe($(doc, "input"));
  });

  it("does not steal focus from a control the user actually focused", () => {
    const { window, doc } = bootWebview();
    const btn = $(doc, "history-btn") as HTMLButtonElement;
    btn.focus();

    window.dispatchEvent(new (window as any).Event("focus"));
    expect(doc.activeElement).toBe(btn);
  });

  it("lands the caret in the input on the new-session click", () => {
    const { window, doc } = bootWebview();
    const newBtn = $(doc, "new-btn") as HTMLButtonElement;
    newBtn.focus(); // the click leaves focus on the button
    click(window, newBtn);
    expect(doc.activeElement).toBe($(doc, "input"));
  });

  it("lands the caret in the input on a session swap (clearMessages)", () => {
    // Both a history-row re-focus and a disk restore reach the webview as the
    // host's clearMessages; the user just clicked a popover row, so the caret
    // should end up ready in the box.
    const { window, doc } = bootWebview();
    ($(doc, "input") as HTMLTextAreaElement).blur();
    dispatch(window, { type: "clearMessages" });
    expect(doc.activeElement).toBe($(doc, "input"));
  });
});

describe("gear entry: Move view (Settings → Advanced)", () => {
  function openAdvancedSettings(window: Window, doc: Document) {
    openSettingsOverlay(window, doc);
    clickSettingsNav(window, doc, "Advanced");
  }
  const itemByLabel = (doc: Document, label: string) =>
    [...doc.querySelectorAll("#settings-overlay .settings-row")].find((el) =>
      (el.textContent || "").includes(label),
    ) as HTMLElement | undefined;

  it("offers one item, the host's own picker, where the secondary side bar was refused", () => {
    // Was three destinations naming our own containers. They went because an
    // editor that refuses our secondary-side-bar container also ignores where
    // the other two declared they live, so all three landed in the same place —
    // and an editor that accepts it already has its own Move To on the view's
    // context menu, which does more than ours could.
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      capabilities: {
        uploadFile: true,
        remoteVoice: true,
        relocateView: true,
        secondarySideBar: false,
        showOutput: true,
      },
    });
    openAdvancedSettings(window, doc);
    const item = itemByLabel(doc, "Move view…");
    expect(item).toBeTruthy();
    click(window, item!.querySelector(".settings-action")!);
    // `pick` maps to no container by design, so the host falls through to its
    // own picker — the only mover that targets a LOCATION.
    expect(posted).toContainEqual({ type: "moveView", location: "pick" });
  });

  it("still shows Show logs when the host sends no capability flags (v3.1.0)", () => {
    // Compatibility contract: the web client is always new; the extension may
    // be an older install that never emitted relocateView/showOutput. That item
    // existed ungated before the flags — absent must still mean supported.
    //
    // Move view is the deliberate exception, and its polarity is the opposite:
    // an absent `secondarySideBar` means the editor HAS one, and an editor with
    // a secondary side bar has its own Move To. So absent means no section.
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      // No relocateView / showOutput — mirrors released v3.1.0 hosts.
      capabilities: { uploadFile: true, remoteVoice: true },
    });
    openAdvancedSettings(window, doc);
    expect(itemByLabel(doc, "Show extension logs")).toBeTruthy();
    expect(itemByLabel(doc, "Move view")).toBeUndefined();
    click(window, itemByLabel(doc, "Show extension logs")!.querySelector(".settings-action")!);
    expect(posted).toContainEqual({ type: "showLogs" });
  });

  it("still shows Show logs when capabilities is omitted entirely", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      // No capabilities object at all (hostCaps stays {}).
    });
    openAdvancedSettings(window, doc);
    expect(itemByLabel(doc, "Show extension logs")).toBeTruthy();
    expect(itemByLabel(doc, "Move view")).toBeUndefined();
  });

  it("hides Move view and Show logs only when the host opts out with false (desktop)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      useCtrlEnter: false,
      capabilities: { uploadFile: true, remoteVoice: true, relocateView: false, showOutput: false },
    });
    openAdvancedSettings(window, doc);
    expect(itemByLabel(doc, "Move view")).toBeUndefined();
    expect(itemByLabel(doc, "Show extension logs")).toBeUndefined();
    // Config paths still work on desktop.
    expect(itemByLabel(doc, "Open global config")).toBeTruthy();
  });
});

describe("context popover (donut click, #39)", () => {
  it("opens on donut click with the context line, closes on outside click", () => {
    const { window, doc, posted } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 44123 } });

    click(window, $(doc, "donut"));
    const pop = $(doc, "context-popover");
    expect((pop as any).hidden).toBe(false);
    expect(pop.textContent).toContain("Context used");
    expect(posted).toContainEqual({ type: "refreshContextDetails" });

    click(window, $(doc, "messages"));
    expect((pop as any).hidden).toBe(true);
  });

  it("renders a structured session/info breakdown without changing adapter occupancy", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, { type: "contextUsage", used: 16017, window: 512000 });
    dispatch(window, {
      type: "contextUsage",
      used: 16017,
      window: 512000,
      systemPromptTokens: 1039,
      toolDefinitionsTokens: 812,
      messageTokens: 12166,
      freeTokens: 495983,
      autoCompactThresholdPercent: 92,
      categories: [{ label: "Skills", tokens: 1200 }, { label: "MCP", tokens: 800, detail: "2 servers" }],
    });
    click(window, $(doc, "donut"));
    const text = $(doc, "context-popover").textContent!;
    expect(text).toContain("In this window");
    expect(text).toContain("System");
    expect(text).toContain("Messages");
    expect(text).toContain("Free");
    expect(text).toContain("Auto-compact at");
    expect(text).toContain("Already counted above");
    expect(text).toContain("Tool definitions");
    expect(text).not.toContain("Tool definitions (");
    expect(text).toContain("Skills");
    expect(text).toContain("MCP (2 servers)");
    // 16,017 used − 1,039 system − 12,166 messages = 2,812 overhead.
    expect(text).toMatch(/Reasoning\/overhead\s*2,812/);
    const windowAt = text.indexOf("In this window");
    const countedAt = text.indexOf("Already counted above");
    expect(text.indexOf("System")).toBeGreaterThan(windowAt);
    expect(text.indexOf("Messages")).toBeGreaterThan(windowAt);
    expect(text.indexOf("Messages")).toBeLessThan(countedAt);
    expect(text.indexOf("Reasoning/overhead")).toBeLessThan(countedAt);
    expect(text.indexOf("Tool definitions")).toBeGreaterThan(countedAt);
    expect(text.indexOf("Skills")).toBeGreaterThan(countedAt);
  });

  it("does not mix a used-only occupancy update into a stale session/info snapshot", () => {
    // Authoritative 100 / 10 system / 80 messages → overhead 10. Keep the
    // group (overhead stays 10, not an invented 40) and re-fetch session/info.
    const { window, doc, posted } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "contextUsage",
      used: 100,
      window: 200000,
      systemPromptTokens: 10,
      messageTokens: 80,
      freeTokens: 199890,
      toolDefinitionsTokens: 50,
      categories: [{ label: "Skills", tokens: 20 }],
    });
    click(window, $(doc, "donut"));
    const first = $(doc, "context-popover").textContent!;
    expect(first).toMatch(/Context used\s*100/);
    expect(first).toContain("In this window");
    expect(first).toMatch(/System\s*10/);
    expect(first).toMatch(/Messages\s*80/);
    expect(first).toMatch(/Reasoning\/overhead\s*10/);
    expect(first).toMatch(/Free\s*199,890/);
    expect(first).toContain("Already counted above");
    expect(first).toContain("Tool definitions");
    expect(first).toContain("Skills");

    posted.length = 0;
    dispatch(window, { type: "contextUsage", used: 130 });
    const after = $(doc, "context-popover").textContent!;
    expect(after).toMatch(/Context used\s*130/);
    expect(after).toContain("In this window");
    expect(after).toMatch(/System\s*10/);
    expect(after).toMatch(/Messages\s*80/);
    expect(after).toMatch(/Reasoning\/overhead\s*10/);
    expect(after).not.toMatch(/Reasoning\/overhead\s*40/);
    expect(after).toContain("Already counted above");
    expect(posted).toContainEqual({ type: "refreshContextDetails" });
  });

  it("keeps the snapshot when a used-only frame restates the same used", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "contextUsage",
      used: 100,
      window: 200000,
      systemPromptTokens: 10,
      messageTokens: 80,
      freeTokens: 199890,
    });
    click(window, $(doc, "donut"));
    dispatch(window, { type: "contextUsage", used: 100 });
    const text = $(doc, "context-popover").textContent!;
    expect(text).toContain("In this window");
    expect(text).toMatch(/Reasoning\/overhead\s*10/);
    expect(text).toMatch(/Free\s*199,890/);
  });

  it("keeps the snapshot after promptComplete moves used and re-fetches session/info", () => {
    const { window, doc, posted } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "contextUsage",
      used: 100,
      window: 200000,
      systemPromptTokens: 10,
      messageTokens: 80,
      freeTokens: 199890,
    });
    click(window, $(doc, "donut"));
    expect($(doc, "context-popover").textContent).toContain("In this window");
    posted.length = 0;
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 130 } });
    const text = $(doc, "context-popover").textContent!;
    expect(text).toMatch(/Context used\s*130/);
    expect(text).toContain("In this window");
    expect(text).toMatch(/Reasoning\/overhead\s*10/);
    expect(text).toContain("Free");
    expect(posted).toContainEqual({ type: "refreshContextDetails" });
  });

  it("shows Reasoning/overhead only when used exceeds system + messages", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "contextUsage",
      used: 25000,
      window: 100000,
      systemPromptTokens: 2000,
      toolDefinitionsTokens: 8000,
      messageTokens: 20000,
      freeTokens: 75000,
    });
    click(window, $(doc, "donut"));
    const text = $(doc, "context-popover").textContent!;
    expect(text).toMatch(/Reasoning\/overhead\s*3,000/);
    const windowAt = text.indexOf("In this window");
    const countedAt = text.indexOf("Already counted above");
    expect(text.indexOf("Reasoning/overhead")).toBeGreaterThan(windowAt);
    expect(text.indexOf("Reasoning/overhead")).toBeLessThan(countedAt);
    expect(text.indexOf("Tool definitions")).toBeGreaterThan(countedAt);
  });

  it("labels Tool definitions with the CLI's tool count when present", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "contextUsage",
      used: 24273,
      window: 500000,
      systemPromptTokens: 1516,
      toolDefinitionsTokens: 8471,
      toolDefinitionsCount: 51,
      messageTokens: 22757,
      freeTokens: 475727,
      categories: [{ label: "Skills", tokens: 4886, detail: "51 skills" }],
    });
    click(window, $(doc, "donut"));
    const text = $(doc, "context-popover").textContent!;
    expect(text).toContain("Tool definitions (51 tools)");
    expect(text).not.toContain("Reasoning/overhead");
    expect(text.indexOf("Messages")).toBeLessThan(text.indexOf("Already counted above"));
    expect(text.indexOf("Tool definitions")).toBeGreaterThan(text.indexOf("Already counted above"));
    expect(text.indexOf("Skills (51 skills)")).toBeGreaterThan(text.indexOf("Already counted above"));
  });

  it("labels Claude and Codex occupancy as context used, not last prompt", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "session",
      sessionId: "s1",
      provider: "claude",
      currentModelId: "claude-opus-4-6",
      models: [{ modelId: "claude-opus-4-6", name: "Opus", totalContextTokens: 1000000 }],
    });
    dispatch(window, { type: "contextUsage", used: 389000, window: 1000000 });
    click(window, $(doc, "donut"));
    const text = $(doc, "context-popover").textContent!;
    expect(text).toContain("Context used");
    expect(text).not.toContain("Last prompt");
    expect(text).not.toMatch(/last turn's prompt size/i);
    expect($(doc, "donut").title).toMatch(/^Context usage —/);
  });

  it("offers Compact, disabled until there is context to compact", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    click(window, $(doc, "donut"));
    const pop = $(doc, "context-popover");
    const act = pop.querySelector(".context-compact") as HTMLElement;
    // Compact moved here from the gear menu: it's a CONTEXT action, so it lives
    // on the surface showing the number that motivates it — and directly under
    // the context line, not stranded below the billing sections.
    expect(act).not.toBeNull();
    expect(act.classList.contains("disabled")).toBe(true); // 0 tokens — nothing to compact
    const rows = [...pop.children];
    expect(rows.indexOf(act)).toBe(rows.findIndex((e) => e.textContent!.includes("Context used")) + 1);
    // A <button> would drag native chrome into the popover; every row is a div.
    expect(act.tagName).toBe("DIV");
  });

  it("Compact sends /compact bare once there is context", () => {
    const { window, doc, posted } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 44123 } });
    click(window, $(doc, "donut"));
    const act = $(doc, "context-popover").querySelector(".context-compact") as HTMLElement;
    expect(act.classList.contains("disabled")).toBe(false);
    click(window, act);
    expect(posted).toContainEqual({ type: "send", text: "/compact", bare: true });
  });
});

describe("context popover — usage breakdown (#53)", () => {
  it("shows no usage rows until the CLI reports usage", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 1000 } });
    click(window, $(doc, "donut"));
    const txt = $(doc, "context-popover").textContent!;
    expect(txt).toContain("Context used");
    // An older CLI sends no `usage` — show the context row alone rather than a
    // wall of zeros ("cache fields only when the CLI reports them", #53).
    expect(txt).not.toContain("Last turn");
    expect(txt).not.toContain("Session total");
  });

  it("leads with Session total and never shows a cache-creation row", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 16394, outputTokens: 160, cachedReadTokens: 16256, reasoningTokens: 127 },
      session: { inputTokens: 32722, outputTokens: 202, cachedReadTokens: 32256 },
    });
    click(window, $(doc, "donut"));
    const txt = $(doc, "context-popover").textContent!;
    // Session total is the number you act on, so it leads; Last turn is detail.
    expect(txt.indexOf("Session total")).toBeGreaterThan(-1);
    expect(txt.indexOf("Session total")).toBeLessThan(txt.indexOf("Last turn"));
    expect(txt.replace(/[,\s\u00a0\u202f]/g, "")).toContain("32722");
    expect(txt).toContain("cache read");
    expect(txt).not.toContain("Cost"); // no reported cost => no fake $0 row
    // No cache-CREATION field exists anywhere in the CLI — it must not be faked.
    expect(txt.toLowerCase()).not.toContain("cache creation");
  });

  it("Last turn is collapsed by default and expands on click", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 16394, outputTokens: 160, modelCalls: 3 },
      session: { inputTokens: 32722, outputTokens: 202 },
    });
    click(window, $(doc, "donut"));
    const hdr = $(doc, "context-popover").querySelector(".popover-section-toggle") as HTMLElement;
    expect(hdr).not.toBeNull();
    const body = hdr.nextElementSibling as HTMLElement;
    expect(body.hidden).toBe(true); // diagnostics stay out of the way by default

    click(window, hdr);
    expect(body.hidden).toBe(false);
    // "Model calls" is what makes billed input (which dwarfs context) make sense.
    expect(body.textContent).toContain("Model calls");
    expect(body.textContent).toContain("3");
  });

  it("a restore-only session total (no turn yet) shows the session section alone", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    // Cold restore: the host seeds from ITS store, so there's no `turn`.
    dispatch(window, { type: "usage", session: { inputTokens: 500, outputTokens: 40 } });
    click(window, $(doc, "donut"));
    const txt = $(doc, "context-popover").textContent!;
    expect(txt).toContain("Session total");
    expect(txt).not.toContain("Last turn");
  });

  it("shows reported session and turn cost at Grok's 10^10-ticks-per-USD scale", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 16000, costUsdTicks: 80_000_000 },
      session: { inputTokens: 32000, costUsdTicks: 180_384_000 },
    });
    click(window, $(doc, "donut"));
    const pop = $(doc, "context-popover");
    expect(pop.textContent).toContain("$0.018038");

    const hdr = pop.querySelector(".popover-section-toggle") as HTMLElement;
    click(window, hdr);
    expect((hdr.nextElementSibling as HTMLElement).textContent).toContain("$0.008");
  });

  it("omits an incomplete session cost while retaining the current turn's cost", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 16000, costUsdTicks: 80_000_000 },
      session: { inputTokens: 32000 },
    });
    click(window, $(doc, "donut"));
    const pop = $(doc, "context-popover");
    const sessionSection = pop.querySelector(".popover-section") as HTMLElement;
    expect(sessionSection.textContent).toBe("Session total");
    expect(sessionSection.nextElementSibling?.textContent).toContain("Input");

    const hdr = pop.querySelector(".popover-section-toggle") as HTMLElement;
    const sessionText: string[] = [];
    for (let el = sessionSection.nextElementSibling; el && el !== hdr; el = el.nextElementSibling) {
      sessionText.push(el.textContent ?? "");
    }
    expect(sessionText.join(" ")).not.toContain("Cost");
    click(window, hdr);
    expect((hdr.nextElementSibling as HTMLElement).textContent).toContain("$0.008");
  });

  it("clears both usage ledgers when the local view switches sessions", () => {
    const { window, doc } = bootWebview();
    // The breakdown is a CODING-mode surface: knowledge work shows the number
    // and Compact and stops, because the rows below are exactly the "tool
    // details" that mode hides everywhere else. These tests are about the
    // rows, so they must say which mode they are in.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 16000, costUsdTicks: 80_000_000 },
      session: { inputTokens: 32000, costUsdTicks: 180_384_000 },
    });

    dispatch(window, { type: "clearMessages" });
    click(window, $(doc, "donut"));

    const text = $(doc, "context-popover").textContent!;
    expect(text).not.toContain("Session total");
    expect(text).not.toContain("Last turn");
    expect(text).not.toContain("Cost");
  });
});

describe("agent message footer (copy + timestamp) — one per turn", () => {
  it("keeps the footer only on the turn's last narration segment, revealed at turn end", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "do things" });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "first I'll look around" });
    // A tool group splits the prose into a second .msg.agent segment.
    dispatch(window, { type: "toolCall", call: { toolCallId: "t1", title: "read_file", kind: "read" } });
    dispatch(window, { type: "messageChunk", text: "here is the conclusion" });

    // Mid-turn: the (single) footer exists but is HIDDEN — no copy icons
    // flickering through the conversation while the agent works.
    let agentFooters = [...doc.querySelectorAll(".msg.agent .msg-actions")] as HTMLElement[];
    expect(agentFooters).toHaveLength(1);
    expect(agentFooters[0].hidden).toBe(true);

    dispatch(window, { type: "promptComplete", meta: {} }); // commits the bubble (real turns always emit it)
    dispatch(window, { type: "agentEnd" });

    agentFooters = [...doc.querySelectorAll(".msg.agent .msg-actions")] as HTMLElement[];
    expect(agentFooters).toHaveLength(1);
    expect(agentFooters[0].hidden).toBe(false);
    // …and it sits on the LAST segment (the conclusion), not the first.
    expect(agentFooters[0].closest(".msg.agent")!.textContent).toContain("here is the conclusion");
    // The user bubble keeps its own footer, visible immediately.
    expect(doc.querySelectorAll(".msg.user .msg-actions")).toHaveLength(1);
  });

  it("each turn keeps its own footer — a new turn doesn't steal the previous one", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "q1" });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "answer one" });
    dispatch(window, { type: "promptComplete", meta: {} });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "userMessage", text: "q2" });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "answer two" });
    dispatch(window, { type: "promptComplete", meta: {} });
    dispatch(window, { type: "agentEnd" });

    expect(doc.querySelectorAll(".msg.agent .msg-actions")).toHaveLength(2);
  });

  it("uses original user and turn-end times during history replay", () => {
    const { window, doc } = bootWebview();
    const userAt = Date.UTC(2026, 6, 30, 6, 14);
    const agentAt = Date.UTC(2026, 6, 30, 6, 19);

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "yesterday's question", timestampMs: userAt });
    dispatch(window, { type: "messageChunk", text: "yesterday's answer" });
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "turn_completed" },
      timestampMs: agentAt,
    });
    dispatch(window, { type: "historyReplay", active: false });

    expect(doc.querySelector(".msg.user .msg-timestamp")!.textContent).toBe(clock(userAt));
    expect(doc.querySelector(".msg.agent .msg-timestamp")!.textContent).toBe(clock(agentAt));
  });

  it("leaves replay timestamps blank when an old CLI sends no timing metadata", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "old question" });
    dispatch(window, { type: "messageChunk", text: "old answer" });
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "turn_completed" },
    });
    dispatch(window, { type: "historyReplay", active: false });

    expect(doc.querySelector(".msg.user .msg-timestamp")!.textContent).toBe("");
    expect(doc.querySelector(".msg.agent .msg-timestamp")!.textContent).toBe("");
  });

  it("continues stamping live messages with the current clock", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "live question" });
    dispatch(window, { type: "messageChunk", text: "live answer" });
    dispatch(window, { type: "agentEnd" });

    expect(doc.querySelector(".msg.user .msg-timestamp")!.textContent).not.toBe("");
    expect(doc.querySelector(".msg.agent .msg-timestamp")!.textContent).not.toBe("");
  });
});

describe("user prompt counter parity (interjections never count)", () => {
  const messageIndex = (doc: Document, text: string) =>
    [...$(doc, "messages").children].findIndex((el) => el.textContent?.includes(text));

  it("keeps the real chat.js replay counter aligned with the host across an interjection", () => {
    const { window, doc } = bootWebview();
    const interjection = "The user sent a message while you were working:\nrevise the plan";
    const replayedUserMessages = ["first prompt", interjection, "second prompt"];
    const hostCount = replayedUserMessages.filter(countsAsUserBubble).length;

    dispatch(window, {
      type: "planHistoryQueue",
      plans: [{ text: "second plan", verdict: "rejected", afterUserMessage: 2 }],
    });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: replayedUserMessages[0] });
    dispatch(window, { type: "messageChunk", text: "first answer" });
    dispatch(window, { type: "userMessageChunk", text: replayedUserMessages[1] });
    dispatch(window, { type: "messageChunk", text: "continued answer" });
    dispatch(window, { type: "userMessageChunk", text: replayedUserMessages[2] });
    dispatch(window, { type: "messageChunk", text: "second answer" });
    dispatch(window, { type: "historyReplay", active: false });

    const realPromptBubbles = doc.querySelectorAll('.msg.user:not([data-steer="1"]):not(.queued)');
    expect(hostCount).toBe(2);
    expect(realPromptBubbles).toHaveLength(hostCount);
    // afterUserMessage:2 belongs to the second turn. If replay counted the
    // interjection, this card drained one boundary early, before second prompt.
    expect(messageIndex(doc, "second plan")).toBeGreaterThan(messageIndex(doc, "second prompt"));
  });

  it("does not advance the live counter for a steer bubble", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "planHistoryQueue",
      plans: [{ text: "after two prompts", verdict: "rejected", afterUserMessage: 2 }],
    });
    dispatch(window, { type: "userMessage", text: "live first" });
    dispatch(window, { type: "userMessage", text: "live steer", steer: true });
    dispatch(window, { type: "userMessage", text: "live second" });
    // The next real boundary drains afterUserMessage:2. A wrongly-counted steer
    // would have drained it before live second instead.
    dispatch(window, { type: "userMessage", text: "live third" });

    expect(doc.querySelectorAll('.msg.user:not([data-steer="1"]):not(.queued)')).toHaveLength(3);
    expect(messageIndex(doc, "after two prompts")).toBeGreaterThan(messageIndex(doc, "live second"));
    expect(messageIndex(doc, "after two prompts")).toBeLessThan(messageIndex(doc, "live third"));
  });
});

describe("truncated remote history coordinates", () => {
  const messageIndex = (doc: Document, text: string) =>
    [...$(doc, "messages").children].findIndex((el) => el.textContent?.includes(text));

  it("keeps a surviving plan card between the same retained agent chunks", () => {
    const { window, doc } = bootWebview();
    const buffer: HostMsg[] = [{
      type: "planHistoryQueue",
      plans: [{
        text: "surviving plan",
        verdict: "approved",
        afterUserMessage: 3,
        afterHistoryEvent: 5,
      }],
    }];
    for (let n = 1; n <= 12; n++) {
      buffer.push({ type: "userMessage", text: `prompt ${n}` });
      if (n < 3) {
        buffer.push({ type: "messageChunk", text: `discarded ${n}a` });
        buffer.push({ type: "messageChunk", text: `discarded ${n}b` });
      } else if (n === 3) {
        buffer.push({ type: "messageChunk", text: "retained draft" });
        buffer.push({ type: "messageChunk", text: "retained implementation" });
      } else {
        buffer.push({ type: "messageChunk", text: `answer ${n}` });
      }
    }

    for (const message of bracketRemoteSnapshot(buffer)) dispatch(window, message);

    expect(messageIndex(doc, "surviving plan")).toBeGreaterThan(messageIndex(doc, "retained draft"));
    expect(messageIndex(doc, "surviving plan")).toBeLessThan(messageIndex(doc, "retained implementation"));
  });
});

describe("composer autosize", () => {
  it("sets an explicit height on every input change (grow-to-5-lines wiring)", () => {
    // happy-dom has no layout (scrollHeight is 0), so the growth itself can't
    // be measured here — this pins the wiring: typing re-runs autosize and the
    // height is always an explicit px value with overflow managed.
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = "line1\nline2\nline3\nline4\nline5\nline6";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(input.style.height).toMatch(/px$/);
    expect(["auto", "hidden"]).toContain(input.style.overflowY);
  });
});

describe("welcome screen visibility (logo/byline hides once real content exists)", () => {
  it("hides the welcome block on the first live user message", () => {
    const { window, doc } = bootWebview();
    expect(($(doc, "welcome") as any).hidden).toBe(false);

    dispatch(window, { type: "userMessage", text: "hello grok" });

    expect(($(doc, "welcome") as any).hidden).toBe(true);
  });

  it("hides the welcome when a restored session replays real user content", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "a real question" });
    dispatch(window, { type: "messageChunk", text: "an answer" });
    dispatch(window, { type: "historyReplay", active: false });

    expect(($(doc, "welcome") as any).hidden).toBe(true);
  });

  it("keeps the welcome on a primer-only restore — the primer is not user content", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "[grok-build-vscode primer v4] Plan-mode protocol instructions." });
    dispatch(window, { type: "messageChunk", text: "ok" });
    dispatch(window, { type: "historyReplay", active: false });

    expect(($(doc, "welcome") as any).hidden).toBe(false);
  });
});
describe("remote tab session reconnect", () => {
  function broadcastChannelFixture() {
    const channels: Array<{
      name: string;
      closed: boolean;
      onmessage?: (event: { data: unknown }) => void;
    }> = [];
    return class FakeBroadcastChannel {
      closed = false;
      onmessage?: (event: { data: unknown }) => void;

      constructor(readonly name: string) {
        channels.push(this);
      }

      postMessage(data: unknown) {
        for (const peer of channels) {
          if (peer !== this && !peer.closed && peer.name === this.name) {
            setTimeout(() => peer.onmessage?.({ data }), 0);
          }
        }
      }

      close() {
        this.closed = true;
      }
    };
  }

  it("regenerates copied tab state before a duplicated page identifies or resumes", async () => {
    const FakeBroadcastChannel = broadcastChannelFixture();
    const remembered = {
      id: "copied-session",
      repoCwd: "/work/repo-b",
      cwd: "/work/repo-b",
    };
    const original = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = FakeBroadcastChannel;
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify(remembered));
      },
    });
    await vi.waitFor(() => (original.window as any).__grokTabTokenReady);
    const originalToken = original.window.sessionStorage.getItem("grok.remote.tabToken:default");
    const originalOwner = original.window.sessionStorage.getItem("grok.remote.tabOwner:default");

    const duplicate = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = FakeBroadcastChannel;
        w.sessionStorage.setItem("grok.remote.tabToken:default", originalToken!);
        w.sessionStorage.setItem("grok.remote.tabOwner:default", originalOwner!);
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify(remembered));
      },
    });
    const tokenReady = (duplicate.window as any).__grokTabTokenReady as Promise<string | undefined>;
    expect(typeof tokenReady?.then).toBe("function");
    expect(duplicate.posted.find((message) => message.type === "ready")).toBeUndefined();
    const settledToken = await tokenReady;
    await Promise.resolve();

    const duplicateToken = duplicate.window.sessionStorage.getItem("grok.remote.tabToken:default");
    expect(duplicateToken).not.toBe(originalToken);
    expect(settledToken).toBe(duplicateToken);
    expect(duplicate.window.sessionStorage.getItem("grok.remote.tabSession:default")).toBeNull();
    expect(duplicate.posted.find((message) => message.type === "ready")).toEqual({
      type: "ready",
      tabToken: duplicateToken,
    });

    duplicate.posted.length = 0;
    dispatch(duplicate.window, { type: "initialState", cwd: "/work/repo-a" });
    expect(duplicate.posted.filter((message) =>
      message.type === "selectRepo" || message.type === "resumeSession"
    )).toEqual([]);
  });

  it("resolves tab-token readiness promptly when BroadcastChannel is unavailable", async () => {
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = undefined;
      },
    });
    const stored = window.sessionStorage.getItem("grok.remote.tabToken:default");

    await expect((window as any).__grokTabTokenReady).resolves.toBe(stored);
  });

  it("starts fresh from copied state when BroadcastChannel is unavailable", async () => {
    const oldToken = "copied-token";
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = undefined;
        w.sessionStorage.setItem("grok.remote.tabToken:default", oldToken);
        w.sessionStorage.setItem("grok.remote.tabOwner:default", "other-page");
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify({
          id: "copied-session",
          repoCwd: "/work/repo-b",
        }));
      },
    });

    const token = await (window as any).__grokTabTokenReady;
    expect(token).not.toBe(oldToken);
    expect(window.sessionStorage.getItem("grok.remote.tabSession:default")).toBeNull();
  });

  it("starts fresh from copied state when BroadcastChannel construction throws", async () => {
    const oldToken = "copied-token";
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = class {
          constructor() { throw new Error("disabled"); }
        };
        w.sessionStorage.setItem("grok.remote.tabToken:default", oldToken);
        w.sessionStorage.setItem("grok.remote.tabOwner:default", "other-page");
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify({
          id: "copied-session",
          repoCwd: "/work/repo-b",
        }));
      },
    });

    const token = await (window as any).__grokTabTokenReady;
    expect(token).not.toBe(oldToken);
    expect(window.sessionStorage.getItem("grok.remote.tabSession:default")).toBeNull();
  });

  it("retains identity and conversation when a stale owner marker has no live channel participant", async () => {
    const oldToken = "discarded-tab-token";
    const remembered = {
      id: "discarded-session",
      repoCwd: "/work/repo-b",
      cwd: "/work/repo-b",
    };
    const { window, posted } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = class {
          onmessage?: (event: { data: unknown }) => void;
          postMessage() {}
          close() {}
        };
        w.sessionStorage.setItem("grok.remote.tabToken:default", oldToken);
        w.sessionStorage.setItem("grok.remote.tabOwner:default", "dead-renderer");
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify(remembered));
      },
    });

    await expect((window as any).__grokTabTokenReady).resolves.toBe(oldToken);
    expect(window.sessionStorage.getItem("grok.remote.tabToken:default")).toBe(oldToken);
    expect(window.sessionStorage.getItem("grok.remote.tabSession:default")).toBe(JSON.stringify(remembered));

    dispatch(window, { type: "initialState", cwd: "/work/repo-a" });
    expect(posted).toContainEqual({ type: "selectRepo", cwd: "/work/repo-b" });
    expect(posted).toContainEqual({
      type: "resumeSession",
      id: "discarded-session",
      cwd: "/work/repo-b",
    });
  });

  it("keeps tab identity and remembered conversation across an ordinary reload", async () => {
    const FakeBroadcastChannel = broadcastChannelFixture();
    const remembered = {
      id: "reload-session",
      repoCwd: "/work/repo-b",
      cwd: "/work/repo-b",
    };
    const priorPage = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = FakeBroadcastChannel;
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify(remembered));
      },
    });
    await vi.waitFor(() => (priorPage.window as any).__grokTabTokenReady);
    const token = priorPage.window.sessionStorage.getItem("grok.remote.tabToken:default");
    priorPage.window.dispatchEvent(new priorPage.window.Event("pagehide"));

    const reloaded = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        (w as any).BroadcastChannel = FakeBroadcastChannel;
        w.sessionStorage.setItem("grok.remote.tabToken:default", token!);
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify(remembered));
      },
    });
    await vi.waitFor(() => (reloaded.window as any).__grokTabTokenReady);

    expect(reloaded.window.sessionStorage.getItem("grok.remote.tabToken:default")).toBe(token);
    dispatch(reloaded.window, { type: "initialState", cwd: "/work/repo-a" });
    expect(reloaded.posted).toContainEqual({ type: "selectRepo", cwd: "/work/repo-b" });
    expect(reloaded.posted).toContainEqual({
      type: "resumeSession",
      id: "reload-session",
      cwd: "/work/repo-b",
    });
  });

  it("reasserts the tab's remembered repository and session on a fresh host snapshot", () => {
    const remembered = {
      id: "session-tab-a",
      repoCwd: "/work/repo-b",
      cwd: "/work/repo-b",
    };
    const { window, posted } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify(remembered));
      },
    });

    dispatch(window, { type: "initialState", cwd: "/work/repo-a" });

    expect(posted).toEqual([
      { type: "selectRepo", cwd: "/work/repo-b" },
      { type: "resumeSession", id: "session-tab-a", cwd: "/work/repo-b" },
    ]);
  });

  it("stores the active session in tab-scoped storage and clears it only on explicit New", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "repos",
      entries: [{ cwd: "/work/repo-b", label: "repo-b", available: true }],
      selectedCwd: "/work/repo-b",
      activeCwd: "/work/repo-b",
    });
    dispatch(window, {
      type: "sessions",
      entries: [{ id: "session-tab-b", cwd: "/work/repo-b" }],
      activeId: "session-tab-b",
    });

    expect(JSON.parse(window.sessionStorage.getItem("grok.remote.tabSession:default")!)).toEqual({
      id: "session-tab-b",
      repoCwd: "/work/repo-b",
      cwd: "/work/repo-b",
    });

    click(window, $(doc, "new-btn"));
    expect(window.sessionStorage.getItem("grok.remote.tabSession:default")).toBeNull();
  });

  it("does not replace reconnect identity until the host accepts a history selection", () => {
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "repos",
      entries: [{ cwd: "/work/repo-b", label: "repo-b", available: true }],
      selectedCwd: "/work/repo-b",
      activeCwd: "/work/repo-b",
    });
    dispatch(window, {
      type: "sessions",
      entries: [
        { id: "current", cwd: "/work/repo-b", displayName: "Current" },
        { id: "rejected", cwd: "/work/repo-b", displayName: "Rejected" },
      ],
      activeId: "current",
    });
    click(window, $(doc, "history-btn"));
    posted.length = 0;

    const rejected = [...doc.querySelectorAll(".history-row")]
      .find((row) => row.textContent?.includes("Rejected")) as HTMLElement;
    click(window, rejected);

    expect(posted).toContainEqual({
      type: "resumeSession",
      id: "rejected",
      cwd: "/work/repo-b",
      claim: true,
    });
    expect(JSON.parse(window.sessionStorage.getItem("grok.remote.tabSession:default")!))
      .toMatchObject({ id: "current", repoCwd: "/work/repo-b" });

    dispatch(window, {
      type: "sessions",
      entries: [{ id: "current", cwd: "/work/repo-b", displayName: "Current" }],
      activeId: "current",
    });
    expect(JSON.parse(window.sessionStorage.getItem("grok.remote.tabSession:default")!))
      .toMatchObject({ id: "current", repoCwd: "/work/repo-b" });
  });

  it("clears a stale reconnect identity when the host authoritatively reports no active session", () => {
    const { window } = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify({
          id: "stale",
          repoCwd: "/work/repo-b",
          cwd: "/work/repo-b",
        }));
      },
    });

    dispatch(window, { type: "sessions", entries: [], activeId: null });

    expect(window.sessionStorage.getItem("grok.remote.tabSession:default")).toBeNull();
  });
});
