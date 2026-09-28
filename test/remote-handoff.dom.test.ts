import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Posted } from "./webview-harness";

function setup(desktop = true, draftReplies = true) {
  const h = bootWebview({ beforeScripts: window => {
    (window as any).grokDesktopShell = desktop;
    const rail = window.document.createElement("aside");
    rail.id = "projects-rail";
    window.document.body.appendChild(rail);
  } });
  dispatch(h.window, { type: "initialState", capabilities: draftReplies ? { composerDraftSession: true } : {} });
  const rows = ["a", "b", "c"].map(id => ({ id, displayName: id, cwd: "/repo", numMessages: 2, updatedAt: 1 }));
  const focus = (sessionId: string) => dispatch(h.window, { type: "sessionName", sessionId, name: sessionId, cwd: "/repo" });
  dispatch(h.window, { type: "repos", entries: [{ cwd: "/repo", label: "repo", available: true }], selectedCwd: "/repo", activeCwd: "/repo" });
  dispatch(h.window, { type: "sessions", entries: rows, activeId: "a" });
  focus("a");
  dispatch(h.window, { type: "remoteStatus", linked: true, handoffReady: true });
  const requests = () => h.posted.filter(m => m.type === "remoteHandoff");
  const open = () => click(h.window, h.doc.getElementById("remote-btn")!);
  const resume = (id: string, history = false) => {
    if (history) {
      click(h.window, h.doc.getElementById("history-btn")!);
      dispatch(h.window, { type: "sessions", entries: rows, activeId: "a" });
    }
    click(h.window, h.doc.querySelector(`${history ? "#history-popover" : "#projects-rail"} [data-session-id="${id}"]`)!);
  };
  const button = (label: string) => [...h.doc.querySelectorAll<HTMLButtonElement>(".remote-handoff-popover button")]
    .find(el => el.textContent === label)!;
  const ready = (request: Posted) => dispatch(h.window, {
    type: "remoteHandoff", requestId: request.requestId, title: request.sessionId,
    url: `https://afkpilot.com/chat?device=desk#session=${request.sessionId}`, qrSvg: "<svg/>",
  });
  const waiting = () => {
    expect(h.doc.querySelector<HTMLElement>(".remote-handoff-popover")!.hidden).toBe(false);
    expect(h.doc.querySelector(".remote-handoff-qr-pending")!.textContent).toContain("Generating QR code…");
    expect(h.doc.querySelector(".remote-handoff-qr")).toBeNull();
    expect(button("Copy link").disabled).toBe(true);
    expect(button("Open in browser").disabled).toBe(true);
  };
  const newSession = () => {
    click(h.window, h.doc.getElementById("new-btn")!);
    return h.posted.filter(m => m.type === "newSession").at(-1)!.draftId;
  };
  const bind = (draftId: unknown, sessionId: string) => dispatch(h.window, { type: "composerDraftSession", draftId, sessionId });
  return { ...h, focus, requests, open, resume, ready, waiting, newSession, bind };
}

