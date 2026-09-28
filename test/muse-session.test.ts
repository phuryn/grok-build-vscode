import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseSession } from "../adapters/muse/session.mts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { AcpClient } from "../src/acp";
import { MuseBackend } from "../src/muse-backend";
import { MspError } from "@muse-code/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { adapterListEntry } from "../src/provider-ui";
import museListing from "./fixtures/muse-session-list.json";

// The session tests inject a fake SDK connection; no vendor executable is used.
vi.mock("@muse-code/sdk", async importOriginal => ({
  ...await importOriginal<typeof import("@muse-code/sdk")>(),
  spawnMspConnection: () => { throw new Error("inject the fake spawn"); },
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.useRealTimers();
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
  const command = vi.fn(async (method: string, params?: any) => {
    if (method === "session/start") return { session: { sessionId: "session", modelId: "default-model", approvalMode: { mode: params.approvalMode, source: "startup" } } };
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

describe("Muse native modes", () => {
  it.each([["agent", "promptUnmatched"], ["yolo", "allowAll"], ["denyUnmatched", "denyUnmatched"]])("starts cloud %s without the Muse sandbox, preserving approvals and trust", async (mode, approvalMode) => {
    const s = setup();
    const posture = { mode, shellSandbox: true, sandboxNetwork: "restricted", trustWorkspaces: false } as any;
    const spec = new MuseBackend(posture, true).spawn({ cliPath: "/fake/muse", cwd: "/workspace", env: {} });
    expect(JSON.parse(spec.env.GROK_MUSE_POSTURE!)).toMatchObject({ mode, shellSandbox: false, cloud: true });
    vi.stubEnv("GROK_MUSE_POSTURE", spec.env.GROK_MUSE_POSTURE!);
    await s.session.initialize();
    expect(s.spawn.mock.calls[0][0].args).toEqual(["serve", "--disable-sandbox", ...(mode === "yolo" ? ["--trust-workspace"] : [])]);
    const result = await s.session.newSession("/workspace", []);
    expect(s.command).toHaveBeenCalledWith("session/start", { workspaceRoot: "/workspace", approvalMode });
    expect(result.modes?.currentModeId).toBe(mode);
    expect(result.modes?.availableModes.map(m => m.id)).toEqual(["yolo", "agent", "denyUnmatched"]);
    s.command.mockResolvedValueOnce({ status: "accepted", effectiveMode: { mode: approvalMode } } as any);
    await s.session.setMode("session", mode);
    expect(s.command).toHaveBeenLastCalledWith("session/setApprovalMode", { sessionId: "session", mode: approvalMode });
    await expect(s.session.setMode("session", "onRequest")).rejects.toThrow("unavailable on cloud machines");
  });

  it("uses Prompt unmatched and no Muse sandbox for a new cloud session seeded from On request", async () => {
    const s = setup();
    const spec = new MuseBackend({ mode: "onRequest", shellSandbox: true, sandboxNetwork: "proxy-only", trustWorkspaces: false }, true)
      .spawn({ cliPath: "/fake/muse", cwd: "/workspace", env: {} });
    expect(JSON.parse(spec.env.GROK_MUSE_POSTURE!).shellSandbox).toBe(false);
    vi.stubEnv("GROK_MUSE_POSTURE", spec.env.GROK_MUSE_POSTURE!);
    await s.session.initialize();
    expect(s.spawn.mock.calls[0][0].args).toEqual(["serve", "--disable-sandbox"]);
    const result = await s.session.newSession("/workspace", []);
    expect(s.command).toHaveBeenCalledWith("session/start", { workspaceRoot: "/workspace", approvalMode: "promptUnmatched" });
    expect(result.modes?.currentModeId).toBe("agent");
  });

  it.each(["agent", "onRequest"])("refuses a cloud history stored as On request without attaching or admitting a turn (saved=%s)", async mode => {
    const s = setup();
    vi.stubEnv("GROK_MUSE_POSTURE", JSON.stringify({ mode, cloud: true }));
    await s.session.initialize();
    s.connection.request.mockResolvedValueOnce({ session: { approvalMode: { mode: "onRequest" } } } as any);
    await expect(s.session.loadSession("session", "/workspace", [])).rejects.toThrow("unavailable on cloud machines");
    expect(s.connection.request).toHaveBeenCalledWith("session/read", { sessionId: "session" });
    expect(s.command).not.toHaveBeenCalled();
    expect(s.client.request).not.toHaveBeenCalled();
    await expect(s.session.prompt("session", [{ type: "text", text: "go" }])).rejects.toThrow("Unknown Muse session");
  });

  it("can resume on cloud after a desktop changes a saved On request history to Prompt unmatched", async () => {
    const s = setup();
    vi.stubEnv("GROK_MUSE_POSTURE", JSON.stringify({ mode: "onRequest", cloud: true }));
    await s.session.initialize();
    s.connection.request.mockResolvedValueOnce({ session: { approvalMode: { mode: "promptUnmatched" } } } as any);
    s.command.mockResolvedValueOnce({ session: { sessionId: "session", workspaceRoot: "/workspace", approvalMode: { mode: "promptUnmatched" } },
      history: { mode: "inline", items: [] } } as any);
    const result = await s.session.loadSession("session", "/workspace", []);
    expect(result.modes?.currentModeId).toBe("agent");
    expect(result.modes?.availableModes.map(m => m.id)).toEqual(["yolo", "agent", "denyUnmatched"]);
  });

  it("also refuses On request when the cloud replay differs from the preflight read", async () => {
    const s = setup();
    vi.stubEnv("GROK_MUSE_POSTURE", JSON.stringify({ mode: "agent", cloud: true }));
    await s.session.initialize();
    s.connection.request.mockResolvedValueOnce({ session: { approvalMode: { mode: "promptUnmatched" } } } as any);
    s.command.mockResolvedValueOnce({ session: { sessionId: "session", workspaceRoot: "/workspace", approvalMode: { mode: "onRequest" } },
      history: { mode: "inline", items: [] }, pendingRequests: [{}] } as any);
    await expect(s.session.loadSession("session", "/workspace", [])).rejects.toThrow("unavailable on cloud machines");
    expect(s.fatal).toHaveBeenCalled();
    expect(s.client.request).not.toHaveBeenCalled();
    await expect(s.session.prompt("session", [{ type: "text", text: "go" }])).rejects.toThrow("Unknown Muse session");
    expect(s.command.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("offers exactly the SDK's closed approval dictionary under Muse's names", async () => {
    const require = createRequire(import.meta.url);
    const schema = readFileSync(join(dirname(require.resolve("@muse-code/sdk")), "msp.d.ts"), "utf8");
    const vocabulary = schema.match(/export type ApprovalMode = ([^;]+);/)![1];
    expect([...vocabulary.matchAll(/"([^"]+)"/g)].map(match => match[1])).toEqual(["allowAll", "promptUnmatched", "onRequest", "denyUnmatched"]);
    const s = await ready();
    expect(s.result.modes?.availableModes).toEqual([
      { id: "yolo", name: "Allow all" }, { id: "agent", name: "Prompt unmatched" },
      { id: "onRequest", name: "On request" }, { id: "denyUnmatched", name: "Deny unmatched" },
    ]);
  });

  it.each([{ mode: "yolo" }, { mode: "agent", shellSandbox: false }])("rejects On request before sending it from unsandboxed %j, even after switching to Prompt unmatched", async posture => {
    vi.stubEnv("GROK_MUSE_POSTURE", JSON.stringify(posture));
    const s = await ready();
    s.command.mockResolvedValueOnce({ status: "accepted", effectiveMode: { mode: "promptUnmatched" } } as any);
    await s.session.setMode("session", "agent");
    s.command.mockClear();
    await expect(s.session.setMode("session", "onRequest")).rejects.toThrow("requires the shell sandbox");
    expect(s.command).not.toHaveBeenCalled();
  });

  it("fails closed before forwarding pending approvals if an unsandboxed resume replays On request", async () => {
    vi.stubEnv("GROK_MUSE_POSTURE", JSON.stringify({ mode: "yolo" }));
    const s = setup();
    await s.session.initialize();
    s.command.mockResolvedValueOnce({ session: { sessionId: "session", workspaceRoot: "/workspace", approvalMode: { mode: "onRequest" } },
      history: { mode: "inline", items: [] }, pendingRequests: [{}] } as any);
    await expect(s.session.loadSession("session", "/workspace", [])).rejects.toThrow("requires the shell sandbox");
    expect(s.client.notify).toHaveBeenCalledWith("session/update", { sessionId: "session", update: { sessionUpdate: "current_mode_update", currentModeId: "onRequest" } });
    expect(s.fatal).toHaveBeenCalled();
    expect(s.client.request).not.toHaveBeenCalled();
    await expect(s.session.prompt("session", [{ type: "text", text: "go" }])).rejects.toThrow("Unknown Muse session");
    expect(s.command.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("uses the latest mode notification buffered during resume", async () => {
    const s = setup();
    await s.session.initialize();
    s.command.mockImplementationOnce(async () => {
      s.event("session/approvalModeChanged", { mode: "denyUnmatched" });
      return { session: { sessionId: "session", workspaceRoot: "/workspace", approvalMode: { mode: "promptUnmatched" } },
        history: { mode: "inline", items: [] } } as any;
    });
    const result = await s.session.loadSession("session", "/workspace", []);
    expect(result.modes?.currentModeId).toBe("denyUnmatched");
  });

  it.each([
    [{ mode: "agent" }, ["serve"], "promptUnmatched"],
    [{ mode: "agent", shellSandbox: false }, ["serve", "--disable-sandbox"], "promptUnmatched"],
    [{ mode: "agent", sandboxNetwork: "restricted", trustWorkspaces: true }, ["serve", "--sandbox-network", "restricted", "--trust-workspace"], "promptUnmatched"],
    [{ mode: "agent", sandboxNetwork: "enabled" }, ["serve", "--sandbox-network", "enabled"], "promptUnmatched"],
    [{ mode: "agent", sandboxNetwork: "proxy-only", trustWorkspaces: false }, ["serve"], "promptUnmatched"],
    [{ mode: "yolo", shellSandbox: true, trustWorkspaces: false }, ["serve", "--disable-sandbox", "--trust-workspace"], "allowAll"],
    [{ mode: "onRequest", shellSandbox: false }, ["serve"], "onRequest"],
    [{ mode: "onRequest", shellSandbox: true, sandboxNetwork: "restricted" }, ["serve", "--sandbox-network", "restricted"], "onRequest"],
    [{ mode: "denyUnmatched", shellSandbox: true }, ["serve"], "denyUnmatched"],
    [{ mode: "denyUnmatched", shellSandbox: false }, ["serve", "--disable-sandbox"], "denyUnmatched"],
  ])("spawns %j and starts in %s", async (posture, args, approvalMode) => {
    for (const platform of ["win32", "linux"] as const) {
      const s = setup();
      Object.defineProperty(process, "platform", { value: platform });
      const executable = platform === "win32" ? "C:\\Muse Code\\muse.cmd" : "/fake/muse";
      const backend = new MuseBackend(posture as any);
      const spec = backend.spawn({ cliPath: executable, cwd: "/workspace", env: {} });
      vi.stubEnv("MUSE_CODE_EXECUTABLE", executable);
      vi.stubEnv("GROK_MUSE_POSTURE", spec.env.GROK_MUSE_POSTURE!);
      await s.session.initialize();
      expect(s.spawn.mock.calls[0][0].args).toEqual(platform === "win32" ? ["/d", "/c", executable, ...args] : args);
      const result = await s.session.newSession("/workspace", []);
      expect(s.command).toHaveBeenCalledWith("session/start", { workspaceRoot: "/workspace", approvalMode });
      expect(result.modes?.currentModeId).toBe(posture.mode);
    }
  });

  it("switches approval on the live MSP connection and carries the accepted mode through ACP", async () => {
    const s = await ready();
    const host = new AcpClient({ cliPath: "/unused", cwd: "/workspace", backend: new MuseBackend(), log: () => {} });
    vi.spyOn(host as any, "request").mockImplementation(async (method: string, p: any) => {
      if (method === "session/new") return s.result;
      if (method === "session/set_mode") return s.session.setMode(p.sessionId, p.modeId);
      throw new Error(method);
    });
    const changed = vi.fn();
    host.on("modeChanged", changed);
    await host.newSession();
    expect(host.currentModeId).toBe("agent");
    for (const [modeId, mode] of [["yolo", "allowAll"], ["agent", "promptUnmatched"], ["onRequest", "onRequest"], ["denyUnmatched", "denyUnmatched"]]) {
      s.command.mockResolvedValueOnce({ status: "accepted", effectiveMode: { mode, source: "approvalReconfigure" } } as any);
      await host.setMode(modeId);
      expect(s.command).toHaveBeenLastCalledWith("session/setApprovalMode", { sessionId: "session", mode });
      expect(host.currentModeId).toBe(modeId);
      expect(changed).toHaveBeenLastCalledWith(modeId);
    }
    expect(s.spawn).toHaveBeenCalledOnce();
  });

  it.each(["allowAll", "promptUnmatched", "onRequest", "denyUnmatched"])("reopens with replayed %s driving the host mode", async mode => {
    const s = setup();
    await s.session.initialize();
    s.command.mockResolvedValueOnce({ session: { sessionId: "session", workspaceRoot: "/workspace", modelId: "default-model",
      approvalMode: { mode, source: "replay", lastCommandId: "stored" } }, history: { mode: "inline", items: [] } } as any);
    const host = new AcpClient({ cliPath: "/unused", cwd: "/workspace", backend: new MuseBackend(), log: () => {} });
    vi.spyOn(host as any, "request").mockImplementation(async (method: string, p: any) => {
      expect(method).toBe("session/load");
      return s.session.loadSession(p.sessionId, p.cwd, p.mcpServers);
    });
    const changed = vi.fn();
    host.on("modeChanged", changed);
    await host.loadSession("session");
    expect(host.currentModeId).toBe(mode === "allowAll" ? "yolo" : mode === "promptUnmatched" ? "agent" : mode);
    expect(changed).toHaveBeenLastCalledWith(host.currentModeId);
    expect(s.command.mock.calls).toEqual([["session/resume", { sessionId: "session", history: "inline" }]]);
  });

  it("does not report a refused or missing effective mode as accepted", async () => {
    const s = await ready();
    for (const response of [{ status: "rejected" }, { status: "accepted" }, { status: "accepted", effectiveMode: { mode: "promptUnmatched" } }]) {
      s.command.mockResolvedValueOnce(response as any);
      await expect(s.session.setMode("session", "yolo")).rejects.toThrow("not accepted");
    }
    s.command.mockClear();
    await expect(s.session.setMode("session", "plan")).rejects.toThrow("Plan");
    await expect(s.session.setMode("foreign", "yolo")).rejects.toThrow("Unknown Muse session");
    expect(s.command).not.toHaveBeenCalled();
  });

  it("publishes replayed full access before forwarding pending approvals", async () => {
    const s = setup();
    await s.session.initialize();
    s.command.mockResolvedValueOnce({ session: { sessionId: "session", workspaceRoot: "/workspace", approvalMode: { mode: "allowAll", source: "replay" } },
      history: { mode: "inline", items: [] }, pendingRequests: [{}] } as any);
    s.connection.request.mockImplementation(async (method?: string) => method === "approval/listPending"
      ? { approvals: [{ approvalId: "pending" }], userInputs: [] } as any : { models: [] });
    const accept = vi.spyOn((s.session as any).approvals, "accept").mockImplementation(() => {
      expect(s.client.notify).toHaveBeenCalledWith("session/update", { sessionId: "session", update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } });
    });
    await s.session.loadSession("session", "/workspace", []);
    expect(accept).toHaveBeenCalledWith("approval/requested", { approvalId: "pending" });
  });

  it("projects live approval changes and ignores foreign sessions", async () => {
    const s = await ready();
    s.event("session/approvalModeChanged", { mode: "allowAll" });
    s.event("session/approvalModeChanged", { mode: "promptUnmatched", sessionId: "foreign" });
    await Promise.resolve();
    expect(s.client.notify).toHaveBeenCalledWith("session/update", { sessionId: "session", update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } });
  });
});

describe("Muse blank session history", () => {
  // session/list from the Run 3 binary/store, with paths, IDs and prompts scrubbed.
  // The blank row has a NUMBER zero; title/firstUserPrompt are omitted, not null.
  it("hides the real blank listing shape before it reaches rail/history, including a fresh catalog client", async () => {
    for (let reopen = 0; reopen < 2; reopen++) {
      const s = setup();
      await s.session.initialize(); // catalog only: no session/start or prompt
      s.connection.request.mockResolvedValue(museListing as any);
      const result = await new MuseBackend().listSessions(async (_method, params) =>
        JSON.parse(JSON.stringify(await s.session.listSessions(params.cwd, params.cursor))), "/example/project");
      const rows = result.sessions.map(entry => adapterListEntry(entry, {}, "muse"));
      expect(rows.map(row => row.id)).toEqual(["muse-parallel-demo", "muse-sequential-demo"]);
      expect(rows.map(row => row.numMessages)).toEqual([1, 1]);
      expect(rows.every(row => !row.displayName.startsWith("Untitled"))).toBe(true);
      expect(s.command).not.toHaveBeenCalled();
    }
  });

  it.each([
    { firstUserPrompt: "Interrupted before the first turn completed" },
    { title: "A conversation with content" },
    { lastActivityAt: "2026-09-27T05:45:52.000000Z" },
    { activeTurnId: "in-flight" },
    { status: "running" },
    { forkedFrom: { sessionId: "source", viewCursor: "opaque" } },
    { turnCount: 1 },
    { turnCount: undefined },
    { activeTurnId: undefined },
    { forkedFrom: undefined },
  ])("preserves zero-turn content or uncertain metadata: %j", async content => {
    const s = setup(); await s.session.initialize();
    const row = { ...museListing.sessions[2], ...content };
    s.connection.request.mockResolvedValue({ sessions: [row], nextCursor: null } as any);
    expect((await s.session.listSessions("/example/project")).sessions).toHaveLength(1);
  });

  it("continues pagination through an entirely blank page", async () => {
    const s = setup(); await s.session.initialize();
    s.connection.request.mockResolvedValueOnce({ sessions: [museListing.sessions[2]], nextCursor: "next" } as any)
      .mockResolvedValueOnce({ sessions: [museListing.sessions[0]], nextCursor: null } as any);
    const result = await new MuseBackend().listSessions((_method, params) => s.session.listSessions(params.cwd, params.cursor), "/example/project");
    expect(result.sessions.map(row => row.sessionId)).toEqual(["muse-parallel-demo"]);
    expect(s.connection.request).toHaveBeenLastCalledWith("session/list", { workspaceRoot: "/example/project", cursor: "next", limit: 200 });
  });
});

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
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true, disposition: "started" });
    s.event("turn/completed", { turnId: "turn", terminal: "completed" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(s.connection.request).toHaveBeenCalledWith("usage/read", {});
    expect(s.client.notify).toHaveBeenCalledWith("_muse/subscription_usage", { sessionId: "session", usage });

    s.client.notify.mockClear();
    s.command.mockResolvedValueOnce({ status: "accepted", turnId: "next", startedNewTurn: true, disposition: "started" } as any);
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
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true, disposition: "started" });
    s.event("turn/completed", { turnId: "turn", terminal: "completed" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(s.fatal).not.toHaveBeenCalled();
    expect(s.logs).toContain("Muse usage/read failed: usage unavailable");
    expect(s.client.notify.mock.calls.some((call: any[]) => call[0] === "_muse/subscription_usage")).toBe(false);
  });
});

describe("Muse turn admission and process ownership", () => {
  it.each([false, true])("admits a queued prompt with delivery already observed=%s and waits for its own terminal", async observed => {
    const s = await ready();
    if (observed) s.event("turn/started", { turnId: "delivery" });
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    const settled = vi.fn(); void prompt.then(settled);
    expect(s.command).toHaveBeenCalledWith("turn/start", { sessionId: "session", ifBusy: "queue", input: [{ type: "text", text: "hello" }] });
    s.admission.resolve({ status: "accepted", turnId: "user", startedNewTurn: false, disposition: "queued" });
    await new Promise(resolve => setImmediate(resolve));
    await expect(s.session.prompt("session", [{ type: "text", text: "again" }])).rejects.toThrow("already has an active prompt");
    s.event("turn/completed", { turnId: "delivery", terminal: "completed" });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    s.event("turn/started", { turnId: "user" });
    s.event("turn/completed", { turnId: "user", terminal: "completed" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(s.command.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it.each([false, true])("withdraws a queued prompt, including cancel before admission=%s", async beforeAdmission => {
    const s = await ready();
    s.event("turn/started", { turnId: "delivery" });
    await s.session.cancel("session");
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    const settled = vi.fn(); void prompt.then(settled);
    if (beforeAdmission) await s.session.cancel("session");
    expect(s.command).not.toHaveBeenCalledWith("turn/cancel", expect.anything());
    s.admission.resolve({ status: "accepted", turnId: "user", startedNewTurn: false, disposition: "queued" });
    await new Promise(resolve => setImmediate(resolve));
    if (!beforeAdmission) await s.session.cancel("session");
    expect(s.command).toHaveBeenCalledWith("turn/unqueue", { sessionId: "session", turnId: "user" });
    s.event("turn/completed", { turnId: "delivery", terminal: "completed" });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    s.event("turn/unqueued", { turnId: "user" });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(s.command).not.toHaveBeenCalledWith("turn/cancel", expect.anything());
  });

  it("cancels only the admitted prompt when launch wins the unqueue race", async () => {
    const s = await ready();
    s.event("turn/started", { turnId: "delivery" });
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    s.admission.resolve({ status: "accepted", turnId: "user", startedNewTurn: false, disposition: "queued" });
    await new Promise(resolve => setImmediate(resolve));
    s.command.mockRejectedValueOnce(new MspError({ code: -32030, message: "already launched", data: { kind: "commandRejected" } }));
    await s.session.cancel("session");
    expect(s.command).toHaveBeenCalledWith("turn/cancel", { sessionId: "session", turnId: "user" });
    expect(s.command).not.toHaveBeenCalledWith("turn/cancel", { sessionId: "session", turnId: "delivery" });
    s.event("turn/completed", { turnId: "user", terminal: "cancelled" });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it.each(["turn/completed", "turn/unqueued"])("keeps queued settlement before acknowledgement: %s", async method => {
    const s = await ready();
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    s.event(method, { turnId: "user", terminal: "completed" });
    s.admission.resolve({ status: "accepted", turnId: "user", startedNewTurn: false, disposition: "queued" });
    await expect(prompt).resolves.toEqual({ stopReason: method === "turn/unqueued" ? "cancelled" : "end_turn" });
  });

  it("does not turn an unqueue transport failure into a foreground cancellation", async () => {
    const s = await ready();
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    s.admission.resolve({ status: "accepted", turnId: "user", startedNewTurn: false, disposition: "queued" });
    await new Promise(resolve => setImmediate(resolve));
    s.command.mockRejectedValueOnce(new Error("transport lost"));
    await expect(s.session.cancel("session")).rejects.toThrow("transport lost");
    expect(s.command).not.toHaveBeenCalledWith("turn/cancel", expect.anything());
    s.event("turn/completed", { turnId: "user", terminal: "completed" });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("uses authoritative disposition instead of the legacy boolean and rejects steering", async () => {
    const s = await ready();
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    s.admission.resolve({ status: "accepted", turnId: "delivery", startedNewTurn: true, disposition: "steered" });
    await expect(prompt).rejects.toThrow("Muse did not admit a prompt turn");
    await s.session.cancel("session");
    expect(s.command).not.toHaveBeenCalledWith("turn/cancel", expect.anything());
  });

  it("keeps rejecting a second prompt during our own admission and active turn", async () => {
    const s = await ready();
    const first = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    await expect(s.session.prompt("session", [{ type: "text", text: "second" }])).rejects.toThrow("already has an active prompt");
    s.admission.resolve({ status: "accepted", turnId: "user", startedNewTurn: true, disposition: "started" });
    s.event("turn/started", { turnId: "user" });
    await expect(s.session.prompt("session", [{ type: "text", text: "third" }])).rejects.toThrow("already has an active prompt");
    s.event("turn/completed", { turnId: "user", terminal: "completed" });
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
  });

  it.each(["protocol", "close"])("cleans up a queued prompt on %s", async failure => {
    vi.useFakeTimers();
    const s = await ready();
    s.event("turn/started", { turnId: "delivery" });
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    s.admission.resolve({ status: "accepted", turnId: "user", disposition: "queued", startedNewTurn: false });
    await Promise.resolve();
    const rejected = expect(prompt).rejects.toThrow(failure === "protocol" ? "invalid MSP" : "closing");
    if (failure === "protocol") s.protocolError(new Error("invalid MSP"));
    else {
      s.exited.resolve({ code: 0, signal: null });
      await s.session.close();
    }
    await rejected;
    expect(s.command).toHaveBeenCalledWith("turn/start", expect.anything());
    expect(vi.getTimerCount()).toBeLessThanOrEqual(failure === "close" ? 1 : 0);
  });

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
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true, disposition: "started" });
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
    s.admission.resolve({ status: "accepted", turnId: "first", startedNewTurn: true, disposition: "started" });
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
    s.command.mockImplementation(async () => ({ status: "accepted", turnId: "second", startedNewTurn: true, disposition: "started" }));
    const second = s.session.prompt("session", [{ type: "text", text: "two" }]);
    s.event("turn/completed", { turnId: "second", terminal: "completed" });
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
  });

  it.each(["protocol", "transport", "exit", "turn"])("rejects a prompt on %s failure", async failure => {
    const s = await ready();
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    const rejected = expect(prompt).rejects.toBeInstanceOf(Error);
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true, disposition: "started" });
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
  const busy = () => new MspError({ code: -32021, message: "session session is already in use",
    data: { kind: "sessionInUse", retryable: false, sessionId: "session" } });

  it.each([1, 5, 33])("resumes after %i lease conflicts on the same connection and projects history once", async conflicts => {
    vi.useFakeTimers();
    const s = setup();
    await s.session.initialize();
    for (let i = 0; i < conflicts; i++) s.command.mockRejectedValueOnce(busy());
    s.command.mockResolvedValue({ session: { sessionId: "session", workspaceRoot: "/workspace" },
      history: { mode: "inline", items: [{ itemId: "answer", revision: 1, kind: "agentMessage", text: "Restored" }] },
    } as any);
    const loading = s.session.loadSession("session", "/workspace", []);
    await vi.advanceTimersByTimeAsync(299);
    expect(s.command).toHaveBeenCalledOnce();
    expect(s.client.notify).not.toHaveBeenCalled();
    expect(s.fatal).not.toHaveBeenCalled();
    await expect(s.session.newSession("/workspace", [])).rejects.toThrow("already owns a session");
    await vi.advanceTimersByTimeAsync(conflicts * 300 - 299);
    await loading;
    expect(s.command).toHaveBeenCalledTimes(conflicts + 1);
    // No commandId override: each SDK command call gets a fresh id.
    for (const call of s.command.mock.calls) expect(call).toEqual(["session/resume", { sessionId: "session", history: "inline" }]);
    expect(s.spawn).toHaveBeenCalledOnce();
    expect(s.handshake.initialize).toHaveBeenCalledOnce();
    expect(s.handshake.close).not.toHaveBeenCalled();
    expect(s.fatal).not.toHaveBeenCalled();
    expect(s.client.notify).toHaveBeenCalledOnce();
    expect(s.client.notify.mock.calls[0]?.[1].update.content.text).toBe("Restored");
  });

  it("reports a persistent lease conflict through ACP after 10 seconds without spawning or creating sessions", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.session.initialize();
    s.command.mockRejectedValue(busy());
    const loading = s.session.loadSession("session", "/workspace", []);
    const failed = loading.catch(error => error);
    await vi.advanceTimersByTimeAsync(9999);
    expect(s.fatal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await failed;
    expect(error).toBeInstanceOf(RequestError);
    expect(error.toErrorResponse()).toEqual({ code: -32021,
      message: "Muse Code is busy with this conversation in another window. Try again in a moment." });
    expect(s.fatal).toHaveBeenCalledOnce();
    expect(s.fatal).toHaveBeenCalledWith(error);
    expect(s.command).toHaveBeenCalledTimes(34);
    for (const call of s.command.mock.calls) expect(call).toEqual(["session/resume", { sessionId: "session", history: "inline" }]);
    expect(s.spawn).toHaveBeenCalledOnce();
    expect(s.handshake.initialize).toHaveBeenCalledOnce();
    expect(s.handshake.close).not.toHaveBeenCalled();
    expect(s.connection.request).not.toHaveBeenCalled();
    expect(s.client.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves fast failure for non-transient resume errors", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.session.initialize();
    const error = new MspError({ code: -32020, message: "Session not found",
      data: { kind: "sessionNotFound", retryable: false } });
    s.command.mockRejectedValue(error);
    await expect(s.session.loadSession("session", "/workspace", [])).rejects.toBe(error);
    expect(s.command).toHaveBeenCalledOnce();
    expect(s.fatal).toHaveBeenCalledOnce();
    expect(s.fatal).toHaveBeenCalledWith(error);
    expect(s.spawn).toHaveBeenCalledOnce();
    expect(s.client.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queues cancellation before admission and waits for the terminal", async () => {
    const s = await ready();
    const prompt = s.session.prompt("session", [{ type: "text", text: "hello" }]);
    await s.session.cancel("session");
    expect(s.command).not.toHaveBeenCalledWith("turn/cancel", expect.anything());
    s.admission.resolve({ status: "accepted", turnId: "turn", startedNewTurn: true, disposition: "started" });
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
    s.command.mockImplementation(async () => ({ status: "accepted", turnId: "next", startedNewTurn: true, disposition: "started" }));
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
  s.admission.resolve({ status: "accepted", turnId: "first", startedNewTurn: true, disposition: "started" });
  s.event("turn/completed", { turnId: "first", terminal: "completed" }); await first;
  s.command.mockImplementation(async () => ({ status: "accepted", turnId: "second", startedNewTurn: true, disposition: "started" }));
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

const museApproval = (turnId: string) => ({ sessionId: "session", approvalId: `approval-${turnId}`, turnId, toolCallId: "call",
  toolName: "bash", rawArgs: "{}", currentRequirementId: { approvalId: `approval-${turnId}`, sourceIndex: 0 },
  availableChoices: [{ choiceId: "allow", decision: "approved", scope: "once", label: "Allow" }] });

it("keeps an approval from Muse's own turn answerable while a prompt queues behind it", async () => {
  const s = await ready();
  const answer = deferred<any>(); s.client.request.mockReturnValue(answer.promise);
  s.event("approval/requested", museApproval("delivery"));
  const prompt = s.session.prompt("session", [{ type: "text", text: "while Muse is busy" }]);
  s.admission.resolve({ status: "accepted", turnId: "mine", startedNewTurn: false, disposition: "queued" });
  await new Promise(resolve => setImmediate(resolve));
  answer.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
  await new Promise(resolve => setImmediate(resolve));
  expect(s.command).toHaveBeenCalledWith("approval/decide", expect.objectContaining({ approvalId: "approval-delivery", choiceId: "allow" }));
  s.event("turn/completed", { turnId: "delivery", terminal: "completed" });
  s.event("turn/completed", { turnId: "mine", terminal: "completed" });
  await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
  expect(s.fatal).not.toHaveBeenCalled();
});

it("drops a finished turn's approval so a late answer never reaches Muse", async () => {
  const s = await ready();
  const answer = deferred<any>(); s.client.request.mockReturnValue(answer.promise);
  s.event("approval/requested", museApproval("done"));
  s.event("turn/completed", { turnId: "done", terminal: "cancelled" });
  answer.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
  await new Promise(resolve => setImmediate(resolve));
  expect(s.command).not.toHaveBeenCalledWith("approval/decide", expect.anything());
  expect(s.fatal).not.toHaveBeenCalled();
});
