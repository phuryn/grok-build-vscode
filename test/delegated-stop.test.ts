import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { ClaudeBackend } from "../src/claude-backend";
import { MuseBackend } from "../src/muse-backend";
import { GrokSidebar } from "../src/sidebar";
import { Session, beginTurn } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { allowFromRemote, remoteRequiresBoundSession } from "../src/remote-policy";
import { parseRunProgressUpdate } from "../src/run-progress";
import type { WebviewMsg } from "../src/protocol";
import { bootWebview, dispatch, type Harness } from "./webview-harness";
import background from "./fixtures/claude-background-subagent.json";

type Stop = Extract<WebviewMsg, { type: "stopDelegatedWork" }>;
const windows: Harness["window"][] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.happyDOM.abort();
});

const token = "11111111-2222-4333-8444-555555555555";
const stop = (kind: Stop["kind"], id: string, stopToken = token): Stop => ({ type: "stopDelegatedWork", kind, id, stopToken });
const controls = (h: Harness) => [...h.doc.querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
const view = (remote = false) => {
  const h = bootWebview({ remote });
  windows.push(h.window);
  return h;
};
const agent = { sessionUpdate: "tool_call", kind: "subagent", toolCallId: "agent", status: "in_progress", title: "Check output" };
const workflow = { sessionUpdate: "workflow_updated", status: "running", run_id: "workflow", name: "check-output", controlsAvailable: false };

function host(provider: "claude" | "muse", sessionId = "first") {
  const backend = provider === "claude" ? new ClaudeBackend() : new MuseBackend();
  const client = new AcpClient({ backend, cliPath: "unused", cwd: process.cwd(), log: vi.fn() });
  client.sessionId = sessionId;
  const session = new Session();
  session.client = client;
  session.provider = provider;
  session.cwd = process.cwd();
  const remoteClients = new RemoteClientState<Session>(session.cwd);
  remoteClients.ready("phone");
  remoteClients.setActive("phone", session);
  const sidebar = Object.assign(Object.create(GrokSidebar.prototype), {
    focused: session, remoteClients, workspaceRoot: () => session.cwd, captureRemoteRequester: vi.fn(),
    authorizedSessionCwds: () => [session.cwd], host: { appendLine: vi.fn() },
  });
  const traces: any[] = [];
  const onLine = (msg: object) => (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  (client as any).proc = { killed: false, stdin: { writable: true, write: (line: string) => traces.push(JSON.parse(line)) } };
  const update = (update: object, source = sessionId) => onLine({ method: "session/update", params: { sessionId: source, update } });
  const reply = (id: number, result: object) => onLine({ id, result });
  const h = view(true);
  for (const type of ["toolCall", "toolCallUpdate"] as const) client.on(type, call => dispatch(h.window, { type, call }));
  client.on("subagentLifecycle", raw => dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate(raw) }));
  const notices = vi.fn(), complete = vi.fn();
  client.on("notice", notices).on("promptComplete", complete);
  return { client, session, sidebar, traces, update, reply, h, notices, complete };
}

function clickStop(h: Harness): Stop {
  const [button] = controls(h);
  expect(button?.textContent).toBe("Stop");
  button.click();
  return parseWebviewMsg(h.posted.at(-1)) as Stop;
}

