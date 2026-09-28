import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AcpClient } from "../src/acp";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { MuseBackend } from "../src/muse-backend";
import { grokBackend } from "../src/grok-backend";
import { childStreamFromRoute } from "../src/acp-dispatch";
import { parseRunProgressUpdate } from "../src/run-progress";
import { OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, transformHostMsgForRemote } from "../src/remote-policy";
import { Projection } from "../adapters/muse/projection.mts";
import { bootWebview, dispatch, type Harness } from "./webview-harness";
import claudeAsyncWire from "./fixtures/claude-async-workflow.json";
import claudeBackground from "./fixtures/claude-background-subagent.json";

// Whitelisted fields from the 2026-09-26 captures. IDs and paths are neutral;
// the fixtures never include the original machine metadata or skill catalog.
const fixtures = JSON.parse(readFileSync(new URL("fixtures/provider-delegation.json", import.meta.url), "utf8"));
const windows: Harness["window"][] = [];
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });
function view(remote = false) {
  let now = 100_000;
  const ticks: (() => void)[] = [];
  const h = bootWebview({ remote, beforeScripts(window) {
    (window as any).Date = class extends window.Date { static now() { return now; } };
    const interval = window.setInterval.bind(window);
    window.setInterval = ((fn: () => void, ms: number) => {
      if (ms === 1000) { ticks.push(fn); return 123; }
      return interval(fn, ms);
    }) as any;
  } });
  windows.push(h.window);
  return { ...h, tick(ms: number) { now += ms; for (const fn of ticks) fn(); } };
}
const backends = [grokBackend, new CodexBackend(), new ClaudeBackend(), new MuseBackend()];
function setup(provider: string, parent = "parent") {
  const desk = view(), phone = view(true);
  let replaying = false;
  const buffer: any[] = [];
  const client = new AcpClient({ cliPath: "unused", cwd: "/example", log: () => {},
    backend: provider === "claude" ? new ClaudeBackend() : backends.find(b => b.provider === provider)! });
  client.sessionId = parent;
  const emit = (msg: any) => {
    if (msg.type === "historyReplay") replaying = msg.active;
    buffer.push(structuredClone(msg));
    dispatch(desk.window, msg);
    dispatch(phone.window, structuredClone(transformHostMsgForRemote(msg, {} as any)));
  };
  client.on("toolCall", call => emit({ type: "toolCall", call }));
  client.on("toolCallUpdate", call => emit({ type: "toolCallUpdate", call }));
  client.on("messageChunk", text => emit({ type: "messageChunk", text }));
  client.on("userMessageChunk", text => emit({ type: "userMessageChunk", text }));
  client.on("notice", text => {
    if (replaying) emit({ type: "subagentUpdate", update: { sessionUpdate: "turn_completed" } });
    emit({ type: "planNotice", text });
  });
  client.on("childStream", ({ childSessionId, route }) => {
    const payload = childStreamFromRoute(childSessionId, route);
    if (payload) emit({ type: "childStream", ...payload });
  });
  const lifecycle = (update: any) => {
    const progress = parseRunProgressUpdate(update);
    emit(progress ? { type: "runProgress", update: progress } : { type: "subagentUpdate", update });
  };
  client.on("subagentLifecycle", lifecycle);
  client.on("xaiNotification", lifecycle);
  return { desk, phone, buffer, emit, client,
    accept: (update: any, sessionId = parent) => (client as any).handleSessionUpdate(update, undefined, sessionId),
    reopen: () => {
      const h = view();
      dispatch(h.window, { type: "historyReplay", active: true });
      for (const msg of buffer) dispatch(h.window, structuredClone(msg));
      dispatch(h.window, { type: "historyReplay", active: false });
      return h;
    },
  };
}
const frame = (h: Harness) => new Promise<void>(resolve => h.window.requestAnimationFrame(() => resolve()));