describe("phone code follows the displayed conversation", () => {
  it.each([true, false])("waits through a history resume (desktop: %s)", desktop => {
    const h = setup(desktop);
    h.resume("b", true);
    expect(h.doc.getElementById("session-name-label")!.textContent).toBe("b");
    h.open();
    h.waiting();
    expect(h.requests()).toHaveLength(0);
    h.focus("a");
    h.waiting();
    expect(h.requests()).toHaveLength(0);
    h.focus("b");
    expect(h.requests()).toHaveLength(1);
    expect(h.requests()[0]).toMatchObject({ sessionId: "b" });
    h.ready(h.requests()[0]);
    expect(h.doc.querySelector(".remote-handoff-qr svg")).not.toBeNull();
  });

  it.each([false, true])("waits through a rail resume from the header action: %s", header => {
    const h = setup();
    h.resume("b");
    if (header) {
      click(h.window, h.doc.querySelector('#session-head-actions [aria-label="Session actions"]')!);
      click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")].find(el => el.textContent?.includes("Continue on phone"))!);
    } else h.open();
    h.waiting();
    expect(h.requests()).toHaveLength(0);
    h.focus("b");
    expect(h.requests().at(-1)).toMatchObject({ sessionId: "b" });
  });

  it("rejects the previous code during and after superseded resumes", () => {
    const h = setup();
    h.open();
    const old = h.requests().at(-1)!;
    h.ready(old);
    h.resume("b");
    h.open();
    h.waiting();
    h.ready(old);
    h.waiting();
    expect(h.requests()).toHaveLength(1);
    h.resume("c");
    h.open();
    h.focus("b");
    h.waiting();
    expect(h.requests()).toHaveLength(1);
    h.focus("c");
    expect(h.requests()).toHaveLength(2);
    expect(h.requests().at(-1)).toMatchObject({ sessionId: "c", action: "show" });
    h.ready(h.requests().at(-1)!);
    h.ready(old);
    expect(h.doc.querySelector(".remote-handoff-popover")!.textContent).toContain("open c there");
    h.focus("c");
    expect(h.requests()).toHaveLength(2);
  });

  it.each([false, true])("waits for the current New's correlated identity (name first: %s)", nameFirst => {
    const h = setup();
    const first = h.newSession();
    const second = h.newSession();
    h.open();
    h.bind(first, "new-1");
    h.focus("new-1");
    h.waiting();
    expect(h.requests()).toHaveLength(0);
    if (nameFirst) h.focus("new-2");
    h.waiting();
    h.bind(second, "new-2");
    if (!nameFirst) h.focus("new-2");
    expect(h.requests()).toHaveLength(1);
    expect(h.requests()[0]).toMatchObject({ sessionId: "new-2" });
    h.ready(h.requests()[0]);
    expect(h.doc.querySelector(".remote-handoff-popover")!.textContent).toContain("open new-2 there");
  });

  it("retargets on host focus changes and session-list confirmations", () => {
    const h = setup();
    h.open();
    const old = h.requests().at(-1)!;
    h.ready(old);
    h.focus("b");
    expect(h.requests().at(-1)).toMatchObject({ sessionId: "b", action: "refresh" });
    expect(h.doc.querySelector(".remote-handoff-qr")).toBeNull();
    h.ready(old);
    expect(h.doc.querySelector(".remote-handoff-qr")).toBeNull();
    h.ready(h.requests().at(-1)!);
    expect(h.doc.querySelector(".remote-handoff-popover")!.textContent).toContain("open b there");
    h.resume("c");
    h.open();
    h.waiting();
    dispatch(h.window, { type: "sessions", entries: [], activeId: "c" });
    expect(h.requests().at(-1)).toMatchObject({ sessionId: "c" });
  });

  it.each(["rail", "projects"])("keeps an explicit %s row target across focus changes", source => {
    const h = setup();
    h.resume("b");
    if (source === "rail") {
      click(h.window, h.doc.querySelector('#projects-rail [data-session-id="a"] .rail-menu-btn')!);
      click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")].find(el => el.textContent?.includes("Continue on phone"))!);
    } else dispatch(h.window, { type: "showRemoteHandoff", source, sessionId: "a", repoCwd: "/repo" });
    expect(h.requests()).toHaveLength(1);
    expect(h.requests()[0]).toMatchObject({ sessionId: "a", repoCwd: "/repo" });
    h.ready(h.requests()[0]);
    h.focus("b");
    expect(h.requests()).toHaveLength(1);
    expect(h.doc.querySelector(".remote-handoff-popover")!.textContent).toContain("open a there");
  });

  it("follows a New on a host that never names the draft back", () => {
    const h = setup(true, false);
    h.newSession();
    h.open();
    h.waiting();
    h.focus("a"); // the conversation being left, echoed late
    h.waiting();
    expect(h.requests()).toHaveLength(0);
    h.focus("new");
    expect(h.requests().at(-1)).toMatchObject({ sessionId: "new" });
  });

  it("returns to the conversation that stayed when an open is refused", () => {
    const h = setup();
    h.resume("b");
    h.open();
    h.waiting();
    dispatch(h.window, { type: "error", text: "That conversation is no longer available." });
    expect(h.requests().at(-1)).toMatchObject({ sessionId: "a" });
  });
});
