import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootWebview, click, dispatch } from "./webview-harness";
import { parseRunProgressUpdate } from "../src/run-progress";
import claude from "./fixtures/claude-async-workflow.json";
// @ts-expect-error The standalone smoke helper has no declarations.
import { extractKnownKinds, extractMetaNamespaces, extractDocumentedIgnored, knownBoundaries, classifyBoundaries, readRenderedChat, assertRenderedScenario, renderReportMarkdown, completeRenderScenarios } from "../scripts/smoke-render-report.mjs";

const root = resolve(__dirname, "..");
const recorded = (file: string) => readFileSync(resolve(__dirname, "fixtures", file), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
const windows: ReturnType<typeof bootWebview>["window"][] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.abort(); });

describe("source-derived boundary vocabulary", () => {
  it("extracts executable cases/guards/menus/aliases/prefixes and ignores prose and unrelated switches", () => {
    const source = `// case "fake": msg.type === "comment";
      const docs = 'msg.type === "string-decoy"';
      switch (option.type) { case "unrelated": break; }
      switch (msg.type) { case "messageChunk": break; case "runProgress": break; }
      if (msg.type === "initialState") {}
      if (["one", "two"].includes(msg.type)) {}
      const alias = msg.type; if (alias === "alias-case") {}
      if (msg.type.startsWith("future/")) {}`;
    expect(extractKnownKinds(source, "type", { roots: ["msg"] })).toEqual({
      values: ["alias-case", "initialState", "messageChunk", "one", "runProgress", "two"], prefixes: ["future/"] });
    expect(extractKnownKinds(source + 'if(msg.type === "new-handler") {}', "type", { roots: ["msg"] }).values).toContain("new-handler");
  });
  it("method inventory excludes outgoing RPC calls and unrelated functions", () => {
    const source = `function request(method) { if(method === "outgoing") {} }
      function handleServerRequest(method) { if(method === "_x.ai/incoming") {} }
      function parseAcpLine(msg) { if(msg.method === "session/update") {} }`;
    expect(extractKnownKinds(source, "method", { functions: ["handleServerRequest", "parseAcpLine"] }).values).toEqual(["_x.ai/incoming", "session/update"]);
  });
  it("does not let an alias in one function approve a different function's unrelated kind", () => {
    expect(extractKnownKinds(`function a(msg) { const k = msg.type; if(k === "handled") {} }
      function b(option) { const k = option.type; if(k === "unhandled") {} }
      function c(k) { if(k === "also-unhandled") {} }`, "type", { roots: ["msg"] }).values).toEqual(["handled"]);
  });
  it("extracts deliberately excluded kinds only from source comments, including future exclusions", () => {
    expect(extractDocumentedIgnored('/** `subagent_progress` is deliberately\n * EXCLUDED */\nfunction a() {}\n// `future_drop` is deliberately EXCLUDED\nfunction b() {}\nconst prose = "`decoy` is deliberately EXCLUDED";'))
      .toEqual(["future_drop", "subagent_progress"]);
    const known = knownBoundaries(root, "grok");
    expect(known.ignoredUpdates).toContain("subagent_progress");
    expect(classifyBoundaries([{ direction: "receive", message: { method: "_x.ai/session_notification", params: { update: { sessionUpdate: "subagent_progress" } } } }], known).ignored)
      .toContainEqual(expect.objectContaining({ kind: "subagent_progress" }));
  });
  it("extracts namespaces from optional dot/bracket reads, not strings or object literals", () => {
    expect(extractMetaNamespaces(`u._meta?.claudeCode?.subagent; u._meta?.["muse/workflow"]; meta?.agentTimestampMs;
      const example = { _meta: { "invented": true } }; const prose = '_meta.notRead';`))
      .toEqual(["agentTimestampMs", "claudeCode", "muse/workflow"]);
  });
  it.each(["grok", "codex", "claude", "muse"])("covers real %s boundaries from current source", provider => {
    const known = knownBoundaries(root, provider);
    expect(known.methods.values).toContain("session/update");
    expect(known.methods.values).toContain("session/request_permission");
    expect(known.updates.values).toContain("tool_call");
    expect(known.webview.values).toEqual(expect.arrayContaining(["messageChunk", "childStream", "runProgress", "subagentUpdate", "error"]));
    if (provider === "claude") expect(known.updates.values).toContain("async_task_progress");
    if (provider === "muse") expect(known.namespaces).toContain("muse/workflow");
  });
});

