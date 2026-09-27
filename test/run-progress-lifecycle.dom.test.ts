// Real CLI capture through the real parser and renderer. In particular, revision
// 4 arrives twice and tokens_used stays zero across the entire lifecycle.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { sessionDirFor } from "../src/sessions";
import { parseRunProgressUpdate } from "../src/run-progress";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const frames = readFileSync(new URL("fixtures/workflow-lifecycle-live.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const windows: Harness["window"][] = [];
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });
function replay() {
  let now = 100_000;
  const h = bootWebview({ beforeScripts: (window) => {
    (window as any).Date = class extends window.Date { static now() { return now; } };
  } });
  windows.push(h.window);
  return { ...h,
    advance: (ms: number) => { now += ms; },
    frame: (i: number) => dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate(frames[i]) }),
  };
}
const text = (h: Harness, selector: string) => h.doc.querySelector(selector)?.textContent ?? "";

const statelessRuns = JSON.parse(readFileSync(new URL("fixtures/workflow-stateless-phases.json", import.meta.url), "utf8")).runs;
const capturedComplete = JSON.parse(readFileSync(new URL("fixtures/workflow-state/complete.json", import.meta.url), "utf8"));
// Two independent runs with the captured disk structure and fixture-local identities.
const capturedRuns = [1, 2].map(n => {
  const file = structuredClone(capturedComplete);
  file.state.run_id = `wf_capture_${n}`;
  file.state.name = `captured-research-${n}`;
  return { run_id: file.state.run_id, name: file.state.name, state: file.state, file };
});
const outputRuns = JSON.parse(readFileSync(new URL("fixtures/workflow-output.json", import.meta.url), "utf8")).runs;

describe("old host output compatibility", () => {
  it.each(outputRuns)("omits ambiguous legacy detail while settling $run_id", (run) => {
    const h = replay();
    const { workflowContent, ...legacy } = parseRunProgressUpdate(run)!;
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "runProgress", update: legacy });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect({ output: h.doc.querySelector(".workflow-output"), pin: h.doc.querySelector(".workflow-pin"),
      detail: text(h, ".run-progress-detail"), summary: text(h, ".run-progress-sub"),
      spend: text(h, ".workflow-spend"), open: (h.doc.querySelector("details") as HTMLDetailsElement).open,
    }).toEqual({ output: null, pin: null, detail: "", summary: "",
      spend: `${run.agents_used} agents`, open: false });
  });
});

