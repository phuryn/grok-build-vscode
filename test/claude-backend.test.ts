import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  ClaudeBackend,
  claudeModeId,
  configStateFromClaudeOptions,
  contextWindowForClaudeModel,
  isClaudeCredentialError,
  listClaudeSessions,
  modelsFromClaudeConfigOptions,
  normalizeClaudePermissionParams,
  normalizeClaudePromptResult,
  normalizeClaudeSessionResponse,
  normalizeClaudeUpdate,
  resolveClaudeAgentAcpAdapter,
} from "../src/claude-backend";

describe("Claude adapter spawn", () => {
  it("runs Electron as Node and points the SDK at the user's Claude CLI", () => {
    const spec = new ClaudeBackend({ adapterPath: "adapter.js", nodePath: "electron.exe" }).spawn({
      cliPath: "claude.exe",
      cwd: "C:\\repo",
      env: { ELECTRON_RUN_AS_NODE: "0", KEEP_ME: "yes" },
    });
    expect(spec.env).toMatchObject({
      CLAUDE_CODE_EXECUTABLE: "claude.exe",
      ELECTRON_RUN_AS_NODE: "1",
      KEEP_ME: "yes",
    });
    expect(spec.args).toEqual(["adapter.js"]);
  });

  it("does not pass a hide-subscription flag", () => {
    // Deliberate: `--hide-claude-auth` would reject subscription accounts that
    // already work in official Claude Code. We never handle the credential.
    const spec = new ClaudeBackend({ adapterPath: "adapter.js" }).spawn({
      cliPath: "claude",
      cwd: "/repo",
      env: {},
    });
    expect(spec.args.join(" ")).not.toMatch(/hide-claude-auth/);
  });

  it("resolves the adapter through package.json bin, not the unexported package root", () => {
    const resolved = resolveClaudeAgentAcpAdapter();
    expect(resolved.replace(/\\/g, "/")).toMatch(/@agentclientprotocol\/claude-agent-acp\/dist\/index\.js$/);
    expect(() => require.resolve("@agentclientprotocol/claude-agent-acp")).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main defined/);
  });

  it("joins the manifest directory with the declared bin", () => {
    const resolved = resolveClaudeAgentAcpAdapter(
      () => path.join("C:", "ext", "node_modules", "@agentclientprotocol", "claude-agent-acp", "package.json"),
      () => JSON.stringify({ bin: { "claude-agent-acp": "dist/index.js" } }),
    );
    expect(resolved).toBe(path.join("C:", "ext", "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"));
  });
});

