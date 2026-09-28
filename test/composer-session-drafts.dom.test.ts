import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

describe.each(["desktop", "vscode", "remote"])("composer session drafts (%s)", (surface) => {
  function setup() {
    const h = bootWebview({
      remote: surface === "remote",
      beforeScripts: (window) => {
        (window as any).grokDesktopShell = surface === "desktop";
        const rail = window.document.createElement("aside");
        rail.id = "projects-rail";
        window.document.body.appendChild(rail);
      },
    });
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    const focus = (sessionId: string) => dispatch(h.window, {
      type: "sessionName", sessionId, name: sessionId, cwd: "/repo",
    });
    const rows = ["a", "b"].map(id => ({ id, displayName: id, cwd: "/repo", numMessages: 2, updatedAt: 1 }));
    dispatch(h.window, { type: "repos", entries: [{ cwd: "/repo", label: "repo", available: true }], selectedCwd: "/repo", activeCwd: "/repo" });
    dispatch(h.window, { type: "sessions", entries: rows, activeId: "a" });
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
    dispatch(window, { type: "clearMessages" });
    focus("a"); // A delayed identity for the session being left.
    expect(input.value).toBe("new draft");
    focus("new");
    bind(draftId, "new");
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
});
