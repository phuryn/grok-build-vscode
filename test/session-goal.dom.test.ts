import { afterEach, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";
import { HOST_MESSAGE_TYPES, type HostMsg } from "../src/protocol";
import { OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, transformHostMsgForRemote } from "../src/remote-policy";
import { Session, sessionGoalMessage, sessionUiSnapshot } from "../src/session";
import { HOST_MESSAGE_TYPES as WEBVIEW_HOST_TYPES } from "../media/webview-helpers.js";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const views: Harness[] = [];
afterEach(() => { for (const h of views.splice(0)) h.window.happyDOM.abort(); });

function view(remote = false) {
  const h = bootWebview({ remote });
  views.push(h);
  return h;
}

function conversation(id: string, backend: ClaudeBackend | CodexBackend) {
  const session = new Session();
  session.provider = backend.provider;
  const client = new AcpClient({ cliPath: "unused", cwd: "/example", backend, log: () => {} });
  session.client = client;
  client.sessionId = session.activeSessionId = id;
  const identity: HostMsg = { type: "session", sessionId: id, provider: backend.provider, models: [], currentModelId: undefined };
  const goal = (value: unknown, sessionId = id, title?: string) => (client as any).onLine(JSON.stringify({
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId, update: { sessionUpdate: "session_info_update", title, _meta: { goal: value } } },
  }));
  return { session, client, identity, goal };
}

function goalText(h: Harness) {
  return Array.from(h.doc.querySelectorAll("#session-goal > span"), el => el.textContent);
}

it.each([
  [new ClaudeBackend(), { status: "active", iterations: 4, lastReason: "Keep checking" }, "Active"],
  [new CodexBackend(), { status: "paused", tokenBudget: 8000, tokensUsed: 2000, timeUsedSeconds: 60 }, "Paused"],
] as const)("renders an observed goal through the host and phone wire, and clears it", (backend, data, status) => {
  const c = conversation("parent", backend);
  const desk = view(), phone = view(true);
  const title = vi.fn();
  c.client.on("sessionTitle", title);
  for (const h of [desk, phone]) dispatch(h.window, c.identity);
  c.client.on("sessionGoal", () => {
    const frame = sessionGoalMessage(c.session)!;
    dispatch(desk.window, frame);
    dispatch(phone.window, transformHostMsgForRemote(frame, {} as any)!);
  });
  const objective = '<img src=x onerror="alert(1)"> Check the result';
  c.goal({ objective, ...data }, "parent", "  Session name  ");
  expect(title.mock.calls).toEqual([["Session name"]]);
  // A title-only update and a malformed goal leave the known snapshot intact.
  c.goal(undefined, "parent", "Renamed");
  expect(title).toHaveBeenLastCalledWith("Renamed");
  c.goal({ objective, status: 1 });
  c.goal(null, "foreign");
  expect(sessionGoalMessage(c.session)?.goal).toEqual({ objective, status: data.status });
  const reload = view(true);
  dispatch(reload.window, c.identity);
  for (const frame of sessionUiSnapshot(c.session, "agent")) dispatch(reload.window, frame);
  for (const h of [desk, phone, reload]) {
    expect(goalText(h)).toEqual(["Goal", objective, status]);
    expect(h.doc.querySelector(".composer-card #session-goal img")).toBeNull();
  }
  c.goal({ objective, status: "complete" });
  expect(goalText(desk)).toEqual(["Goal", objective, "Complete"]);
  c.goal(null);
  expect(goalText(desk)).toEqual([]);
  expect(goalText(phone)).toEqual([]);
  expect(sessionGoalMessage(c.session)?.goal).toBeNull();
});

it("holds an early load snapshot for the requested session and drops a different session's", async () => {
  const c = conversation("reopened", new CodexBackend());
  c.client.sessionId = "previous";
  (c.client as any).request = async (method: string) => {
    if (method === "session/load") {
      c.goal({ objective: "Restore this", status: "active" });
      c.goal(null, "previous");
    }
    return {};
  };
  await c.client.loadSession("reopened");
  const phone = view(true);
  dispatch(phone.window, c.identity);
  for (const frame of sessionUiSnapshot(c.session, "agent")) dispatch(phone.window, frame);
  expect(goalText(phone)).toEqual(["Goal", "Restore this", "Active"]);
});

it("does not carry a goal between simultaneous views or across a switch to an older host", () => {
  const a = conversation("a", new ClaudeBackend());
  const b = conversation("b", new CodexBackend());
  a.goal({ objective: "Objective A", status: "active" });
  b.goal({ objective: "Objective B", status: "blocked" });
  const desk = view(), phone = view(true);
  function focus(h: Harness, c: typeof a) {
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, c.identity);
    for (const frame of sessionUiSnapshot(c.session, "agent")) dispatch(h.window, frame);
  }
  focus(desk, a);
  focus(phone, b);
  dispatch(desk.window, sessionGoalMessage(b.session)!);
  dispatch(phone.window, sessionGoalMessage(a.session)!);
  expect(goalText(desk)).toEqual(["Goal", "Objective A", "Active"]);
  expect(goalText(phone)).toEqual(["Goal", "Objective B", "Blocked"]);
  focus(desk, b);
  expect(goalText(desk)).toEqual(["Goal", "Objective B", "Blocked"]);

  const old = view(true);
  const oldIdentity = { ...a.identity, sessionId: "old" };
  dispatch(old.window, oldIdentity);
  dispatch(phone.window, { type: "clearMessages" });
  dispatch(phone.window, oldIdentity);
  dispatch(phone.window, sessionGoalMessage(b.session)!);
  expect(old.doc.querySelector("#session-goal")).toBeNull();
  expect(phone.doc.querySelector("#session-goal")).toBeNull();
  expect(goalText(desk)).toEqual(["Goal", "Objective B", "Blocked"]);
});

it("registers the additive frame as mirrored and conversation-scoped", () => {
  expect(HOST_MESSAGE_TYPES).toContain("sessionGoal");
  expect(WEBVIEW_HOST_TYPES).toContain("sessionGoal");
  expect(OUTBOUND_DISPOSITION.sessionGoal).toBe("mirror");
  expect(OUTBOUND_PROJECT_AUTH.sessionGoal).toBe("scope");
});
