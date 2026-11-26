import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session, beginTurn, endTurn } from "../src/session";
import { bootWebview, click, dispatch } from "./webview-harness";

function harness() {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  const written: any[] = [];
  const client = new AcpClient({ cliPath: "unused", cwd: "/", log() {},
    timeouts: { promptIdleTimeoutMs: 1_000, promptAbsoluteTimeoutMs: 10_000 } });
  (client as any).proc = { killed: false, stdin: { writable: true, write: (line: string) => written.push(JSON.parse(line)) } };
  session.client = client;
  sidebar.focused = session;
  sidebar.pendingConfirms = new Map();
  sidebar.confirmSeq = 0;
  sidebar.remoteClients = new RemoteClientState<Session>("/proj");
  for (const id of ["phone", "desk"]) {
    sidebar.remoteClients.ready(id);
    sidebar.remoteClients.setActive(id, session);
  }
  const surfaces = [bootWebview(), bootWebview()];
  sidebar.sendRemoteSession = vi.fn((_s, msg) => {
    for (const surface of surfaces) dispatch(surface.window, msg);
  });
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.captureRemoteRequester = vi.fn();
  sidebar.setStatus = vi.fn();
  sidebar.refreshKeepAwake = vi.fn();
  sidebar.closeDiffForRequest = vi.fn();
  sidebar.persistPlanVerdict = vi.fn();
  sidebar.host = { getConfiguration: () => ({ get: (_k: string, fallback: unknown) => fallback }) };
  return { sidebar, session, client, written, surfaces };
}