it.each(["completed", "failed", "stopped"])("Claude background %s reaches desk, phone and buffered reopen without its receipt", state => {
  const s = setup("claude");
  for (const u of claudeBackground.launch) s.accept(u);
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe("in background");
    expect(h.doc.querySelector(".subagent-result-body")).toBeNull();
    expect(h.doc.querySelector("#messages")?.textContent).not.toMatch(/Async agent|agent-task|output_file/);
  }
  expect(s.desk.doc.querySelector(".subagent-time")?.textContent).toBe("");
  s.accept({ sessionUpdate: "async_task_progress", asyncTaskId: "agent-task", usage: { durationMs: 2300, totalTokens: 42 } });
  s.accept({ sessionUpdate: "async_task_state_update", asyncTaskId: "agent-task", state, summary: "## Result\n\nok" });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe(state === "completed" ? "done" : state);
    expect(h.doc.querySelector(".subagent-result-body h2")?.textContent).toBe("Result");
    expect(h.doc.querySelector(".subagent-time")?.textContent).toBe("0:02");
    expect(h.doc.querySelector(".delegation-meta")?.textContent).toContain("42");
  }
});

it.each(["completed", "failed", "stopped"])("Claude cold reopen uses only the task notification's %s outcome", state => {
  const s = setup("claude");
  s.emit({ type: "historyReplay", active: true });
  for (const u of claudeBackground.launch.filter(u => !(u._meta.claudeCode as any).toolResponse)) s.accept(u);
  s.accept({ sessionUpdate: "user_message_chunk", content: { type: "text", text:
    `<task-notification><task-id>agent-task</task-id><tool-use-id>agent-tool</tool-use-id><status>${state}</status><result>ok</result></task-notification>` } });
  s.emit({ type: "historyReplay", active: false });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe(state === "completed" ? "done" : state);
    expect(h.doc.querySelector(".subagent-result-body")?.textContent).toBe("ok");
    expect(h.doc.querySelector(".subagent-time")?.textContent).toBe("");
    expect(h.doc.querySelector(".delegation-meta")?.textContent).toBe("");
    expect(h.doc.querySelector("#messages")?.textContent).not.toMatch(/Async agent|task-notification|agent-task/);
  }
});

it("Claude's captured failure renders its message without the tool error wrapper", () => {
  const s = setup("claude");
  for (const u of claudeBackground.failure) s.accept(u);
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe("failed");
    expect(h.doc.querySelector(".subagent-result-body")?.textContent).toContain("InputValidationError:");
    expect(h.doc.querySelector("#messages")?.textContent).not.toContain("tool_use_error");
  }
});

it("Claude corrects a provisional stop and retains the result across late receipts", () => {
  const s = setup("claude");
  for (const u of claudeBackground.launch) s.accept(u);
  s.accept({ sessionUpdate: "async_task_state_update", asyncTaskId: "agent-task", state: "stopped" });
  s.accept({ sessionUpdate: "async_task_state_update", asyncTaskId: "agent-task", state: "completed", summary: "ok" });
  s.accept(claudeBackground.launch.at(-1));
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe("done");
    expect(h.doc.querySelector(".subagent-result-body")?.textContent).toBe("ok");
  }
});

it("Claude cold reopen without a task outcome settles in background with no invented clock", () => {
  const s = setup("claude");
  s.emit({ type: "historyReplay", active: true });
  for (const u of claudeBackground.launch.filter(u => !(u._meta.claudeCode as any).toolResponse)) s.accept(u);
  s.emit({ type: "historyReplay", active: false });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    h.tick(300_000);
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe("in background");
    expect(h.doc.querySelector(".subagent-time")?.textContent).toBe("");
    expect(h.doc.querySelector(".subagent-result-body")).toBeNull();
    expect(h.doc.querySelector(".subagent-row .delegation-chevron")).toBeNull();
  }
});

