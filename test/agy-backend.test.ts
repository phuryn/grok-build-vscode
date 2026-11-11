import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgyBackend,
  AgyToolCallMerger,
  AgyToolCallShapes,
  agyGeminiHome,
  agyServerArgs,
  agySessionParams,
  agyThinkingLevel,
  agyWorkingFolderPrompt,
  configStateFromAgyOptions,
  isAgyCredentialError,
  listAgySessions,
  modelsFromAgyConfigOptions,
  normalizeAgySessionResponse,
  normalizeAgyUpdate,
  stopAgyServerTree,
} from "../src/agy-backend";
import { AcpClient, acpClientCapabilities } from "../src/acp";
import { pickAutoAcceptOption } from "../src/session";
import { sessionModes } from "../src/mode-prefs";

// Measured from agy_acp_server 1.4.0 `session/new` (research/antigravity-acp.md).
const configOptions = [
  { currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }], id: "model", name: "Model", category: "model", type: "select" },
  { currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }], id: "thinking_level", name: "Thinking Level", category: "thought_level", type: "select" },
  { currentValue: "default", options: [{ value: "default", name: "Default" }], id: "mode", name: "Session Mode", category: "mode", type: "select" },
];

describe("Antigravity models and effort", () => {
  it("applies the default and live key effort through AcpClient without an ACP thinking_level RPC, including after resume", async () => {
    let level: "low" | "medium" | "high" = "high";
    const backend = new AgyBackend({ keyRelay: {
      baseUrl: "http://127.0.0.1/relay/lease", release: () => {}, supportsThinking: () => true,
      get thinkingLevel() { return level; }, setThinkingLevel: (value) => { level = value; },
    } });
    const client = new AcpClient({ backend, cliPath: "unused", cwd: "/repo", env: {}, effort: "low", log: () => {} });
    const rpc = vi.spyOn(client as any, "request").mockResolvedValue({ sessionId: "s", configOptions: [{ id: "model", currentValue: "gemini-4-argon", options: [{ value: "gemini-4-argon" }] }] });
    await client.newSession();
    expect(level).toBe("low");
    expect(client.currentReasoningEffort).toBe("low");
    const before = rpc.mock.calls.length;
    await expect(client.setReasoningEffort("xhigh")).resolves.toBe(true);
    expect(rpc.mock.calls).toHaveLength(before);
    expect(level).toBe("high");
    expect(client.currentReasoningEffort).toBe("high");
    await client.loadSession("s");
    expect(client.currentReasoningEffort).toBe("high");
    await expect(client.setReasoningEffort("medium")).resolves.toBe(true);
    expect(level).toBe("medium");
    expect(rpc.mock.calls.some(([, params]) => (params as any)?.configId === "thinking_level")).toBe(false);
  });

  it("offers exactly Low/Medium/High from relay thinking metadata and applies key effort locally", () => {
    let level: "low" | "medium" | "high" = "low";
    const backend = new AgyBackend({ keyRelay: {
      baseUrl: "http://127.0.0.1/relay/lease", release: () => {},
      supportsThinking: (id) => id === "gemini-4-carbon",
      get thinkingLevel() { return level; },
      setThinkingLevel: (value) => { level = value; },
    } });
    const response = { configOptions: [{ id: "model", currentValue: "gemini-4-carbon", options: ["gemini-4-carbon", "gemini-3.8-flash"].map((value) => ({ value })) }] };
    const [thinking, plain] = backend.normalizeSessionResponse(response).models.availableModels;
    expect(thinking._meta).toMatchObject({ supportsReasoningEffort: true, reasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }], reasoningEffort: "low" });
    expect(plain._meta).toMatchObject({ supportsReasoningEffort: false, reasoningEfforts: [] });
    for (const [requested, expected] of [["none", "low"], ["minimal", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"]]) {
      expect(backend.setReasoningEffort("s", "gemini-4-carbon", requested)).toEqual({ local: true });
      expect(level).toBe(expected);
      expect(backend.configState({}, { modelId: "gemini-4-carbon", modeId: "agent", reasoningEffort: requested }).reasoningEffort).toBe(expected);
    }
    expect(backend.setReasoningEffort("s", "gemini-3.8-flash", "low")).toBeNull();
    expect(backend.setReasoningEffort("s", "gemini-4-carbon", "max")).toBeNull();
    expect(level).toBe("high");
    expect(backend.configState({}, { modelId: "gemini-3.8-flash", modeId: "agent" }).reasoningEffort).toBeUndefined();
  });

  it("shows one model with thinking_level as its effort ladder", () => {
    expect(modelsFromAgyConfigOptions(configOptions)).toEqual({
      currentModelId: "gemini-3.8-flash",
      availableModels: [{
        modelId: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        // The catalog names no window: Gemini's, until a usage_update says it.
        _meta: { totalContextTokens: 1_048_576, supportsReasoningEffort: true, reasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }], reasoningEffort: "high" },
      }],
    });
  });

  it("replaces the server's three per-level models in the session response", () => {
    const response = {
      sessionId: "s",
      configOptions,
      models: { currentModelId: "gemini-3.8-flash-high", availableModels: ["high", "medium", "low"].map((l) => ({ modelId: `gemini-3.8-flash-${l}` })) },
    };
    const normalized = normalizeAgySessionResponse(response);
    expect(normalized.models.currentModelId).toBe("gemini-3.8-flash");
    expect(normalized.models.availableModels.map((m: any) => m.modelId)).toEqual(["gemini-3.8-flash"]);
    expect(normalizeAgySessionResponse({ sessionId: "s", models: response.models })).toEqual({ sessionId: "s", models: response.models });
  });

  it.each([
    ["none", "low"], ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"], ["", undefined], ["max", undefined],
  ])("maps effort %s to thinking_level %s", (level, expected) => {
    expect(agyThinkingLevel(level)).toBe(expected);
    const call = new AgyBackend().setReasoningEffort("s", "gemini-3.8-flash", level);
    expect(call).toEqual(expected ? { method: "session/set_config_option", params: { sessionId: "s", configId: "thinking_level", value: expected } } : null);
  });

  // API-key mode lists the server's hardcoded catalog (model_selection.py
  // DEFAULT_MODEL_LIST): several families, and Gemini 3.1 Pro has only high
  // and low. `thinking_level` lists only the CURRENT family's levels, so each
  // family's ladder comes from its own listed variants.
  it("gives each family of the key catalog its own row and its own levels", () => {
    const families: [string, string, string[]][] = [
      ["gemini-3.8-flash", "Gemini 3.8 Flash", ["high", "medium", "low"]],
      ["gemini-3.7-flash", "Gemini 3.7 Flash", ["high", "medium", "low"]],
      ["gemini-3.1-pro", "Gemini 3.1 Pro", ["high", "low"]],
    ];
    const response = {
      sessionId: "s",
      configOptions: [
        { currentValue: "gemini-3.8-flash", options: families.map(([value, name]) => ({ value, name })), id: "model", category: "model", type: "select" },
        { currentValue: "medium", options: ["low", "medium", "high"].map((value) => ({ value, name: value })), id: "thinking_level", category: "thought_level", type: "select" },
      ],
      models: {
        currentModelId: "gemini-3.8-flash-medium",
        availableModels: families.flatMap(([id, name, levels]) => levels.map((level) => ({ modelId: `${id}-${level}`, name: `${name} (${level})` }))),
      },
    };
    const models = normalizeAgySessionResponse(response).models;
    expect(models.currentModelId).toBe("gemini-3.8-flash");
    expect(models.availableModels.map((m: any) => [m.modelId, m.name, m._meta.reasoningEfforts.map((e: any) => e.value), m._meta.reasoningEffort])).toEqual([
      ["gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"], "medium"],
      ["gemini-3.7-flash", "Gemini 3.7 Flash", ["low", "medium", "high"], undefined],
      ["gemini-3.1-pro", "Gemini 3.1 Pro", ["low", "high"], undefined],
    ]);
  });

  it("reads model and level back from configOptions, keeping the host's mode", () => {
    const low = configOptions.map((o) => o.id === "thinking_level" ? { ...o, currentValue: "low" } : o);
    expect(configStateFromAgyOptions({ configOptions: low }, { modelId: "x", reasoningEffort: "high", modeId: "yolo" }))
      .toEqual({ modelId: "gemini-3.8-flash", reasoningEffort: "low", modeId: "yolo" });
    expect(configStateFromAgyOptions({}, { modelId: "x", reasoningEffort: "high", modeId: "agent" }))
      .toEqual({ modelId: "x", reasoningEffort: "high", modeId: "agent" });
  });

  it("offers Agent and Auto accept, never Plan, and Auto accept never sends a saved grant", () => {
    expect(sessionModes("agy")).toEqual(["agent", "yolo"]);
    expect(() => new AgyBackend().setMode("s", "plan")).toThrow(/Plan/);
    expect(new AgyBackend().setMode("s", "yolo")).toEqual({ method: "session/set_mode", params: { sessionId: "s", modeId: "yolo" } });
    const options = [
      { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" },
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    expect(pickAutoAcceptOption(options, "agy")?.optionId).toBe("allow");
  });
});