describe("completion without a terminal notification", () => {
  it.each([80, 10])("keeps every disk-repaired frame above a %i-turn window done and unpinned after replay and scroll-up", (turns) => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-window-"));
    vi.stubEnv("GROK_HOME", dir);
    const h = replay();
    (h.window as any).__grokHistoryWindow = turns;
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    session.provider = "grok";
    session.activeSessionId = "01a0c8e9-649c-7130-9515-915e62291d30";
    sidebar.focused = session;
    sidebar.view = { webview: { postMessage: (message: unknown) => dispatch(h.window, structuredClone(message)) } };
    sidebar.mirrorToProjectsRail = () => {};
    sidebar.sendRemoteSession = () => {};
    sidebar.sessionCwd = () => dir;
    const run = capturedRuns[0];
    const update = parseRunProgressUpdate({ ...run.state, sessionUpdate: "workflow_updated",
      run_id: run.run_id, name: run.name, status: "active", revision: 1 })!;
    const later = Array.from({ length: turns }, (_, i) => `Later turn ${i}`);
    session.buffer.push({ type: "userMessage", text: "Before run" }, { type: "runProgress", update },
      { type: "userMessage", text: "During run" },
      { type: "runProgress", update: { ...update, revision: 2 } },
      ...later.map(text => ({ type: "userMessage" as const, text })));
    const replayBuffer = () => {
      dispatch(h.window, { type: "clearMessages" });
      dispatch(h.window, { type: "historyReplay", active: true });
      for (const message of session.buffer) dispatch(h.window, structuredClone(message));
      dispatch(h.window, { type: "historyReplay", active: false });
    };
    try {
      replayBuffer();
      const folder = join(sessionDirFor(dir, dir, session.activeSessionId)!, "workflows", run.run_id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "state.json"), JSON.stringify(run.file));
      sidebar.refreshWorkflowCompletions(session);
      // Discard the live client's replaceOnly-patched prefix, as a focus switch
      // or reload does. Only the host buffer can make this second replay safe.
      replayBuffer();
      const order = () => [...h.doc.querySelectorAll(".msg.user .body, .workflow-report-name")].map(el => el.textContent);
      expect({ order: order(), card: h.doc.querySelector(".workflow-card"),
        prefix: (h.window as any).__grokHistory.prefixRemaining() })
        .toEqual({ order: later, card: null, prefix: 2 });
      const messages = h.doc.getElementById("messages")!;
      Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 10000 });
      messages.dispatchEvent(new h.window.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
      messages.scrollTop = 0;
      messages.dispatchEvent(new h.window.Event("scroll"));
      expect({ order: order(), pin: h.doc.querySelector(".workflow-pin, .workflow-marker, .run-progress-btn, [aria-current=step]"),
        reports: [...h.doc.querySelectorAll(".workflow-report")].map(el => (el as HTMLDetailsElement).open),
      }).toEqual({ order: ["Before run", "captured-research-1", "During run", ...later], pin: null, reports: [false] });
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["desk", "phone"])("does not append a live repair outside the %s window", (surface) => {
    const h = replay();
    (h.window as any).__grokHistoryWindow = 1;
    const update = parseRunProgressUpdate({ ...capturedRuns[0].state, sessionUpdate: "workflow_updated",
      run_id: capturedRuns[0].run_id, name: capturedRuns[0].name, status: "active" })!;
    dispatch(h.window, { type: "historyReplay", active: true });
    if (surface === "desk") {
      dispatch(h.window, { type: "userMessage", text: "Before run" });
      dispatch(h.window, { type: "runProgress", update });
    }
    dispatch(h.window, { type: "userMessage", text: "After run" });
    dispatch(h.window, { type: "historyReplay", active: false });
    dispatch(h.window, { type: "runProgress", update: { ...update, done: true, phase: "completed" }, replaceOnly: true });
    const visible = [...h.doc.querySelectorAll(".msg.user .body, .workflow-report-name")].map(el => el.textContent);
    (h.window as any).__grokHistory.expandAll();
    expect({ visible,
      expanded: [...h.doc.querySelectorAll(".msg.user .body, .workflow-report-name")].map(el => el.textContent),
      pin: h.doc.querySelector(".workflow-pin, .workflow-marker, .run-progress-btn"),
    }).toEqual({ visible: ["After run"],
      expanded: surface === "desk" ? ["Before run", "captured-research-1", "After run"] : ["After run"], pin: null });
  });

  it.each(["live", "unobserved completion", "cold replay", "browser reload"])("repairs from disk in the middle of the transcript and replays closed reports in order (%s)", (mode) => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "workflow-state-"));
    vi.stubEnv("GROK_HOME", dir);
    const h = replay();
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    session.provider = "grok";
    session.activeSessionId = "01a0c8e9-649c-7130-9515-915e62291d30";
    sidebar.focused = session;
    sidebar.pool = new Set([session]);
    let watching = mode !== "unobserved completion";
    sidebar.view = watching ? { webview: { postMessage: (message: unknown) => dispatch(h.window, message) } } : undefined;
    sidebar.localizeHistoryMessage = (message: unknown) => message;
    sidebar.mirrorToProjectsRail = () => {};
    sidebar.sendRemoteSession = () => {};
    sidebar.sessionCwd = () => dir;
    sidebar.isAuthorizedCwd = () => true;
    sidebar.remoteClients = { clientsForActiveValue: () => watching ? ["phone"] : [] };
    sidebar.sendRemoteClient = (_id: string, message: unknown) => dispatch(h.window, message);
    const sessionDir = sessionDirFor(dir, dir, session.activeSessionId)!;
    const writeStates = () => {
      for (const run of capturedRuns) {
        const folder = join(sessionDir, "workflows", run.run_id);
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "state.json"), JSON.stringify(run.file));
      }
    };
    try {
      if (mode === "cold replay") writeStates();
      dispatch(h.window, { type: "historyReplay", active: mode !== "live" });
      for (const run of capturedRuns) {
        sidebar.emit(session, { type: "userMessage", text: `Start ${run.name}` });
        // A deliberately stale notification, not a fabricated capture from the
        // affected machine. Disk state is the supplied CLI shape.
        const message = { type: "runProgress", update: parseRunProgressUpdate({ ...run.state,
          status: "active", sessionUpdate: "workflow_updated", run_id: run.run_id, name: run.name,
          elapsed_ms: run.state.elapsed_ms_floor, revision: 42 })! };
        if (mode === "browser reload") session.buffer.push(message as any);
        else sidebar.emit(session, message);
      }
      sidebar.emit(session, { type: "userMessage", text: "Later conversation" });
      if (mode === "cold replay") {
        expect(session.buffer.filter(m => m.type === "runProgress" && m.update.done)).toHaveLength(2);
      }
      if (mode !== "cold replay") writeStates();
      if (mode === "live" || mode === "unobserved completion") {
        if (watching) (h.doc.querySelector(".workflow-pin-toggle") as any).click();
        sidebar.startWorkflowCompletionPolling();
        vi.advanceTimersByTime(2000);
        if (!watching) {
          expect(session.buffer.filter(m => m.type === "runProgress" && m.update.done)).toHaveLength(2);
          watching = true;
          sidebar.sendRemoteHistorySnapshot(session);
        }
      } else sidebar.sendRemoteHistorySnapshot(session);
      dispatch(h.window, { type: "historyReplay", active: false });
      expect(h.doc.querySelector(".workflow-pin, .workflow-marker, .run-progress-btn, [aria-current=step]")).toBeNull();
      expect([...h.doc.querySelectorAll(".workflow-report-name")].map(el => el.textContent))
        .toEqual(["captured-research-1", "captured-research-2"]);
      expect([...h.doc.querySelectorAll("details")].map(el => el.open)).toEqual([false, false]);
      expect([...h.doc.querySelectorAll(".workflow-phase")].map(el => el.getAttribute("data-state")))
        .toEqual(Array(8).fill("done"));
      expect([...h.doc.querySelectorAll(".delegation-time")].map(el => el.textContent)).toEqual(["4:39", "4:39"]);
      expect(h.doc.querySelector(".workflow-agent button, .workflow-agent-chevron")).toBeNull();
      const count = session.buffer.length;
      sidebar.refreshWorkflowCompletions(session);
      expect(session.buffer).toHaveLength(count);
      // Replay into a fresh view so existing cards cannot hide appended repairs.
      const restored = replay();
      dispatch(restored.window, { type: "historyReplay", active: true });
      for (const message of session.buffer) dispatch(restored.window, message);
      dispatch(restored.window, { type: "historyReplay", active: false });
      expect({
        bufferOrder: session.buffer.map(m => m.type === "runProgress" ? `${m.update.title}: ${m.update.done}`
          : m.type === "userMessage" ? m.text : m.type),
        replayOrder: [...restored.doc.querySelectorAll(".msg.user .body, .workflow-report-name")].map(el => el.textContent),
      }).toEqual({
        bufferOrder: ["Start captured-research-1", "captured-research-1: true", "Start captured-research-2", "captured-research-2: true", "Later conversation"],
        replayOrder: ["Start captured-research-1", "captured-research-1", "Start captured-research-2", "captured-research-2", "Later conversation"],
      });
    } finally {
      clearInterval(sidebar.workflowTimer);
      vi.useRealTimers();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("repairs an old host's complete/done:false snapshot (historical %s)", (historical) => {
    const h = replay();
    dispatch(h.window, { type: "historyReplay", active: historical });
    for (const run of statelessRuns) {
      const update = parseRunProgressUpdate({ ...run.state, sessionUpdate: "workflow_updated", run_id: run.run_id, name: run.name })!;
      dispatch(h.window, { type: "runProgress", update: { ...update, done: false } });
    }
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(h.doc.querySelector(".workflow-pin, .workflow-marker, .run-progress-btn")).toBeNull();
    expect([...h.doc.querySelectorAll(".workflow-report")].map(el => (el as HTMLDetailsElement).open)).toEqual([false, false]);
    expect([...h.doc.querySelectorAll(".workflow-report-name")].map(el => el.textContent))
      .toEqual(["demo-stages", "demo-stages-2"]);
  });
});