it("Claude's ID-less wake-up and reply leave same-named background cards settled on desk, phone and reopen", async () => {
  const s = setup("claude");
  for (const id of ["agent", "other"]) for (const u of claudeBackground.launch) {
    s.accept(JSON.parse(JSON.stringify(u).replaceAll("agent-tool", `${id}-tool`).replaceAll("agent-task", `${id}-task`)));
  }
  s.accept(claudeBackground.wake);
  s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Agent returned: ok" } });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    h.tick(300_000);
    await frame(h);
    const cards = [...h.doc.querySelectorAll(".subagent-card")];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.classList.contains("subagent-done")).toBe(false);
      expect((card as any)._liveStartedAt == null).toBe(true);
      expect(card.querySelector(".subagent-status")?.textContent).toBe("in background");
      expect(card.querySelector(".subagent-time")?.textContent).toBe("");
      expect(card.querySelector(".subagent-time")?.hasAttribute("hidden")).toBe(true);
      expect(card.querySelector(".subagent-result-body, .delegation-chevron")).toBeNull();
    }
    expect(h.doc.querySelector("#messages")?.textContent).toContain("Agent returned: ok");
    expect(h.doc.querySelector("#messages")?.textContent).not.toMatch(/Async agent|internal metadata|no update|task-notification/);
  }
  // An actual task ID finishes only its own card, without timing the unknown wait.
  s.accept({ sessionUpdate: "async_task_state_update", asyncTaskId: "agent-task", state: "completed", summary: "ok" });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect([...h.doc.querySelectorAll(".subagent-status")].map(el => el.textContent)).toEqual(["done", "in background"]);
    expect([...h.doc.querySelectorAll(".subagent-time")].map(el => el.textContent)).toEqual(["", ""]);
  }
});

it("Codex replay stops a disconnected child instead of leaving it running", async () => {
  const s = setup("codex");
  s.emit({ type: "historyReplay", active: true });
  (s.client as any).request = async () => {
    s.accept({ sessionUpdate: "subagent_spawned", subagentSessionId: "unfinished", name: "Check" });
    s.accept({ sessionUpdate: "subagent_state_update", subagentSessionId: "unfinished", state: "disconnected" });
    return {};
  };
  await s.client.loadSession("parent");
  s.emit({ type: "historyReplay", active: false });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".subagent-status")?.textContent).toBe("stopped");
    expect(h.doc.querySelector(".subagent-time")?.textContent).toBe("");
  }
});

it("shows every Claude script phase from launch on desk and phone, with sanitized titles", () => {
  const s = setup("claude");
  const titles = ["One", '<img src=x onerror="alert(1)">'];
  s.accept({ sessionUpdate: "tool_call", toolCallId: "launch-live", _meta: { claudeCode: { toolName: "Workflow" } },
    rawInput: { script: `export const meta = { phases: ${JSON.stringify(titles.map(title => ({ title })))} };` } });
  s.accept(claudeAsyncWire[1]);
  for (const h of [s.desk, s.phone, s.reopen()]) {
    const phases = [...h.doc.querySelectorAll(".workflow-pin .workflow-phase")];
    expect(phases.map(p => p.textContent)).toEqual(titles);
    expect(phases.map(p => (p as HTMLElement).dataset.state)).toEqual(["pending", "pending"]);
    expect(h.doc.querySelector(".workflow-pin img")).toBeNull();
  }
  s.accept(claudeAsyncWire[0]); s.accept(claudeAsyncWire[3]);
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect([...h.doc.querySelectorAll(".workflow-pin .workflow-phase")].map(p => (p as HTMLElement).dataset.state)).toEqual(["active", "pending"]);
  }
});

