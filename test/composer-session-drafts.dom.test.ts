import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

describe.each(["desktop", "vscode", "remote"])("composer session drafts (%s)", (surface) => {
  function setup(draftReplies = true, initialSession = true) {
    const h = bootWebview({
      remote: surface === "remote",
      beforeScripts: (window) => {
        (window as any).grokDesktopShell = surface === "desktop";
        const rail = window.document.createElement("aside");
        rail.id = "projects-rail";
        window.document.body.appendChild(rail);
      },
    });
    dispatch(h.window, { type: "initialState", capabilities: draftReplies ? { composerDraftSession: true } : {} });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    const focus = (sessionId: string) => dispatch(h.window, {
      type: "sessionName", sessionId, name: sessionId, cwd: "/repo",
    });
    const rows = ["a", "b"].map(id => ({ id, displayName: id, cwd: "/repo", numMessages: 2, updatedAt: 1 }));
    dispatch(h.window, { type: "repos", entries: [{ cwd: "/repo", label: "repo", available: true }], selectedCwd: "/repo", activeCwd: "/repo" });
    dispatch(h.window, { type: "sessions", entries: rows, activeId: initialSession ? "a" : null });
    const resume = (id: string, history = false) => {
      if (history) {
        click(h.window, h.doc.getElementById("history-btn")!);
        dispatch(h.window, { type: "sessions", entries: rows, activeId: "a" });
      }
      const el = h.doc.querySelector(`${history ? "#history-popover" : "#projects-rail"} [data-session-id="${id}"]`);
      expect(el).not.toBeNull();
      click(h.window, el!);
    };
    const newSession = () => {
      click(h.window, h.doc.getElementById("new-btn")!);
      return h.posted.filter(m => m.type === "newSession").at(-1)!.draftId;
    };
    const bind = (draftId: unknown, sessionId: string) => dispatch(h.window, { type: "composerDraftSession", draftId, sessionId });
    return { ...h, input, focus, resume, newSession, bind };
  }

  it("restores independent drafts across repeated switches and transcript resets", () => {
    const { window, input, focus } = setup();
    focus("a");
    input.value = "draft A\nwith context";
    dispatch(window, { type: "clearMessages" });
    focus("b");
    expect(input.value).toBe("");
    input.value = "draft B";
    focus("a");
    expect(input.value).toBe("draft A\nwith context");
    focus("b");
    expect(input.value).toBe("draft B");
    input.value = "";
    focus("a");
    focus("b");
    expect(input.value).toBe("");
  });

  it("does not clear a draft on same-session replay or rename", () => {
    const { window, input, focus } = setup();
    focus("a");
    input.value = "keep me";
    dispatch(window, { type: "clearMessages" });
    focus("a");
    dispatch(window, { type: "sessions", entries: [], activeId: "a" });
    expect(input.value).toBe("keep me");
  });

  it.each(["", "older stored draft"])("keeps typing through the host's replay and late identity (stored: %s)", stored => {
    const { window, input, focus } = setup();
    focus("b");
    input.value = stored;
    focus("a");
    input.value = "A's draft";
    const session = new Session();
    session.activeSessionId = "b";
    session.buffer = [{ type: "messageChunk", text: "Previous answer" }];
    const frames: string[] = [];
    const sidebar = Object.assign(Object.create(GrokSidebar.prototype), {
      remoteClients: { cwd: () => "/repo", setActive: () => {} },
      touch: () => {}, markRead: () => {}, refreshWorkflowCompletions: () => {},
      sessionIdentityFrame: () => ({ type: "session", sessionId: "b", provider: "grok", models: [] }),
      displayMode: () => "agent", remoteActiveSessionId: () => "b",
      buildSessionsList: () => ({ type: "sessions", entries: [], activeId: "b" }),
      postSessionName: () => { frames.push("sessionName"); focus("b"); },
      restorePersistedDraft: () => {},
      sendRemoteClient: (_id: string, msg: any) => {
        frames.push(msg.type === "historyReplay" ? `${msg.type}:${msg.active}` : msg.type);
        dispatch(window, msg);
        if (msg.type === "historyReplay" && msg.active) {
          input.value = "typed while B loads";
          input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
        }
      },
    });
    sidebar.focusRemoteSession("phone", session, false);
    expect(frames).toEqual([
      "clearMessages", "session", "historyReplay:true", "historyBatch", "historyReplay:false",
      "startupStatus", "subscriptionUsage", "modeChanged", "planModeAvailability",
      "feedbackAvailability", "chips", "queuedSends", "sessions", "sessionName",
    ]);
    // Merged, never replaced: B's saved draft first, then what was typed.
    expect(input.value).toBe(stored ? `${stored}\n\ntyped while B loads` : "typed while B loads");
    focus("a");
    expect(input.value).toBe("A's draft");
  });

  it("also switches on host session lists before the name frame arrives", () => {
    const { window, input, focus } = setup();
    focus("a");
    input.value = "A";
    dispatch(window, { type: "sessions", entries: [], activeId: "b" });
    expect(input.value).toBe("");
    input.value = "B";
    focus("b");
    expect(input.value).toBe("B");
    focus("a");
    expect(input.value).toBe("A");
  });

  it("starts New empty and keeps text typed before the new id arrives", () => {
    const { window, input, focus, newSession, bind } = setup();
    focus("a");
    input.value = "old draft";
    const draftId = newSession();
    expect(input.value).toBe("");
    input.value = "new draft";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "startupStatus", provider: "grok", stage: "starting", elapsedMs: 0 });
    focus("a"); // A delayed identity for the session being left.
    expect(input.value).toBe("new draft");
    focus("new");
    bind(draftId, "new");
    dispatch(window, { type: "startupStatus", provider: "grok", stage: null, elapsedMs: 0 });
    dispatch(window, { type: "setBusy", value: false });
    expect(input.value).toBe("new draft");
    focus("a");
    expect(input.value).toBe("old draft");
    focus("new");
    expect(input.value).toBe("new draft");
  });

  it.each([false, true])("switches the draft at the gesture before an identity reply (history: %s)", history => {
    const { input, focus, resume } = setup();
    focus("b");
    input.value = "saved B";
    focus("a");
    input.value = "original A";
    resume("b", history);
    expect(input.value).toBe("saved B");
    input.value = "";
    focus("a"); // delayed echo must not retarget the box
    expect(input.value).toBe("");
    focus("b");
    focus("a");
    expect(input.value).toBe("original A");
    focus("b");
    expect(input.value).toBe("");
  });

  it("keeps a pending New's draft after leaving it for an existing conversation", () => {
    const { input, focus, resume, newSession, bind } = setup();
    input.value = "A draft";
    const draftId = newSession();
    input.value = "pending New draft";
    resume("b");
    expect(input.value).toBe("");
    input.value = "B draft";
    bind(draftId, "new");
    expect(input.value).toBe("B draft");
    focus("b");
    focus("new");
    expect(input.value).toBe("pending New draft");
    focus("a");
    expect(input.value).toBe("A draft");
  });

  it.each([false, true])("preserves both rapid New drafts with reversed replies: %s", reversed => {
    const { input, focus, newSession, bind } = setup();
    const first = newSession();
    input.value = "first New";
    const second = newSession();
    expect(input.value).toBe("");
    input.value = "second New";
    const replies = [[first, "new-1"], [second, "new-2"]] as const;
    for (const [token, id] of reversed ? [...replies].reverse() : replies) bind(token, id);
    expect(input.value).toBe("second New");
    focus("new-2");
    focus("new-1");
    expect(input.value).toBe("first New");
    focus("new-2");
    expect(input.value).toBe("second New");
  });

  it("restores an abandoned New if its conversation is opened before its binding reply", () => {
    const { input, focus, resume, newSession, bind } = setup();
    const draftId = newSession();
    input.value = "pending draft";
    resume("b");
    focus("b");
    focus("new");
    input.value = "additional text";
    bind(draftId, "new");
    expect(input.value).toBe("pending draft\n\nadditional text");
  });

  it("binds a New on a host that never names the draft back", () => {
    const { window, input, focus, newSession } = setup(false);
    focus("a");
    input.value = "old draft";
    newSession();
    expect(input.value).toBe("");
    input.value = "new draft";
    dispatch(window, { type: "sessions", entries: [], activeId: "a" }); // the conversation being left
    focus("a");
    expect(input.value).toBe("new draft");
    focus("new");
    expect(input.value).toBe("new draft");
    focus("a");
    expect(input.value).toBe("old draft");
    focus("new");
    expect(input.value).toBe("new draft");
  });

  it.each(["resume", "new"])("puts the composer back when a %s is refused, and keeps the clicked draft", kind => {
    const { window, input, focus, resume, newSession, bind } = setup();
    focus("b");
    input.value = "saved B";
    focus("a");
    input.value = "A draft";
    const draftId = kind === "new" ? newSession() : (resume("b"), undefined);
    input.value = kind === "new" ? "typed for New" : "saved B, edited";
    dispatch(window, { type: "error", text: "That conversation is no longer available." });
    expect(input.value).toBe("A draft");
    focus("a"); // the host re-confirms the one it kept
    expect(input.value).toBe("A draft");
    if (kind === "new") {
      bind(draftId, "new"); // the host created it after all
      focus("new");
      expect(input.value).toBe("typed for New");
    } else {
      focus("b");
      expect(input.value).toBe("saved B, edited");
    }
  });

  it("parks an Edit reply for the conversation left by a gesture before the host changes focus", () => {
    const { window, input, focus, resume, doc } = setup();
    input.value = "A draft";
    resume("b");
    input.value = "B draft";
    dispatch(window, { type: "restoreComposer", sessionId: "a", text: "edited sentence", chips: [
      { id: "file", path: "/repo/file.txt", relPath: "file.txt", kind: "file", hidden: false },
    ] });
    expect(input.value).toBe("B draft");
    expect(doc.getElementById("attachments")!.textContent).not.toContain("file.txt");
    focus("b");
    focus("a");
    expect(input.value).toBe("A draft\n\nedited sentence");
    expect(doc.getElementById("attachments")!.textContent).toContain("file.txt");
  });

  it("does not restore text that has already been sent", () => {
    const { doc, window, input, focus } = setup();
    focus("a");
    input.value = "send this";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    (doc.getElementById("send-btn") as HTMLButtonElement).click();
    expect(input.value).toBe("");
    focus("b");
    focus("a");
    expect(input.value).toBe("");
  });

  it("keeps input typed before the initial session identity", () => {
    const { doc, window } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    const focus = (sessionId: string) => dispatch(window, { type: "sessionName", sessionId, name: sessionId, cwd: "/repo" });
    input.value = "first prompt";
    focus("a");
    expect(input.value).toBe("first prompt");
    focus("b");
    expect(input.value).toBe("");
  });

  it.each(["history", "reconnect", "reload"])("keeps the latest text through %s, including a late persisted draft", load => {
    const { window, input, focus, resume } = setup(true, load !== "reload");
    if (load === "history") resume("b", true);
    else if (load === "reconnect") focus("b");
    // getRemoteSnapshot: initialState, clear, bracketed history, UI snapshot,
    // sessions, sessionName. A cold start later unlocks and restores its draft.
    dispatch(window, { type: "initialState", capabilities: { composerDraftSession: true } });
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "historyReplay", active: true });
    input.value = "my newest keystrokes";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    dispatch(window, { type: "messageChunk", text: "Previous answer" });
    dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, { type: "startupStatus", provider: "grok", stage: null, elapsedMs: 0 });
    dispatch(window, { type: "sessions", entries: [], activeId: "b" });
    focus("b");
    dispatch(window, { type: "setBusy", value: false });
    // Nothing typed is replaced; a parked draft is merged beside it, once.
    dispatch(window, { type: "restoreComposer", sessionId: "b", text: "", draft: true });
    expect(input.value).toBe("my newest keystrokes");
    for (let i = 0; i < 2; i++) {
      dispatch(window, { type: "restoreComposer", sessionId: "b", text: "older persisted text", draft: true });
      expect(input.value).toBe("my newest keystrokes\n\nolder persisted text");
    }
    expect(input.disabled).toBe(false);
  });

  it("restores an automatic draft into an untouched empty composer", () => {
    const { window, input, focus } = setup();
    focus("a");
    dispatch(window, { type: "restoreComposer", sessionId: "a", text: "parked draft", draft: true });
    expect(input.value).toBe("parked draft");
  });
});
