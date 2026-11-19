import { describe, expect, it } from "vitest";
import {
  compositeModelId,
  configStateFromCodexOptions,
  codexEffectiveModeId,
  isCodexCredentialError,
  isCodexMcpToolCall,
  listAllCodexSessions,
  normalizeCodexModels,
  normalizeCodexPermissionParams,
  normalizeCodexPromptResult,
  normalizeCodexUpdate,
  parseCompositeModelId,
  CodexBackend,
} from "../src/codex-backend";
import { applyAgentModeToHostPlan } from "../src/plan-gate";

describe("Codex adapter spawn", () => {
  it("always runs the Electron executable as Node in every host", () => {
    const spec = new CodexBackend({ adapterPath: "adapter.cjs", nodePath: "electron.exe" }).spawn({
      cliPath: "codex.exe",
      cwd: "C:\\repo",
      env: { ELECTRON_RUN_AS_NODE: "0", KEEP_ME: "yes" },
    });
    expect(spec.env).toMatchObject({
      CODEX_PATH: "codex.exe",
      ELECTRON_RUN_AS_NODE: "1",
      KEEP_ME: "yes",
    });
  });
});

describe("Codex composite model mapping", () => {
  it("parses only the final effort suffix and maps back bidirectionally", () => {
    expect(parseCompositeModelId("gpt-5.6-sol[high]")).toEqual({ modelId: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(parseCompositeModelId("family[name][ultra]")).toEqual({ modelId: "family[name]", reasoningEffort: "ultra" });
    expect(parseCompositeModelId("gpt-5.6-sol")).toBeUndefined();
    expect(compositeModelId("gpt-5.6-sol", "max")).toBe("gpt-5.6-sol[max]");
  });

  it("collapses composite ids into logical families and preserves observed effort order", () => {
    const normalized = normalizeCodexModels({
      currentModelId: "gpt-5.6-sol[xhigh]",
      availableModels: [
        { modelId: "gpt-5.6-sol[low]", name: "Sol low", description: "fast" },
        { modelId: "gpt-5.6-sol[xhigh]", name: "Sol xhigh" },
        { modelId: "gpt-5.6-terra[medium]", name: "Terra medium" },
        { modelId: "gpt-5.6-sol[ultra]", name: "Sol ultra" },
      ],
    });
    expect(normalized.currentModelId).toBe("gpt-5.6-sol");
    expect(normalized.availableModels).toHaveLength(2);
    expect(normalized.availableModels[0]).toMatchObject({
      modelId: "gpt-5.6-sol",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [{ value: "low" }, { value: "xhigh" }, { value: "ultra" }],
      },
    });
  });

  it("strips the adapter's parenthesized effort suffix from family display names", () => {
    // The live adapter names variants "GPT-5.6-Sol (low)" — the family entry
    // must not inherit any variant's effort (it rendered as a model named
    // "GPT-5.6-Sol (low)" in the picker while effort is a separate setting).
    const normalized = normalizeCodexModels({
      currentModelId: "gpt-5.6-sol[low]",
      availableModels: [
        { modelId: "gpt-5.6-sol[low]", name: "GPT-5.6-Sol (low)" },
        { modelId: "gpt-5.6-sol[high]", name: "GPT-5.6-Sol (high)" },
        { modelId: "gpt-5.5[low]", name: "GPT-5.5 (low)" },
        { modelId: "gpt-5.4-mini[medium]", name: "GPT-5.4 Mini medium" },
      ],
    });
    expect(normalized.availableModels.map((m: any) => m.name)).toEqual([
      "GPT-5.6-Sol",
      "GPT-5.5",
      "GPT-5.4 Mini",
    ]);
  });
});

describe("Codex output and usage normalization", () => {
  it("remaps an MCP execute call to kind other and keeps the adapter title", () => {
    const normalized = normalizeCodexUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "mcp-1",
      kind: "execute",
      title: "mcp.canva.search-designs",
      rawInput: { server: "canva", tool: "search-designs", arguments: { query: "logo" } },
      _meta: { is_mcp_tool_call: true },
    });
    expect(normalized.update).toMatchObject({
      kind: "other",
      title: "mcp.canva.search-designs",
      rawInput: { server: "canva", tool: "search-designs", arguments: { query: "logo" } },
      _meta: { is_mcp_tool_call: true },
    });
    expect(isCodexMcpToolCall(normalized.update)).toBe(true);
  });

  it("fills a missing MCP title from structured server/tool fields", () => {
    const normalized = normalizeCodexUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "mcp-1",
      rawInput: { server: "canva", tool: "list-folder-items", arguments: {} },
    });
    expect(normalized.update.title).toBe("mcp.canva.list-folder-items");
    expect(normalized.update.kind).toBeUndefined();
  });

  it("does not remap a real shell command that happens to mention a server", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-1",
      kind: "execute",
      title: "node -e echo",
      rawInput: { command: "node -e \"console.log('ok')\"", cwd: "C:\\repo" },
    };
    expect(isCodexMcpToolCall(update)).toBe(false);
    expect(normalizeCodexUpdate(update).update.kind).toBe("execute");
    expect(normalizeCodexUpdate(update).update.title).toBe("node -e echo");
  });

  it("maps formatted command output without losing exit_code", () => {
    const normalized = normalizeCodexUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-1",
      rawOutput: { formatted_output: "hello\n", exit_code: 7 },
    });
    expect(normalized.update.rawOutput).toEqual({ formatted_output: "hello\n", output: "hello\n", exit_code: 7 });
  });

  it("normalizes null full-file diff oldText to an empty creation side", () => {
    const normalized = normalizeCodexUpdate({
      sessionUpdate: "tool_call",
      content: [{ type: "diff", path: "new.ts", oldText: null, newText: "export {};\n" }],
    });
    expect(normalized.update.content[0].oldText).toBe("");
    expect(normalized.update.content[0].newText).toBe("export {};\n");
  });

  it("feeds usage_update window without treating billed used as occupancy", () => {
    expect(normalizeCodexUpdate({ sessionUpdate: "usage_update", used: 1234, size: 258400 }, { replay: false }))
      .toEqual({
        update: { sessionUpdate: "usage_update", used: 1234, size: 258400 },
        meta: { replay: false },
        contextWindow: 258400,
        usageUpdateUsed: 1234,
      });
  });

  it("maps top-level prompt usage into existing meta and leaves cost absent", () => {
    const result = normalizeCodexPromptResult({
      stopReason: "end_turn",
      usage: { totalTokens: 90, inputTokens: 50, cachedReadTokens: 20, outputTokens: 30, thoughtTokens: 10 },
      _meta: { quota: { token_count: 90, model_usage: [{ model: "gpt-5.6-sol", inputTokens: 50 }] } },
    });
    expect(result._meta).toMatchObject({
      totalTokens: 70,
      reasoningTokens: 10,
      usage: { totalTokens: 90, inputTokens: 50, cachedReadTokens: 20, outputTokens: 30, reasoningTokens: 10 },
      quota: { token_count: 90 },
    });
    expect(result._meta.usage.costUsdTicks).toBeUndefined();
  });
});