describe("provider delegation through the existing presentation wire", () => {
  it.each(["live", "load"])("Codex %s builds one card, owns child output, and keeps wait separate", async phase => {
    const rows = fixtures["codex-subagent-optin"].filter((r: any) => r.phase === phase);
    const s = setup("codex", rows[0].sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: true });
    if (phase === "load") {
      s.client.sessionId = undefined;
      (s.client as any).request = async () => {
        for (const row of rows) s.accept(row.update, row.sessionId);
        return {};
      };
      await s.client.loadSession(rows[0].sessionId);
    } else for (const row of rows) s.accept(row.update, row.sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: false });
    for (const h of [s.desk, s.phone, s.reopen()]) {
      await frame(h);
      expect(h.doc.querySelectorAll(".subagent-card")).toHaveLength(1);
      const card = h.doc.querySelector(".subagent-card")!;
      expect(card.classList.contains("subagent-done")).toBe(true);
      expect(card.querySelector(".subagent-stream")?.textContent).toContain("4");
      expect(card.querySelector(".subagent-result-body")?.textContent).toBe("4");
      expect(card.querySelector(".subagent-result .msg-copy-btn")).not.toBeNull();
      expect(card.querySelector(".subagent-title")?.textContent).toBe("Arithmetic");
      expect(h.doc.querySelector("#messages")?.textContent).not.toMatch(/Start subagent|Complete subagent/);
    }
    expect(s.buffer.filter(m => m.type === "toolCall" && m.call.title === "wait")).toHaveLength(phase === "live" ? 1 : 0);
  });

  it.each(["live", "load"])("Claude %s preserves the card, hand-back, duration and tokens without a child stream", phase => {
    const rows = fixtures["claude-subagent"].filter((r: any) => r.phase === phase);
    const s = setup("claude", rows[0].sessionId);
    for (const row of rows) s.accept(row.update, row.sessionId);
    for (const h of [s.desk, s.phone, s.reopen()]) {
      const card = h.doc.querySelector(".subagent-card")!;
      expect(card).not.toBeNull();
      expect(card.classList.contains("subagent-done")).toBe(true);
      expect(card.querySelector(".subagent-result")?.textContent).toContain("4");
      expect(card.querySelector(".subagent-result")?.textContent).not.toMatch(/hand-back|agentId|usage/);
      expect(card.querySelector(".subagent-time")?.textContent).toBe("0:01");
      expect(card.querySelector(".delegation-meta")?.textContent).toContain("tokens");
    }
    expect(s.buffer.some(m => m.type === "childStream")).toBe(false);
  });

  it("Claude's marker is authoritative even when the first title is descriptive", () => {
    const s = setup("claude");
    s.accept({ sessionUpdate: "tool_call", toolCallId: "agent", title: "Compute four", kind: "think",
      _meta: { claudeCode: { toolName: "Agent", subagent: true } } });
    expect(s.desk.doc.querySelectorAll(".subagent-card")).toHaveLength(1);
  });

  it.each(["live", "load"])("Claude workflow %s has one unpinned launch receipt and a safe replay notice", async phase => {
    const rows = fixtures["claude-workflow"].filter((r: any) => r.phase === phase);
    const s = setup("claude", rows[0].sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: true });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Workflow launched." } });
    for (const row of rows) s.accept(row.update, row.sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: false });
    for (const h of [s.desk, s.phone, s.reopen()]) {
      await frame(h);
      expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
      expect(h.doc.querySelector(".workflow-pin")).toBeNull();
      expect(h.doc.querySelector(".workflow-card")?.textContent).not.toMatch(/no recent updates|no update since/);
      expect(h.doc.querySelector(".workflow-card")?.textContent).toContain(phase === "load" ? "done" : "running");
      expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(0);
      expect(h.doc.querySelector("#messages")?.textContent).not.toContain("<task-notification>");
      expect(h.doc.querySelector("#messages")?.textContent).toContain("alpha beta");
      if (phase === "load") {
        const notice = h.doc.querySelector(".plan-notice")!;
        expect(notice.textContent).toBe("Background task completed.");
        const answer = [...h.doc.querySelectorAll(".msg.agent .body")].find(el => el.textContent?.trim() === "alpha beta");
        expect(answer).toBeDefined();
        expect(!!(notice.compareDocumentPosition(answer!) & 4)).toBe(true);
      }
    }
    expect(s.buffer.filter(m => m.type === "planNotice")).toHaveLength(phase === "load" ? 1 : 0);
    expect(s.buffer.some(m => m.type === "userMessageChunk")).toBe(false);
  });

  it.each([false, true])("Muse workflow roster and final summary survive history=%s and phone buffering", history => {
    const s = setup("muse");
    const p = new Projection(update => s.accept(update), () => {});
    const rows = fixtures["muse-workflow"];
    if (history) p.acceptHistory(rows.at(-1).item);
    else {
      for (const row of rows.slice(0, -1)) p.accept(row.method, { item: row.item });
      expect(s.buffer.filter(m => m.type === "runProgress").at(-1).update.done).toBe(false);
      expect(s.desk.doc.querySelectorAll(".workflow-pin .workflow-agent")).toHaveLength(2);
      expect(s.desk.doc.querySelector(".workflow-card .workflow-expanded")).toBeNull();
      expect(s.desk.doc.querySelector(".workflow-trace")).not.toBeNull();
      expect(s.desk.doc.querySelector(".workflow-pin-pref")).not.toBeNull();
      expect(s.desk.doc.querySelectorAll(".run-progress-btn")).toHaveLength(0);
      for (const h of [s.desk, s.phone, s.reopen()]) {
        const dots = h.doc.querySelectorAll(".workflow-pin .workflow-dot");
        expect([...dots].map(dot => (dot as HTMLElement).dataset.state)).toEqual(["done", "done"]);
        expect(dots[0].parentElement?.hidden).toBe(false);
        expect(h.doc.querySelectorAll(".workflow-phase")).toHaveLength(0);
      }
      p.accept(rows.at(-1).method, { item: rows.at(-1).item });
      p.accept(rows.at(-1).method, { item: rows.at(-1).item }); // duplicate revision
    }
    expect(s.buffer.filter(m => m.type === "runProgress")).toHaveLength(history ? 1 : rows.length);
    for (const h of [s.desk, s.phone, s.reopen()]) {
      expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
      expect(h.doc.querySelectorAll(".workflow-agent")).toHaveLength(2);
      expect([...h.doc.querySelectorAll(".workflow-report-dots .workflow-dot")].map(dot => (dot as HTMLElement).dataset.state)).toEqual(["done", "done"]);
      expect(h.doc.querySelector(".workflow-output-body")?.textContent).toMatch(/alpha[\s\S]*beta/);
      expect(h.doc.querySelector(".workflow-output-body code")?.textContent).toContain('"status": "ok"');
      expect(h.doc.querySelector(".workflow-output-body")?.textContent).not.toContain("Returned value:");
      expect(h.doc.querySelector(".workflow-pin")).toBeNull();
      expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(0);
    }
  });

  it.each(backends.map(b => b.provider))("%s accepts post-end_turn output once without a new prompt", async provider => {
    const s = setup(provider);
    s.emit({ type: "agentStart" });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Launched. " } });
    s.emit({ type: "agentEnd" });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "alpha beta" } });
    for (const h of [s.desk, s.phone, s.reopen()]) {
      await frame(h);
      expect(h.doc.querySelector("#messages")?.textContent?.match(/alpha beta/g)).toHaveLength(1);
    }
    expect(s.buffer.filter(m => m.type === "messageChunk" && m.text === "alpha beta")).toHaveLength(1);
  });

  it("Grok tool cards still use lifecycle tagging and finish through that rail", () => {
    const s = setup("grok");
    const call = { sessionUpdate: "tool_call", toolCallId: "grok-call", title: "spawn_subagent",
      _meta: { "x.ai/tool": { name: "spawn_subagent" } }, rawInput: { description: "Compute four", background: true } };
    expect(grokBackend.normalizeUpdate(call, undefined).update).toBe(call);
    s.accept(call);
    s.client.emit("xaiNotification", { sessionUpdate: "subagent_spawned", subagent_id: "child", child_session_id: "child" });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "4" } }, "child");
    s.client.emit("xaiNotification", { sessionUpdate: "subagent_finished", subagent_id: "child", status: "completed", output: "4", duration_ms: 2353 });
    const card = s.desk.doc.querySelector(".subagent-card")!;
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.querySelector(".subagent-stream")?.textContent).toContain("4");
    expect(card.querySelector(".subagent-time")?.textContent).toBe("0:02");
  });

  it("all reused messages remain mirrored and session-scoped", () => {
    for (const type of ["toolCall", "toolCallUpdate", "subagentUpdate", "childStream", "runProgress", "planNotice", "messageChunk"] as const) {
      expect(OUTBOUND_DISPOSITION[type]).toBe("mirror");
      expect(OUTBOUND_PROJECT_AUTH[type]).toBe("scope");
    }
  });
});

