import { afterEach, describe, expect, it } from "vitest";
import grokCapture from "./fixtures/smoke-grok-capture.json";
import { extractPromptMeta } from "../src/acp-dispatch";
import { parseFeedbackEnabledMeta } from "../src/feedback";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootWebview, click, dispatch } from "./webview-harness";
import { parseRunProgressUpdate } from "../src/run-progress";
import claude from "./fixtures/claude-async-workflow.json";
import codexMetadata from "./fixtures/smoke-codex-metadata.json";
import { normalizeCodexPromptResult, normalizeCodexUpdate } from "../src/codex-backend";
// @ts-expect-error The standalone smoke helper has no declarations.
import { extractKnownKinds, extractMetaNamespaces, extractDocumentedIgnored, knownBoundaries, classifyBoundaries, readRenderedChat, assertRenderedScenario, renderReportMarkdown, completeRenderScenarios, cardResultEvidence, smokeOutcome } from "../scripts/smoke-render-report.mjs";

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
  it("classifies the nine captured Codex annotations and duplicate usage against executable source", () => {
    expect(codexMetadata.updates).toHaveLength(9);
    const known = knownBoundaries(root, "codex");
    // The report must not claim that source reads a namespace it never reads.
    expect(extractMetaNamespaces(readFileSync(resolve(root, "src/codex-backend.ts"), "utf8"))).not.toContain("codex");
    const events = codexMetadata.updates.map(update => ({ direction: "receive", message: { method: "session/update", params: { update } } }));
    const result = classifyBoundaries([...events, { direction: "receive", message: { result: codexMetadata.result } }], known);
    expect(result.unhandled).toEqual([]);
    expect(result.ignored).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "codex", count: 9, reason: expect.stringContaining("native subagent_spawned") }),
      expect.objectContaining({ kind: "quota", count: 1, reason: expect.stringContaining("result.usage") }),
    ]));
    expect(normalizeCodexPromptResult(codexMetadata.result)._meta.usage.totalTokens).toBe(codexMetadata.result.usage.totalTokens);
    expect(normalizeCodexUpdate({ sessionUpdate: "subagent_spawned", subagentSessionId: "child", task: "reply ok" }).update)
      .toMatchObject({ kind: "subagent", subagent_id: "child", status: "in_progress" });
    expect(classifyBoundaries([{ direction: "receive", message: { result: { _meta: { futureCodexNamespace: {} } } } }], known).unhandled).toHaveLength(1);
  });
  it.each(["codex", "claude"])("documents each captured %s optional boundary without hiding new kinds", provider => {
    const known = knownBoundaries(root, provider);
    const events = [
      { direction: "receive", message: { result: { _meta: { goal: { version: 1 }, jetbrains: { air: { version: 1 } }, steering: { supported: true } } } } },
      { direction: "receive", message: { method: "session/update", params: { update: { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "plan", _meta: { commandAction: { kind: "setConfigOption", configId: "collaboration_mode", value: "plan" } } },
      ] } } } },
      { direction: "receive", message: { method: "_auth/status_update", params: { authStatus: { kind: "account", label: "redacted" } } } },
    ];
    const result = classifyBoundaries(events, known);
    expect(result.unhandled).toEqual([]);
    expect(result.ignored.map((r: any) => r.kind)).toEqual(expect.arrayContaining(["goal", "jetbrains", "commandAction", "_auth/status_update"]));
    expect(result.ignored.every((r: any) => r.reason.includes("src/"))).toBe(true);
    expect(result.seen.find((r: any) => r.kind === "steering").status).toBe(provider === "codex" ? "KNOWN" : "KNOWN-IGNORED");
    expect(classifyBoundaries([{ direction: "receive", message: { method: "_auth/status_update", id: 77 } }], known).unhandled).toHaveLength(1);
    expect(classifyBoundaries([{ direction: "receive", message: { result: { _meta: { unknownVendor: {} } } } }], known).unhandled).toHaveLength(1);
  });

  it("does not call unselected scenarios passes or missing failures", () => {
    const result = completeRenderScenarios([{ name: "subagent", result: "PASS" }], "claude", undefined, "subagent");
    expect(result.find((s: any) => s.name === "workflow").result).toBe("NOT RUN");
    expect(completeRenderScenarios([], "claude", undefined, "subagent").find((s: any) => s.name === "subagent").result).toBe("FAIL");
  });
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
    const events = recorded("composer-subagent-session.jsonl").flatMap(call => [
      { direction: "receive", message: { params: { update: call } } },
      { direction: "host-to-webview", message: { type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call } },
    ]);
    const resultEvidence = cardResultEvidence(opened.cards, events);
    expect(resultEvidence.every((e: any) => e.reported)).toBe(true);
    const scenario = { name: "subagent", result: "PASS", pageErrors: [], closed, opened, resultEvidence };
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
    const resultEvidence = cardResultEvidence(opened.cards, [{ direction: "receive", message: { params: { update: { ...sample, result_summary: "One sentence result" } } } }]);
    expect(resultEvidence[0].reported).toBe(true);
    expect(() => assertRenderedScenario({ name: "workflow", result: "PASS", pageErrors: [], closed, opened, resultEvidence })).not.toThrow();
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


