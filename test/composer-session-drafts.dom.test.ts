import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

it("keeps a new editor's draft when the selected model starts a different provider ID", () => {
  const { window, doc, posted } = bootWebview({ vscode: true,
    beforeScripts: win => { win.document.body.dataset.editorChat = "true"; },
  });
  const input = doc.querySelector<HTMLTextAreaElement>("#input")!;
  const identify = (sessionId: string) => dispatch(window, { type: "sessionName", sessionId, name: "New session", cwd: "/repo" });
  dispatch(window, { type: "editorChatBinding", sessionId: "grok-shell" });
  dispatch(window, { type: "editorChatBound", binding: 1 });
  identify("grok-shell");
  input.value = "Still writing my first prompt";
  input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  // switchModel restarts the same Session in place and publishes a new id.
  dispatch(window, { type: "session", sessionId: "codex-shell", models: [], provider: "codex" });
  identify("codex-shell");
  expect(input.value).toBe("Still writing my first prompt");
  expect(posted.filter(msg => msg.type === "editorChatDraft").at(-1)?.text).toBe(input.value);
});

it("keeps the outgoing composer until the host accepts a History open", () => {
  const { window, doc, posted } = bootWebview({ vscode: true,
    beforeScripts: win => { win.document.body.dataset.editorChat = "true"; },
  });
  const input = doc.querySelector<HTMLTextAreaElement>("#input")!;
  const identify = (sessionId: string) => dispatch(window, { type: "sessionName", sessionId, name: sessionId, cwd: "/repo" });
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  };
  const chooseB = () => {
    click(window, doc.getElementById("history-btn")!);
    dispatch(window, { type: "sessions", activeId: "a", entries: ["a", "b"].map(id => ({
      id, displayName: id, cwd: "/repo", updatedAt: 1, numMessages: 2,
    })) });
    click(window, doc.querySelector('#history-popover [data-session-id="b"]')!);
  };
  dispatch(window, { type: "editorChatBinding", sessionId: "a" });
  dispatch(window, { type: "editorChatBound", binding: 1 });
  identify("a");
  type("Draft for A");
  chooseB();
  expect(input.value).toBe("Draft for A");
  dispatch(window, { type: "sessionOpening", sessionId: "b", failed: true });
  expect(input.value).toBe("Draft for A");

  chooseB();
  dispatch(window, { type: "editorChatBinding", sessionId: "b", switchDraft: true });
  dispatch(window, { type: "restoreComposer", sessionId: "b", text: "Draft for B", draft: true });
  dispatch(window, { type: "editorChatBound", binding: 2 });
  dispatch(window, { type: "historyReplay", active: true });
  type("Draft for B plus load typing");
  identify("b");
  dispatch(window, { type: "historyReplay", active: false });
  expect(input.value).toBe("Draft for B plus load typing");
  expect(posted.filter(msg => msg.type === "editorChatDraft" && msg.binding === 2).at(-1)?.text).toBe(input.value);
});

it.each(["new", "history"])("switches the tab draft when the host accepts %s", gesture => {
  const { window, doc, posted } = bootWebview({ vscode: true,
    beforeScripts: win => { win.document.body.dataset.editorChat = "true"; },
  });
  const input = doc.querySelector<HTMLTextAreaElement>("#input")!;
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  };
  const identify = (id: string) => dispatch(window, { type: "sessionName", sessionId: id, name: id, cwd: "/repo" });
  dispatch(window, { type: "initialState", capabilities: { composerDraftSession: true } });
  dispatch(window, { type: "editorChatBinding", sessionId: "a" });
  identify("a");
  dispatch(window, { type: "editorChatBound", binding: 1 });
  type("source draft");

  if (gesture === "new") click(window, doc.getElementById("new-btn")!);
  else {
    click(window, doc.getElementById("history-btn")!);
    dispatch(window, { type: "sessions", activeId: "a", entries: ["a", "b"].map(id => ({
      id, displayName: id, cwd: "/repo", updatedAt: 1, numMessages: 2,
    })) });
    click(window, doc.querySelector('#history-popover [data-session-id="b"]')!);
  }
  const action = posted.find(m => m.type === "editorChatAction" && (m.message as any).type === (gesture === "new" ? "newSession" : "resumeSession"));
  expect(action?.binding).toBe(1);
  expect(action?.message).not.toHaveProperty("draftId");
  expect(posted.filter(m => m.type === "editorChatDraft" && m.binding === 1).at(-1)?.text).toBe("source draft");
  expect(input.value).toBe("source draft");
  dispatch(window, { type: "editorChatBinding", sessionId: gesture === "history" ? "b" : undefined, switchDraft: true });
  expect(input.value).toBe("");
  if (gesture === "history") dispatch(window, { type: "restoreComposer", sessionId: "b", text: "destination draft", draft: true });
  dispatch(window, { type: "editorChatBound", binding: 2 });
  type([input.value, "typed while opening"].filter(Boolean).join("\n\n"));
  identify("b");
  expect(input.value).toBe(gesture === "history" ? "destination draft\n\ntyped while opening" : "typed while opening");
  expect(posted.filter(m => m.type === "editorChatDraft" && m.binding === 2).at(-1)?.text).toBe(input.value);
});