it.each(["completed", "failed"])("Claude upgrades the receipt in place and finishes %s on desk, phone and warm reopen", terminal => {
  const s = setup("claude");
  s.accept(claudeAsyncWire[1]);
  const card = s.desk.doc.querySelector(".workflow-card");
  expect(card?.textContent).toContain("running");
  s.accept(claudeAsyncWire[0]);
  for (const update of claudeAsyncWire.slice(2, 5)) s.accept(update);
  expect(s.desk.doc.querySelector(".workflow-card")).toBe(card);
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
    expect(h.doc.querySelectorAll(".workflow-pin .workflow-dot")).toHaveLength(2);
    expect(h.doc.querySelector(".workflow-pin")?.textContent).toContain("two-steps");
    expect(h.doc.querySelector(".workflow-pin")?.textContent).toContain("step-two");
    expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(0);
  }
  s.accept(claudeAsyncWire[5]);
  s.accept({ ...claudeAsyncWire[6], state: terminal, summary: "## Result\n\n**Finished** <script>bad()</script>" });
  s.accept({ ...claudeAsyncWire[7], state: terminal });
  s.accept(claudeAsyncWire[1]);
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    expect(h.doc.querySelector(".workflow-report-state")?.textContent).toBe(terminal === "completed" ? "done" : "failed");
    expect(h.doc.querySelectorAll(".workflow-agent")).toHaveLength(2);
    expect(h.doc.querySelector(".workflow-output-body h2")?.textContent).toBe("Result");
    expect(h.doc.querySelector(".workflow-output-body script")).toBeNull();
  }
});

