import { afterEach, describe, expect, it } from "vitest";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";

const windows: Harness["window"][] = [];
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });

function view(provider = "grok") {
  let now = 100_000;
  const ticks: (() => void)[] = [];
  const h = bootWebview({ beforeScripts(window) {
    (window as any).Date = class extends window.Date { static now() { return now; } };
    const interval = window.setInterval.bind(window);
    window.setInterval = ((fn: () => void, ms: number) => {
      if (ms === 1000) { ticks.push(fn); return 123; }
      return interval(fn, ms);
    }) as any;
  } });
  windows.push(h.window);
  dispatch(h.window, { type: "providerState", providers: [{ id: provider }] });
  dispatch(h.window, { type: "session", sessionId: "parent", provider, models: [] });
  return { ...h, tick(ms: number) { now += ms; for (const fn of ticks) fn(); } };
}

function subagent(h: Harness, status = "in_progress", extra = {}) {
  dispatch(h.window, { type: h.doc.querySelector(".subagent-card") ? "toolCallUpdate" : "toolCall", call: {
    toolCallId: "child-tool", title: "spawn_subagent", child_session_id: "child",
    rawInput: { description: "Check facts" }, status, ...extra,
  } });
  return h.doc.querySelector(".subagent-card")!;
}
function workflow(h: Harness, provider: string, status = "running", extra = {}) {
  dispatch(h.window, { type: "runProgress", update: {
    id: "run", kind: "workflow", title: "Check facts", displayName: "check",
    phase: status, done: status !== "running", failed: status === "failed",
    controlsAvailable: provider === "grok",
    phases: [{ title: "Secret step name", state: status === "running" ? "active" : "done" }],
    agents: [{ id: "agent", label: "Researcher", state: status, tokensUsed: 36420 }],
    agentsUsed: 1, ...extra,
  } });
  return h.doc.querySelector(".workflow-card")!;
}
function header(card: Element, kind: string, status: string, expandable: boolean) {
  const row = card.querySelector(".delegation-header")!;
  expect([...row.children].map(el => [...el.classList].find(c => c.startsWith("delegation-"))))
    .toEqual(["delegation-icon", "delegation-kind", "delegation-name", ...(kind === "Workflow" ? ["delegation-dots"] : []),
      "delegation-status", "delegation-time", ...(expandable ? ["delegation-chevron"] : [])]);
  expect(row.querySelector(".delegation-icon svg")).not.toBeNull();
  expect(row.querySelector(".delegation-kind")!.textContent).toBe(kind);
  expect(row.querySelector(".delegation-status")!.textContent).toBe(status);
  expect(row.textContent).not.toMatch(/tokens|Secret step|Child prose|updated|Output/);
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(card.querySelector(".blink-dots")).toBeNull();
  return row;
}

