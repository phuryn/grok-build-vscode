import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseSession } from "../adapters/muse/session.mts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { AcpClient } from "../src/acp";
import { MuseBackend } from "../src/muse-backend";

// The session tests inject a fake SDK connection; no vendor executable is used.
vi.mock("@muse-code/sdk", () => ({ spawnMspConnection: () => { throw new Error("inject the fake spawn"); } }));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platformDescriptor);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  vi.stubEnv("MUSE_CODE_EXECUTABLE", "/fake/muse");
  let notify!: (notification: any) => void;
  let protocolError!: (error: Error) => void;
  const exited = deferred<{ code: number; signal: null }>();
  const closed = deferred<void>();
  const admission = deferred<any>();
  const command = vi.fn(async (method: string) => {
    if (method === "session/start") return { session: { sessionId: "session", modelId: "default-model" } };
    if (method === "turn/start") return admission.promise;
    return {};
  });
  const description = "Your content, including inter-session messages, may be used for product improvement.";
  const connection = { command, closed: closed.promise,
    request: vi.fn(async () => ({ models: [{ modelId: "default-model", displayLabel: "Default",
      description, contextLimit: 1007997 }] })) };
  const handshake = { exited: exited.promise, onNotification: (fn: typeof notify) => { notify = fn; },
    onProtocolError: (fn: typeof protocolError) => { protocolError = fn; }, onServerRequest: vi.fn(),
    initialize: vi.fn(async () => ({ connection, initializeResult: { serverInfo: { name: "muse", version: "1.3.0" } } })),
    close: vi.fn(async () => exited.promise) };
  const client = { notify: vi.fn(async () => {}), request: vi.fn() };
  const logs: string[] = [], fatal = vi.fn(), spawn = vi.fn((_options: { command: string; args: string[] }) => handshake);
  const session = new MuseSession(client as any, message => logs.push(message), fatal, spawn as any);
  const event = (method: string, params: any = {}) => notify({ method, params: { sessionId: "session", ...params } });
  const raw = (method: string, params: Record<string, any> = {}) => notify({ method, params });
  return { session, spawn, handshake, client, logs, fatal, event, raw, admission, exited, closed, command, connection, description, protocolError: (e: Error) => protocolError(e) };
}

async function ready() {
  const s = setup();
  await s.session.initialize();
  const result = await s.session.newSession("/workspace", []);
  return { ...s, result };
}