describe("Codex permission normalization", () => {
  it("filters the exec-policy amendment, synthesizes a bounded first-line title, and preserves meta", () => {
    const command = "node -e \"console.log('a very long command')\" " + "x".repeat(100);
    const normalized = normalizeCodexPermissionParams({
      _meta: { codex: { kind: "approval" } },
      toolCall: { toolCallId: "t1", kind: "execute", rawInput: { command: `${command}\nsecond line` } },
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "accept_execpolicy_amendment", kind: "allow_always", name: "Allow policy" },
        { optionId: "reject_once", kind: "reject_once", name: "Reject" },
      ],
    });
    expect(normalized.options.map((option: any) => option.optionId)).toEqual(["allow_once", "reject_once"]);
    expect(normalized.toolCall.title).toHaveLength(80);
    expect(normalized.toolCall.title.endsWith("…")).toBe(true);
    expect(normalized._meta).toEqual({ codex: { kind: "approval" } });
  });

  it("keeps plan review on the ordinary permission shape", () => {
    const params = {
      _meta: { codex: { kind: "plan_review" } },
      toolCall: { kind: "switch_mode", title: "Implement this plan?", rawInput: { plan: "# Plan" } },
      options: [{ optionId: "implement_plan", kind: "allow_once", name: "Implement" }, { optionId: "revise_plan", kind: "reject_once", name: "Revise" }],
    };
    expect(normalizeCodexPermissionParams(params)).toEqual(params);
  });
});