describe("session-bound human request lifecycles", () => {
  it("keeps the turn clock paused through overlapping cards until the last answer", async () => {
    const { sidebar, session, written } = harness();
    sidebar.showDeskAlert = vi.fn();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const turn = beginTurn(session);
      now = 2_000;
      sidebar.postQuestionRequest(session, { id: 1, questions: [{ question: "First?" }] });
      now = 5_000;
      sidebar.postQuestionRequest(session, { id: 2, questions: [{ question: "Second?" }] });
      now = 10_000;
      await sidebar.onMessage({ type: "questionAnswer", requestId: 1, answers: { "First?": "Yes" } }, "remote", "desk");
      expect(sidebar.setStatus).toHaveBeenLastCalledWith(session, "needs-you");
      now = 20_000;
      await sidebar.onMessage({ type: "questionAnswer", requestId: 2, answers: { "Second?": "Yes" } }, "remote", "desk");
      expect(sidebar.setStatus).toHaveBeenLastCalledWith(session, "working");
      expect(written.map((response) => response.id)).toEqual([1, 2]);
      now = 23_000;
      expect(endTurn(session, turn)).toBe(true);
      expect(turn.durationMs).toBe(5_000);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["completed", "failed"])("%s closes the matching open question on every surface and preserves its draft", (status) => {
    const { sidebar, session, written, surfaces } = harness();
    session.pendingQuestions.set(0, "call-colour");
    session.pendingQuestions.set(1, "another-call");
    const otherSession = new Session();
    otherSession.pendingQuestions.set(0, "call-colour");
    sidebar.emit(session, { type: "questionRequest", req: {
      id: 0, toolCallId: "call-colour", questions: [{ question: "Which colour?" }],
    } });
    for (const { window, doc } of surfaces) {
      click(window, doc.querySelector(".question-option")!);
      const field = doc.querySelector(".question-other-input") as HTMLTextAreaElement;
      field.value = "Blue\nwith green details";
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    // No content at all: a reason string is neither required nor consulted.
    sidebar.closeQuestionsForToolCall(session, { toolCallId: "call-colour", status });
    sidebar.closeQuestionsForToolCall(session, { toolCallId: "call-colour", status });
    expect(session.pendingQuestions.has(0)).toBe(false);
    expect(session.pendingQuestions.get(1)).toBe("another-call");
    expect(otherSession.pendingQuestions.get(0)).toBe("call-colour");
    expect(session.buffer.filter((m) => m.type === "questionResolved"))
      .toEqual([{ type: "questionResolved", requestId: 0, outcome: "closed" }]);
    for (const { window, doc, posted } of surfaces) {
      expect(doc.querySelector(".card.question .card-title")!.textContent).toBe("Question is no longer open");
      expect(doc.querySelector(".question-answer")!.textContent).toContain("Blue\nwith green details");
      click(window, doc.querySelector(".question-recover")!);
      expect((doc.querySelector("#input") as HTMLTextAreaElement).value)
        .toBe("Which colour?\nBlue\nwith green details");
      expect(posted.some((m: any) => m.type === "questionAnswer" || m.type === "send")).toBe(false);
    }
    expect(written).toEqual([]);
    expect(sidebar.setStatus).not.toHaveBeenCalled(); // No turn to revive.
  });

  it.each([
    { toolCallId: "permission-call", status: "completed" },
    { toolCallId: "plan-call", status: "failed" },
    { toolCallId: "call-colour", status: "in_progress" },
    { toolCallId: "call-colour", status: "pending" },
    { toolCallId: "call-colour" },
    { status: "completed" },
    { toolCallId: "", status: "completed" },
  ])("ignores uncorrelated or nonterminal updates even with timeout prose: %j", (call) => {
    const { sidebar, session, client } = harness();
    session.pendingQuestions.set(0, "call-colour");
    session.pendingQuestions.set(1, undefined); // An older CLI's question.
    session.pendingPermissions.set(2, { title: "Permission", toolCallId: "permission-call", options: [] });
    session.pendingExitPlans.set(3, { planText: "Plan" });
    const sync = vi.spyOn(client, "setHumanWaitActive");
    sidebar.closeQuestionsForToolCall(session, {
      ...call, content: [{ type: "content", content: { type: "text", text: "User declined to answer the questions. Continue with the task" } }],
    });
    expect(session.pendingQuestions.size).toBe(2);
    expect(session.pendingPermissions.size).toBe(1);
    expect(session.pendingExitPlans.size).toBe(1);
    expect(session.buffer).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(["questionAnswer", "questionCancel"])("a terminal update after %s cannot replace acceptance or reset idle time again", async (type) => {
    const { sidebar, session, client, written } = harness();
    session.pendingQuestions.set(0, "call-colour");
    await sidebar.onMessage({ type, requestId: 0, answers: { "Which colour?": "Blue" } }, "remote", "desk");
    const sync = vi.spyOn(client, "setHumanWaitActive");
    sidebar.closeQuestionsForToolCall(session, { toolCallId: "call-colour", status: "completed" });
    expect(session.buffer.filter((m) => m.type === "questionResolved"))
      .toEqual([{ type: "questionResolved", requestId: 0, outcome: "accepted" }]);
    expect(written).toHaveLength(1);
    expect(sync).not.toHaveBeenCalled();
  });

  it("an answer racing a terminal update is told it is stale without a JSON-RPC write", async () => {
    const { sidebar, session, written } = harness();
    session.pendingQuestions.set(0, "call-colour");
    sidebar.closeQuestionsForToolCall(session, { toolCallId: "call-colour", status: "completed" });
    await sidebar.onMessage({ type: "questionAnswer", requestId: 0, answers: { Q: "Blue" } }, "remote", "phone");
    expect(session.buffer).toEqual([
      { type: "questionResolved", requestId: 0, outcome: "closed" },
      { type: "questionResolved", requestId: 0, outcome: "stale" },
    ]);
    expect(written).toEqual([]);
  });

  it.each([false, true])("terminal closure refreshes idle only when no human request remains (permission: %s)", async (permissionStillOpen) => {
    vi.useFakeTimers();
    try {
      const { sidebar, session, client } = harness();
      session.turnToken = {};
      const prompt = (client as any).request("session/prompt", {});
      let settled = false;
      void prompt.catch(() => { settled = true; });
      const timedOut = expect(prompt).rejects.toThrow("ACP request timed out: session/prompt");
      session.pendingQuestions.set(0, "call-colour");
      if (permissionStillOpen) session.pendingPermissions.set(2, {
        title: "Read?", options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }],
      });
      sidebar.syncHumanWait(session);
      await vi.advanceTimersByTimeAsync(2_500);
      sidebar.closeQuestionsForToolCall(session, { toolCallId: "call-colour", status: "completed" });
      if (permissionStillOpen) {
        expect(sidebar.setStatus).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(settled).toBe(false);
        await sidebar.onMessage({ type: "permissionAnswer", requestId: 2, optionId: "yes" }, "remote", "desk");
      }
      expect(sidebar.setStatus).toHaveBeenLastCalledWith(session, "working");
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
    } finally { vi.useRealTimers(); }
  });

  it.each(["questionAnswer", "questionCancel"])("tells a stale %s without writing any JSON-RPC response", async (type) => {
    const { sidebar, session, written } = harness();
    await sidebar.onMessage({ type, requestId: "gone", answers: { Q: "draft" } }, "remote", "phone");
    expect(written).toEqual([]);
    expect(session.buffer).toContainEqual({ type: "questionResolved", requestId: "gone", outcome: "stale" });
    expect(sidebar.setStatus).not.toHaveBeenCalled();
  });

  it("two surfaces race: first answer is written once and the second is told it is stale", async () => {
    const { sidebar, session, written, surfaces } = harness();
    session.pendingQuestions.set(7, undefined);
    sidebar.emit(session, { type: "questionRequest", req: { id: 7, questions: [{ question: "Q?" }] } });
    await sidebar.onMessage({ type: "questionAnswer", requestId: 7, answers: { "Q?": "first" } }, "remote", "desk");
    expect(session.buffer.at(-1)).toEqual({ type: "questionResolved", requestId: 7, outcome: "accepted" });
    for (const surface of surfaces) expect(surface.doc.querySelector(".card.question.resolved")).not.toBeNull();
    await sidebar.onMessage({ type: "questionAnswer", requestId: 7, answers: { "Q?": "second" } }, "remote", "phone");
    expect(written).toEqual([{ jsonrpc: "2.0", id: 7, result: { outcome: "accepted", answers: { "Q?": "first" }, annotations: {} } }]);
    expect(session.buffer.at(-1)).toEqual({ type: "questionResolved", requestId: 7, outcome: "stale" });
    expect(sidebar.sendRemoteSession).toHaveBeenLastCalledWith(session, session.buffer.at(-1));
    expect(sidebar.setStatus).toHaveBeenCalledTimes(1);
  });

  it("does not claim acceptance when the response cannot be written", async () => {
    const { sidebar, session, client, written } = harness();
    session.pendingQuestions.set(7, undefined);
    (client as any).proc.stdin.writable = false;
    await sidebar.onMessage({ type: "questionAnswer", requestId: 7, answers: { Q: "draft" } }, "remote", "desk");
    expect(written).toEqual([]);
    expect(session.buffer.at(-1)).toMatchObject({ type: "questionResolved", outcome: "stale" });
  });

  it("a matching id in another session cannot answer this session's question", async () => {
    const { sidebar, session, written } = harness();
    session.pendingQuestions.set(7, undefined);
    sidebar.remoteClients.setActive("phone", new Session());
    await sidebar.onMessage({ type: "questionAnswer", requestId: 7, answers: {} }, "remote", "phone");
    expect(written).toEqual([]);
    expect(session.pendingQuestions.has(7)).toBe(true);
    expect(session.buffer).toEqual([]);
  });

  it.each(["turn end", "cancel", "teardown"])("broadcasts closure and resets human wait on %s", async (reason) => {
    const { sidebar, session, client } = harness();
    const sync = vi.spyOn(client, "setHumanWaitActive");
    session.pendingQuestions.set("open", undefined);
    sidebar.syncHumanWait(session);
    if (reason === "turn end") sidebar.noteLiveTurnEnded(session);
    else if (reason === "cancel") await sidebar.onMessage({ type: "cancel" }, "remote", "phone");
    else sidebar.detachClient(session);
    expect(session.pendingQuestions.size).toBe(0);
    expect(sync).toHaveBeenLastCalledWith(false);
    expect(session.buffer).toContainEqual({ type: "questionResolved", requestId: "open", outcome: "closed" });
  });

  it("a late completion cannot clear a newer turn's question", () => {
    const { sidebar, session, client } = harness();
    session.turnToken = {};
    session.pendingQuestions.set("new", undefined);
    const sync = vi.spyOn(client, "setHumanWaitActive");
    sidebar.noteLiveTurnEnded(session);
    expect(session.pendingQuestions.has("new")).toBe(true);
    expect(session.buffer).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([
    ["question", "permission", "plan"],
    ["permission", "plan", "question"],
    ["plan", "question", "permission"],
  ])("mixed requests suspend the live timer through %s, %s, then %s", async (...order) => {
    vi.useFakeTimers();
    try {
      const { sidebar, session, client } = harness();
      const p = (client as any).request("session/prompt", {});
      let settled = false;
      void p.catch(() => { settled = true; });
      const timedOut = expect(p).rejects.toThrow("ACP request timed out: session/prompt");
      session.pendingQuestions.set(1, undefined);
      session.pendingPermissions.set(2, { title: "Allow?", options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }] });
      session.pendingExitPlans.set(3, { planText: "Plan" });
      sidebar.syncHumanWait(session);
      const answers: Record<string, object> = {
        question: { type: "questionAnswer", requestId: 1, answers: {} },
        permission: { type: "permissionAnswer", requestId: 2, optionId: "yes" },
        plan: { type: "exitPlanAnswer", requestId: 3, verdict: "abandoned" },
      };
      for (const kind of order) {
        await vi.advanceTimersByTimeAsync(2_000);
        expect(settled).toBe(false);
        await sidebar.onMessage(answers[kind], "remote", "phone");
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
    } finally { vi.useRealTimers(); }
  });

  it("does not replay a destructive modal, and first confirm answer dismisses every surface", async () => {
    const { sidebar, session, surfaces } = harness();
    const pending = sidebar.confirmInChat(session, { title: "Revert files?", confirmLabel: "Rewind", danger: true });
    for (const surface of surfaces) expect(surface.doc.querySelector(".confirm-overlay")).not.toBeNull();
    const id = sidebar.sendRemoteSession.mock.calls.at(-1)[1].id;
    const reopened = bootWebview();
    for (const msg of session.buffer) dispatch(reopened.window, msg);
    expect(reopened.doc.querySelector(".confirm-overlay")).toBeNull();
    await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: true }, "remote", "desk");
    await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: false }, "remote", "phone");
    await expect(pending).resolves.toBe(true);
    for (const surface of surfaces) {
      expect(surface.doc.querySelector(".confirm-overlay")).toBeNull();
      expect(surface.posted.filter((m: any) => m.type === "uiConfirmAnswer")).toEqual([]);
    }
    expect(session.buffer).toEqual([]);
    expect(sidebar.sendRemoteSession.mock.calls.filter(([, m]: any) => m.type === "uiConfirmResolved")).toHaveLength(1);
  });

  it("teardown abandons only that session's confirms and cannot consume a late answer", async () => {
    const { sidebar, session } = harness();
    const pending = sidebar.confirmInChat(session, { title: "Revert?", confirmLabel: "Rewind" });
    const id = sidebar.sendRemoteSession.mock.calls.at(-1)[1].id;
    const other = new Session();
    const resolveOther = vi.fn();
    sidebar.pendingConfirms.set("other", { session: other, resolve: resolveOther });
    sidebar.detachClient(session);
    await expect(pending).resolves.toBe(false);
    expect(resolveOther).not.toHaveBeenCalled();
    await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: true }, "remote", "desk");
    expect(sidebar.pendingConfirms.size).toBe(1);
  });
});