describe("card Stop", () => {
  it("accepts only scoped card stops and uses the workflow control tier", () => {
    const msg = stop("workflow", "card");
    expect(parseWebviewMsg(msg)).toEqual(msg);
    for (const change of [{ kind: "turn" }, { id: "" }, { id: " " }, { id: "a".repeat(513) }, { id: 9 }, { stopToken: "missing" }]) {
      expect(parseWebviewMsg({ ...msg, ...change })).toBeNull();
    }
    expect(remoteRequiresBoundSession(msg.type)).toBe(true);
    expect(allowFromRemote(msg.type, "read-only")).toBe(false);
    expect(allowFromRemote(msg.type, "propose")).toBe(true);
    expect(allowFromRemote(msg.type, "full")).toBe(true);
  });

  it.each(["workflow", "subagent"] as const)("renders the %s Stop only with a host token, with a stable node and no Stop after settlement or replay", kind => {
    const h = view();
    const post = (fields: object) => kind === "workflow"
      ? dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate({ ...workflow, ...fields }) })
      : dispatch(h.window, { type: h.doc.querySelector(".subagent-card") ? "toolCallUpdate" : "toolCall", call: { ...agent, ...fields } });
    post({});
    expect(controls(h)).toHaveLength(0);
    post({ stopToken: token, revision: 1 });
    expect(controls(h).map(el => el.textContent)).toEqual(["Stop"]);
    const [button] = controls(h);
    if (kind === "workflow") h.doc.querySelector<HTMLButtonElement>(".workflow-pin .delegation-header")!.click();
    button.focus();
    post({ stopToken: token, revision: 2 });
    expect(controls(h)[0]).toBe(button);
    expect(h.doc.activeElement).toBe(button);
    expect(clickStop(h)).toEqual(stop(kind, kind === "workflow" ? "workflow" : "agent"));
    post({ status: "cancelled", revision: 3 });
    expect(controls(h)).toHaveLength(0);
    expect(h.doc.querySelector(".delegation-status")?.textContent).toBe("stopped");
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "historyReplay", active: true });
    post({ status: "cancelled", revision: 3 });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(controls(h)).toHaveLength(0);
  });

  it.each(["running", "paused"])("preserves the existing named workflow controls for %s", status => {
    const h = view();
    dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate({ ...workflow, controlsAvailable: undefined, status }) });
    expect(controls(h).map(el => el.textContent)).toEqual([status === "paused" ? "Resume" : "Pause", "Stop"]);
    controls(h)[1].click();
    expect(h.posted.at(-1)).toEqual({ type: "workflowControl", action: "stop", displayName: "check-output" });
  });

  it("routes the stop of a correlated workflow once and leaves the parent prompt and queued text alone", async () => {
    const target = host("claude");
    const { client, session, sidebar, traces, update, reply, h, notices, complete } = target;
    const turn = beginTurn(session);
    session.queuedSends = [{ text: "Send me next", chips: [] }];
    const prompt = client.prompt("Continue after the workflow");
    const call = { sessionUpdate: "tool_call_update", toolCallId: "workflow-tool", status: "completed",
      _meta: { claudeCode: { toolName: "Workflow", toolResponse: {
        status: "async_launched", taskType: "local_workflow", taskId: "native-task", runId: "workflow",
      } } } };
    const spawned = { sessionUpdate: "async_task_spawned", asyncTaskId: "native-task", taskType: "workflow", toolCallId: "workflow-tool", canStop: true };
    update(call);
    expect(controls(h)).toHaveLength(0);
    update(spawned, "foreign");
    update({ sessionUpdate: "async_task_state_update", asyncTaskId: "native-task", state: "stopped" }, "foreign");
    expect(controls(h)).toHaveLength(0);
    update(spawned);
    const msg = clickStop(h);
    const pending = sidebar.onMessage(msg, "remote", "phone");
    await sidebar.onMessage(msg, "remote", "phone");
    await sidebar.onMessage({ ...msg, id: "native-task" }, "local");
    expect(traces.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "session/prompt", params: { sessionId: "first", prompt: [{ type: "text", text: "Continue after the workflow" }] } },
      { method: "_session/async_task/stop", params: { sessionId: "first", asyncTaskId: "native-task" } },
    ]);
    update({ sessionUpdate: "async_task_state_update", asyncTaskId: "native-task", state: "stopped" });
    reply(traces[1].id, { stopped: true });
    await pending;
    update({ ...spawned, sessionUpdate: "async_task_progress" });
    await sidebar.onMessage(msg, "local");
    expect(traces).toHaveLength(2);
    expect(h.doc.querySelector(".workflow-card .delegation-status")?.textContent).toBe("stopped");
    expect(controls(h)).toHaveLength(0);
    expect(notices).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(session.turnToken).toBe(turn);
    expect(session.queuedSends).toEqual([{ text: "Send me next", chips: [] }]);
    reply(traces[0].id, { stopReason: "end_turn" });
    await prompt;
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("requires a native stop handle for a background subagent and keeps nested activity scoped to the root", async () => {
    const { sidebar, update, traces, reply, h } = host("claude");
    update({ sessionUpdate: "async_task_spawned", toolCallId: "agent-tool", asyncTaskId: "agent-task", taskType: "subagent", canStop: true }, "foreign");
    for (const frame of background.launch) update(frame);
    expect(controls(h)).toHaveLength(0);
    update({ sessionUpdate: "tool_call", toolCallId: "nested", kind: "think", status: "in_progress",
      _meta: { claudeCode: { toolName: "Agent", parentToolUseId: "agent-tool" } } });
    update({ sessionUpdate: "async_task_spawned", toolCallId: "nested", asyncTaskId: "nested-task", taskType: "subagent", canStop: true });
    expect(controls(h)).toHaveLength(0);
    update({ sessionUpdate: "async_task_spawned", toolCallId: "agent-tool", asyncTaskId: "agent-task", taskType: "subagent", canStop: true });
    const msg = clickStop(h);
    const pending = sidebar.onMessage(msg, "local");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ method: "_session/async_task/stop", params: { sessionId: "first", asyncTaskId: "agent-task" } });
    reply(traces[0].id, { stopped: false });
    await pending;
    await sidebar.onMessage(msg, "local");
    expect(traces).toHaveLength(1);
    update({ sessionUpdate: "async_task_state_update", toolCallId: "agent-tool", asyncTaskId: "agent-task", state: "completed" });
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe("done");
    expect(controls(h)).toHaveLength(0);
  });

  it.each(["workflow", "subagent"] as const)("routes a %s only to the bound Muse session and rejects a stale card with the same id", async kind => {
    const first = host("muse");
    const next = host("muse", "second");
    const frame = kind === "workflow" ? { sessionUpdate: "session_info_update",
      _meta: { "muse/workflow": { ...workflow, stopAvailable: true } } }
      : { ...agent, kind: "think", _meta: { "muse/subagent": true, "muse/canStop": true } };
    first.update(frame);
    next.update(frame);
    const prior = clickStop(first.h), current = clickStop(next.h);
    expect(prior.id).toBe(current.id);
    expect(prior.stopToken).not.toBe(current.stopToken);
    next.sidebar.focused = first.session;
    await next.sidebar.onMessage(prior, "remote", "phone");
    expect(next.traces).toHaveLength(0);
    expect(first.traces).toHaveLength(0);
    const pending = next.sidebar.onMessage(current, "remote", "phone");
    expect(next.traces[0]).toMatchObject({ method: "_muse/stop_delegated_work",
      params: { sessionId: "second", kind, id: current.id } });
    next.reply(next.traces[0].id, { stopped: true });
    await pending;
  });
});