describe("live smoke regressions", () => {
  it("classifies every captured Grok flat metadata field and notification with a host reference", () => {
    const known = knownBoundaries(root, "grok");
    const events = [
      { direction: "receive", message: { result: { _meta: Object.fromEntries(grokCapture.metadata.map(key => [key, {}])) } } },
      ...grokCapture.methods.map(method => ({ direction: "receive", message: { method } })),
      ...grokCapture.updates.map(sessionUpdate => ({ direction: "receive", message: { params: { update: { sessionUpdate } } } })),
    ];
    const audit = classifyBoundaries(events, known);
    expect(audit.seen.every((row: any) => row.reason?.match(/src\/|media\//))).toBe(true);
    expect(audit.unhandled.map((row: any) => [row.kind, row.status])).toEqual([["session_info_update", "FINDING"]]);
    expect(audit.seen.find((row: any) => row.kind === "usage").status).toBe("KNOWN");
    expect(audit.seen.find((row: any) => row.kind === "inputTokens").status).toBe("KNOWN");
    expect(audit.seen.find((row: any) => row.kind === "feedbackEnabled").status).toBe("KNOWN");
    expect(extractPromptMeta({ _meta: { inputTokens: 12, modelId: "grok-test" } })).toMatchObject({ inputTokens: 12, modelId: "grok-test" });
    expect(parseFeedbackEnabledMeta({ _meta: { feedbackEnabled: true } })).toBe(true);
    expect(known.metadataShape).toBe("flat fields");
    const drift = classifyBoundaries([
      { direction: "receive", message: { result: { _meta: { newFlatField: true } } } },
      { direction: "receive", message: { method: "_x.ai/new-broadcast" } },
      { direction: "receive", message: { method: "_x.ai/settings/update", id: 99 } },
      { direction: "receive", message: { params: { update: { sessionUpdate: "new_grok_update" } } } },
    ], known);
    expect(drift.unhandled).toHaveLength(4);
    expect(drift.unhandled.every((row: any) => row.status === "UNKNOWN")).toBe(true);
    expect(renderReportMarkdown({ provider: "grok", route: "capture", boundaries: audit, scenarios: [] })).toContain("## Grok classification");
  });
  it("reports captured Grok JSON as backlog, accepts absent summaries and requires supported results on their own card", () => {
    const cards = [grokCapture.workflow.card];
    const events = grokCapture.workflow.updates.map(update => ({ direction: "receive", message: { params: { update } } }));
    expect(events.length).toBeGreaterThan(1);
    const evidence = (items: any[]) => cardResultEvidence(cards, items, { provider: "grok" });
    const scenario = { name: "workflow", result: "PASS", pageErrors: [], opened: { cards }, resultEvidence: evidence(events) };
    expect(scenario.resultEvidence[0]).toMatchObject({ reported: true, required: false });
    expect(scenario.resultEvidence[0].reason).toContain("known structured-result backlog");
    expect(evidence(events.slice(0, -1))[0]).toMatchObject({ reported: false, required: false });
    expect(() => assertRenderedScenario(scenario)).not.toThrow();
    const result = (id: string) => ({ direction: "receive", message: { params: { update: { sessionUpdate: "workflow_updated", run_id: id, result_summary: "two" } } } });
    expect(evidence([...events, result("unrelated")])[0].required).toBe(false);
    scenario.resultEvidence = evidence([...events, result(cards[0].id)]);
    expect(() => assertRenderedScenario(scenario)).toThrow(/no non-empty result/);
    const structured = result(cards[0].id);
    structured.message.params.update.result_summary = '{"summary":"two"}';
    expect(evidence([structured])[0].required).toBe(true);
    expect(cardResultEvidence(cards, events, { provider: "claude" })[0].required).toBe(true);
    expect(() => assertRenderedScenario({ ...scenario, resultEvidence: [{ reported: false }], opened: { cards: [{ ...cards[0], terminal: false }] } })).toThrow(/nonterminal/);
  });
  it("keeps the three Codex terminal metadata namespaces as findings, not ignored annotations", () => {
    const names = ["terminal_info", "terminal_output_delta", "terminal_exit"];
    const events = names.map(key => ({ direction: "receive", message: { params: { update: {
      sessionUpdate: "tool_call_update", toolCallId: "exec-1", _meta: { [key]: { terminal_id: "exec-1" } },
    } } } }));
    const audit = classifyBoundaries(events, knownBoundaries(root, "codex"));
    expect(audit.unhandled).toHaveLength(3);
    expect(audit.unhandled.every((r: any) => r.status === "FINDING" && r.reason)).toBe(true);
    expect(audit.ignored).toEqual([]);
    const normalized = normalizeCodexUpdate({ sessionUpdate: "tool_call_update", toolCallId: "exec-1",
      _meta: { terminal_output_delta: { data: "streamed output", terminal_id: "exec-1" } } });
    expect(normalized.update.rawOutput).toBeUndefined();
    for (const file of ["src/codex-backend.ts", "src/acp.ts", "src/acp-dispatch.ts", "src/sidebar.ts", "media/chat.js", "media/webview-helpers.js"]) {
      expect(readFileSync(resolve(root, file), "utf8")).not.toMatch(/terminal_(?:info|output_delta|exit)/);
    }
  });
  it.each(["codex", "claude"])("documents captured %s permission and accounting annotations", provider => {
    const metadata = provider === "claude" ? { permission: {}, quota: {}, "_claude/origin": { kind: "human" } } : { permission: {} };
    const audit = classifyBoundaries([{ direction: "receive", message: { result: { _meta: metadata } } }], knownBoundaries(root, provider));
    expect(audit.unhandled).toEqual([]);
    expect(audit.ignored).toHaveLength(Object.keys(metadata).length);
    expect(audit.ignored.every((r: any) => r.reason.includes("src/"))).toBe(true);
  });
  it("accepts Claude's output-file-only completion but still requires a result when that same card reports one", () => {
    const cards = [{ id: "wf-live", kind: "workflow", terminal: true, result: "", header: {} }];
    const events = claude.map(update => ({ direction: "receive", message: { params: { update } } }));
    const scenario = { name: "workflow", result: "PASS", pageErrors: [], opened: { cards }, closed: { cards }, resultEvidence: cardResultEvidence(cards, events) };
    expect(scenario.resultEvidence[0]).toMatchObject({ reported: false, reason: "no result reported by the provider" });
    expect(() => assertRenderedScenario(scenario)).not.toThrow();
    expect(renderReportMarkdown({ provider: "claude", route: "test", boundaries: { unhandled: [], ignored: [] }, scenarios: [scenario] })).toContain("no result reported by the provider");
    const unrelated = { direction: "receive", message: { params: { update: { sessionUpdate: "workflow_updated", run_id: "another", resultSummary: "other result" } } } };
    expect(cardResultEvidence(cards, [...events, unrelated])[0].reported).toBe(false);
    const summary = { direction: "receive", message: { params: { update: { sessionUpdate: "async_task_state_update", asyncTaskId: "task-live", state: "completed", summary: "actual result" } } } };
    scenario.resultEvidence = cardResultEvidence(cards, [...events, summary]);
    expect(scenario.resultEvidence[0].reported).toBe(true);
    expect(() => assertRenderedScenario(scenario)).toThrow(/no non-empty result/);
    cards[0].result = "actual result";
    expect(() => assertRenderedScenario(scenario)).not.toThrow();
    cards[0].terminal = false;
    expect(() => assertRenderedScenario(scenario)).toThrow(/nonterminal/);
  });
  it("correlates subagent results individually, even when the host drops the reported output", () => {
    const cards = [{ kind: "subagent" }, { kind: "subagent" }];
    const events = ["one", "two"].map(id => ({ direction: "host-to-webview", message: { type: "toolCall", call: { kind: "subagent", toolCallId: id } } }));
    const wire = { direction: "receive", message: { params: { update: { sessionUpdate: "tool_call_update", toolCallId: "two", rawOutput: [{ type: "text", text: "result" }] } } } };
    expect(cardResultEvidence(cards, [...events, wire]).map((e: any) => e.reported)).toEqual([false, true]);
  });
  it("separates inconclusive-only, partial, interrupted and failed exits", () => {
    expect(smokeOutcome([{ result: "PASS" }, { result: "N/A" }])).toEqual({ status: "PASS", exitCode: 0 });
    expect(smokeOutcome([{ result: "NOT RUN" }])).toEqual({ status: "PARTIAL", exitCode: 0 });
    expect(smokeOutcome([{ result: "PASS" }, { result: "INCONCLUSIVE" }])).toEqual({ status: "INCONCLUSIVE", exitCode: 2 });
    expect(smokeOutcome([{ result: "FAIL" }, { result: "INCONCLUSIVE" }])).toEqual({ status: "FAIL", exitCode: 1 });
    expect(smokeOutcome([{ result: "INCONCLUSIVE" }], true)).toEqual({ status: "FAIL", exitCode: 1 });
  });
  it("requires Codex's child-session output on its own card even without a DOM tool ID", () => {
    const cards = [{ kind: "subagent", result: "", terminal: true }];
    const events = [
      { direction: "host-to-webview", message: { type: "toolCall", call: { kind: "subagent", toolCallId: "codex-subagent:child", child_session_id: "child" } } },
      { direction: "receive", message: { params: { sessionId: "child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child result" } } } } },
    ];
    const resultEvidence = cardResultEvidence(cards, events);
    expect(resultEvidence[0].reported).toBe(true);
    expect(() => assertRenderedScenario({ name: "subagent", pageErrors: [], opened: { cards }, resultEvidence })).toThrow(/no non-empty result/);
  });
});