describe("the captured workflow lifecycle", () => {
  // Synthetic completion extends the captured start/pause/cancel vocabulary;
  // the capture itself never reached Report.
  it.each([false, true])("settles a complete rollup and rejects an older active revision (replay %s)", (historical) => {
    const h = replay();
    dispatch(h.window, { type: "historyReplay", active: historical });
    h.frame(0);
    const finish = { ...frames[6], revision: 8, status: "complete", current_phase: "Report",
      phases: frames[0].phases.map((p: { title: string }) => ({ ...p, state: "done" })),
      result_summary: "Partial", agents_used: 6, agent_budget: 16, elapsed_ms: 390000,
    };
    dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate(finish) });
    h.frame(2);
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(h.doc.querySelector(".workflow-pin, .workflow-marker, [aria-current=step]")).toBeNull();
    expect(text(h, ".workflow-report-name")).toBe("deep-research");
    expect(text(h, ".workflow-card .delegation-time")).toBe("6:30");
    expect(text(h, ".workflow-card .workflow-output-body")).toBe("Partial");
    expect(text(h, ".workflow-card .workflow-spend")).toBe("6 agents");
    expect(h.doc.querySelectorAll('.workflow-phase[data-state="done"]')).toHaveLength(4);
  });

  it("preserves observed fields, including the zero-token cancelled agent", () => {
    const updates = frames.map(parseRunProgressUpdate);
    expect(updates.every(Boolean)).toBe(true);
    expect(updates[0]!.agents).toBeUndefined();
    expect(updates[0]!.currentPhase).toBeUndefined();
    expect(updates[1]!.phases).toHaveLength(4);
    expect(updates[2]!.agents![0]).toMatchObject({ label: "research-planner", phase: "Plan", state: "running", tokensUsed: 0 });
    expect(updates[2]).toEqual(updates[3]);
    expect(updates[5]!.agents![0].state).toBe("cancelled");
    expect(updates.slice(4).map((u) => u!.elapsedMs)).toEqual([182, 182, 182]);
    expect(updates.every((u) => u!.displayName === "deep-research")).toBe(true);
  });
  it("never claims motion from duplicate frames, run pause or zero tokens", () => {
    const h = replay();
    for (let i = 0; i <= 4; i++) {
      h.advance(4000); h.frame(i);
      expect(h.doc.querySelector(".workflow-motion")).toBeNull();
      expect(text(h, ".workflow-agent-activity")).not.toMatch(/tokens moved|state changed/);
      expect(h.doc.querySelector(".workflow-card .blink-dots")).toBeNull();
    }
    expect(text(h, ".workflow-pin .run-progress-phase")).toBe("paused");
    expect([...h.doc.querySelectorAll(".workflow-pin .run-progress-btn")].map((b) => b.textContent)).toEqual(["Resume", "Stop"]);
  });
  it("observes a cancelled state transition without portraying it as ongoing work", () => {
    const h = replay(); h.frame(4); h.frame(5);
    expect(text(h, ".workflow-agent-state")).toBe("cancelled · 0 tokens");
    expect(text(h, ".workflow-agent-activity")).toBe("state changed 0s ago \u00b7 no token activity observed");
    h.advance(12000); h.frame(5);
    expect(text(h, ".workflow-agent-activity")).toBe("state changed 12s ago \u00b7 no token activity observed");
    expect(h.doc.querySelector(".workflow-motion")).toBeNull();
    expect(h.doc.querySelector(".workflow-receipt")).toBeNull();
  });
  it("ends the pin on stop while retaining the reported duration and roster in the transcript", () => {
    const h = replay(); frames.forEach((_, i) => h.frame(i));
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    expect(text(h, ".workflow-card .run-progress-phase")).toBe("");
    expect(text(h, ".workflow-card .delegation-time")).toBe("0:00");
    expect(text(h, ".workflow-agent-state")).toBe("cancelled · 0 tokens");
    expect(h.doc.querySelector(".workflow-card")!.classList.contains("run-progress-cancelled")).toBe(true);
    expect(h.doc.querySelectorAll(".workflow-card .run-progress-btn")).toHaveLength(0);
  });
  it("keeps state-change evidence without denying an unchanged positive token total", () => {
    const h = replay();
    for (const i of [4, 5, 6]) {
      const update = parseRunProgressUpdate(frames[i])!;
      dispatch(h.window, { type: "runProgress", update: {
        ...update, agents: update.agents!.map((agent) => ({ ...agent, tokensUsed: 288307 })),
      } });
    }
    expect(text(h, ".workflow-card .workflow-agent-state")).toBe("cancelled · 288K tokens");
    expect(text(h, ".workflow-card .workflow-agent-activity")).toBe("state changed");
  });
});