describe("Claude session model mapping", () => {
  const configOptions = [
    {
      id: "model",
      currentValue: "claude-opus-4-6",
      options: [
        { value: "default", name: "Default" },
        { value: "claude-opus-4-6", name: "Opus", description: "strongest" },
        { value: "claude-sonnet-4-6", name: "Sonnet" },
      ],
    },
    {
      id: "effort",
      currentValue: "high",
      options: [
        { value: "default", name: "Default" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    { id: "mode", currentValue: "plan" },
  ];

  it("turns configOptions into the host picker envelope with appropriate context windows", () => {
    const models = modelsFromClaudeConfigOptions(configOptions);
    expect(models.currentModelId).toBe("claude-opus-4-6");
    expect(models.availableModels).toHaveLength(3);
    expect(models.availableModels[1]).toMatchObject({
      modelId: "claude-opus-4-6",
      name: "Opus",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [{ value: "low" }, { value: "high" }],
        totalContextTokens: 1000000,
      },
    });
  });

  it("resolves model context windows for current and legacy Claude models", () => {
    expect(contextWindowForClaudeModel("claude-sonnet-5")).toBe(1000000);
    expect(contextWindowForClaudeModel("claude-opus-5")).toBe(1000000);
    expect(contextWindowForClaudeModel("claude-fable-5-1")).toBe(1000000);
    expect(contextWindowForClaudeModel("sonnet", "Claude Sonnet 5")).toBe(1000000);
    expect(contextWindowForClaudeModel("custom-model", "Model [1M]")).toBe(1000000);
    expect(contextWindowForClaudeModel("claude-haiku-4-5")).toBe(200000);
    expect(contextWindowForClaudeModel("claude-3-5-sonnet")).toBe(200000);
  });

  it("fills models on session/new so the picker is not empty", () => {
    const normalized = normalizeClaudeSessionResponse({ sessionId: "s1", configOptions });
    expect(normalized.sessionId).toBe("s1");
    expect(normalized.models.currentModelId).toBe("claude-opus-4-6");
    expect(normalized.models.availableModels).toHaveLength(3);
  });
});

describe("Claude output and usage normalization", () => {
  it("feeds usage_update window without treating billed used as occupancy", () => {
    expect(normalizeClaudeUpdate({ sessionUpdate: "usage_update", used: 12, size: 200000 }, { replay: false }))
      .toEqual({
        update: { sessionUpdate: "usage_update", used: 12, size: 200000 },
        meta: { replay: false },
        contextWindow: 200000,
        usageUpdateUsed: 12,
      });
  });

  it("lifts a session title off session_info_update", () => {
    expect(normalizeClaudeUpdate({ sessionUpdate: "session_info_update", title: " Named " }))
      .toEqual({ sessionTitle: "Named" });
  });

  it("maps prompt usage into existing meta and keeps occupancy off the billed total", () => {
    const result = normalizeClaudePromptResult({
      stopReason: "end_turn",
      usage: {
        totalTokens: 35671,
        inputTokens: 2,
        outputTokens: 12,
        cachedReadTokens: 25408,
        cachedWriteTokens: 10249,
        thoughtTokens: 3,
      },
    });
    expect(result._meta).toMatchObject({
      totalTokens: 35659,
      cachedWriteTokens: 10249,
      reasoningTokens: 3,
      usage: {
        totalTokens: 35671,
        inputTokens: 2,
        outputTokens: 12,
        cachedReadTokens: 25408,
        cachedWriteTokens: 10249,
        reasoningTokens: 3,
      },
    });
  });
});

describe("Claude diff synthesis", () => {
  it("synthesizes a diff for an Edit tool_call from old_string/new_string", () => {
    const result = normalizeClaudeUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      rawInput: { file_path: "/repo/a.ts", old_string: "old", new_string: "new" },
    });
    expect(result.update.content).toEqual([
      { type: "diff", path: "/repo/a.ts", oldText: "old", newText: "new" },
    ]);
  });

  it("synthesizes a create diff for a Write tool_call_update with oldText empty", () => {
    const result = normalizeClaudeUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      rawInput: { file_path: "/repo/new.ts", content: "hello\n" },
    });
    expect(result.update.content).toEqual([
      { type: "diff", path: "/repo/new.ts", oldText: "", newText: "hello\n" },
    ]);
  });

  it("does not synthesize a second diff when a native diff block is already present", () => {
    const native = { type: "diff", path: "/repo/a.ts", oldText: "native-old", newText: "native-new" };
    const result = normalizeClaudeUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      content: [native],
      rawInput: { file_path: "/repo/a.ts", old_string: "old", new_string: "new" },
    });
    expect(result.update.content).toEqual([native]);
  });

  it("does not mutate the incoming update object", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "t4",
      rawInput: { file_path: "/repo/a.ts", old_string: "old", new_string: "new" },
    };
    const before = JSON.stringify(update);
    normalizeClaudeUpdate(update);
    expect(JSON.stringify(update)).toBe(before);
  });

  it("leaves non-edit tool calls untouched", () => {
    const update = { sessionUpdate: "tool_call", toolCallId: "t5", rawInput: { command: "npm test" } };
    expect(normalizeClaudeUpdate(update)).toEqual({ update, meta: undefined });
  });

  it("overrides a degenerate native diff (oldText === newText) with one synthesized from rawInput", () => {
    // Reproduces a live-observed bug: Claude's completed tool_call_update
    // shipped its own content diff, but with oldText === newText (a "+0 −0"
    // card even though the edit visibly changed the file). Claude's own
    // diffs are documented as unreliable — a degenerate one must not block
    // synthesizing a correct one from the same update's rawInput.
    const degenerate = { type: "diff", path: "/repo/PLAN.md", oldText: "unchanged", newText: "unchanged" };
    const result = normalizeClaudeUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t6",
      status: "completed",
      content: [degenerate],
      rawInput: { file_path: "/repo/PLAN.md", old_string: "Revision: 3.1", new_string: "Revision: 3.2" },
    });
    expect(result.update.content).toEqual([
      { type: "diff", path: "/repo/PLAN.md", oldText: "Revision: 3.1", newText: "Revision: 3.2" },
    ]);
  });

  it("injects the diff into permission params so the card gets open diff →", () => {
    const params = normalizeClaudePermissionParams({
      toolCall: { kind: "edit", rawInput: { file_path: "/repo/a.ts", old_string: "old", new_string: "new" } },
      options: [],
    });
    expect(params.toolCall.content).toEqual([
      { type: "diff", path: "/repo/a.ts", oldText: "old", newText: "new" },
    ]);
    expect(params.toolCall.title).toBe("permission: edit");
  });

  it("retains the synthesized diff on sparse completed tool_call_update via ClaudeBackend", () => {
    const backend = new ClaudeBackend();
    // 1. Initial tool_call: has rawInput, no status
    const callRes = backend.normalizeUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t_sparse",
      rawInput: { file_path: "/repo/file.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
    }, undefined);
    expect(callRes.update.content).toEqual([
      { type: "diff", path: "/repo/file.ts", oldText: "const a = 1;", newText: "const a = 2;" },
    ]);

    // 2. Completed tool_call_update: claude-agent-acp omits rawInput and content
    const updateRes = backend.normalizeUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t_sparse",
      status: "completed",
      rawOutput: "File updated successfully",
    }, undefined);
    expect(updateRes.update.content).toEqual([
      { type: "diff", path: "/repo/file.ts", oldText: "const a = 1;", newText: "const a = 2;" },
    ]);
    expect(updateRes.update.status).toBe("completed");
  });
});

