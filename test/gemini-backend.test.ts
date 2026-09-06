import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMINI_MODELS,
  GeminiBackend,
  configStateFromGeminiOptions,
  isGeminiCredentialError,
  listGeminiSessions,
  modelsFromGeminiConfigOptions,
  normalizeGeminiPermissionParams,
  normalizeGeminiPromptResult,
  normalizeGeminiSessionResponse,
  normalizeGeminiUpdate,
  parseAgyModelsOutput,
} from "../src/gemini-backend";

describe("Gemini spawn", () => {
  it("spawns the gemini CLI with --acp flag for legacy gemini", () => {
    const backend = new GeminiBackend();
    const spec = backend.spawn({
      cliPath: "gemini",
      cwd: "C:\\repo",
      env: { KEEP_ME: "yes" },
    });
    expect(spec.command).toBe("gemini");
    expect(spec.args).toEqual(["--acp"]);
    expect(spec.env).toMatchObject({ KEEP_ME: "yes" });
  });

  it("spawns AgyAcpAdapter via node when Antigravity agy binary is provided", () => {
    const backend = new GeminiBackend({ adapterPath: "/fake/agy-acp-adapter.js" });
    const spec = backend.spawn({
      cliPath: "C:\\Users\\dev\\.gemini\\bin\\agy.exe",
      cwd: "C:\\repo",
      env: { KEEP_ME: "yes" },
    });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual(["/fake/agy-acp-adapter.js"]);
    expect(spec.env).toMatchObject({
      KEEP_ME: "yes",
      AGY_PATH: "C:\\Users\\dev\\.gemini\\bin\\agy.exe",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("supports custom args if specified for legacy gemini", () => {
    const backend = new GeminiBackend({ args: ["--acp", "--verbose"] });
    const spec = backend.spawn({
      cliPath: "/usr/local/bin/gemini",
      cwd: "/repo",
      env: {},
    });
    expect(spec.command).toBe("/usr/local/bin/gemini");
    expect(spec.args).toEqual(["--acp", "--verbose"]);
  });
});

describe("Antigravity models discovery and parsing", () => {
  const agyModelsOutput = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.7-flash-low\tGemini 3.7 Flash (Low)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;

  it("parses all 14 models from agy models into families and raw list", () => {
    const { rawModels, availableModels } = parseAgyModelsOutput(agyModelsOutput);
    expect(rawModels).toHaveLength(14);
    expect(availableModels).toHaveLength(7);

    const flash38 = availableModels.find((m) => m.modelId === "gemini-3.8-flash");
    expect(flash38).toBeDefined();
    expect(flash38?.name).toBe("Gemini 3.8 Flash");
    expect(flash38?._meta.supportsReasoningEffort).toBe(true);
    expect(flash38?._meta.reasoningEfforts).toEqual([
      { value: "low" },
      { value: "medium" },
      { value: "high" },
    ]);

    const pro31 = availableModels.find((m) => m.modelId === "gemini-3.1-pro");
    expect(pro31).toBeDefined();
    expect(pro31?.name).toBe("Gemini 3.1 Pro");
    expect(pro31?._meta.supportsReasoningEffort).toBe(true);
    expect(pro31?._meta.reasoningEfforts).toEqual([
      { value: "low" },
      { value: "high" },
    ]);

    const sonnet = availableModels.find((m) => m.modelId === "claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet?.name).toBe("Claude Sonnet 4.6 (Thinking)");
    expect(sonnet?._meta.supportsReasoningEffort).toBe(false);
  });

  it("includes 7 primary model families in DEFAULT_GEMINI_MODELS", () => {
    expect(DEFAULT_GEMINI_MODELS.length).toBeGreaterThanOrEqual(7);
    const ids = DEFAULT_GEMINI_MODELS.map((m) => m.modelId);
    expect(ids).toContain("gemini-3.8-flash");
    expect(ids).toContain("gemini-3.7-flash");
    expect(ids).toContain("gemini-3.6-flash");
    expect(ids).toContain("gemini-3.1-pro");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-6-thinking");
    expect(ids).toContain("gpt-oss-120b-medium");
  });
});

describe("Gemini session model mapping", () => {
  const configOptions = [
    {
      id: "model",
      currentValue: "gemini-3.8-flash",
      options: [
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Most capable agentic workhorse" },
        { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro", description: "Flagship deep reasoning" },
      ],
    },
    {
      id: "reasoning_effort",
      currentValue: "high",
      options: [
        { value: "default", name: "Default" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    { id: "mode", currentValue: "agent" },
  ];

  it("turns configOptions into the host picker envelope", () => {
    const models = modelsFromGeminiConfigOptions(configOptions);
    expect(models.currentModelId).toBe("gemini-3.8-flash");
    expect(models.availableModels).toHaveLength(2);
    expect(models.availableModels[0]).toMatchObject({
      modelId: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [{ value: "low" }, { value: "high" }],
      },
    });
  });

  it("fills models on session response if availableModels is missing", () => {
    const normalized = normalizeGeminiSessionResponse({ sessionId: "s1", configOptions });
    expect(normalized.sessionId).toBe("s1");
    expect(normalized.models.currentModelId).toBe("gemini-3.8-flash");
    expect(normalized.models.availableModels).toHaveLength(2);
  });
});

describe("Gemini prompt and permission normalization", () => {
  it("normalizes token usage from prompt result", () => {
    const result = normalizeGeminiPromptResult({
      stopReason: "end_turn",
      usage: {
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        thoughtTokens: 200,
      },
    });
    expect(result.usage).toMatchObject({
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 200,
    });
  });

  it("synthesizes tool title for untitled permission requests", () => {
    const untitled = normalizeGeminiPermissionParams({
      toolCall: { kind: "execute", rawInput: { command: "git status" } },
    });
    expect(untitled.toolCall.title).toBe("git status");

    const titled = { toolCall: { title: "Custom Title" } };
    expect(normalizeGeminiPermissionParams(titled)).toEqual(titled);
  });
});

describe("Gemini diff synthesis fallback", () => {
  it("synthesizes a diff from old_string/new_string when no native diff is present", () => {
    const result = normalizeGeminiUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      rawInput: { file_path: "/repo/a.ts", old_string: "old", new_string: "new" },
    }, undefined);
    expect(result.update.content).toEqual([
      { type: "diff", path: "/repo/a.ts", oldText: "old", newText: "new" },
    ]);
  });

  it("leaves an existing native diff block untouched", () => {
    const native = { type: "diff", path: "/repo/a.ts", oldText: "native-old", newText: "native-new" };
    const result = normalizeGeminiUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      content: [native],
      rawInput: { file_path: "/repo/a.ts", old_string: "old", new_string: "new" },
    }, undefined);
    expect(result.update.content).toEqual([native]);
  });

  it("injects the diff into permission params", () => {
    const params = normalizeGeminiPermissionParams({
      toolCall: { kind: "edit", rawInput: { file_path: "/repo/a.ts", old_string: "old", new_string: "new" } },
    });
    expect(params.toolCall.content).toEqual([
      { type: "diff", path: "/repo/a.ts", oldText: "old", newText: "new" },
    ]);
  });
});

describe("Gemini mode and config state", () => {
  it("generates correct setModel and setMode methods", () => {
    const backend = new GeminiBackend();
    expect(backend.setModel("s1", "gemini-3.8-flash")).toEqual({
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "model", value: "gemini-3.8-flash" },
    });
    expect(backend.setMode("s1", "yolo")).toEqual({
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "yolo" },
    });
  });

  it("reads config state from configOptions", () => {
    const state = configStateFromGeminiOptions({
      configOptions: [
        { id: "model", currentValue: "gemini-3.1-pro" },
        { id: "reasoning_effort", currentValue: "low" },
        { id: "mode", currentValue: "yolo" },
      ],
    }, { modelId: "", reasoningEffort: "", modeId: "" });

    expect(state).toEqual({
      modelId: "gemini-3.1-pro",
      reasoningEffort: "low",
      modeId: "yolo",
    });
  });
});

describe("Gemini session listing", () => {
  it("filters sessions by target cwd and handles pagination", async () => {
    const calls: Array<string | undefined> = [];
    const result = await listGeminiSessions(async (cursor) => {
      calls.push(cursor);
      return {
        sessions: [
          { sessionId: "s1", cwd: "C:\\repo", title: "Session 1" },
          { sessionId: "s2", cwd: "C:\\other", title: "Session 2" },
        ],
      };
    }, "C:\\repo", "win32");

    expect(calls).toEqual([undefined]);
    expect(result.sessions).toEqual([
      { sessionId: "s1", cwd: "C:\\repo", title: "Session 1" },
    ]);
  });
});

describe("Gemini auth classification", () => {
  it("identifies credential error messages", () => {
    expect(isGeminiCredentialError({ message: "Not logged in, please run gemini auth login" })).toBe(true);
    expect(isGeminiCredentialError({ message: "Authentication required" })).toBe(true);
    expect(isGeminiCredentialError({ message: "Session expired. Sign in required." })).toBe(true);
    expect(isGeminiCredentialError({ data: { message: "auth_required: please authenticate" } })).toBe(true);
    expect(isGeminiCredentialError("Invalid API key provided")).toBe(true);
    expect(isGeminiCredentialError({ message: "Rate limit exceeded" })).toBe(false);
    expect(isGeminiCredentialError(new Error("Connection reset by peer"))).toBe(false);

    const backend = new GeminiBackend();
    expect(backend.isCredentialError({ message: "Please run gemini auth login" })).toBe(true);
    expect(backend.isCredentialError(new Error("Unknown error"))).toBe(false);
  });
});

