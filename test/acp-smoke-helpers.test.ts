import { describe, expect, it } from "vitest";
import { normalizeCodexPermissionParams, normalizeCodexUpdate } from "../src/codex-backend";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { MuseBackend } from "../src/muse-backend";
import { grokBackend } from "../src/grok-backend";
import { parseRunProgressUpdate } from "../src/run-progress";
import claudeWorkflow from "./fixtures/claude-async-workflow.json";
import liveCatalogs from "./fixtures/smoke-live-catalogs.json";
const { isSubagentToolCall } = require("../media/webview-helpers.js");
// The entry guard makes this import pure: npm test never starts a real CLI.
// @ts-expect-error Standalone release script intentionally has no declaration file.
import { permissionSmokeNotApplicable, approvalOption, bounded, checkPermission, checkTools, timeoutMs, selectSmokeModel, selectSmokeEffort, desktopSmokeCatalog, smokeScenario, lowestSmokeEffort, checkSubagents, checkWorkflow, delegationAttempted, isMuseDeliveryChunk, inconclusive } from "../scripts/acp-smoke.mjs";

describe("ACP smoke evidence checks (no adapter or model)", () => {
  const permission = {
    sessionId: "s",
    toolCall: { toolCallId: "t", kind: "execute", rawInput: { command: "write scratch" } },
    options: [
      { optionId: "policy", name: "Always", kind: "allow_always" },
      { optionId: "once", name: "Once", kind: "allow_once" },
    ],
    _meta: { provider: "retained" },
  };
  const start = { sessionUpdate: "tool_call", toolCallId: "t", title: "Read", kind: "read", rawInput: { path: "read-me.txt" } };
  const end = { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", rawOutput: { formatted_output: "arbitrary content" } };

  it("prefers one-time approval and handles missing/malformed options without hanging", () => {
    expect(approvalOption(permission).optionId).toBe("once");
    expect(approvalOption({ options: [permission.options[0]] }).optionId).toBe("policy");
    expect(approvalOption({ options: [null, { kind: "allow_once" }] })).toBeUndefined();
    expect(approvalOption({})).toBeUndefined();
  });

  it("accepts real normalization and rejects loss of selected option, metadata or identity", () => {
    const normalized = normalizeCodexPermissionParams(permission);
    expect(() => checkPermission(permission, normalized, "s", "once")).not.toThrow();
    for (const changed of [
      { ...normalized, options: [] },
      { ...normalized, _meta: undefined },
      { ...normalized, sessionId: "other" },
      { ...normalized, toolCall: { ...normalized.toolCall, toolCallId: undefined } },
    ]) expect(() => checkPermission(permission, changed, "s", "once")).toThrow();
  });

  it("requires connected tool frames for the requested read, independent of output wording", () => {
    expect(checkTools([start, end], normalizeCodexUpdate, "read-me.txt")).toContain("1 completed");
    expect(() => checkTools([start, end], normalizeCodexUpdate, "different.txt")).toThrow(/requested file/);
    expect(() => checkTools([end], normalizeCodexUpdate)).toThrow(/preceding tool_call/);
    expect(() => checkTools([start], normalizeCodexUpdate)).toThrow(/no tool_call_update/);
    expect(() => checkTools([start, { ...end, status: "failed" }], normalizeCodexUpdate)).toThrow(/no completed/);
    expect(() => checkTools([start, end], (update: unknown) => ({ update }))).toThrow(/formatted_output/);
  });

  it("rejects disabled/infinite timers and names a missing response", async () => {
    expect(timeoutMs(undefined, 50)).toBe(50);
    for (const value of ["0", "-1", "NaN", "Infinity", "0.1", "2147483648"]) {
      expect(() => timeoutMs(value, 50)).toThrow(/invalid timeout/);
    }
    await expect(bounded(Promise.resolve("ok"), "initialize", 50)).resolves.toBe("ok");
    await expect(bounded(Promise.reject(new Error("EPIPE")), "stdin", 50)).rejects.toThrow("EPIPE");
    await expect(bounded(new Promise(() => {}), "session/load replay", 5)).rejects.toThrow("session/load replay never arrived within 5ms");
  });
});

// Same chronological projection as Peer; no compiled bundles or real CLIs.
function framesFor(backend: any, updates: any[], seedBackend: any = backend) {
  return updates.map(entry => {
    const { raw, sessionId = "parent" } = entry;
    const normalized = backend.normalizeUpdate(raw, undefined);
    const seed = raw?._meta?.claudeCode?.toolName === "Workflow"
      ? seedBackend.normalizeUpdate(raw, undefined).workflowUpdate : undefined;
    return structuredClone({ sessionId, raw, update: normalized.update,
      workflow: parseRunProgressUpdate(normalized.workflowUpdate ?? normalized.update),
      seedWorkflow: parseRunProgressUpdate(seed) });
  });
}

describe("live smoke catalog selection", () => {
  it.each([
    ["codex", new CodexBackend(), "gpt-6-luna", "low"],
    ["claude", new ClaudeBackend(), "haiku", "low"],
    ["muse", new MuseBackend(), "muse-spark-1.3-contributor", "none"],
  ] as const)("ranks the captured %s catalog AFTER the real app normalizer", (provider, backend, modelId, effort) => {
    const normalized = backend.normalizeSessionResponse(structuredClone(liveCatalogs[provider].session));
    expect(selectSmokeModel(normalized)).toMatchObject({ modelId, effort });
    const desktop = desktopSmokeCatalog({ modelId: normalized.models.currentModelId,
      models: normalized.models.availableModels.map((m: any) => ({ ...m,
        supportsReasoningEffort: m._meta?.supportsReasoningEffort, reasoningEfforts: m._meta?.reasoningEfforts?.map((e: any) => e.value) })) });
    expect(selectSmokeModel(desktop)).toMatchObject({ modelId, effort });
    if (provider === "codex") expect(() => selectSmokeModel(normalized, "gpt-6-luna[low]")).toThrow(/not in the advertised/);
  });

  it("uses Claude's post-Haiku config menu, which removes effort, rather than stale per-model metadata", () => {
    const initial = new ClaudeBackend().normalizeSessionResponse(liveCatalogs.claude.session);
    const haiku = initial.models.availableModels.find((m: any) => m.modelId === "haiku");
    expect(selectSmokeEffort(liveCatalogs.claude.session, haiku)).toEqual({ configId: "effort", effort: "low" });
    expect(selectSmokeEffort(liveCatalogs.claude.afterModel, haiku)).toEqual({ effort: undefined });
    expect(selectSmokeEffort(liveCatalogs.codex.session, {})).toEqual({ configId: "reasoning_effort", effort: "low" });
    expect(selectSmokeEffort(liveCatalogs.muse.session, liveCatalogs.muse.session.models.availableModels[0])).toEqual({ effort: "none" });
  });

  it("honors advertised thought-level ids and refuses ambiguous/unrecognized options", () => {
    const option = { id: "thinking", category: "thought_level", options: [{ value: "high" }, { value: "minimal" }] };
    expect(selectSmokeEffort({ configOptions: [option] }, {})).toEqual({ configId: "thinking", effort: "minimal" });
    expect(() => selectSmokeEffort({ configOptions: [option, { ...option, id: "effort" }] }, {})).toThrow(/ambiguous/);
    expect(() => selectSmokeEffort({ configOptions: [{ ...option, options: [{ value: "turbo" }] }] }, {})).toThrow(/unrecognized/);
  });

  it("preserves Muse's current privacy variant without pretending the catalog proves prices", () => {
    const response = structuredClone(liveCatalogs.muse.session);
    expect(selectSmokeModel(response).basis).toContain("cheapest is unproven");
    response.models.currentModelId = "muse-spark-1.2";
    expect(selectSmokeModel(response).modelId).toBe("muse-spark-1.2");
    response.models.currentModelId = "missing";
    expect(() => selectSmokeModel(response)).toThrow(/no recognizable/);
  });

  it("validates one cheap scenario before launching a provider", () => {
    const allowed = ["plain reply", "subagent", "workflow"];
    expect(smokeScenario(["--provider=codex", "--scenario=plain-reply"], allowed)).toBe("plain reply");
    expect(smokeScenario([], allowed)).toBeUndefined();
    for (const args of [["--scenario="], ["--scenario=typo"], ["--scenario=subagent", "--scenario=workflow"]]) {
      expect(() => smokeScenario(args, allowed)).toThrow();
    }
  });
  const model = (modelId: string, efforts?: string[]) => ({ modelId, name: modelId,
    _meta: { supportsReasoningEffort: !!efforts, reasoningEfforts: efforts?.map(value => ({ value })) } });
  const catalog = (models: any[]) => ({ models: { availableModels: models } });

  it.each([
    ["codex", ["gpt-future", "gpt-future-mini"]],
    ["claude", ["opus-next", "haiku-next"]],
    ["grok", ["grok-future", "grok-future-fast"]],
    ["muse", ["muse-large", "muse-small"]],
  ])("selects %s economy tiers from the advertised catalog, not pinned IDs", (_, ids) => {
    const result = selectSmokeModel(catalog(ids.map(id => model(id, ["high", "low", "medium"]))));
    expect(result).toMatchObject({ modelId: ids[1], effort: "low" });
    expect(result.basis).toContain("catalog supplies no prices");
  });

  it("honors an exact advertised override and rejects stale overrides and ambiguous menus", () => {
    const response = catalog([model("unknown-a"), model("unknown-b")]);
    expect(selectSmokeModel(response, "unknown-b")).toMatchObject({ modelId: "unknown-b", basis: "env override" });
    expect(() => selectSmokeModel(response, "old-model")).toThrow(/not in the advertised/);
    expect(() => selectSmokeModel(response)).toThrow(/no recognizable economy tier/);
    expect(() => selectSmokeModel(catalog([model("future-mini-a"), model("future-mini-b")]))).toThrow(/tied economy tiers/);
    expect(() => selectSmokeModel({})).toThrow(/no models/);
    expect(selectSmokeModel(catalog([model("only-model")])).modelId).toBe("only-model");
  });

  it("does not select a default alias, and honors the catalog's explicit cheapest description", () => {
    expect(selectSmokeModel(catalog([model("default"), model("muse")] )).modelId).toBe("muse");
    expect(selectSmokeModel(catalog([model("nano-future"), { ...model("new-tier"), description: "Our cheapest model" }])).modelId).toBe("new-tier");
  });

  it("only chooses advertised efforts; absent support is N/A, unknown menus fail", () => {
    expect(lowestSmokeEffort(model("a", ["low", "none", "minimal"]))).toBe("none");
    expect(lowestSmokeEffort(model("a", ["high"]))).toBe("high");
    expect(lowestSmokeEffort(model("a"))).toBeUndefined();
    expect(() => lowestSmokeEffort(model("a", ["new-effort"]))).toThrow(/unrecognized effort/);
    expect(() => lowestSmokeEffort(model("a", []))).toThrow(/no effort menu/);
  });

  it("uses the providers' actual catalog normalizers", () => {
    const codex = new CodexBackend().normalizeSessionResponse(catalog([
      model("future-mini[high]"), model("future-mini[low]"),
    ]));
    expect(selectSmokeModel(codex)).toMatchObject({ modelId: "future-mini", effort: "low" });
    const claude = new ClaudeBackend().normalizeSessionResponse({ configOptions: [
      { id: "model", currentValue: "opus-future", options: [{ value: "opus-future", name: "Opus" }, { value: "haiku-future", name: "Haiku" }] },
      { id: "effort", currentValue: "high", options: [{ value: "default" }, { value: "low" }, { value: "high" }] },
    ] });
    expect(selectSmokeModel(claude)).toMatchObject({ modelId: "haiku-future", effort: "low" });
    const muse = new MuseBackend().normalizeSessionResponse({ _meta: catalog([model("muse", ["none", "ultra"])]) });
    expect(selectSmokeModel(muse)).toMatchObject({ modelId: "muse", effort: "none" });
  });
});

describe("normalized delegation evidence", () => {
  const codex = [
    { raw: { sessionUpdate: "subagent_spawned", subagentSessionId: "child", task: "ok" } },
    { sessionId: "child", raw: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
    { raw: { sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" } },
  ];
  it("correlates the real Codex synthetic card with its own child stream", () => {
    expect(checkSubagents(framesFor(new CodexBackend(), codex), "parent", isSubagentToolCall)).toContain("completed with non-empty result");
    for (const sessionId of ["parent", "unrelated-child"]) {
      const wrong = codex.map((f, i) => i === 1 ? { ...f, sessionId } : f);
      expect(() => checkSubagents(framesFor(new CodexBackend(), wrong), "parent", isSubagentToolCall)).toThrow(/no non-empty/);
    }
  });
  it.each(["running", "failed", "cancelled"])("rejects a Codex child in %s state", state => {
    const updates = [...codex.slice(0, 2), { raw: { ...codex[2].raw, state } }];
    expect(() => checkSubagents(framesFor(new CodexBackend(), updates), "parent", isSubagentToolCall)).toThrow(/did not complete/);
  });
  it("checks Claude's normalized hand-back and merges metadata across sparse updates", () => {
    const updates = [
      { raw: { sessionUpdate: "tool_call", toolCallId: "agent", kind: "think", _meta: { claudeCode: { toolName: "Agent", subagent: true } } } },
      { raw: { sessionUpdate: "tool_call_update", toolCallId: "agent", status: "completed",
        _meta: { claudeCode: { toolName: "Agent", subagent: true } },
        rawOutput: "[Subagent hand-back]\nThe report follows:\n  ok\nagentId: child" } },
    ];
    expect(checkSubagents(framesFor(new ClaudeBackend(), updates), "parent", isSubagentToolCall)).toContain("1 normalized");
    expect(() => checkSubagents(framesFor(new ClaudeBackend(), updates.map((f, i) => i ? { raw: { ...f.raw, rawOutput: "" } } : f)), "parent", isSubagentToolCall)).toThrow(/no non-empty/);
  });
  it("distinguishes model refusal from a lost normalized delegation", () => {
    expect(() => checkSubagents([], "parent", isSubagentToolCall)).toThrow(/model did not delegate/);
    expect(() => checkSubagents(codex.map(f => ({ ...f, update: undefined })), "parent", isSubagentToolCall)).toThrow(/no normalized subagent card/);
    expect(inconclusive("NOT_OBSERVED", "not observed")).toMatchObject({ code: "NOT_OBSERVED", message: "not observed" });
  });

  const script = { sessionUpdate: "tool_call", toolCallId: "launch-live", _meta: { claudeCode: { toolName: "Workflow" } },
    rawInput: { script: "export const meta = { phases: [{ title: 'One' }, { title: 'Two' }] };" } };
  const claudeFrames = (updates: any[]) => framesFor(new ClaudeBackend(), updates.map(raw => ({ raw })), new ClaudeBackend());
  it("requires Claude's complete up-front step roster from the Workflow script meta", () => {
    const frames = claudeFrames([script, ...claudeWorkflow]);
    expect(checkWorkflow(frames, "claude")).toContain("all steps seeded");
    expect(frames.find(f => f.workflow)?.workflow?.phases?.map(p => p.state)).toEqual(["pending", "pending"]);
    expect(() => checkWorkflow(claudeFrames(claudeWorkflow), "claude")).toThrow(/script metadata/);
    const lateStep = structuredClone(frames);
    lateStep.at(-1)!.workflow!.phases!.push({ title: "Surprise" });
    expect(() => checkWorkflow(lateStep, "claude")).toThrow(/discovered late/);
    const noAir = frames.map(f => ({ ...f, raw: f.raw.sessionUpdate.startsWith("async_task_") ? {} : f.raw }));
    expect(() => checkWorkflow(noAir, "claude")).toThrow(/correlated AIR/);
    const unrelatedAir = frames.map(f => ({ ...f, raw: f.raw.sessionUpdate === "async_task_spawned" ? { ...f.raw, asyncTaskId: "unrelated" } : f.raw }));
    expect(() => checkWorkflow(unrelatedAir, "claude")).toThrow(/correlated AIR/);
  });
  it.each(["muse", "grok"])("parses %s snapshots and rejects failed, cancelled, single-child and missing completion", provider => {
    const progress = (status: string, count = 2) => ({ sessionUpdate: "workflow_updated", run_id: "run", status,
      phases: Array.from({ length: count }, (_, i) => ({ title: String(i) })),
      agents: Array.from({ length: count }, (_, i) => ({ agent_id: String(i), label: String(i) })) });
    const frames = (status: string, count = 2) => framesFor(provider === "muse" ? new MuseBackend() : grokBackend,
      [progress(status, count)].map(raw => ({ raw: provider === "muse" ? { sessionUpdate: "session_info_update", _meta: { "muse/workflow": raw } } : raw })));
    expect(checkWorkflow(frames("completed"), provider)).toContain("parsed done=true");
    for (const status of ["failed", "cancelled", "running"]) expect(() => checkWorkflow(frames(status), provider)).toThrow(/did not finish successfully/);
    expect(() => checkWorkflow(frames("completed", 1), provider)).toThrow(/never showed >=2/);
    expect(() => checkWorkflow([...frames("completed"), { workflow: { ...frames("completed")[0].workflow, id: "unrelated" } }], provider)).toThrow(/unrelated run IDs/);
  });
  it("never labels a lost workflow projection as model refusal", () => {
    expect(() => checkWorkflow([], "muse")).toThrow(/model did not delegate/);
    for (const raw of [script, { sessionUpdate: "tool_call", title: "workflow" }, { sessionUpdate: "async_task_spawned", taskType: "workflow" }]) {
      expect(delegationAttempted([{ raw }], "workflow")).toBe(true);
      expect(() => checkWorkflow([{ raw }], "claude")).toThrow(/no parsed workflowUpdate/);
    }
    expect(delegationAttempted([{ raw: { sessionUpdate: "agent_message_chunk", content: { text: "I ran a workflow" } } }], "workflow")).toBe(false);
  });
});

describe("Muse delivery-window evidence", () => {
  const chunk = { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "result" } } } };
  it("requires an unsolicited parent answer after the launch RPC and workflow completion", () => {
    expect(isMuseDeliveryChunk(chunk, "s", true, true)).toBe(true);
    expect(isMuseDeliveryChunk(chunk, "s", false, true)).toBe(false);
    expect(isMuseDeliveryChunk(chunk, "s", true, false)).toBe(false);
    expect(isMuseDeliveryChunk(chunk, "other", true, true)).toBe(false);
    expect(isMuseDeliveryChunk({ ...chunk, method: "replay" }, "s", true, true)).toBe(false);
    expect(isMuseDeliveryChunk({ ...chunk, params: { ...chunk.params, update: { sessionUpdate: "session_info_update" } } }, "s", true, true)).toBe(false);
  });
});


it("does not claim Muse's provider-controlled permission policy must ask", () => {
  expect(permissionSmokeNotApplicable("muse")).toContain("approval policy to Muse");
  expect(permissionSmokeNotApplicable("muse")).toContain("not exercised");
  expect(permissionSmokeNotApplicable("codex")).toBeUndefined();
  expect(permissionSmokeNotApplicable("claude")).toBeUndefined();
});