describe("Codex config response state", () => {
  it("derives model, effort, and extension mode from the full response", () => {
    expect(configStateFromCodexOptions({ configOptions: [
      { id: "model", currentValue: "gpt-5.6-terra" },
      { configId: "reasoning_effort", value: "max" },
      { id: "mode", currentValue: "agent-full-access" },
      { id: "collaboration_mode", currentValue: "plan" },
    ] }, {})).toEqual({ modelId: "gpt-5.6-terra", reasoningEffort: "max", modeId: "plan" });
  });

  it("keeps permission mode when collaboration is default so full-access is not Agent", () => {
    expect(codexEffectiveModeId("default", "agent-full-access")).toBe("agent-full-access");
    expect(codexEffectiveModeId("default", "agent")).toBe("agent");
    expect(codexEffectiveModeId("default", "read-only")).toBe("askApproval");
    expect(codexEffectiveModeId("plan", "read-only")).toBe("plan");
    expect(codexEffectiveModeId("plan", "agent-full-access")).toBe("plan");
    expect(codexEffectiveModeId("default", undefined, "plan")).toBe("default");

    const fullAccess = configStateFromCodexOptions({ configOptions: [
      { id: "mode", currentValue: "agent-full-access" },
      { id: "collaboration_mode", currentValue: "default" },
    ] }, { modeId: "plan" });
    expect(fullAccess.modeId).toBe("agent-full-access");
    expect(applyAgentModeToHostPlan(fullAccess.modeId!, false)).toEqual({
      planActive: false,
      autoApprove: true,
    });

    const agent = configStateFromCodexOptions({ configOptions: [
      { id: "mode", currentValue: "agent" },
      { id: "collaboration_mode", currentValue: "default" },
    ] }, {});
    expect(agent.modeId).toBe("agent");
    expect(applyAgentModeToHostPlan(agent.modeId!, false)).toEqual({
      planActive: false,
      autoApprove: false,
    });

    // Grok's client gate must stay independent of this mapping.
    expect(applyAgentModeToHostPlan("agent-full-access", true)).toBeNull();
  });
});

it("selects the interactive approval preset through the permission axis", () => {
  expect(new CodexBackend().setMode("session", "askApproval")).toEqual({
    method: "session/set_config_option",
    params: { sessionId: "session", configId: "mode", value: "read-only" },
  });
});

describe("Codex session listing", () => {
  it("omits cwd from pages, paginates, dedupes cursors/ids, and filters Windows paths case-insensitively", async () => {
    const calls: Array<string | undefined> = [];
    const result = await listAllCodexSessions(async (cursor) => {
      calls.push(cursor);
      if (!cursor) return {
        sessions: [
          { sessionId: "one", cwd: "c:\\github\\repo", title: "One" },
          { sessionId: "other", cwd: "C:\\GitHub\\Elsewhere", title: "Other" },
        ],
        nextCursor: "page-2",
      };
      return {
        sessions: [
          { sessionId: "one", cwd: "C:\\GitHub\\Repo", title: "duplicate" },
          { sessionId: "two", cwd: "C:\\GITHUB\\REPO", title: "Two" },
        ],
        nextCursor: "page-2",
      };
    }, "C:\\GitHub\\Repo", "win32");
    expect(calls).toEqual([undefined, "page-2"]);
    expect(result).toEqual({
      sessions: [
        { sessionId: "one", cwd: "c:\\github\\repo", title: "One" },
        { sessionId: "two", cwd: "C:\\GITHUB\\REPO", title: "Two" },
      ],
      nextCursor: null,
    });
  });
});

describe("Codex auth classification", () => {
  it("is conservative and distinct from unrelated entitlement failures", () => {
    expect(isCodexCredentialError({ message: "Authentication required: not logged in" })).toBe(true);
    expect(isCodexCredentialError({ message: "quota exhausted for this account" })).toBe(false);
  });
});