describe("recorded boundary samples and unknown net", () => {
  it("accepts recorded Claude AIR and distinguishes a deliberate drop from a new kind", () => {
    const events = claude.map(update => ({ direction: "receive", message: { method: "session/update", params: { update } } }));
    const known = knownBoundaries(root, "claude");
    expect(classifyBoundaries(events, known).unhandled).toEqual([]);
    const audit = classifyBoundaries([...events,
      { direction: "routed", ignored: true, message: { raw: claude[0], emitted: [] } },
      { direction: "receive", message: { method: "_x.ai/new-method", params: { update: { sessionUpdate: "unforeseen", _meta: { futureVendor: {} } } } } },
      { direction: "routed", ignored: true, message: { raw: { sessionUpdate: "unforeseen" }, emitted: [] } },
      { direction: "host-to-webview", message: { type: "newCard" } },
    ], known);
    expect(audit.ignored).toContainEqual(expect.objectContaining({ kind: "async_task_spawned", status: "KNOWN-IGNORED" }));
    expect(audit.unhandled.map((r: any) => r.kind)).toEqual(expect.arrayContaining(["_x.ai/new-method", "unforeseen", "futureVendor", "newCard"]));
    expect(audit.ignored.some((r: any) => r.kind === "unforeseen")).toBe(false);
  });
  it("recognizes the recorded Grok workflow rail and tool namespace without inspecting model data as metadata", () => {
    const known = knownBoundaries(root, "grok");
    const updates = [...recorded("workflow-lifecycle-live.jsonl"), ...recorded("composer-subagent-session.jsonl")];
    const events = updates.map(update => ({ direction: "receive", message: { method: "_x.ai/session_notification", params: { update } } }));
    expect(classifyBoundaries(events, known).unhandled).toEqual([]);
    expect(classifyBoundaries([{ direction: "receive", message: { method: "session/update", params: { update: {
      sessionUpdate: "tool_call", rawInput: { _meta: { notProtocol: true } } } } } }], known).unhandled).toEqual([]);
    expect(classifyBoundaries([{ direction: "receive", message: { result: { models: { availableModels: [
      { modelId: "advertised", _meta: { newCatalogNamespace: true } },
    ] } } } }], known).unhandled).toContainEqual(expect.objectContaining({ kind: "newCatalogNamespace" }));
  });
  it("puts UNHANDLED first in Markdown, with ignored kinds separately and full text in the report", () => {
    const boundaries = { seen: [], unhandled: [{ boundary: "webview", kind: "future", count: 1 }], ignored: [{ boundary: "ACP update", kind: "known-drop", count: 2 }] };
    const report = { provider: "muse", route: "real desktop", boundaries, pageErrors: ["late renderer exception"], scenarios: [{ name: "plain reply", result: "PASS", pageErrors: [], opened: { finalReply: "judge this wording", errors: ["visible error"] } }] };
    const text = renderReportMarkdown(report);
    expect(text.startsWith("# UNHANDLED\n")).toBe(true);
    expect(text).toContain("## Known but ignored");
    expect(text).toContain("judge this wording");
    expect(text).toContain("visible error");
    expect(text).toContain("PAGE ERROR: late renderer exception");
  });
});