describe("Claude permission and mode mapping", () => {
  it("synthesizes a title only when the adapter left the card untitled", () => {
    const untitled = normalizeClaudePermissionParams({
      toolCall: { kind: "execute", rawInput: { command: "npm test" } },
      options: [{ optionId: "allow_once" }],
    });
    expect(untitled.toolCall.title).toBe("npm test");
    const titled = { toolCall: { title: "Edit src.ts", kind: "edit" }, options: [] };
    expect(normalizeClaudePermissionParams(titled)).toEqual(titled);
  });

  it("maps host Agent/Auto-accept onto Claude permission modes", () => {
    expect(claudeModeId("yolo")).toBe("bypassPermissions");
    expect(claudeModeId("agent")).toBe("default");
    expect(claudeModeId("plan")).toBe("plan");
    expect(new ClaudeBackend().setMode("sid", "yolo")).toEqual({
      method: "session/set_mode",
      params: { sessionId: "sid", modeId: "bypassPermissions" },
    });
  });

  it("reads model, effort, and mode from configOptions", () => {
    expect(configStateFromClaudeOptions({
      configOptions: [
        { id: "model", currentValue: "claude-sonnet-4-6" },
        { id: "effort", currentValue: "low" },
        { id: "mode", currentValue: "bypassPermissions" },
      ],
    }, {})).toEqual({
      modelId: "claude-sonnet-4-6",
      reasoningEffort: "low",
      modeId: "bypassPermissions",
    });
  });
});

describe("Claude session listing", () => {
  it("passes cwd, filters the checkout, and stops when there is no cursor", async () => {
    const calls: Array<string | undefined> = [];
    const result = await listClaudeSessions(async (cursor) => {
      calls.push(cursor);
      return {
        sessions: [
          { sessionId: "one", cwd: "C:\\GitHub\\Repo", title: "One", updatedAt: "2026-08-01T00:00:00.000Z" },
          { sessionId: "other", cwd: "C:\\GitHub\\Elsewhere", title: "Other" },
        ],
      };
    }, "c:\\github\\repo", "win32");
    expect(calls).toEqual([undefined]);
    expect(result).toEqual({
      sessions: [
        { sessionId: "one", cwd: "C:\\GitHub\\Repo", title: "One", updatedAt: "2026-08-01T00:00:00.000Z" },
      ],
      nextCursor: null,
    });
  });
});

describe("Claude auth classification", () => {
  it("matches the adapter's login and subscription-refusal text, not quota", () => {
    expect(isClaudeCredentialError({ message: "Not logged in · Please run /login" })).toBe(true);
    expect(isClaudeCredentialError({ message: "Session expired. Please run /login to sign in again." })).toBe(true);
    expect(isClaudeCredentialError({ message: "This integration does not support using claude.ai subscriptions." })).toBe(true);
    expect(isClaudeCredentialError({ message: "quota exhausted for this account" })).toBe(false);
    expect(new ClaudeBackend().isCredentialError({ message: "authentication required" })).toBe(true);
  });
});