describe("Antigravity session setup", () => {
  it("puts the project folder in the server's system-prompt append", () => {
    const cwd = path.join("C:", "Users", "me", "project");
    expect(agySessionParams(cwd)).toEqual({ _meta: { antigravity: { systemPrompt: { append: agyWorkingFolderPrompt(cwd) } } } });
    expect(agyWorkingFolderPrompt(cwd)).toContain(`The project folder for this session is ${cwd}.`);
    expect(new AgyBackend().sessionParams(cwd)).toEqual(agySessionParams(cwd));
  });

  it("spawns the server directly, with --uid= on Linux only", () => {
    expect(agyServerArgs("linux")).toEqual(["--uid="]);
    expect(agyServerArgs("win32")).toEqual([]);
    expect(agyServerArgs("darwin")).toEqual([]);
    const spec = new AgyBackend({ platform: "linux" }).spawn({ cliPath: "/opt/agy/agy_acp_server.par", cwd: "/repo", env: { A: "1" } });
    expect(spec).toEqual({ command: "/opt/agy/agy_acp_server.par", args: ["--uid="], env: { A: "1" }, shell: false });
    const script = new AgyBackend({ platform: "win32" }).spawn({ cliPath: "C:\\fake\\server.cjs", cwd: "C:\\repo", env: {} });
    expect(script.command).toBe(process.execPath);
    expect(script.args).toEqual(["C:\\fake\\server.cjs"]);
  });

  it("advertises no client fs or terminal, so the server runs its own tools", () => {
    expect(acpClientCapabilities("agy")).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  });

  it("resolves GEMINI_HOME like the server", () => {
    expect(agyGeminiHome({}, "/home/me")).toBe(path.join("/home/me", ".gemini"));
    expect(agyGeminiHome({ GEMINI_HOME: "/data/g" }, "/home/me")).toBe("/data/g");
    expect(agyGeminiHome({ GEMINI_HOME: "~/g" }, "/home/me")).toBe(path.join("/home/me", "/g"));
  });
});