describe("Muse reasoning effort", () => {
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

  it("advertises the SDK vocabulary in order as value objects on every model", async () => {
    const require = createRequire(import.meta.url);
    const schema = readFileSync(join(dirname(require.resolve("@muse-code/sdk")), "msp.d.ts"), "utf8");
    const vocabulary = schema.match(/export type ReasoningEffort = ([^;]+);/)![1];
    expect([...vocabulary.matchAll(/"([^"]+)"/g)].map(match => match[1])).toEqual(levels);
    const s = await ready();
    s.connection.request.mockResolvedValue({ models: [
      { modelId: "one", isDefault: true, contextLimit: 100 }, { modelId: "two", contextLimit: 200 },
    ] } as any);
    const models = await s.session.models();
    expect(models.currentModelId).toBe("one");
    expect(models.availableModels.map((m: any) => m._meta)).toEqual([100, 200].map(totalContextTokens => ({
      totalContextTokens, supportsReasoningEffort: true, reasoningEfforts: levels.map(value => ({ value })),
    })));
  });

  it("sends each effort verbatim to MSP and reflects only the accepted current value", async () => {
    const s = await ready();
    s.command.mockResolvedValue({ status: "accepted" } as any);
    for (const level of levels) {
      await expect(s.session.setReasoningEffort("session", level)).resolves.toEqual({});
      expect(s.command).toHaveBeenLastCalledWith("session/setReasoningEffort", { sessionId: "session", reasoningEffort: level });
      expect((await s.session.models("default-model")).availableModels[0]._meta.reasoningEffort).toBe(level);
    }
  });

  it("rejects a refused effort clearly without changing the value or killing the session", async () => {
    const s = await ready();
    s.command.mockResolvedValueOnce({ status: "accepted" } as any);
    await s.session.setReasoningEffort("session", "low");
    for (const status of ["rejected", "future-status", undefined]) {
      s.command.mockResolvedValueOnce({ status } as any);
      await expect(s.session.setReasoningEffort("session", "ultra")).rejects.toThrow('Muse reasoning effort "ultra" was rejected');
      expect((await s.session.models("default-model")).availableModels[0]._meta.reasoningEffort).toBe("low");
    }
    expect(s.fatal).not.toHaveBeenCalled();
    s.command.mockResolvedValueOnce({ status: "accepted" } as any);
    await expect(s.session.setReasoningEffort("session", "medium")).resolves.toEqual({});
  });

  it("refuses an effort for a foreign session before sending MSP", async () => {
    const s = await ready();
    s.command.mockClear();
    await expect(s.session.setReasoningEffort("foreign", "high")).rejects.toThrow("Unknown Muse session");
    expect(s.command).not.toHaveBeenCalled();
  });

  it("restores snapshot effort only on the current model", async () => {
    const s = setup();
    await s.session.initialize();
    s.command.mockResolvedValue({ session: { sessionId: "session", workspaceRoot: "/workspace", modelId: "default-model" },
      history: { mode: "snapshot", snapshot: { state: { items: [], reasoningEffort: { reasoningEffort: "max", source: "user" } } } },
    } as any);
    const result = await s.session.loadSession("session", "/workspace", []);
    expect(result._meta.models.availableModels[0]._meta.reasoningEffort).toBe("max");
    expect((await s.session.models("another-model")).availableModels[0]._meta).not.toHaveProperty("reasoningEffort");
  });

  it("carries the advertised menu and accepted effort through the ACP host", async () => {
    const s = await ready();
    const host = new AcpClient({ cliPath: "/unused", cwd: "/workspace", backend: new MuseBackend(), log: () => {} });
    vi.spyOn(host as any, "request").mockImplementation(async (method: string, params: any) => {
      if (method === "session/new") return s.result;
      if (method === "session/set_config_option") return s.session.setReasoningEffort(params.sessionId, params.value);
      throw new Error(`Unexpected request: ${method}`);
    });
    await host.newSession();
    expect(host.availableModels[0].reasoningEfforts).toEqual(levels);
    expect(host.currentModelSupportsEffort()).toBe(true);
    s.command.mockResolvedValueOnce({ status: "accepted" } as any);
    await expect(host.setReasoningEffort("ultra")).resolves.toBe(true);
    expect(host.currentReasoningEffort).toBe("ultra");
    s.command.mockResolvedValueOnce({ status: "rejected" } as any);
    await expect(host.setReasoningEffort("max")).rejects.toThrow('Muse reasoning effort "max" was rejected');
    expect(host.currentReasoningEffort).toBe("ultra");
  });
});

describe("Muse CLI spawn", () => {
  it.skipIf(process.platform !== "win32")("starts a real Windows shim from an install path containing spaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "Muse install with spaces "));
    try {
      const executable = join(dir, "muse.cmd");
      writeFileSync(executable, "@echo off\r\necho SPAWN_OK %1\r\n");
      const s = setup();
      vi.stubEnv("MUSE_CODE_EXECUTABLE", executable);
      await s.session.initialize();
      // Use the adapter's actual SDK spawn plan in Node, not a quoted mock.
      const { command, args } = s.spawn.mock.calls[0][0];
      const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
      expect({ code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() })
        .toEqual({ code: 0, stdout: "SPAWN_OK serve", stderr: "" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ["win32", String.raw`C:\Users\Dell\AppData\Local\Programs\muse\muse.cmd`],
    ["win32", String.raw`C:\Users\Dell User\AppData\Local\Programs\muse\muse.CMD`],
  ])("wraps %s shim %s with separate executable and serve arguments", async (platform, executable) => {
    const s = setup();
    Object.defineProperty(process, "platform", { value: platform });
    vi.stubEnv("MUSE_CODE_EXECUTABLE", executable);
    const comspec = String.raw`C:\Windows\System32\cmd.exe`;
    vi.stubEnv("COMSPEC", comspec);
    await s.session.initialize();
    expect(s.spawn).toHaveBeenCalledOnce();
    const { command, args } = s.spawn.mock.calls[0][0];
    expect({ command, args }).toEqual({
      command: comspec, args: ["/d", "/c", executable, "serve"],
    });
  });

  it("wraps a win32 .bat with cmd.exe when COMSPEC is absent", async () => {
    const s = setup();
    Object.defineProperty(process, "platform", { value: "win32" });
    const executable = String.raw`C:\muse\muse.bat`;
    vi.stubEnv("MUSE_CODE_EXECUTABLE", executable);
    vi.stubEnv("COMSPEC", "");
    delete process.env.COMSPEC;
    await s.session.initialize();
    expect(s.spawn).toHaveBeenCalledOnce();
    const { command, args } = s.spawn.mock.calls[0][0];
    expect({ command, args }).toEqual({
      command: "cmd.exe", args: ["/d", "/c", executable, "serve"],
    });
  });

  it.each([
    ["win32", String.raw`C:\muse\muse.exe`],
    ["linux", "/home/u/.local/bin/muse"],
    ["darwin", "/home/u/.local/bin/muse"],
    ["linux", "/home/u/.local/bin/muse.cmd"],
  ])("launches %s executable %s directly", async (platform, executable) => {
    const s = setup();
    Object.defineProperty(process, "platform", { value: platform });
    vi.stubEnv("MUSE_CODE_EXECUTABLE", executable);
    await s.session.initialize();
    expect(s.spawn).toHaveBeenCalledOnce();
    const { command, args } = s.spawn.mock.calls[0][0];
    expect({ command, args }).toEqual({
      command: executable, args: ["serve"],
    });
  });
});

describe("Muse subscription usage", () => {
  const usage = {
    tier: "hidden-tier", observedAtMs: 1_700_000_000_000,
    window: { usedPercent: 12, resetsAtMs: 1_700_000_300_000, windowDurationMins: 300 },
    weekly: { usedPercent: 40, resetsAtMs: 1_700_600_000_000 },
  };

  it("sends usage after a turn and on usage/changed, and nothing without a session", async () => {
    const s = setup();
    await s.session.initialize();
    s.raw("usage/changed", usage);
    expect(s.client.notify).not.toHaveBeenCalled();

    await s.session.newSession("/workspace", []);
    s.connection.request.mockResolvedValueOnce({ usage });
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true });
    s.event("turn/completed", { turnId: "turn", terminal: "completed" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(s.connection.request).toHaveBeenCalledWith("usage/read", {});
    expect(s.client.notify).toHaveBeenCalledWith("_muse/subscription_usage", { sessionId: "session", usage });

    s.client.notify.mockClear();
    s.command.mockResolvedValueOnce({ status: "accepted", turnId: "next", startedNewTurn: true } as any);
    s.connection.request.mockResolvedValueOnce({});
    const quiet = s.session.prompt("session", [{ type: "text", text: "again" }]);
    s.event("turn/completed", { turnId: "next", terminal: "completed" });
    await expect(quiet).resolves.toEqual({ stopReason: "end_turn" });
    expect(s.client.notify).not.toHaveBeenCalled();

    s.raw("usage/changed", usage);
    expect(s.client.notify).toHaveBeenCalledWith("_muse/subscription_usage", { sessionId: "session", usage });
  });

  it("logs a failed usage read and still finishes the turn", async () => {
    const s = await ready();
    s.connection.request.mockRejectedValueOnce(new Error("usage unavailable"));
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true });
    s.event("turn/completed", { turnId: "turn", terminal: "completed" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(s.fatal).not.toHaveBeenCalled();
    expect(s.logs).toContain("Muse usage/read failed: usage unavailable");
    expect(s.client.notify.mock.calls.some((call: any[]) => call[0] === "_muse/subscription_usage")).toBe(false);
  });
});

describe("Muse turn admission and process ownership", () => {
  it("requests no capabilities and preserves the complete model description", async () => {
    const s = await ready();
    expect(s.handshake.initialize).toHaveBeenCalledWith({ clientInfo: { name: "grok_build_muse_adapter", version: "1" },
      capabilities: { requestedCapabilities: [], experimentalApi: false, userInputDialogs: false } });
    expect(s.result.models.availableModels[0].description).toBe(s.description);
  });

  it("waits beyond admission for the matching terminal and flushes text updates first", async () => {
    const s = await ready();
    const delivered = deferred<void>();
    s.client.notify.mockImplementation(() => delivered.promise);
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    let settled = false;
    void prompt.then(() => { settled = true; });
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    s.event("turn/completed", { turnId: "old", terminal: "completed" });
    s.event("item/delta", { itemId: "answer", field: "text", delta: "hello" });
    s.event("turn/completed", { turnId: "turn", terminal: "completed" });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    delivered.resolve();
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("handles completion before admission and a second prompt in the same session", async () => {
    const s = await ready();
    const first = s.session.prompt("session", [{ type: "text", text: "one" }]);
    s.event("turn/completed", { turnId: "first", terminal: "completed" });
    s.admission.resolve({ status: "accepted", turnId: "first", startedNewTurn: true });
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
    s.command.mockImplementation(async () => ({ status: "accepted", turnId: "second", startedNewTurn: true }));
    const second = s.session.prompt("session", [{ type: "text", text: "two" }]);
    s.event("turn/completed", { turnId: "second", terminal: "completed" });
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
  });

  it.each(["protocol", "transport", "exit", "turn"])("rejects a prompt on %s failure", async failure => {
    const s = await ready();
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    const rejected = expect(prompt).rejects.toBeInstanceOf(Error);
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true });
    await new Promise(resolve => setImmediate(resolve));
    if (failure === "protocol") s.protocolError(new Error("invalid MSP"));
    if (failure === "transport") s.closed.resolve();
    if (failure === "exit") s.exited.resolve({ code: 7, signal: null });
    if (failure === "turn") s.event("turn/completed", { turnId: "turn", terminal: "failed", error: { message: "failed" } });
    await rejected;
  });

  it("does not finish shutdown or report an exit until the child has actually exited", async () => {
    const s = await ready();
    const close = s.session.close();
    let settled = false;
    void close.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(s.handshake.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(s.logs.some(line => line.startsWith("MUSE_CHILD_EXIT"))).toBe(false);
    s.exited.resolve({ code: 0, signal: null });
    await close;
    expect(s.logs.at(-1)).toBe('MUSE_CHILD_EXIT {"code":0,"signal":null}');
  });
});


describe("Muse cancellation and resume", () => {
  it("queues cancellation before admission and waits for the terminal", async () => {
    const s = await ready();
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    await s.session.cancel("session");
    expect(s.command).not.toHaveBeenCalledWith("turn/cancel", expect.anything());
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(s.command).toHaveBeenCalledWith("turn/cancel", { sessionId: "session", turnId: "turn" });
    let settled = false;
    void prompt.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    s.event("turn/completed", { turnId: "turn", terminal: "cancelled" });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it.each(["inline", "snapshot"])("projects %s history before the first live event", async mode => {
    const s = setup();
    await s.session.initialize();
    const resumed = deferred<any>();
    s.command.mockImplementation(async () => resumed.promise);
    const loading = s.session.loadSession("session", "/workspace", []);
    s.event("item/delta", { itemId: "answer", field: "text", delta: " world", viewCursor: "live" });
    expect(s.client.notify).not.toHaveBeenCalled();
    const items = [
      { itemId: "user", revision: 1, kind: "userMessage", text: "Hello" },
      { itemId: "reminder", revision: 1, kind: "reminderChild", text: "private reminder" },
      { itemId: "answer", revision: 1, kind: "agentMessage", text: "Hello" },
    ];
    resumed.resolve({ session: { sessionId: "session", workspaceRoot: "/workspace", modelId: "default-model" },
      history: mode === "inline" ? { mode, items } : { mode, snapshot: { state: { items } } }, viewCursor: "head" });
    await loading;
    const updates = s.client.notify.mock.calls.map((args: any) => args[1].update);
    expect(updates.map((u: any) => [u.sessionUpdate, u.content.text])).toEqual([
      ["user_message_chunk", "Hello"], ["agent_message_chunk", "Hello"], ["agent_message_chunk", " world"],
    ]);
    s.event("item/completed", { item: { itemId: "answer", revision: 2, kind: "agentMessage", text: "Hello world" } });
    await new Promise(resolve => setImmediate(resolve));
    expect(s.client.notify).toHaveBeenCalledTimes(3);
    s.command.mockImplementation(async () => ({ status: "accepted", turnId: "next", startedNewTurn: true }));
    const next = s.session.prompt("session", [{ type: "text", text: "next" }]);
    s.event("item/delta", { itemId: "next-answer", field: "text", delta: "Next" });
    s.event("turn/completed", { turnId: "next", terminal: "completed" });
    await next;
    expect(s.client.notify.mock.calls.at(-1)?.[1].update.content.text).toBe("Next");
  });

  it("pages durable revisions when inline history is unavailable, without replaying deltas", async () => {
    const s = setup(); await s.session.initialize();
    s.command.mockResolvedValue({ session: { sessionId: "session", workspaceRoot: "/workspace" },
      history: { mode: "none" }, viewCursor: "head" } as any);
    const modelRequest = s.connection.request.getMockImplementation()!;
    s.connection.request.mockImplementation(async (...args: any[]) => {
      if (args[0] !== "view/page") return modelRequest();
      return { events: [
        { method: "item/delta", params: { itemId: "a", delta: "Ignore delta", viewCursor: "one" } },
        { method: "item/completed", params: { item: { itemId: "a", revision: 1, kind: "agentMessage", text: "Final" }, viewCursor: "head" } },
      ], nextCursor: null } as any;
    });
    await s.session.loadSession("session", "/workspace", []);
    expect(s.client.notify).toHaveBeenCalledOnce();
    expect(s.client.notify.mock.calls[0]?.[1].update.content.text).toBe("Final");
  });
});


it("fails promptly if the process dies while admission is still outstanding", async () => {
  const s = await ready();
  const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
  const rejected = expect(prompt).rejects.toThrow("exited unexpectedly");
  s.exited.resolve({ code: 1, signal: null });
  await rejected;
});


it("keeps reminder identities hidden across consecutive turns", async () => {
  const s = await ready();
  const first = s.session.prompt("session", [{ type: "text", text: "first" }]);
  s.event("item/started", { item: { itemId: "reminder", revision: 1, kind: "reminderChild" } });
  s.admission.resolve({ status: "accepted", turnId: "first", startedNewTurn: true });
  s.event("turn/completed", { turnId: "first", terminal: "completed" }); await first;
  s.command.mockImplementation(async () => ({ status: "accepted", turnId: "second", startedNewTurn: true }));
  const second = s.session.prompt("session", [{ type: "text", text: "second" }]);
  s.event("item/delta", { itemId: "reminder", field: "text", delta: "must stay hidden" });
  s.event("item/delta", { itemId: "answer", field: "text", delta: "Answer" });
  s.event("turn/completed", { turnId: "second", terminal: "completed" }); await second;
  expect(s.client.notify).toHaveBeenCalledOnce();
  expect(s.client.notify.mock.calls[0]?.[1].update.content.text).toBe("Answer");
});


it("acknowledges approval presentation and deduplicates the paired notification", async () => {
  const s = await ready();
  const answer = deferred<any>(); s.client.request.mockReturnValue(answer.promise);
  const params = { sessionId: "session", approvalId: "approval", toolCallId: "call", toolName: "bash", rawArgs: "{}",
    currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
    availableChoices: [{ choiceId: "server-denial", decision: "denied", scope: "once", label: "Deny" }] };
  const request = s.handshake.onServerRequest.mock.calls[0][0];
  await expect(request({ method: "approval/request", params })).resolves.toEqual({});
  s.event("approval/requested", params);
  expect(s.client.request).toHaveBeenCalledOnce();
  expect(s.command).not.toHaveBeenCalledWith("approval/decide", expect.anything());
  answer.resolve({ outcome: { outcome: "selected", optionId: "server-denial" } });
  await new Promise(resolve => setImmediate(resolve));
  expect(s.command).toHaveBeenCalledWith("approval/decide", { sessionId: "session", approvalId: "approval",
    choiceId: "server-denial", requirementId: params.currentRequirementId });
  expect(s.fatal).not.toHaveBeenCalled();
});