it("keeps text typed before New gets an id when the provider restarts", () => {
  const { window, doc, posted } = bootWebview({ vscode: true,
    beforeScripts: win => { win.document.body.dataset.editorChat = "true"; },
  });
  const input = doc.querySelector<HTMLTextAreaElement>("#input")!;
  dispatch(window, { type: "initialState", capabilities: { composerDraftSession: true } });
  dispatch(window, { type: "editorChatBinding", sessionId: "a" });
  dispatch(window, { type: "sessionName", sessionId: "a", name: "A", cwd: "/repo" });
  dispatch(window, { type: "editorChatBound", binding: 1 });
  click(window, doc.getElementById("new-btn")!);
  dispatch(window, { type: "editorChatBinding", switchDraft: true });
  dispatch(window, { type: "editorChatBound", binding: 2 });
  input.value = "Still writing my first prompt";
  input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  expect(posted.at(-1)).toMatchObject({ type: "editorChatDraft", binding: 2, text: input.value });

  dispatch(window, { type: "editorChatBinding" });
  dispatch(window, { type: "editorChatBound", binding: 3 });
  dispatch(window, { type: "sessionName", sessionId: "new-id", name: "New", cwd: "/repo" });
  expect(input.value).toBe("Still writing my first prompt");
  click(window, doc.getElementById("send-btn")!);
  expect(posted).toContainEqual(expect.objectContaining({ type: "editorChatAction", binding: 3,
    message: expect.objectContaining({ type: "send", text: "Still writing my first prompt" }),
  }));
});

it("routes editor chat drafts and sends with the current editor binding", () => {
  const { window, doc, posted } = bootWebview({
    beforeScripts: (win) => { win.document.body.dataset.editorChat = "true"; },
  });
  const input = doc.getElementById("input") as HTMLTextAreaElement;
  const bind = (id: string, binding: number, draft = "") => {
    dispatch(window, { type: "editorChatBinding", sessionId: id, switchDraft: true });
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "sessionName", sessionId: id, cwd: "/repo", name: id });
    dispatch(window, { type: "setBusy", value: false });
    if (draft) dispatch(window, { type: "restoreComposer", text: draft, draft: true });
    dispatch(window, { type: "editorChatBound", binding });
  };
  bind("a", 1);
  input.value = "draft on A";
  input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  expect(posted).toContainEqual(expect.objectContaining({ type: "editorChatDraft", binding: 1, text: "draft on A" }));
  bind("b", 2, "draft on B");
  expect(input.value).toBe("draft on B");
  click(window, doc.getElementById("send-btn")!);
  expect(posted).toContainEqual({
    type: "editorChatAction", binding: 2, message: { type: "send", text: "draft on B" },
  });
  expect(posted.some(msg => msg.type === "send")).toBe(false);
  bind("a", 3, "draft on A");
  expect(input.value).toBe("draft on A");
});

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

  it.each([
    ["", ""], ["older stored draft", ""], ["", "A's draft"], ["older stored draft", "A's draft"],
  ])("keeps typing through the host's replay and late identity (stored: %j, left: %j)", (stored, left) => {
    const { window, input, focus } = setup();
    focus("b");
    input.value = stored;
    focus("a");
    input.value = left;
    // Into an empty composer the keystrokes are B's; after A's text they extend
    // A's draft (a host-driven switch, e.g. another repo, must not carry it).
    const typed = left ? `${left} and more` : "typed while B loads";
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
          input.value = typed;
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
    expect(input.value).toBe(left ? stored : [stored, typed].filter(Boolean).join("\n\n"));
    focus("a");
    expect(input.value).toBe(left ? typed : "");
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

  it("files a new chat's handed-over prompt under that chat when it lands before the switch", () => {
    // First-prompt Edit: the host opens the new chat and hands the prompt over
    // before the frame that moves the composer arrives.
    const { window, input, focus } = setup();
    focus("a");
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "restoreComposer", sessionId: "c", text: "Edited first prompt", draft: true });
    expect(input.value).toBe("");
    dispatch(window, { type: "sessions", entries: [], activeId: "c" });
    expect(input.value).toBe("Edited first prompt");
    focus("a");
    expect(input.value).toBe("");
  });

  it("restores an automatic draft into an untouched empty composer", () => {
    const { window, input, focus } = setup();
    focus("a");
    dispatch(window, { type: "restoreComposer", sessionId: "a", text: "parked draft", draft: true });
    expect(input.value).toBe("parked draft");
  });
});

it("stores the host-issued editor restore key alongside existing webview state", () => {
  let saved: Record<string, unknown> = { disclosure: true };
  const h = bootWebview({ vscode: true, beforeScripts: window => {
    window.document.body.dataset.editorChat = "true";
    (window as any).acquireVsCodeApi = () => ({
      getState: () => saved,
      setState: (value: typeof saved) => { saved = value; },
      postMessage: () => {},
    });
  } });
  dispatch(h.window, { type: "editorChatBinding", sessionId: "one", restoreKey: "panel-key" });
  expect(saved).toEqual({ disclosure: true, editorChatRestoreKey: "panel-key" });
  dispatch(h.window, { type: "editorChatBinding", sessionId: "two", switchDraft: true });
  expect(saved.editorChatRestoreKey).toBe("panel-key");
});

it("keeps a restored draft in the composer while send is blocked", () => {
  const { window, doc, posted } = bootWebview({ vscode: true, beforeScripts: window => {
    window.document.body.dataset.editorChat = "true";
  } });
  dispatch(window, { type: "editorChatBinding", restoreBlocked: true });
  dispatch(window, { type: "editorChatBound", binding: 1 });
  dispatch(window, { type: "restoreComposer", text: "draft to keep", draft: true });
  const input = doc.querySelector<HTMLTextAreaElement>("#input")!;
  const send = doc.querySelector<HTMLButtonElement>("#send-btn")!;
  expect(send.disabled).toBe(true);

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(input.value).toBe("draft to keep");
  expect(posted.some(msg => msg.type === "editorChatAction" && (msg.message as Posted).type === "send")).toBe(false);

  dispatch(window, { type: "editorChatRestoreBlocked", value: false });
  expect(send.disabled).toBe(false);
});