describe("Antigravity credential classification", () => {
  it.each([
    [{ code: -32000, message: "Authentication required", data: { message: "No authentication method selected." } }, true],
    [{ code: -32000, message: "Logged out. Sign in again to continue; the previous session's credentials were cleared." }, true],
    [new Error("Onboarding failed: ineligible"), true],
    [{ code: -32602, message: "Model 'claude-opus' is not available for the current authentication method." }, false],
    [{ code: -32002, message: "Resource not found" }, false],
    [new Error("Antigravity ACP server exited (code 1)"), false],
  ])("%j -> %s", (error, expected) => {
    expect(isAgyCredentialError(error)).toBe(expected);
    expect(new AgyBackend().isCredentialError(error)).toBe(expected);
  });
});

describe("Antigravity updates", () => {
  const sessionId = "9c4f7823-ed35-4cbc-a8ff-38810a61d288";
  const file = "C:\\work\\agy-spike\\acp-hello.txt";
  // The measured sequence for one approved edit (acp-perm.log).
  const approved = { toolCallId: "b6f93483bd0942fa8b4b4751ca211cc3", title: "Run create_file?", kind: "edit", status: "pending",
    content: [{ path: file, newText: "hi", _meta: { kind: "add" }, type: "diff" }], locations: [{ path: file }],
    rawInput: { CodeContent: "hi", TargetFile: file }, sessionUpdate: "tool_call" };
  const running = { toolCallId: `${sessionId}:1`, title: "Running edit_file", kind: "edit", status: "in_progress",
    locations: [{ path: file }], rawInput: { file_path: file }, sessionUpdate: "tool_call" };
  const done = { toolCallId: `${sessionId}:1`, status: "completed", rawOutput: "Create acp-hello.txt", sessionUpdate: "tool_call_update" };
  const sweep = { toolCallId: approved.toolCallId, status: "failed", rawOutput: "Tool call was approved but never executed.", sessionUpdate: "tool_call_update" };

  const run = (updates: any[]) => {
    const merger = new AgyToolCallMerger();
    const shapes = new AgyToolCallShapes();
    return updates.map((update) => normalizeAgyUpdate(update, undefined, merger, shapes).update).filter(Boolean);
  };
  // The renderer's tool name and field names ride along (agy-tool-shapes.test.ts).
  const shaped = { ...approved, tool: "write_file", rawInput: { ...approved.rawInput, file_path: file } };

  it("folds an approved edit's execution into the approved card and drops the false failure", () => {
    expect(run([approved, running, done, sweep])).toEqual([
      shaped,
      { sessionUpdate: "tool_call_update", toolCallId: approved.toolCallId, status: "in_progress", tool: "write_file" },
      { ...done, toolCallId: approved.toolCallId, tool: "write_file" },
    ]);
  });

  it("matches by file when several edits wait, in either order", () => {
    const other = "C:\\work\\agy-spike\\other.txt";
    const second = { ...approved, toolCallId: "second", content: [{ ...approved.content[0], path: other }], locations: [{ path: other }] };
    const runningOther = { ...running, toolCallId: `${sessionId}:2`, locations: [{ path: other.toUpperCase() }] };
    const out = run([approved, second, runningOther, running]);
    expect(out[2]).toMatchObject({ toolCallId: "second", sessionUpdate: "tool_call_update" });
    expect(out[3]).toMatchObject({ toolCallId: approved.toolCallId, sessionUpdate: "tool_call_update" });
  });

  it("keeps a denied edit's failure, and an edit that really never ran", () => {
    const denied = { toolCallId: approved.toolCallId, status: "failed", rawOutput: "Denied", sessionUpdate: "tool_call_update" };
    expect(run([approved, denied])).toEqual([shaped, { ...denied, tool: "write_file" }]);
    expect(run([approved, sweep])).toEqual([shaped, { ...sweep, tool: "write_file" }]);
  });

  it("updates command calls in place, under a neutral title", () => {
    const command = { toolCallId: "cmd", kind: "execute", status: "pending", title: "echo done", sessionUpdate: "tool_call" };
    const progress = { toolCallId: "cmd", status: "completed", sessionUpdate: "tool_call_update" };
    expect(run([command, progress])).toEqual([
      { ...command, title: "Run command", tool: "run_command" },
      { ...progress, tool: "run_command" },
    ]);
  });

  it("hides /logout and /plan, keeps /usage, and ignores server mode changes", () => {
    const merger = new AgyToolCallMerger();
    const commands = normalizeAgyUpdate({ sessionUpdate: "available_commands_update", availableCommands: [
      { name: "plan" }, { name: "logout" }, { name: "usage" }] }, undefined, merger);
    expect(commands.update.availableCommands).toEqual([{ name: "usage" }]);
    expect(normalizeAgyUpdate({ sessionUpdate: "current_mode_update", currentModeId: "yolo" }, undefined, merger).update).toBeUndefined();
  });

  // The server does not fail a prompt Google refused: it sends the API's own
  // message as agent text and ends the turn normally.
  it.each([
    ["API key not valid. Please pass a valid API key.", true],
    ["API key expired. Please renew the API key.", true],
    ["Request had invalid authentication credentials. Expected OAuth 2 access token.", true],
    ["Agent execution error: rpc error: code = InvalidArgument reason:API_KEY_INVALID", true],
    ["Here is how an API key works in general.", false],
    // The agent talking about someone else's error is not Google refusing ours.
    ["Your log says API key not valid. Please pass a valid API key. Check .env.", false],
    ["The client returns API_KEY_INVALID when the header is empty.", false],
  ])("flags %j as a rejected credential: %s", (text, rejected) => {
    const result = normalizeAgyUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, undefined, new AgyToolCallMerger());
    expect(result.update.content.text).toBe(text);
    expect(result.credentialRejected === true).toBe(rejected);
  });

  it("reads the context meter straight from usage_update", () => {
    const result = normalizeAgyUpdate({ sessionUpdate: "usage_update", used: 13224, size: 1048576 }, undefined, new AgyToolCallMerger());
    expect(result).toMatchObject({ contextUsed: 13224, contextWindow: 1048576 });
  });
});