it("Claude phase and agent labels stay text on desk, phone and buffered reopen", () => {
  const s = setup("claude");
  s.accept(claudeAsyncWire[1]); s.accept(claudeAsyncWire[0]);
  s.accept({ ...claudeAsyncWire[3], description: '<img src=x onerror=bad()>: <script>bad()</script>' });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    const pin = h.doc.querySelector(".workflow-pin")!;
    expect(pin.textContent).toContain("<script>bad()</script>");
    expect(pin.querySelector("img, script")).toBeNull();
  }
});

it.each(["completed", "failed", "stopped"])("Claude phase progression and parallel agents stay clear on desk/phone/reopen (%s)", terminal => {
  const s = setup("claude");
  s.accept(claudeAsyncWire[1]); s.accept(claudeAsyncWire[0]);
  for (const description of ["Pick: three nouns", "Describe: describe:wave", "Describe: describe:tide", "Describe: describe:reef", "Describe: describe:wave"]) {
    s.accept({ ...claudeAsyncWire[3], description });
  }
  for (const h of [s.desk, s.phone, s.reopen()]) {
    const pin = h.doc.querySelector(".workflow-pin")!;
    expect([...pin.querySelectorAll(".workflow-phase")].map(el => (el as HTMLElement).dataset.state)).toEqual(["done", "active"]);
    expect([...pin.querySelectorAll(".workflow-agent")].map(el => (el as HTMLElement).dataset.state)).toEqual(["done", "active", "active", "active"]);
    expect(pin.textContent).not.toMatch(/unknown|\?/);
  }
  s.accept({ ...claudeAsyncWire[3], description: "Combine: make a haiku" });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect([...h.doc.querySelectorAll(".workflow-pin .workflow-agent")].map(el => (el as HTMLElement).dataset.state)).toEqual(["done", "done", "done", "done", "active"]);
  }
  s.accept({ ...claudeAsyncWire[6], state: terminal });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".workflow-report-state")?.textContent).toBe(terminal === "completed" ? "done" : terminal === "stopped" ? "stopped" : "failed");
    expect([...h.doc.querySelectorAll(".workflow-agent")].map(el => (el as HTMLElement).dataset.state)).toEqual(["done", "done", "done", "done", terminal === "completed" ? "done" : terminal === "stopped" ? "cancelled" : terminal]);
    expect(h.doc.querySelector(".workflow-card")?.textContent).not.toMatch(/unknown|\?/);
  }
});