describe("real chat.js render report extraction", () => {
  it("reports every scenario even if desktop startup fails, without silently passing missing work", () => {
    const muse = completeRenderScenarios([], "muse");
    expect(muse).toHaveLength(4);
    expect(muse.find((s: any) => s.name === "subagent").result).toBe("N/A");
    expect(muse.filter((s: any) => s.result === "FAIL")).toHaveLength(3);
    const existing = { name: "plain reply", result: "PASS", pageErrors: [] };
    const codex = completeRenderScenarios([existing], "codex");
    expect(codex[0]).toBe(existing);
    expect(codex.find((s: any) => s.name === "workflow").result).toBe("N/A");
    expect(codex.find((s: any) => s.name === "subagent").result).toBe("FAIL");
  });
  it("reads actual closed/opened subagent results and copy controls from a recorded Composer conversation", () => {
    const h = bootWebview(); windows.push(h.window);
    for (const call of recorded("composer-subagent-session.jsonl")) dispatch(h.window, { type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call });
    const closed = readRenderedChat(h.doc);
    expect(closed.cards).toHaveLength(6);
    expect(closed.cards.every((c: any) => c.terminal && c.header.chevron && c.result === "" && !c.copy)).toBe(true);
    for (const el of h.doc.querySelectorAll(".subagent-row")) click(h.window, el);
    const opened = readRenderedChat(h.doc);
    expect(opened.cards.every((c: any) => c.result && c.copy && c.header.expanded)).toBe(true);
    const scenario = { name: "subagent", result: "PASS", pageErrors: [], closed, opened };
    expect(() => assertRenderedScenario(scenario)).not.toThrow();
    expect(() => assertRenderedScenario({ ...scenario, pageErrors: ["TypeError in chat.js"] })).toThrow(/renderer threw/);
    expect(() => assertRenderedScenario({ ...scenario, opened: closed })).toThrow(/no non-empty result/);
    dispatch(h.window, { type: "error", text: "Recorded visible provider failure" });
    expect(readRenderedChat(h.doc).errors.join(" ")).toContain("Recorded visible provider failure");
  });
  it("records workflow steps, agents, terminal dots and result as the renderer displays them", () => {
    const h = bootWebview(); windows.push(h.window);
    const sample = recorded("workflow-lifecycle-live.jsonl")[2];
    // Recorded running shape plus an explicitly synthetic terminal edge: unit
    // testing extraction, not claiming the original live run completed.
    dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate({ ...sample, status: "completed", result_summary: "One sentence result", elapsed_ms: 1200 }) });
    const closed = readRenderedChat(h.doc);
    expect(closed.cards[0].header.iconKind).toBe("Workflow");
    expect(closed.cards[0].result).toBe("");
    const details = h.doc.querySelector(".workflow-report") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new (h.window as any).Event("toggle"));
    const opened = readRenderedChat(h.doc);
    expect(opened.cards[0].result).toBe("One sentence result");
    expect(opened.cards[0].steps).toContain("Plan");
    expect(opened.cards[0].agents).toContain("research-planner");
    expect(opened.cards[0].copy).toBe(true);
    expect(() => assertRenderedScenario({ name: "workflow", result: "PASS", pageErrors: [], closed, opened })).not.toThrow();
  });
  it("asserts plumbing, leaves answer correctness to a judge, and cannot pass an absent card", () => {
    const base = { result: "PASS", pageErrors: [], opened: { cards: [], finalReply: "not the requested word", errors: [] } };
    expect(() => assertRenderedScenario({ ...base, name: "plain reply" })).not.toThrow();
    expect(() => assertRenderedScenario({ ...base, name: "delivery prompt" })).not.toThrow();
    expect(() => assertRenderedScenario({ ...base, name: "workflow" })).toThrow(/no rendered workflow/);
    expect(() => assertRenderedScenario({ ...base, name: "subagent", result: "INCONCLUSIVE" })).not.toThrow();
    expect(() => assertRenderedScenario({ ...base, name: "subagent", result: "INCONCLUSIVE", pageErrors: ["boom"] })).toThrow(/renderer threw/);
  });
});