describe("Antigravity history", () => {
  const dir = path.join("/home/me", ".gemini", "antigravity-acp", "conversations");
  const files: Record<string, string> = {
    [path.join(dir, "a.meta")]: JSON.stringify({ cwd: "C:\\Users\\me\\proj" }),
    [path.join(dir, "b.meta")]: JSON.stringify({ cwd: "c:\\users\\ME\\proj" }),
    [path.join(dir, "c.meta")]: JSON.stringify({ cwd: "C:\\Users\\me\\other" }),
    [path.join(dir, "d.meta")]: "not json",
  };
  const fakeFs = {
    readDir: (target: string) => { if (target !== dir) throw new Error("ENOENT"); return ["a.db", "a.meta", "b.db", "b.meta", "c.db", "c.meta", "d.db", "e.db"]; },
    readFile: (file: string) => { if (!(file in files)) throw new Error("ENOENT"); return files[file]; },
    modifiedAt: (file: string) => file.endsWith("a.db") ? 1000 : file.endsWith("b.db") ? 2000 : undefined,
  };

  it("lists the project's conversations from the server's own store, ignoring Windows case", () => {
    expect(listAgySessions("C:\\Users\\me\\proj", "win32", { env: {}, home: "/home/me", fs: fakeFs })).toEqual([
      { sessionId: "a", cwd: "C:\\Users\\me\\proj", updatedAt: 1000 },
      { sessionId: "b", cwd: "c:\\users\\ME\\proj", updatedAt: 2000 },
    ]);
  });

  it("is empty when nothing has been stored yet, and never asks the server", async () => {
    expect(listAgySessions("/repo", "linux", { env: {}, home: "/nowhere", fs: fakeFs })).toEqual([]);
    const request = vi.fn();
    const result = await new AgyBackend({ env: {}, home: "/home/me", fs: fakeFs }).listSessions(request, "C:\\Users\\me\\proj", "win32");
    expect(result.sessions.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("stopping the Windows server", () => {
  it("kills only the bootloader's same-named children, as trees, so the bootloader cleans up", async () => {
    const run = vi.fn(async (command: string) => command === "powershell.exe" ? "4242\r\n4343\r\n" : "");
    await stopAgyServerTree(1000, "C:\\Users\\me\\agy\\agy_acp_server.exe", run);
    expect(run.mock.calls[0][0]).toBe("powershell.exe");
    expect(run.mock.calls[0][1].at(-1)).toContain("ParentProcessId=1000 AND Name='agy_acp_server.exe'");
    expect(run.mock.calls.slice(1)).toEqual([["taskkill", ["/PID", "4242", "/T", "/F"]], ["taskkill", ["/PID", "4343", "/T", "/F"]]]);
  });

  it("does nothing off Windows or for a script server", async () => {
    const run = vi.fn(async () => "");
    await new AgyBackend({ platform: "linux", run }).stopProcess(1, "/opt/agy_acp_server.par");
    await new AgyBackend({ platform: "win32", run }).stopProcess(1, "C:\\fake\\server.cjs");
    expect(run).not.toHaveBeenCalled();
  });
});