it.each(["inProgress", "failed"])("Muse child dots distinguish failure without phases or invented names (%s)", status => {
  const s = setup("muse");
  const p = new Projection(update => s.accept(update), () => {});
  p.acceptHistory({ ...fixtures["muse-workflow"].at(-1).item, status,
    children: [{ childId: "one", status: "terminal", terminal: "failed" }, { childId: "two", status: "started" }] });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    const selector = status === "inProgress" ? ".workflow-pin .workflow-dot" : ".workflow-report-dots .workflow-dot";
    expect([...h.doc.querySelectorAll(selector)].map(dot => (dot as HTMLElement).dataset.state)).toEqual(["failed", "active"]);
    expect(h.doc.querySelectorAll(".workflow-phase")).toHaveLength(0);
    expect(h.doc.querySelectorAll(".workflow-agent-name")[0].textContent).toBe("Agent 1");
  }
});

describe("paused workflow Markdown (#189)", () => {
  it.each(["grok", "muse"])("%s renders only the pause message with the Output sanitizer", provider => {
    const h = view();
    const update = parseRunProgressUpdate({ sessionUpdate: "workflow_updated", run_id: "paused", name: "review",
      status: "user_paused", pause_message: "## Ready\n\n- Needs attention\n- Planning\n- Archive\n\n<script>bad()</script>",
      last_event: "stale event", last_event_detail: "leftover detail",
      ...(provider === "muse" ? { controlsAvailable: false } : {}) })!;
    dispatch(h.window, { type: "runProgress", update });
    const detail = h.doc.querySelector(".run-progress-detail")!;
    expect(detail.querySelector("h2")?.textContent).toBe("Ready");
    expect(detail.querySelectorAll("li")).toHaveLength(3);
    expect(detail.querySelector("script")).toBeNull();
    expect(detail.textContent).not.toMatch(/stale event|leftover detail/);
    dispatch(h.window, { type: "runProgress", update: { ...update, phase: "running", workflowContent: { pauseMessage: null, resultSummary: null } } });
    expect(h.doc.querySelector(".run-progress-detail")?.textContent).toBe("");
  });
});

it.each(["live", "load"])("Claude %s uses the launched name and description without claiming progress", phase => {
  const s = setup("claude");
  if (phase === "load") s.emit({ type: "historyReplay", active: true });
  if (phase === "live") s.accept({ sessionUpdate: "tool_call_update", toolCallId: "launch",
    _meta: { claudeCode: { toolName: "Workflow", toolResponse: { status: "async_launched",
      taskType: "local_workflow", runId: "wf-demo", taskId: "task-demo", workflowName: "greeting-demo", summary: "Write then shorten" } } } });
  s.accept({ sessionUpdate: "tool_call_update", toolCallId: "launch", status: "completed",
    _meta: { claudeCode: { toolName: "Workflow" } }, rawOutput:
      "Workflow launched in background. Task ID: task-demo\nSummary: Write then shorten\nScript file: /project/workflows/scripts/greeting-demo-wf-demo.js\nRun ID: wf-demo" });
  if (phase === "load") s.emit({ type: "historyReplay", active: false });
  s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The workflow finished." } });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("greeting-demo");
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("running");
    expect(h.doc.querySelector(".workflow-card")?.textContent).not.toContain("Write then shorten");
    expect(h.doc.querySelector(".workflow-pin, .workflow-receipt, .run-progress-btn")).toBeNull();
  }
  s.accept({ sessionUpdate: "user_message_chunk", content: { type: "text", text:
    "<task-notification><task-id>task-demo</task-id><status>completed</status><result>Hello there friend</result></task-notification>" } });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("done");
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("greeting-demo");
    expect(h.doc.querySelector(".workflow-card")?.textContent).not.toContain("Hello there friend");
    expect(h.doc.querySelector(".workflow-pin, .workflow-receipt, .run-progress-btn")).toBeNull();
  }
});