describe("Find inside a closed card", () => {
  const find = (h: Harness, q: string) => {
    const api = (h.window as any).__grokFind;
    api.open(); api.setQuery(q); api.next();
    return api;
  };

  it("opens a finished subagent card and keeps it open through the refresh timer", () => {
    const h = view("claude");
    const card = subagent(h);
    subagent(h, "completed", { rawOutput: { text: "needle in the result" }, _meta: { subagentUsage: { tokens: 10, durationMs: 1000 } } });
    expect((card.querySelector(".subagent-result") as HTMLElement).hidden).toBe(true);
    find(h, "needle");
    h.tick(3000);
    expect((card.querySelector(".subagent-result") as HTMLElement).hidden).toBe(false);
    expect(card.querySelector(".delegation-header")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens a running workflow's closed transcript card when the hit is inside it", () => {
    const h = view();
    const card = workflow(h, "grok", "running", { phases: [{ title: "Needle step", state: "active" }] });
    const body = card.querySelector(".workflow-expanded") as HTMLElement;
    expect(body.hidden).toBe(true);
    find(h, "Needle step");
    expect(body.hidden).toBe(false);
    workflow(h, "grok", "running", { phases: [{ title: "Needle step", state: "active" }] });
    expect((card.querySelector(".workflow-expanded") as HTMLElement).hidden).toBe(false);
  });

  it.each(["running", "done"])("leaves an empty %s workflow card closed when Find hits its hidden labels", status => {
    const h = view("claude");
    const card = workflow(h, "claude", status, { phases: [], agents: [], agentsUsed: undefined, controlsAvailable: false });
    find(h, "Steps");
    const row = card.querySelector(".delegation-header")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".delegation-chevron")).toBeNull();
    if (status === "done") expect((card.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    else expect((card.querySelector(".workflow-expanded") as HTMLElement).hidden).toBe(true);
  });
});

describe("header dots for long workflows", () => {
  const shown = (card: Element) => [...card.querySelector(".delegation-header .workflow-dots")!.children]
    .filter(el => !(el as HTMLElement).hidden)
    .map(el => el.classList.contains("workflow-dots-more") ? "…" : (el as HTMLElement).dataset.state);
  const steps = (states: string[]) => states.map((state, i) => ({ title: `Step ${i + 1}`, state }));

  it("keeps every dot up to four steps", () => {
    const h = view();
    expect(shown(workflow(h, "grok", "running", { phases: steps(["done", "done", "active", "pending"]) })))
      .toEqual(["done", "done", "active", "pending"]);
  });

  it("windows eight steps to the current one and its neighbours, marking what is hidden", () => {
    const h = view();
    expect(shown(workflow(h, "grok", "running", { phases: steps(["active", ...Array(7).fill("pending")]) })))
      .toEqual(["active", "pending", "pending", "…"]);
    expect(shown(workflow(h, "grok", "running", { phases: steps(["done", "done", "done", "active", "pending", "pending", "pending", "pending"]) })))
      .toEqual(["…", "done", "active", "pending", "…"]);
    expect(shown(workflow(h, "grok", "done", { phases: steps(Array(8).fill("done")) })))
      .toEqual(["…", "done", "done", "done"]);
  });

  it("keeps the full list of steps inside the card", () => {
    const h = view();
    const card = workflow(h, "grok", "running", { phases: steps(["done", "active", ...Array(6).fill("pending")]) });
    expect(card.querySelectorAll(".workflow-phases > li")).toHaveLength(8);
  });
});

describe("quiet delegation card contract", () => {
  it.each(["grok", "claude", "codex"])("%s subagent has the same closed header across running, done and failed", provider => {
    for (const state of ["running", "done", "failed"]) {
      const h = view(provider);
      const card = subagent(h);
      header(card, "Subagent", "running", false);
      if (state !== "running") subagent(h, state === "done" ? "completed" : "failed", {
        rawOutput: { text: "**Result**" }, _meta: { subagentUsage: { tokens: 36420, durationMs: 7343 } },
      });
      header(card, "Subagent", state, state !== "running");
      expect((card.querySelector(".subagent-result") as HTMLElement).hidden).toBe(true);
      if (state !== "running") {
        expect(card.querySelector(".delegation-meta")!.textContent).toBe("36.42K tokens");
        expect(card.querySelector(".subagent-time")!.textContent).toBe("0:07");
      }
    }
  });

  it.each(["grok", "claude", "muse"])("%s workflow shares its closed header with the pin and finished report", provider => {
    for (const state of ["running", "done", "failed"]) {
      const h = view(provider);
      const card = workflow(h, provider, state);
      const row = header(card, "Workflow", state, true);
      if (state === "running") {
        const pin = h.doc.querySelector(".workflow-pin-run")!;
        expect(header(pin, "Workflow", state, true).innerHTML).toBe(row.innerHTML);
        expect((pin.querySelector(".workflow-expanded") as HTMLElement).hidden).toBe(true);
      } else expect((card.querySelector("details") as HTMLDetailsElement).open).toBe(false);
      expect(card.querySelector(".delegation-meta")!.textContent).toBe("1 agent · 36.42K tokens");
    }
  });

  it("offers a chevron only when activity, result, metadata or controls exist", () => {
    const h = view("claude");
    const card = subagent(h);
    header(card, "Subagent", "running", false);
    dispatch(h.window, { type: "childStream", childSessionId: "child", event: "messageChunk", text: "Child prose" });
    const row = header(card, "Subagent", "running", true);
    expect(row.tagName).toBe("BUTTON"); // native Enter/Space activation
    expect(row.getAttribute("tabindex")).toBe("0");
    click(h.window, row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector(".delegation-chevron")!.classList.contains("is-open")).toBe(true);
    expect((card.querySelector(".subagent-stream") as HTMLElement).hidden).toBe(false);
    const empty = workflow(h, "claude", "failed", { phases: [], agents: [], agentsUsed: undefined });
    const summary = header(empty, "Workflow", "failed", false);
    click(h.window, summary);
    expect((empty.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    expect(empty.textContent).not.toMatch(/No agents reported|final workflow update|historical workflow update/);
  });

  it.each(["subagent", "workflow"])("%s measures time only after a live start and freezes at completion", kind => {
    const h = view(kind === "subagent" ? "codex" : "muse");
    const send = (status = "running") => kind === "subagent" ? subagent(h, status === "running" ? "in_progress" : "completed") : workflow(h, "muse", status);
    const card = send();
    h.tick(5000);
    expect(card.querySelector(".delegation-time")!.textContent).toBe("0:05");
    send("done"); h.tick(60000);
    expect(card.querySelector(".delegation-time")!.textContent).toBe("0:05");
    send("done");
    expect(card.querySelector(".delegation-time")!.textContent).toBe("0:05");
    const replay = view();
    dispatch(replay.window, { type: "historyReplay", active: true });
    if (kind === "subagent") subagent(replay); else workflow(replay, "muse");
    if (kind === "subagent") subagent(replay, "completed"); else workflow(replay, "muse", "done");
    dispatch(replay.window, { type: "historyReplay", active: false });
    const restored = replay.doc.querySelector(kind === "subagent" ? ".subagent-card" : ".workflow-card")!;
    replay.tick(60000);
    expect(restored.querySelector(".delegation-time")!.textContent).toBe("");
    expect((restored.querySelector(".delegation-time") as HTMLElement).hidden).toBe(true);
    const terminalFirst = view();
    const finished = kind === "subagent" ? subagent(terminalFirst, "completed") : workflow(terminalFirst, "muse", "done");
    expect(finished.querySelector(".delegation-time")!.textContent).toBe("");
  });

  it("advances reported workflow time and puts two-minute staleness in both headers", () => {
    const h = view();
    const card = workflow(h, "grok", "running", { elapsedMs: 10000 });
    h.tick(119000);
    expect(card.querySelector(".delegation-time")!.textContent).toBe("2:09");
    expect(card.querySelector(".delegation-status")!.textContent).toBe("running");
    h.tick(1000);
    expect([...h.doc.querySelectorAll(".delegation-status")].map(el => el.textContent)).toEqual(["no update for 2 min", "no update for 2 min"]);
    workflow(h, "grok", "done", { elapsedMs: 123000 }); h.tick(60000);
    expect(card.querySelector(".delegation-time")!.textContent).toBe("2:03");
    expect(card.querySelector(".delegation-status")!.textContent).toBe("done");
    expect(h.doc.querySelector(".workflow-receipt")).toBeNull();
  });

  it("does not rewind elapsed on duplicate receipts, and freezes a reported pause", () => {
    const h = view();
    const card = workflow(h, "grok", "running", { elapsedMs: 10000 });
    h.tick(5000);
    workflow(h, "grok", "running", { elapsedMs: 10000 });
    expect(card.querySelector(".delegation-time")!.textContent).toBe("0:15");
    workflow(h, "grok", "running", { elapsedMs: 16000, phase: "user_paused" });
    h.tick(150000);
    expect(card.querySelector(".delegation-time")!.textContent).toBe("0:16");
    expect(card.querySelector(".delegation-status")!.textContent).toBe("paused");
    expect(h.doc.querySelector(".workflow-pin .run-progress-actions")!.closest(".workflow-expanded")).not.toBeNull();
  });

  it("keeps Claude's Allowed Workflow decision row", () => {
    const h = view("claude");
    dispatch(h.window, { type: "historyBatch", messages: [
      { type: "permissionRequest", req: { id: 9, toolCall: { toolCallId: "approval", title: "Workflow", kind: "other" }, options: [] } },
      { type: "permissionResolved", requestId: 9, optionId: "once" },
    ] });
    workflow(h, "claude");
    expect(h.doc.querySelector(".card.permission")!.textContent).toMatch(/Allowed\s*Workflow/);
  });

  it.each(["subagent", "workflow"])("%s result uses assistant markdown and copies the source", async kind => {
    const h = view();
    const source = "## Result\n\n**Source** [unsafe](javascript:alert(1)) <script>bad()</script>";
    const card = kind === "subagent" ? subagent(h, "completed", { rawOutput: { text: source } })
      : workflow(h, "grok", "done", { workflowContent: { resultSummary: source } });
    const result = card.querySelector(".delegation-result")!;
    const body = result.firstElementChild!;
    expect(body.innerHTML.replaceAll(' dir="auto"', "")).toBe((h.window as any).__grokRenderMarkdown(source));
    expect(body.querySelector("script")).toBeNull();
    expect(card.querySelector(".subagent-result-label, .workflow-output-label")).toBeNull();
    click(h.window, card.querySelector(".delegation-header")!);
    const button = result.querySelector(".msg-copy-btn")!;
    expect(button.parentElement).toBe(result.lastElementChild);
    click(h.window, button);
    expect(await h.window.navigator.clipboard.readText()).toBe(source);
  });

  it("reads Grok lifecycle tokens even when tool completion wins the race", () => {
    const h = view();
    const card = subagent(h);
    dispatch(h.window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_spawned", subagent_id: "child" } });
    subagent(h, "completed", { rawOutput: { text: "Answer" } });
    dispatch(h.window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_finished", subagent_id: "child",
      status: "completed", duration_ms: 9000, tokens_used: 36420 } });
    expect(card.querySelector(".delegation-meta")!.textContent).toBe("36.42K tokens");
    expect((card.querySelector(".delegation-meta") as HTMLElement).hidden).toBe(true);
    expect(card.querySelector(".delegation-time")!.textContent).toBe("0:09");
  });

  it("omits Muse's raw workflow tool on live and replay updates", () => {
    for (const replay of [false, true]) {
      const h = view("muse");
      dispatch(h.window, { type: "historyReplay", active: replay });
      dispatch(h.window, { type: "toolCall", call: { toolCallId: "raw", title: "workflow", kind: "other", status: "in_progress" } });
      workflow(h, "muse");
      dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "raw", title: "workflow", kind: "other", status: "completed" } });
      dispatch(h.window, { type: "historyReplay", active: false });
      expect(h.doc.querySelector(".tool-flat, .tool-group")).toBeNull();
      expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
    }
  });
});
